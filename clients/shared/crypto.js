// clients/shared/crypto.js
// Browser-side QR session crypto. Same algorithms as backend/src/crypto/qr-session.ts.
// Loaded via <script type="module"> in both patient and provider clients.

import { p256 } from "/shared/vendor/noble-curves-p256.js";
import { hkdf } from "/shared/vendor/noble-hashes-hkdf.js";
import { sha256 } from "/shared/vendor/noble-hashes-sha256.js";
import { encode as cborEncode, decode as cborDecode } from "/shared/vendor/cbor-x.js";

export { p256, hkdf, sha256, cborEncode, cborDecode };

export function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function unhex(s) {
  if (s.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function generateEcdhKeypair() {
  const priv = p256.utils.randomPrivateKey();
  const pubCompressed = p256.getPublicKey(priv, true);
  return { priv, pubCompressed };
}

export function deriveSharedKey(myPriv, peerPubCompressed, sessionId) {
  // P-256 ECDH yields a 33-byte compressed point; strip the prefix byte
  const shared = p256.getSharedSecret(myPriv, peerPubCompressed, true).slice(1);
  return hkdf(sha256, shared, new TextEncoder().encode(sessionId), new TextEncoder().encode("qurovita-v1"), 32);
}

export function verifyQr(qrBytes, ecdsaVerifyPubCompressed) {
  const payload = cborDecode(qrBytes);
  if (payload.v !== 1) throw new Error("Unsupported QR version");
  if (Math.floor(Date.now() / 1000) > payload.exp) throw new Error("QR session expired");
  const { sig, ...unsigned } = payload;
  const msg = cborEncode(unsigned);
  const msgHash = sha256(msg);
  const ok = p256.verify(sig, msgHash, ecdsaVerifyPubCompressed);
  if (!ok) throw new Error("QR signature invalid — possible tampering");
  return payload;
}

export async function encryptBundle(plaintext, key, aad) {
  const ck = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, ck, plaintext));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0); out.set(ct, iv.length);
  return out;
}

export async function decryptBundle(wire, key, aad) {
  const ck = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = wire.subarray(0, 12);
  const ct = wire.subarray(12);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, ck, ct));
  return pt;
}
