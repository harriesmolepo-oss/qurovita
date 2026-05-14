// @qurovita/crypto — canonical QuroVita OOB cryptographic handshake.
//
// CSIR-mandated algorithms:
//   ECDH P-256 · ECDSA P-256 · HKDF-SHA256 · AES-256-GCM
//
// Runs identically in Node 20+ (via tsx or native ESM) and the browser
// (via Next.js transpilePackages). Do NOT modify the algorithm suite
// without written CSIR sign-off and a migration plan to post-quantum.

import { p256 } from "@noble/curves/p256";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { encode as cborEncode, decode as cborDecode } from "cbor-x";

export { cborDecode };

export const SESSION_TTL_SECONDS = 60; // demo: 60s (prod: 300s per v2.0 doc)

// ---------------------------------------------------------------------------
// QR payload — CBOR-encoded, always < 2900 bytes (Version 40 QR cap).
// ---------------------------------------------------------------------------
export interface QrPayload {
  v: 1;
  sid: string;       // session UUID
  spk: Uint8Array;   // server ECDH pubkey, 33-byte compressed P-256
  exp: number;       // unix expiry timestamp
  url: string;       // WebSocket URL the patient is listening on
  sig: Uint8Array;   // 64-byte ECDSA P-256 compact r||s signature
}

export interface CreateSessionArgs {
  sessionId: string;
  patientPubCompressed: Uint8Array; // 33 bytes
  websocketUrl: string;
  ecdsaSigningPrivKey: Uint8Array;  // 32 bytes — omit when using signerFn
  ttlSeconds?: number;
}

export interface CreateSessionAsyncArgs {
  sessionId: string;
  patientPubCompressed: Uint8Array;
  websocketUrl: string;
  /** Async signer (e.g. KMS). Receives the raw CBOR message; returns 64-byte compact r||s. */
  signerFn: (msg: Uint8Array) => Promise<Uint8Array>;
  ttlSeconds?: number;
}

