/**
 * The web remote control relay protocol, as spoken by the desktop
 * (`packages/desktop/src/main/webRemoteControlTransport.ts`) and the phone
 * (`packages/web/src/webRemoteControlTransport.ts`). Kept free of Node APIs so the
 * same code can run in other runtimes (Workers, Deno).
 */

export type RelayRole = "device" | "terminal";
export type RelayPairStatus = "waiting" | "matched";
export type RelayErrorCode = "AUTH_FAILED" | "DEVICE_OFFLINE" | "KICKED" | "WRONG_PARAM" | "INTERNAL";

export type RelayClientMessage =
  | { type: "device_register_init"; device_mid: string; pass_hash: string }
  | { type: "auth_init"; role: RelayRole; device_sid: string }
  | { type: "auth_response"; device_sid: string; proof: string }
  | { type: "pair_status_query" }
  | { type: "data" };

export type RelayServerMessage =
  | { type: "device_register_ack"; device_sid: string }
  | { type: "auth_challenge"; nonce: string }
  | { type: "auth_ack"; device_sid: string; terminal_sid?: string; pair_status: RelayPairStatus }
  | { type: "pair_status_ack"; terminal_sid?: string; pair_status: RelayPairStatus }
  | { type: "error"; code: RelayErrorCode; message: string };

const MAX_ID_LENGTH = 200;
const MAX_SECRET_LENGTH = 512;

function readString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

/** Parses one text frame; `undefined` means it isn't a message this relay understands. */
export function parseRelayClientMessage(text: string): RelayClientMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const message = raw as Record<string, unknown>;
  switch (message.type) {
    case "device_register_init": {
      const deviceMid = readString(message.device_mid, MAX_ID_LENGTH);
      const passHash = readString(message.pass_hash, MAX_SECRET_LENGTH);
      return deviceMid && passHash
        ? { type: "device_register_init", device_mid: deviceMid, pass_hash: passHash }
        : undefined;
    }
    case "auth_init": {
      const deviceSid = readString(message.device_sid, MAX_ID_LENGTH);
      const role = message.role === "device" || message.role === "terminal" ? message.role : undefined;
      return deviceSid && role ? { type: "auth_init", role, device_sid: deviceSid } : undefined;
    }
    case "auth_response": {
      const deviceSid = readString(message.device_sid, MAX_ID_LENGTH);
      const proof = readString(message.proof, MAX_SECRET_LENGTH);
      return deviceSid && proof ? { type: "auth_response", device_sid: deviceSid, proof } : undefined;
    }
    case "pair_status_query":
      return { type: "pair_status_query" };
    case "data":
      return "payload" in message ? { type: "data" } : undefined;
    default:
      return undefined;
  }
}

export function serializeRelayServerMessage(message: RelayServerMessage, now: number): string {
  return JSON.stringify({ ...message, server_ts: now });
}

function base64UrlNoPadding(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url(HMAC-SHA256(key = UTF-8 pass hash, "nonce|role|device_sid")), no padding. */
export async function calculateRelayProof(
  passHash: string,
  nonce: string,
  role: RelayRole,
  deviceSid: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passHash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${nonce}|${role}|${deviceSid}`),
  );
  return base64UrlNoPadding(new Uint8Array(signature));
}

/** Compares two strings without returning early on the first difference. */
export function constantTimeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function createRelayNonce(): string {
  return base64UrlNoPadding(crypto.getRandomValues(new Uint8Array(18)));
}

export function createRelayId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
