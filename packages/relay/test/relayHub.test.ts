import { describe, expect, it } from "vitest";
import { WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS } from "@zcode/shared";
import {
  calculateRelayProof,
  MemoryRelayRegistry,
  RelayCloseCodes,
  RelayHub,
  type RelayPeer,
  type RelayRole,
} from "../src/index.js";

class FakePeer implements RelayPeer {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly raw: string[] = [];
  closed?: { code: number; reason: string };

  send(text: string): void {
    this.raw.push(text);
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  last(): Record<string, unknown> | undefined {
    return this.sent.at(-1);
  }
}

const PASS_HASH = "c2VjcmV0LXBhc3MtaGFzaA==";

async function register(hub: RelayHub, mid = "mid-1"): Promise<string> {
  const desktop = new FakePeer();
  hub.open(desktop);
  await hub.receive(
    desktop,
    JSON.stringify({ type: "device_register_init", device_mid: mid, pass_hash: PASS_HASH, meta: {} }),
  );
  hub.close(desktop);
  return desktop.last()?.device_sid as string;
}

async function authenticate(
  hub: RelayHub,
  role: RelayRole,
  deviceSid: string,
  passHash = PASS_HASH,
): Promise<FakePeer> {
  const peer = new FakePeer();
  hub.open(peer);
  await hub.receive(peer, JSON.stringify({ type: "auth_init", role, device_sid: deviceSid, meta: {} }));
  const nonce = peer.last()?.nonce;
  if (typeof nonce === "string") {
    const proof = await calculateRelayProof(passHash, nonce, role, deviceSid);
    await hub.receive(peer, JSON.stringify({ type: "auth_response", device_sid: deviceSid, proof }));
  }
  return peer;
}

describe("relay hub", () => {
  it("computes the same proofs as the desktop and the phone", async () => {
    for (const vector of WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS) {
      expect(
        await calculateRelayProof(vector.passHash, vector.nonce, vector.role, vector.deviceSid),
      ).toBe(vector.proof);
    }
  });

  it("registers a desktop and pairs it with a phone", async () => {
    const hub = new RelayHub({ registry: new MemoryRelayRegistry() });
    const sid = await register(hub);
    expect(sid).toMatch(/^xd_/);

    const desktop = await authenticate(hub, "device", sid);
    expect(desktop.last()).toMatchObject({ type: "auth_ack", device_sid: sid, pair_status: "waiting" });

    const phone = await authenticate(hub, "terminal", sid);
    expect(phone.last()).toMatchObject({ type: "auth_ack", pair_status: "matched" });
    expect(phone.last()?.terminal_sid).toMatch(/^xt_/);
    expect(desktop.last()).toMatchObject({ type: "pair_status_ack", pair_status: "matched" });
  });

  it("forwards data frames unchanged in both directions", async () => {
    const hub = new RelayHub({ registry: new MemoryRelayRegistry() });
    const sid = await register(hub);
    const desktop = await authenticate(hub, "device", sid);
    const phone = await authenticate(hub, "terminal", sid);

    const fromPhone = JSON.stringify({ type: "data", payload: { type: "bootstrap" }, client_ts: 1 });
    await hub.receive(phone, fromPhone);
    expect(desktop.raw.at(-1)).toBe(fromPhone);

    const fromDesktop = JSON.stringify({ type: "data", payload: { type: "platform" } });
    await hub.receive(desktop, fromDesktop);
    expect(phone.raw.at(-1)).toBe(fromDesktop);
  });

  it("rejects a wrong proof and keeps the socket unauthenticated", async () => {
    const hub = new RelayHub({ registry: new MemoryRelayRegistry() });
    const sid = await register(hub);
    const intruder = await authenticate(hub, "terminal", sid, "not-the-pass-hash");

    expect(intruder.last()).toMatchObject({ type: "error", code: "AUTH_FAILED" });
    expect(hub.isAuthenticated(intruder)).toBe(false);
    await hub.receive(intruder, JSON.stringify({ type: "data", payload: {} }));
    expect(intruder.last()).toMatchObject({ type: "error", code: "WRONG_PARAM" });
  });

  it("answers an unknown device with AUTH_FAILED so the desktop registers again", async () => {
    const hub = new RelayHub({ registry: new MemoryRelayRegistry() });
    const desktop = await authenticate(hub, "device", "xd_unknown");
    expect(desktop.last()).toMatchObject({ type: "error", code: "AUTH_FAILED" });
  });

  it("uses each challenge once", async () => {
    const hub = new RelayHub({ registry: new MemoryRelayRegistry() });
    const sid = await register(hub);
    const peer = new FakePeer();
    hub.open(peer);
    await hub.receive(peer, JSON.stringify({ type: "auth_init", role: "terminal", device_sid: sid }));
    const nonce = peer.last()?.nonce as string;
    const proof = await calculateRelayProof(PASS_HASH, nonce, "terminal", sid);
    await hub.receive(peer, JSON.stringify({ type: "auth_response", device_sid: sid, proof: "wrong" }));
    await hub.receive(peer, JSON.stringify({ type: "auth_response", device_sid: sid, proof }));
    expect(peer.last()).toMatchObject({ type: "error", code: "WRONG_PARAM" });
    expect(hub.isAuthenticated(peer)).toBe(false);
  });

  it("lets only the newest phone stay connected", async () => {
    const hub = new RelayHub({ registry: new MemoryRelayRegistry() });
    const sid = await register(hub);
    const desktop = await authenticate(hub, "device", sid);
    const firstPhone = await authenticate(hub, "terminal", sid);
    const secondPhone = await authenticate(hub, "terminal", sid);

    expect(firstPhone.sent.some((message) => message.code === "KICKED")).toBe(true);
    expect(firstPhone.closed?.code).toBe(RelayCloseCodes.TerminalReplaced);
    expect(secondPhone.last()).toMatchObject({ type: "auth_ack", pair_status: "matched" });

    // The kicked socket's late close must not unpair the new phone.
    hub.close(firstPhone);
    await hub.receive(desktop, JSON.stringify({ type: "pair_status_query", device_sid: sid }));
    expect(desktop.last()).toMatchObject({ type: "pair_status_ack", pair_status: "matched" });
  });

  it("tells the desktop when the phone leaves, and refuses data with no peer", async () => {
    const hub = new RelayHub({ registry: new MemoryRelayRegistry() });
    const sid = await register(hub);
    const desktop = await authenticate(hub, "device", sid);
    const phone = await authenticate(hub, "terminal", sid);

    hub.close(phone);
    expect(desktop.last()).toMatchObject({ type: "pair_status_ack", pair_status: "waiting" });
    await hub.receive(desktop, JSON.stringify({ type: "data", payload: {} }));
    expect(desktop.last()).toMatchObject({ type: "error", code: "INTERNAL" });
  });

  it("revokes old links when the same desktop registers again", async () => {
    const hub = new RelayHub({ registry: new MemoryRelayRegistry() });
    const oldSid = await register(hub, "mid-1");
    const newSid = await register(hub, "mid-1");
    expect(newSid).not.toBe(oldSid);

    const stalePhone = await authenticate(hub, "terminal", oldSid);
    expect(stalePhone.last()).toMatchObject({ type: "error", code: "AUTH_FAILED" });
    const phone = await authenticate(hub, "terminal", newSid);
    expect(phone.last()).toMatchObject({ type: "auth_ack" });
  });
});
