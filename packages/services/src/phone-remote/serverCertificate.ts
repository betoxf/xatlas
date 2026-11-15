import { randomBytes, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";

/** Renewed this long before it expires; phones then pair again. */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const VALIDITY_DAYS = 825;

export interface PhoneRemoteServerCertificate {
  readonly key: string;
  readonly cert: string;
  /** SHA-256 of the certificate, lowercase hex: what the xatlas apps pin. */
  readonly fingerprint: string;
}

/**
 * The certificate this Mac serves the phone remote with. It's self-signed: phones
 * trust it because the pairing code carries its fingerprint, not because of a CA.
 */
export function ensurePhoneRemoteServerCertificate(directory: string): PhoneRemoteServerCertificate {
  const certPath = join(directory, "server-cert.pem");
  const keyPath = join(directory, "server-key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, "utf8");
    const parsed = new X509Certificate(cert);
    if (Date.parse(parsed.validTo) - Date.now() > RENEW_BEFORE_MS) {
      return { key: readFileSync(keyPath, "utf8"), cert, fingerprint: fingerprintOf(parsed) };
    }
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  certificate.serialNumber = serial.toString("hex");
  const notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notBefore = notBefore;
  certificate.validity.notAfter = new Date(notBefore.getTime() + VALIDITY_DAYS * 86_400_000);
  const name = [{ name: "commonName", value: "xatlas phone remote" }];
  certificate.setSubject(name);
  certificate.setIssuer(name);
  certificate.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", critical: true, digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] },
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());

  const cert = forge.pki.certificateToPem(certificate);
  const key = forge.pki.privateKeyToPem(keys.privateKey);
  mkdirSync(directory, { recursive: true });
  writeFileSync(keyPath, key, { mode: 0o600 });
  writeFileSync(certPath, cert, { mode: 0o644 });
  return { key, cert, fingerprint: fingerprintOf(new X509Certificate(cert)) };
}

function fingerprintOf(certificate: X509Certificate): string {
  return certificate.fingerprint256.replace(/:/g, "").toLowerCase();
}
