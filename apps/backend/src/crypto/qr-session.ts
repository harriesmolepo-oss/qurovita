// backend/src/crypto/qr-session.ts
//
// QuroVita OOB Cryptographic Handshake — same code path as production.
// Uses @noble/curves so it runs identically in Node and the browser
// (the browser uses the same source via a CDN import in clients/).
//
// CSIR-mandated algorithms:
//   - ECDH P-256 (key exchange)
//   - ECDSA P-256 (QR signature, prevents tamper / TTL extension)
//   - HKDF-SHA256 (key derivation)
//   - AES-256-GCM (bundle encryption, native WebCrypto)

import { p256 } from "@noble/curves/p256";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { encode as cborEncode, decode as cborDecode } from "cbor-x";

export const SESSION_TTL_SECONDS = 60; // demo: 60s (prod: 300s per v2.0 doc)

// ---------------------------------------------------------------------------
// QR payload — CBOR-encoded. Stays well under 3KB QR cap.
// ---------------------------------------------------------------------------
export interface QrPayload {
  v: 1;
  sid: string;       // session UUID
  spk: Uint8Array;   // server ECDH pubkey, 33-byte compressed
  exp: number;       // unix expiry
  url: string;       // websocket URL the patient is listening on
  sig: Uint8Array;   // 64-byte ECDSA P-256 raw r||s
}

// ---------------------------------------------------------------------------
// Server-side: create the QR payload + retain the server ECDH privkey.
// ---------------------------------------------------------------------------
export interface CreateSessionArgs {
  sessionId: string;
  patientPubCompressed: Uint8Array; // 33 bytes
  websocketUrl: string;
  ecdsaSigningPrivKey: Uint8Array;  // 32 bytes
  ttlSeconds?: number;
}

export interface CreatedSession {
  qrBytes: Uint8Array;              // CBOR bytes, ready to render
  serverEcdhPriv: Uint8Array;       // store server-side, scoped to session
  serverEcdhPubCompressed: Uint8Array;
}

export function createSession(args: CreateSessionArgs): CreatedSession {
  const ttl = args.ttlSeconds ?? SESSION_TTL_SECONDS;
  const serverPriv = p256.utils.randomPrivateKey();
  const serverPubCompressed = p256.getPublicKey(serverPriv, true); // 33 bytes

  const exp = Math.floor(Date.now() / 1000) + ttl;
  const unsigned = {
    v: 1 as const,
    sid: args.sessionId,
    spk: serverPubCompressed,
    exp,
    url: args.websocketUrl,
  };

  const msg = cborEncode(unsigned);
  const msgHash = sha256(msg);
  const sig = p256.sign(msgHash, args.ecdsaSigningPrivKey).toCompactRawBytes(); // 64 bytes r||s

  const signed: QrPayload = { ...unsigned, sig };
  const qrBytes = cborEncode(signed);

  if (qrBytes.length > 2900) {
    throw new Error(`QR payload ${qrBytes.length} bytes exceeds Version 40 QR cap`);
  }

  return { qrBytes, serverEcdhPriv: serverPriv, serverEcdhPubCompressed: serverPubCompressed };
}

// ---------------------------------------------------------------------------
// Provider-side: verify the QR signature, derive the shared key.
// ---------------------------------------------------------------------------
export function verifyQrAndDeriveProviderKey(args: {
  qrBytes: Uint8Array;
  ecdsaVerifyPubCompressed: Uint8Array;  // QuroVita's published ECDSA pubkey
}): { payload: QrPayload; providerEcdhPriv: Uint8Array; providerEcdhPubCompressed: Uint8Array } {
  const payload = cborDecode(args.qrBytes) as QrPayload;

  if (payload.v !== 1) throw new Error("Unsupported QR version");
  if (!payload.sid || !payload.spk || !payload.exp || !payload.url || !payload.sig) {
    throw new Error("QR payload malformed");
  }
  if (Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error("QR session expired");
  }

  // Verify ECDSA over the unsigned fields
  const { sig, ...unsigned } = payload;
  const msg = cborEncode(unsigned);
  const msgHash = sha256(msg);
  const ok = p256.verify(sig, msgHash, args.ecdsaVerifyPubCompressed);
  if (!ok) throw new Error("QR signature invalid — possible tampering");

  // Provider generates an ephemeral ECDH keypair to do the handshake with
  // the server-issued ECDH pubkey embedded in the QR.
  const providerPriv = p256.utils.randomPrivateKey();
  const providerPubCompressed = p256.getPublicKey(providerPriv, true);

  return { payload, providerEcdhPriv: providerPriv, providerEcdhPubCompressed: providerPubCompressed };
}

// ---------------------------------------------------------------------------
// Both sides — derive the same AES-256 key.
//
// Patient holds: serverPubCompressed (came back from POST /qr-sessions)
//                patientEcdhPriv (generated locally before posting)
// Provider holds: serverPubCompressed (decoded from QR payload.spk)
//                 providerEcdhPriv (generated after QR verify)
// Server holds:   serverEcdhPriv (the session-scoped privkey we made)
//                 patientPubCompressed (sent up in POST)
//
// The patient and server derive a key using ECDH(patient, server).
// The provider needs the same key — in this demo the server gives it to
// the provider over the same WebSocket after the provider has presented
// a valid session ID. In the production BLE path the patient transmits
// the key wrap (or the server brokers — see v2.0 doc).
// ---------------------------------------------------------------------------
export function deriveSharedKey(args: {
  myEcdhPriv: Uint8Array;          // 32 bytes
  peerEcdhPubCompressed: Uint8Array; // 33 bytes
  sessionId: string;
}): Uint8Array {
  // P-256 ECDH yields a 32-byte X coordinate as the shared secret
  const shared = p256.getSharedSecret(args.myEcdhPriv, args.peerEcdhPubCompressed, true).slice(1);
  const okm = hkdf(sha256, shared, new TextEncoder().encode(args.sessionId), new TextEncoder().encode("qurovita-v1"), 32);
  return okm;
}

// ---------------------------------------------------------------------------
// AES-256-GCM wrap/unwrap. Uses WebCrypto so the same code runs in Node
// (Node 20+ has globalThis.crypto.subtle) and the browser.
// ---------------------------------------------------------------------------
export async function encryptBundle(plaintext: Uint8Array, key: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis.crypto as Crypto).subtle;
  const cryptoKey = await subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = (globalThis.crypto as Crypto).getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, cryptoKey, plaintext));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

export async function decryptBundle(wire: Uint8Array, key: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis.crypto as Crypto).subtle;
  const cryptoKey = await subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = wire.subarray(0, 12);
  const ct = wire.subarray(12);
  const pt = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, cryptoKey, ct));
  return pt;
}
