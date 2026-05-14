// apps/backend/src/kms.ts
//
// Provides the server ECDSA P-256 signing key + AES-256-GCM ECDH key wrapper.
//
// PRODUCTION (NODE_ENV=production):
//   Signing:  AWS KMS asymmetric key, type ECC_NIST_P256, usage SIGN_VERIFY.
//             Private key NEVER leaves KMS.
//             Required env vars: AWS_KMS_KEY_ID, AWS_REGION (defaults to af-south-1).
//   Wrapping: AWS KMS symmetric key, usage ENCRYPT_DECRYPT.
//             Required env var: AWS_KMS_WRAP_KEY_ID.
//
// DEVELOPMENT (any other NODE_ENV):
//   .keys/ file cache — generated on first run, persisted locally.
//   No AWS account required.
//   Wrapping key is derived from the ECDSA private key via HKDF (domain-separated).
//
// Usage:
//   const { pubHex, signerFn, wrapPrivkey, unwrapPrivkey } = await getSigningState();

import { createPublicKey, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import { loadOrCreateSigningKey } from "./crypto/keys.js";

export interface SigningState {
  /** 33-byte compressed P-256 public key as lowercase hex */
  pubHex: string;
  /** Async signer: receives raw CBOR message, returns 64-byte compact r||s signature */
  signerFn: (msg: Uint8Array) => Promise<Uint8Array>;
  /** Encrypt a 32-byte ECDH private key for DB storage (AES-256-GCM dev / KMS prod) */
  wrapPrivkey: (raw: Uint8Array) => Promise<Uint8Array>;
  /** Decrypt a previously wrapped ECDH private key */
  unwrapPrivkey: (wrapped: Uint8Array) => Promise<Uint8Array>;
}

let _state: SigningState | null = null;

/** Returns the signing state, initialising it once on first call. */
export async function getSigningState(): Promise<SigningState> {
  if (_state) return _state;
  _state =
    process.env.NODE_ENV === "production"
      ? await initFromKMS()
      : initFromFile();
  return _state;
}

// ---------------------------------------------------------------------------
// Dev path — .keys/ file cache
// ---------------------------------------------------------------------------
function initFromFile(): SigningState {
  const key = loadOrCreateSigningKey();
  // Derive a 32-byte AES wrapping key from the ECDSA private key.
  // The distinct info string domain-separates this from the signing key itself.
  const wrapKey = hkdf(
    sha256,
    key.priv,
    new Uint8Array(0),
    new TextEncoder().encode("qurovita-ecdh-wrap-v1"),
    32,
  );

  return {
    pubHex: Buffer.from(key.pub).toString("hex"),
    signerFn: async (msg: Uint8Array) =>
      p256.sign(sha256(msg), key.priv).toCompactRawBytes(),
    ...makeLocalWrapper(wrapKey),
  };
}

// ---------------------------------------------------------------------------
// Production path — AWS KMS
// ---------------------------------------------------------------------------
async function initFromKMS(): Promise<SigningState> {
  const keyId = process.env.AWS_KMS_KEY_ID;
  if (!keyId) throw new Error("AWS_KMS_KEY_ID env var is required in production");

  const wrapKeyId = process.env.AWS_KMS_WRAP_KEY_ID;
  if (!wrapKeyId) throw new Error("AWS_KMS_WRAP_KEY_ID env var is required in production");

  const region = process.env.AWS_REGION ?? "af-south-1";

  // Lazy-import the AWS SDK so it is never loaded in dev
  const { KMSClient, GetPublicKeyCommand, SignCommand, EncryptCommand, DecryptCommand } =
    await import("@aws-sdk/client-kms");

  const client = new KMSClient({ region });

  // Fetch the public key once; it changes only on key rotation
  const pubRes = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!pubRes.PublicKey) throw new Error("KMS GetPublicKey returned empty");
  const pubCompressed = spkiDerToCompressed(Buffer.from(pubRes.PublicKey));

  const signerFn = async (msg: Uint8Array): Promise<Uint8Array> => {
    const digest = sha256(msg);
    const res = await client.send(
      new SignCommand({
        KeyId: keyId,
        Message: digest,
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (!res.Signature) throw new Error("KMS Sign returned empty signature");
    return p256.Signature.fromDER(res.Signature as Uint8Array).toCompactRawBytes();
  };

  const wrapPrivkey = async (raw: Uint8Array): Promise<Uint8Array> => {
    const res = await client.send(new EncryptCommand({ KeyId: wrapKeyId, Plaintext: raw }));
    if (!res.CiphertextBlob) throw new Error("KMS Encrypt returned empty");
    return new Uint8Array(res.CiphertextBlob);
  };

  const unwrapPrivkey = async (wrapped: Uint8Array): Promise<Uint8Array> => {
    const res = await client.send(new DecryptCommand({ KeyId: wrapKeyId, CiphertextBlob: wrapped }));
    if (!res.Plaintext) throw new Error("KMS Decrypt returned empty");
    return new Uint8Array(res.Plaintext);
  };

  return { pubHex: Buffer.from(pubCompressed).toString("hex"), signerFn, wrapPrivkey, unwrapPrivkey };
}

// ---------------------------------------------------------------------------
// AES-256-GCM local key wrapper (dev only)
// Wire format: iv(12) || ciphertext(32) || tag(16) = 60 bytes total
// ---------------------------------------------------------------------------
function makeLocalWrapper(wrapKey: Uint8Array): Pick<SigningState, "wrapPrivkey" | "unwrapPrivkey"> {
  return {
    wrapPrivkey: async (raw: Uint8Array) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", wrapKey, iv);
      const ct = Buffer.concat([cipher.update(raw), cipher.final()]);
      const tag = cipher.getAuthTag();
      return new Uint8Array(Buffer.concat([iv, ct, tag]));
    },
    unwrapPrivkey: async (wrapped: Uint8Array) => {
      const iv = wrapped.subarray(0, 12);
      const ct = wrapped.subarray(12, 44);
      const tag = wrapped.subarray(44, 60);
      const decipher = createDecipheriv("aes-256-gcm", wrapKey, iv);
      decipher.setAuthTag(Buffer.from(tag));
      return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a 33-byte compressed P-256 public key from a DER-encoded SPKI blob.
 * KMS GetPublicKey returns SPKI DER for asymmetric EC keys.
 */
function spkiDerToCompressed(der: Buffer): Uint8Array {
  const keyObj = createPublicKey({ key: der, format: "der", type: "spki" });
  const jwk = keyObj.export({ format: "jwk" }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new Error("Failed to extract EC coordinates from KMS public key");

  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(x, 1);
  uncompressed.set(y, 33);
  return p256.ProjectivePoint.fromHex(uncompressed).toRawBytes(true);
}
