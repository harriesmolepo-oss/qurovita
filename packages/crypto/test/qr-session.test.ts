import { describe, it, expect } from "vitest";
import { p256 } from "@noble/curves/p256";
import {
  createSession,
  verifyQrAndDeriveProviderKey,
  deriveSharedKey,
  encryptBundle,
  decryptBundle,
  hex,
} from "../src/index.js";

// Fixed server ECDSA signing keypair for tests — do NOT use in production.
const signingPriv = p256.utils.randomPrivateKey();
const signingPub = p256.getPublicKey(signingPriv, true);

const DUMMY_URL = "ws://localhost:3000";

describe("createSession / verifyQrAndDeriveProviderKey", () => {
  it("round-trip: create, verify, ECDH exchange, encrypt/decrypt", async () => {
    const { qrBytes, serverEcdhPriv } = createSession({
      sessionId: "00000000-0000-0000-0000-000000000001",
      patientPubCompressed: p256.getPublicKey(p256.utils.randomPrivateKey(), true),
      websocketUrl: DUMMY_URL,
      ecdsaSigningPrivKey: signingPriv,
    });

    // Provider verifies QR and generates its ECDH keypair.
    const { payload, providerEcdhPriv, providerEcdhPubCompressed } =
      verifyQrAndDeriveProviderKey({ qrBytes, ecdsaVerifyPubCompressed: signingPub });

    expect(payload.v).toBe(1);
    expect(payload.sid).toBe("00000000-0000-0000-0000-000000000001");

    // Both sides derive the same AES-256 session key.
    const serverKey = deriveSharedKey(serverEcdhPriv, providerEcdhPubCompressed, payload.sid);
    const providerKey = deriveSharedKey(providerEcdhPriv, payload.spk, payload.sid);

    expect(hex(serverKey)).toBe(hex(providerKey));

    // Encrypt on one side, decrypt on the other.
    const plaintext = new TextEncoder().encode("Hello QuroVita");
    const aad = new TextEncoder().encode(payload.sid);
    const ciphertext = await encryptBundle(plaintext, serverKey, aad);
    const recovered = await decryptBundle(ciphertext, providerKey, aad);

    expect(new TextDecoder().decode(recovered)).toBe("Hello QuroVita");
  });

  it("tamper rejection: modifying a byte in the QR signature fails verification", () => {
    const { qrBytes } = createSession({
      sessionId: "00000000-0000-0000-0000-000000000002",
      patientPubCompressed: p256.getPublicKey(p256.utils.randomPrivateKey(), true),
      websocketUrl: DUMMY_URL,
      ecdsaSigningPrivKey: signingPriv,
    });

    // Flip the last byte of the raw payload.
    const tampered = new Uint8Array(qrBytes);
    tampered[tampered.length - 1] ^= 0xff;

    expect(() =>
      verifyQrAndDeriveProviderKey({ qrBytes: tampered, ecdsaVerifyPubCompressed: signingPub })
    ).toThrow();
  });

  it("expired session rejection: TTL in the past throws on verify", () => {
    const { qrBytes } = createSession({
      sessionId: "00000000-0000-0000-0000-000000000003",
      patientPubCompressed: p256.getPublicKey(p256.utils.randomPrivateKey(), true),
      websocketUrl: DUMMY_URL,
      ecdsaSigningPrivKey: signingPriv,
      ttlSeconds: -60, // already expired
    });

    expect(() =>
      verifyQrAndDeriveProviderKey({ qrBytes, ecdsaVerifyPubCompressed: signingPub })
    ).toThrow(/expired/i);
  });

  it("QR payload size guard: URL long enough to bust 2900-byte cap throws at createSession", () => {
    const longUrl = "ws://localhost:3000/" + "x".repeat(3000);

    expect(() =>
      createSession({
        sessionId: "00000000-0000-0000-0000-000000000004",
        patientPubCompressed: p256.getPublicKey(p256.utils.randomPrivateKey(), true),
        websocketUrl: longUrl,
        ecdsaSigningPrivKey: signingPriv,
      })
    ).toThrow(/2900/);
  });
});
