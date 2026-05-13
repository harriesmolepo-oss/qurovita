// Browser-side crypto for the provider portal.
// Mirrors apps/backend/src/crypto/qr-session.ts — same CSIR-mandated algorithms.
// This will be replaced by an import from @qurovita/crypto in T0.4.

import { p256 } from "@noble/curves/p256";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { encode as cborEncode, decode as cborDecode } from "cbor-x";

export { cborDecode };

export function hex(buf: Uint8Array): string {
  return [...buf].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function unhex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function generateEcdhKeypair(): { priv: Uint8Array; pubCompressed: Uint8Array } {
  const priv = p256.utils.randomPrivateKey();
  const pubCompressed = p256.getPublicKey(priv, true);
  return { priv, pubCompressed };
}

export function deriveSharedKey(myPriv: Uint8Array, peerPubCompressed: Uint8Array, sessionId: string): Uint8Array {
  const shared = p256.getSharedSecret(myPriv, peerPubCompressed, true).slice(1);
  return hkdf(sha256, shared, new TextEncoder().encode(sessionId), new TextEncoder().encode("qurovita-v1"), 32);
}

export function verifyQr(qrBytes: Uint8Array, ecdsaVerifyPubCompressed: Uint8Array): Record<string, unknown> {
  const payload = cborDecode(qrBytes) as Record<string, unknown>;
  if (payload["v"] !== 1) throw new Error("Unsupported QR version");
  if (Math.floor(Date.now() / 1000) > (payload["exp"] as number)) throw new Error("QR session expired");
  const { sig, ...unsigned } = payload;
  const msg = cborEncode(unsigned);
  const msgHash = sha256(msg);
  const ok = p256.verify(sig as Uint8Array, msgHash, ecdsaVerifyPubCompressed);
  if (!ok) throw new Error("QR signature invalid — possible tampering");
  return payload;
}

// Copy to a fresh ArrayBuffer — WebCrypto rejects SharedArrayBuffer-backed views in strict TS
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

export async function decryptBundle(wire: Uint8Array, key: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const ck = await crypto.subtle.importKey("raw", toArrayBuffer(key), { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = wire.subarray(0, 12);
  const ct = wire.subarray(12);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) },
    ck,
    toArrayBuffer(ct),
  ));
}
