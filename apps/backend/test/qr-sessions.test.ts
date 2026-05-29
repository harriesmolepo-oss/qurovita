import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import { randomUUID } from "node:crypto";
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
  let pendingId: string;
  let claimedId: string;
  let revokedId: string;

  beforeAll(async () => {
    const { pool: db } = await import("../src/db.js");
    // Decode the shared authToken to obtain the patient's users.id.
    // JWT payload is base64url; sub == users.id (UUID).
    const userId = JSON.parse(
      Buffer.from(authToken.split(".")[1], "base64url").toString(),
    ).sub as string;
    const kp = generateEcdhKeypair();
    const stubPub = Buffer.from(kp.pubCompressed);
    const stubPriv = Buffer.alloc(32, 0xaa);

    // pending — real API so the full insertion path is exercised
    const res = await request
      .post("/qr-sessions")
      .set("authorization", `Bearer ${authToken}`)
      .send({ patientPubKey: stubPub.toString("base64") });
    pendingId = (res.body as { sessionId: string }).sessionId;

    // claimed — INSERT directly; expires_at in future, claimed_at set
    claimedId = randomUUID();
    await db.query(
      `insert into qr_sessions
         (id, patient_user_id, patient_pubkey, server_privkey, server_pubkey,
          expires_at, claimed_at)
       values ($1,$2,$3,$4,$5, now() + interval '5 minutes', now())`,
      [claimedId, userId, stubPub, stubPriv, stubPub],
    );

    // revoked — INSERT directly; expires_at in future, revoked_at set
    revokedId = randomUUID();
    await db.query(
      `insert into qr_sessions
         (id, patient_user_id, patient_pubkey, server_privkey, server_pubkey,
          expires_at, revoked_at)
       values ($1,$2,$3,$4,$5, now() + interval '5 minutes', now())`,
      [revokedId, userId, stubPub, stubPriv, stubPub],
    );
  });

  it("200 { active:true, expiresAt, claimed:false } for an active session", async () => {
    const res = await request
      .get(`/shared/qr-sessions/${pendingId}/status`)
      // no Authorization header — /shared/ is auth-exempt
      .expect(200);
    const body = res.body as { active: boolean; expiresAt: string; claimed: boolean };
    expect(body.active).toBe(true);
    expect(body.claimed).toBe(false);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("200 { active:false, claimed:true } after session is claimed", async () => {
    const res = await request
      .get(`/shared/qr-sessions/${claimedId}/status`)
      .expect(200);
    const body = res.body as { active: boolean; claimed: boolean };
    expect(body.active).toBe(false);
    expect(body.claimed).toBe(true);
  });

  it("200 { active:false, claimed:false } after session is revoked", async () => {
    const res = await request
      .get(`/shared/qr-sessions/${revokedId}/status`)
      .expect(200);
    const body = res.body as { active: boolean; claimed: boolean };
    expect(body.active).toBe(false);
    expect(body.claimed).toBe(false);
  });

  it("400 for malformed UUID", async () => {
    await request.get("/shared/qr-sessions/not-a-uuid/status").expect(400);
  });

  it("404 for unknown session id", async () => {
    await request
      .get("/shared/qr-sessions/00000000-0000-0000-0000-000000000000/status")
      .expect(404);
  });
});

