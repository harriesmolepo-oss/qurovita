import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import { type FastifyInstance } from "fastify";
import { generateEcdhKeypair } from "@qurovita/crypto";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let request: ReturnType<typeof supertest>;
let authToken: string;
let validPubKeyB64: string;

beforeAll(async () => {
  app = await buildApp({ rateLimitMax: 100, silent: true });
  await app.ready();
  request = supertest(app.server);

  const kp = generateEcdhKeypair();
  validPubKeyB64 = Buffer.from(kp.pubCompressed).toString("base64");

  await request.post("/auth/otp-request").send({ phone: "+27821234567" }).expect(200);
  const res = await request
    .post("/auth/otp-verify")
    .send({ phone: "+27821234567", otp: "000000" })
    .expect(200);
  authToken = (res.body as { token: string }).token;
});

afterAll(async () => { await app.close(); });

describe("POST /qr-sessions", () => {
  it("201 with sessionId, payload (base64 CBOR), signature, expiresAt", async () => {
    const res = await request
      .post("/qr-sessions")
      .set("authorization", `Bearer ${authToken}`)
      .send({ patientPubKey: validPubKeyB64 })
      .expect(201);
    const body = res.body as { sessionId: string; payload: string; signature: string; expiresAt: string };
    expect(body.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Buffer.from(body.payload, "base64").length).toBeGreaterThan(0);
    expect(Buffer.from(body.signature, "base64").length).toBe(64);
    expect(() => new Date(body.expiresAt)).not.toThrow();
  });

  it("expires_at − now is within 300 s ±2 s (TTL guard)", async () => {
    const before = Date.now();
    const res = await request
      .post("/qr-sessions")
      .set("authorization", `Bearer ${authToken}`)
      .send({ patientPubKey: validPubKeyB64 })
      .expect(201);
    const { expiresAt } = res.body as { expiresAt: string };
    const ttl = (new Date(expiresAt).getTime() - before) / 1000;
    expect(ttl).toBeGreaterThan(298);
    expect(ttl).toBeLessThan(302);
  });

  it("400 for missing patientPubKey", async () => {
    const res = await request
      .post("/qr-sessions")
      .set("authorization", `Bearer ${authToken}`)
      .send({})
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/patientPubKey required/i);
  });

  it("400 for wrong-length patientPubKey (not 33-byte compressed)", async () => {
    const shortKey = Buffer.alloc(4).toString("base64");
    const res = await request
      .post("/qr-sessions")
      .set("authorization", `Bearer ${authToken}`)
      .send({ patientPubKey: shortKey })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/33-byte/i);
  });

  it("400 for 33-byte key with wrong prefix (0x04)", async () => {
    const badKey = Buffer.alloc(33);
    badKey[0] = 0x04;
    badKey.fill(0xab, 1);
    const res = await request
      .post("/qr-sessions")
      .set("authorization", `Bearer ${authToken}`)
      .send({ patientPubKey: badKey.toString("base64") })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/compressed P-256/i);
  });

  it("401 for unauthenticated request", async () => {
    await request
      .post("/qr-sessions")
      .send({ patientPubKey: validPubKeyB64 })
      .expect(401);
  });

  it("429 when rate limit is exceeded", async () => {
    const rateApp = await buildApp({ rateLimitMax: 3, silent: true });
    await rateApp.ready();
    const rateReq = supertest(rateApp.server);

    await rateReq.post("/auth/otp-request").send({ phone: "+27829111111" });
    const { body: { token } } = await rateReq
      .post("/auth/otp-verify")
      .send({ phone: "+27829111111", otp: "000000" });

    await rateReq
      .post("/qr-sessions")
      .set("authorization", `Bearer ${token}`)
      .send({ patientPubKey: validPubKeyB64 });

    await rateReq
      .post("/qr-sessions")
      .set("authorization", `Bearer ${token}`)
      .send({ patientPubKey: validPubKeyB64 })
      .expect(429);

    await rateApp.close();
  });
});

describe("GET /shared/qr-sessions/:id/status", () => {
  it.todo("200 { active:true, expiresAt, claimed:false } for an active session");
  it.todo("200 { active:false, claimed:true } after session is claimed");
  it.todo("200 { active:false, claimed:false } after session is revoked");
  it.todo("400 for malformed UUID");
  it.todo("404 for unknown session id");
});

describe("POST /qr-sessions/:id/revoke", () => {
  it.todo("204 on first revoke");
  it.todo("204 on second revoke (idempotent)");
  it.todo("403 when JWT belongs to a different patient");
  it.todo("400 for malformed UUID");
});

describe("POST /shared/qr-sessions/:id/claim", () => {
  it.todo("204 on first claim");
  it.todo("409 on second claim (not idempotent)");
  it.todo("409 for a revoked session");
  it.todo("410 for an expired session");
  it.todo("410 for an expired session that was also claimed (expired wins)");
});
