// apps/backend/src/kms.ts
//
// Provides the server ECDSA P-256 signing key.
//
// PRODUCTION (NODE_ENV=production):
//   AWS KMS asymmetric key, type ECC_NIST_P256, usage SIGN_VERIFY.
//   The private key NEVER leaves KMS.
//   Required env vars: AWS_KMS_KEY_ID, AWS_REGION (defaults to af-south-1).
//
// DEVELOPMENT (any other NODE_ENV):
//   .keys/ file cache — generated on first run, persisted locally.
//   No AWS account required.
//
// Usage:
//   const { pubHex, signerFn } = await getSigningState();
//   // pubHex  → publish via GET /keys/ecdsa
//   // signerFn → pass to createSessionAsync(...)

import { createPublicKey } from "node:crypto";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { loadOrCreateSigningKey } from "./crypto/keys.js";

export interface SigningState {
  /** 33-byte compressed P-256 public key as lowercase hex */
  pubHex: string;
  /** Async signer: receives raw CBOR message, returns 64-byte compact r||s signature */
  signerFn: (msg: Uint8Array) => Promise<Uint8Array>;
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
  return {
    pubHex: Buffer.from(key.pub).toString("hex"),
    signerFn: async (msg: Uint8Array) =>
      p256.sign(sha256(msg), key.priv).toCompactRawBytes(),
  };
}

// ---------------------------------------------------------------------------
// Production path — AWS KMS
// ---------------------------------------------------------------------------
async function initFromKMS(): Promise<SigningState> {
  const keyId = process.env.AWS_KMS_KEY_ID;
  if (!keyId) throw new Error("AWS_KMS_KEY_ID env var is required in production");

  const region = process.env.AWS_REGION ?? "af-south-1";

  // Lazy-import the AWS SDK so it is never loaded in dev
  const { KMSClient, GetPublicKeyCommand, SignCommand } =
    await import("@aws-sdk/client-kms");

  const client = new KMSClient({ region });

  // Fetch the public key once; it changes only on key rotation
  const pubRes = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!pubRes.PublicKey) throw new Error("KMS GetPublicKey returned empty");

  const pubCompressed = spkiDerToCompressed(Buffer.from(pubRes.PublicKey));

  const signerFn = async (msg: Uint8Array): Promise<Uint8Array> => {
    // Pre-hash with SHA-256 and pass the digest to KMS
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
    // KMS returns DER-encoded ECDSA signature; convert to 64-byte compact r||s
    return p256.Signature.fromDER(res.Signature as Uint8Array).toCompactRawBytes();
  };

  return { pubHex: Buffer.from(pubCompressed).toString("hex"), signerFn };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a 33-byte compressed P-256 public key from a DER-encoded SPKI blob.
 * KMS GetPublicKey returns SPKI DER for asymmetric EC keys.
 */
function spkiDerToCompressed(der: Buffer): Uint8Array {
  // Use Node's built-in crypto to parse the SPKI blob (robust against DER variants)
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