describe("POST /qr-sessions/:id/revoke", () => {
  it("204 on first revoke", async () => {
    const freshApp = await buildApp({ rateLimitMax: 60, silent: true });
    await freshApp.ready();
    const req = supertest(freshApp.server);
    await req.post("/auth/otp-request").send({ phone: "+27830000001" });
    const { body: { token } } = await req
      .post("/auth/otp-verify").send({ phone: "+27830000001", otp: "000000" });
    const kp = generateEcdhKeypair();
    const { body: { sessionId } } = await req
      .post("/qr-sessions").set("authorization", `Bearer ${token}`)
      .send({ patientPubKey: Buffer.from(kp.pubCompressed).toString("base64") });
    await req
      .post(`/qr-sessions/${sessionId}/revoke`)
      .set("authorization", `Bearer ${token}`)
      .expect(204);
    await freshApp.close();
  });

  it("204 on second revoke (idempotent)", async () => {
    const freshApp = await buildApp({ rateLimitMax: 60, silent: true });
    await freshApp.ready();
    const req = supertest(freshApp.server);
    await req.post("/auth/otp-request").send({ phone: "+27830000002" });
    const { body: { token } } = await req
      .post("/auth/otp-verify").send({ phone: "+27830000002", otp: "000000" });
    const kp = generateEcdhKeypair();
    const { body: { sessionId } } = await req
      .post("/qr-sessions").set("authorization", `Bearer ${token}`)
      .send({ patientPubKey: Buffer.from(kp.pubCompressed).toString("base64") });
    await req
      .post(`/qr-sessions/${sessionId}/revoke`)
      .set("authorization", `Bearer ${token}`)
      .expect(204);
    // second call: COALESCE keeps existing revoked_at — still 204
    await req
      .post(`/qr-sessions/${sessionId}/revoke`)
      .set("authorization", `Bearer ${token}`)
      .expect(204);
    await freshApp.close();
  });

  it("403 when JWT belongs to a different patient", async () => {
    // phone_e164 is UNIQUE: two distinct phones → two distinct users.id rows.
    // token1.sub != token2.sub is structurally guaranteed — no collision possible.
    const freshApp = await buildApp({ rateLimitMax: 60, silent: true });
    await freshApp.ready();
    const req = supertest(freshApp.server);

    await req.post("/auth/otp-request").send({ phone: "+27831000001" });
    const { body: { token: token1 } } = await req
      .post("/auth/otp-verify").send({ phone: "+27831000001", otp: "000000" });

    await req.post("/auth/otp-request").send({ phone: "+27831000002" });
    const { body: { token: token2 } } = await req
      .post("/auth/otp-verify").send({ phone: "+27831000002", otp: "000000" });

    const kp = generateEcdhKeypair();
    const { body: { sessionId } } = await req
      .post("/qr-sessions").set("authorization", `Bearer ${token1}`)
      .send({ patientPubKey: Buffer.from(kp.pubCompressed).toString("base64") });

    // token2.sub resolves to a different users.id — must be 403, not 404
    await req
      .post(`/qr-sessions/${sessionId}/revoke`)
      .set("authorization", `Bearer ${token2}`)
      .expect(403);

    await freshApp.close();
  });

  it("400 for malformed UUID", async () => {
    await request
      .post("/qr-sessions/not-a-uuid/revoke")
      .set("authorization", `Bearer ${authToken}`)
      .expect(400);
  });
});

