import { afterEach, describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePhoneRemoteServerCertificate } from "../src/phone-remote/serverCertificate.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("phone remote server certificate", () => {
  it("creates a self-signed certificate once and keeps its fingerprint", () => {
    const directory = mkdtempSync(join(tmpdir(), "xatlas-phone-cert-"));
    directories.push(directory);

    const first = ensurePhoneRemoteServerCertificate(directory);
    const second = ensurePhoneRemoteServerCertificate(directory);

    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(new X509Certificate(first.cert).fingerprint256.replace(/:/g, "").toLowerCase()).toBe(
      first.fingerprint,
    );
    expect(statSync(join(directory, "server-key.pem")).mode & 0o777).toBe(0o600);
  });
});
