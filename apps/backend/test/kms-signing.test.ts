import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type FastifyInstance } from "fastify";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ rateLimitMax: 100, silent: true });
  await app.ready();
});

afterAll(async () => { await app.close(); });

describe("kms signerFn", () => {
  it("returns a 64-byte compact r‖s signature", async () => {
    const msg = Buffer.from("hello-qurovita");
    const sig = await app.kms.signerFn(msg);
    expect(sig).toHaveLength(64);
  });

  it("signature verifies against the correct message", async () => {
    const msg = Buffer.from("hello-qurovita");
    const sig = await app.kms.signerFn(msg);
    // signerFn applies SHA-256 internally; hash manually here for p256.verify
    expect(p256.verify(sig, sha256(msg), app.kms.pubHex)).toBe(true);
  });

  it("signature does NOT verify against a different message", async () => {
    const msg = Buffer.from("hello-qurovita");
    const sig = await app.kms.signerFn(msg);
    const different = Buffer.from("tampered-message");
    expect(p256.verify(sig, sha256(different), app.kms.pubHex)).toBe(false);
  });
});