describe("POST /shared/qr-sessions/:id/claim", () => {
  it("204 on first claim", async () => {
    const freshApp = await buildApp({ rateLimitMax: 60, silent: true });
    await freshApp.ready();
    const req = supertest(freshApp.server);
    await req.post("/auth/otp-request").send({ phone: "+27840000001" });
    const { body: { token } } = await req
      .post("/auth/otp-verify").send({ phone: "+27840000001", otp: "000000" });
    const kp = generateEcdhKeypair();
    const { body: { sessionId } } = await req
      .post("/qr-sessions").set("authorization", `Bearer ${token}`)
      .send({ patientPubKey: Buffer.from(kp.pubCompressed).toString("base64") });
    await req
      .post(`/shared/qr-sessions/${sessionId}/claim`)
      // no Authorization header — /shared/ is auth-exempt; omitting proves it
      .expect(204);
    await freshApp.close();
  });

  it("409 on second claim (not idempotent)", async () => {
    const freshApp = await buildApp({ rateLimitMax: 60, silent: true });
    await freshApp.ready();
    const req = supertest(freshApp.server);
    await req.post("/auth/otp-request").send({ phone: "+27840000002" });
    const { body: { token } } = await req
      .post("/auth/otp-verify").send({ phone: "+27840000002", otp: "000000" });
    const kp = generateEcdhKeypair();
    const { body: { sessionId } } = await req
      .post("/qr-sessions").set("authorization", `Bearer ${token}`)
      .send({ patientPubKey: Buffer.from(kp.pubCompressed).toString("base64") });
    await req.post(`/shared/qr-sessions/${sessionId}/claim`).expect(204);
    await req.post(`/shared/qr-sessions/${sessionId}/claim`).expect(409);
    await freshApp.close();
  });

  it("409 for a revoked session", async () => {
    const freshApp = await buildApp({ rateLimitMax: 60, silent: true });
    await freshApp.ready();
    const req = supertest(freshApp.server);
    await req.post("/auth/otp-request").send({ phone: "+27840000003" });
    const { body: { token } } = await req
      .post("/auth/otp-verify").send({ phone: "+27840000003", otp: "000000" });
    const kp = generateEcdhKeypair();
    const { body: { sessionId } } = await req
      .post("/qr-sessions").set("authorization", `Bearer ${token}`)
      .send({ patientPubKey: Buffer.from(kp.pubCompressed).toString("base64") });
    await req
      .post(`/qr-sessions/${sessionId}/revoke`)
      .set("authorization", `Bearer ${token}`)
      .expect(204);
    await req.post(`/shared/qr-sessions/${sessionId}/claim`).expect(409);
    await freshApp.close();
  });

  it("410 for an expired session", async () => {
    // Cannot UPDATE expires_at — column-scoped grant allows only revoked_at, claimed_at.
    // Must INSERT a pre-expired row instead.
    const freshApp = await buildApp({ rateLimitMax: 60, silent: true });
    await freshApp.ready();
    const req = supertest(freshApp.server);
    const { pool: db } = await import("../src/db.js");
    await req.post("/auth/otp-request").send({ phone: "+27840000004" });
    const { body: { token } } = await req
      .post("/auth/otp-verify").send({ phone: "+27840000004", otp: "000000" });
    const userId = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    ).sub as string;
    const kp = generateEcdhKeypair();
    const stubPub = Buffer.from(kp.pubCompressed);
    const expiredId = randomUUID();
    await db.query(
      `insert into qr_sessions
         (id, patient_user_id, patient_pubkey, server_privkey, server_pubkey, expires_at)
       values ($1,$2,$3,$4,$5, now() - interval '1 minute')`,
      [expiredId, userId, stubPub, Buffer.alloc(32, 0xaa), stubPub],
    );
    await req.post(`/shared/qr-sessions/${expiredId}/claim`).expect(410);
    await freshApp.close();
  });

  it("410 for an expired session that was also claimed (expired wins)", async () => {
    // Session is both expired (expires_at in the past) and claimed (claimed_at set).
    // The handler checks expires_at FIRST — expired(410) must win over claimed(409).
    const freshApp = await buildApp({ rateLimitMax: 60, silent: true });
    await freshApp.ready();
    const req = supertest(freshApp.server);
    const { pool: db } = await import("../src/db.js");
    await req.post("/auth/otp-request").send({ phone: "+27840000005" });
    const { body: { token } } = await req
      .post("/auth/otp-verify").send({ phone: "+27840000005", otp: "000000" });
    const userId = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    ).sub as string;
    const kp = generateEcdhKeypair();
    const stubPub = Buffer.from(kp.pubCompressed);
    const expiredClaimedId = randomUUID();
    await db.query(
      `insert into qr_sessions
         (id, patient_user_id, patient_pubkey, server_privkey, server_pubkey,
          expires_at, claimed_at)
       values ($1,$2,$3,$4,$5, now() - interval '1 minute', now() - interval '2 minutes')`,
      [expiredClaimedId, userId, stubPub, Buffer.alloc(32, 0xaa), stubPub],
    );
    // claimed_at IS NOT NULL (would be 409) but expires_at in the past (410) wins
    await req.post(`/shared/qr-sessions/${expiredClaimedId}/claim`).expect(410);
    await freshApp.close();
  });
});
