import {
  calculateRelayProof,
  constantTimeEqual,
  createRelayId,
  createRelayNonce,
  parseRelayClientMessage,
  serializeRelayServerMessage,
  type RelayClientMessage,
  type RelayErrorCode,
  type RelayPairStatus,
  type RelayRole,
  type RelayServerMessage,
} from "./protocol.js";
import type { RelayRegistry } from "./registry.js";

/** One WebSocket, as the hub sees it. */
export interface RelayPeer {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export type RelayLogEvent =
  | "registered"
  | "authenticated"
  | "auth-failed"
  | "paired"
  | "unpaired"
  | "replaced";

export interface RelayHubOptions {
  readonly registry: RelayRegistry;
  readonly now?: () => number;
  /** Never receives secrets: only roles and shortened ids. */
  readonly log?: (event: RelayLogEvent, fields: Record<string, string>) => void;
}

/** Close codes sent to sockets the hub ends itself. */
export const RelayCloseCodes = {
  DeviceReplaced: 4001,
  TerminalReplaced: 4003,
} as const;

interface PeerState {
  readonly peer: RelayPeer;
  role?: RelayRole;
  deviceSid?: string;
  nonce?: string;
  authenticated: boolean;
  terminalSid?: string;
  /** Messages from one socket are handled strictly in order. */
  queue: Promise<void>;
}

interface Room {
  device?: PeerState;
  terminal?: PeerState;
}

function shortId(id: string | undefined): string {
  return id ? id.slice(0, 10) : "-";
}

/**
 * Pairs one desktop ("device") with one phone ("terminal") per registered
 * device, after each proves it knows the pairing secret, and forwards their
 * `data` frames without reading them.
 */
export class RelayHub {
  private readonly peers = new Map<RelayPeer, PeerState>();
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;

  constructor(private readonly options: RelayHubOptions) {
    this.now = options.now ?? Date.now;
  }

  open(peer: RelayPeer): void {
    this.peers.set(peer, { peer, authenticated: false, queue: Promise.resolve() });
  }

  isAuthenticated(peer: RelayPeer): boolean {
    return this.peers.get(peer)?.authenticated === true;
  }

  receive(peer: RelayPeer, text: string): Promise<void> {
    const state = this.peers.get(peer);
    if (!state) return Promise.resolve();
    state.queue = state.queue
      .then(() => this.handle(state, text))
      .catch(() => this.sendError(state, "INTERNAL", "Relay error"));
    return state.queue;
  }

  close(peer: RelayPeer): void {
    const state = this.peers.get(peer);
    this.peers.delete(peer);
    if (!state?.authenticated || !state.deviceSid) return;
    const room = this.rooms.get(state.deviceSid);
    if (!room) return;
    const other = state.role === "device" ? room.terminal : room.device;
    if (state.role === "device" && room.device === state) room.device = undefined;
    else if (state.role === "terminal" && room.terminal === state) room.terminal = undefined;
    else return;
    if (other) {
      this.send(other, { type: "pair_status_ack", pair_status: "waiting" });
      this.log("unpaired", { device: shortId(state.deviceSid), left: state.role ?? "-" });
    }
    if (!room.device && !room.terminal) this.rooms.delete(state.deviceSid);
  }

  private async handle(state: PeerState, text: string): Promise<void> {
    const message = parseRelayClientMessage(text);
    if (!message) {
      this.sendError(state, "WRONG_PARAM", "Unsupported message");
      return;
    }
    switch (message.type) {
      case "device_register_init":
        return this.register(state, message);
      case "auth_init":
        return this.authInit(state, message);
      case "auth_response":
        return this.authResponse(state, message);
      case "pair_status_query":
        return this.pairStatusQuery(state);
      case "data":
        return this.forward(state, text);
    }
  }

  private async register(
    state: PeerState,
    message: Extract<RelayClientMessage, { type: "device_register_init" }>,
  ): Promise<void> {
    if (state.authenticated) {
      this.sendError(state, "WRONG_PARAM", "Already authenticated");
      return;
    }
    const deviceSid = createRelayId("xd");
    await this.options.registry.register({
      deviceSid,
      deviceMid: message.device_mid,
      passHash: message.pass_hash,
      registeredAt: this.now(),
    });
    this.log("registered", { device: shortId(deviceSid) });
    this.send(state, { type: "device_register_ack", device_sid: deviceSid });
  }