export interface CreatedSession {
  qrBytes: Uint8Array;
  serverEcdhPriv: Uint8Array;
  serverEcdhPubCompressed: Uint8Array;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
export function hex(buf: Uint8Array): string {
  return [...buf].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function unhex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("odd-length hex string");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Copy bytes into a plain ArrayBuffer — required by WebCrypto under strict TS
// because Uint8Array can be backed by SharedArrayBuffer which SubtleCrypto rejects.
function toAb(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

// ---------------------------------------------------------------------------
// Server-side: create the signed QR payload.
// ---------------------------------------------------------------------------
export function createSession(args: CreateSessionArgs): CreatedSession {
  const ttl = args.ttlSeconds ?? SESSION_TTL_SECONDS;
  const serverPriv = p256.utils.randomPrivateKey();
  const serverPubCompressed = p256.getPublicKey(serverPriv, true);

  const exp = Math.floor(Date.now() / 1000) + ttl;
  const unsigned = { v: 1 as const, sid: args.sessionId, spk: serverPubCompressed, exp, url: args.websocketUrl };
  const msg = cborEncode(unsigned);
  const sig = p256.sign(sha256(msg), args.ecdsaSigningPrivKey).toCompactRawBytes();
  const signed: QrPayload = { ...unsigned, sig };
  const qrBytes = cborEncode(signed);

  if (qrBytes.length > 2900) {
    throw new Error(`QR payload ${qrBytes.length} bytes — exceeds Version 40 QR cap (2900 bytes)`);
  }
  return { qrBytes, serverEcdhPriv: serverPriv, serverEcdhPubCompressed: serverPubCompressed };
}

// ---------------------------------------------------------------------------
// Async variant of createSession — used with KMS (private key stays in KMS).
// ---------------------------------------------------------------------------
export async function createSessionAsync(args: CreateSessionAsyncArgs): Promise<CreatedSession> {
  const ttl = args.ttlSeconds ?? SESSION_TTL_SECONDS;
  const serverPriv = p256.utils.randomPrivateKey();
  const serverPubCompressed = p256.getPublicKey(serverPriv, true);

  const exp = Math.floor(Date.now() / 1000) + ttl;
  const unsigned = { v: 1 as const, sid: args.sessionId, spk: serverPubCompressed, exp, url: args.websocketUrl };
  const msg = cborEncode(unsigned);
  const sig = new Uint8Array(await args.signerFn(msg));
  const signed: QrPayload = { ...unsigned, sig };
  const qrBytes = cborEncode(signed);

  if (qrBytes.length > 2900) {
    throw new Error(`QR payload ${qrBytes.length} bytes — exceeds Version 40 QR cap (2900 bytes)`);
  }
  return { qrBytes, serverEcdhPriv: serverPriv, serverEcdhPubCompressed: serverPubCompressed };
}

// ---------------------------------------------------------------------------
// Provider-side: verify QR signature and generate provider ECDH keypair.
// ---------------------------------------------------------------------------
export function verifyQrAndDeriveProviderKey(args: {
  qrBytes: Uint8Array;
  ecdsaVerifyPubCompressed: Uint8Array;
}): { payload: QrPayload; providerEcdhPriv: Uint8Array; providerEcdhPubCompressed: Uint8Array } {
  const payload = cborDecode(args.qrBytes) as QrPayload;
  if (payload.v !== 1) throw new Error("Unsupported QR version");
  if (!payload.sid || !payload.spk || !payload.exp || !payload.url || !payload.sig) {
    throw new Error("QR payload malformed");
  }
  if (Math.floor(Date.now() / 1000) > payload.exp) throw new Error("QR session expired");

  const { sig, ...unsigned } = payload;
  const ok = p256.verify(sig, sha256(cborEncode(unsigned)), args.ecdsaVerifyPubCompressed);
  if (!ok) throw new Error("QR signature invalid — possible tampering");

  const providerPriv = p256.utils.randomPrivateKey();
  return { payload, providerEcdhPriv: providerPriv, providerEcdhPubCompressed: p256.getPublicKey(providerPriv, true) };
}

// ---------------------------------------------------------------------------
// Both sides: ECDH key exchange → HKDF → 32-byte AES-256 session key.
// ---------------------------------------------------------------------------
export function generateEcdhKeypair(): { priv: Uint8Array; pubCompressed: Uint8Array } {
  const priv = p256.utils.randomPrivateKey();
  return { priv, pubCompressed: p256.getPublicKey(priv, true) };
}

export function deriveSharedKey(myEcdhPriv: Uint8Array, peerEcdhPubCompressed: Uint8Array, sessionId: string): Uint8Array {
  const shared = p256.getSharedSecret(myEcdhPriv, peerEcdhPubCompressed, true).slice(1);
  return hkdf(sha256, shared, new TextEncoder().encode(sessionId), new TextEncoder().encode("qurovita-v1"), 32);
}

// ---------------------------------------------------------------------------
// AES-256-GCM bundle encrypt / decrypt — same code path in Node and browser.
// ---------------------------------------------------------------------------
export async function encryptBundle(plaintext: Uint8Array, key: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle;
  const ck = await subtle.importKey("raw", toAb(key), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: toAb(iv), additionalData: toAb(aad) }, ck, toAb(plaintext)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

export async function decryptBundle(wire: Uint8Array, key: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle;
  const ck = await subtle.importKey("raw", toAb(key), { name: "AES-GCM" }, false, ["decrypt"]);
  return new Uint8Array(await subtle.decrypt(
    { name: "AES-GCM", iv: toAb(wire.subarray(0, 12)), additionalData: toAb(aad) },
    ck,
    toAb(wire.subarray(12)),
  ));
}

// ---------------------------------------------------------------------------
// Browser-only: verify a QR payload without deriving a key (for the tamper test).
// ---------------------------------------------------------------------------
export function verifyQr(qrBytes: Uint8Array, ecdsaVerifyPubCompressed: Uint8Array): QrPayload {
  const payload = cborDecode(qrBytes) as QrPayload;
  if (payload.v !== 1) throw new Error("Unsupported QR version");
  if (Math.floor(Date.now() / 1000) > payload.exp) throw new Error("QR session expired");
  const { sig, ...unsigned } = payload;
  const ok = p256.verify(sig, sha256(cborEncode(unsigned)), ecdsaVerifyPubCompressed);
  if (!ok) throw new Error("QR signature invalid — possible tampering");
  return payload;
}