  private async authInit(
    state: PeerState,
    message: Extract<RelayClientMessage, { type: "auth_init" }>,
  ): Promise<void> {
    if (state.authenticated) {
      this.sendError(state, "WRONG_PARAM", "Already authenticated");
      return;
    }
    if (!(await this.options.registry.get(message.device_sid))) {
      this.log("auth-failed", { device: shortId(message.device_sid), role: message.role });
      this.sendError(state, "AUTH_FAILED", "Unknown device");
      return;
    }
    state.role = message.role;
    state.deviceSid = message.device_sid;
    state.nonce = createRelayNonce();
    this.send(state, { type: "auth_challenge", nonce: state.nonce });
  }

  private async authResponse(
    state: PeerState,
    message: Extract<RelayClientMessage, { type: "auth_response" }>,
  ): Promise<void> {
    const { nonce, role, deviceSid } = state;
    // A challenge answers exactly one response.
    state.nonce = undefined;
    if (state.authenticated || !nonce || !role || deviceSid !== message.device_sid) {
      this.sendError(state, "WRONG_PARAM", "No pending challenge");
      return;
    }
    const record = await this.options.registry.get(deviceSid);
    const expected = record
      ? await calculateRelayProof(record.passHash, nonce, role, deviceSid)
      : undefined;
    // The socket may have closed while the proof was being checked.
    if (this.peers.get(state.peer) !== state) return;
    if (!expected || !constantTimeEqual(expected, message.proof)) {
      this.log("auth-failed", { device: shortId(deviceSid), role });
      this.sendError(state, "AUTH_FAILED", "Invalid proof");
      return;
    }
    state.authenticated = true;
    this.log("authenticated", { device: shortId(deviceSid), role });
    this.join(state, deviceSid, role);
  }

  private join(state: PeerState, deviceSid: string, role: RelayRole): void {
    const room = this.rooms.get(deviceSid) ?? {};
    this.rooms.set(deviceSid, room);
    if (role === "device") {
      const previous = room.device;
      room.device = state;
      if (previous && previous !== state) {
        this.retire(previous, RelayCloseCodes.DeviceReplaced, "Replaced by a newer desktop connection");
      }
    } else {
      const previous = room.terminal;
      state.terminalSid = createRelayId("xt");
      room.terminal = state;
      if (previous && previous !== state) {
        // Only one phone at a time: the newest wins, the older one learns why it lost.
        this.sendError(previous, "KICKED", "Another phone opened this remote control link");
        this.retire(previous, RelayCloseCodes.TerminalReplaced, "Replaced by a newer phone connection");
      }
    }
    const status = this.pairStatus(room);
    this.send(state, {
      type: "auth_ack",
      device_sid: deviceSid,
      ...(room.terminal?.terminalSid ? { terminal_sid: room.terminal.terminalSid } : {}),
      pair_status: status,
    });
    const other = role === "device" ? room.terminal : room.device;
    if (status === "matched" && other) {
      this.send(other, {
        type: "pair_status_ack",
        ...(room.terminal?.terminalSid ? { terminal_sid: room.terminal.terminalSid } : {}),
        pair_status: "matched",
      });
      this.log("paired", { device: shortId(deviceSid) });
    }
  }

  private retire(state: PeerState, code: number, reason: string): void {
    this.peers.delete(state.peer);
    this.log("replaced", { device: shortId(state.deviceSid), role: state.role ?? "-" });
    state.peer.close(code, reason);
  }

  private pairStatusQuery(state: PeerState): void {
    const room = state.authenticated && state.deviceSid ? this.rooms.get(state.deviceSid) : undefined;
    if (!room) {
      this.sendError(state, "WRONG_PARAM", "Not authenticated");
      return;
    }
    this.send(state, {
      type: "pair_status_ack",
      ...(room.terminal?.terminalSid ? { terminal_sid: room.terminal.terminalSid } : {}),
      pair_status: this.pairStatus(room),
    });
  }

  private forward(state: PeerState, text: string): void {
    const room = state.authenticated && state.deviceSid ? this.rooms.get(state.deviceSid) : undefined;
    if (!room) {
      this.sendError(state, "WRONG_PARAM", "Not authenticated");
      return;
    }
    const target = state.role === "device" ? room.terminal : room.device;
    if (!target) {
      // Same answer as the hosted relay: the sender stays connected and waits for its peer.
      this.sendError(state, "INTERNAL", "Peer not connected");
      return;
    }
    target.peer.send(text);
  }

  private pairStatus(room: Room): RelayPairStatus {
    return room.device && room.terminal ? "matched" : "waiting";
  }

  private send(state: PeerState, message: RelayServerMessage): void {
    state.peer.send(serializeRelayServerMessage(message, this.now()));
  }

  private sendError(state: PeerState, code: RelayErrorCode, message: string): void {
    this.send(state, { type: "error", code, message });
  }

  private log(event: RelayLogEvent, fields: Record<string, string>): void {
    this.options.log?.(event, fields);
  }
}
