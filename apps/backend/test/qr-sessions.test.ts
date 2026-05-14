import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import { type FastifyInstance } from "fastify";
import { generateEcdhKeypair, hex } from "@qurovita/crypto";
import { buildApp } from "../src/app.js";

// Shared app — high rate limit so normal tests never exhaust the counter
let app: FastifyInstance;
let request: ReturnType<typeof supertest>;
let authToken: string;
let validPubHex: string;

beforeAll(async () => {
  app = await buildApp({ rateLimitMax: 100, silent: true });
  await app.ready();
  request = supertest(app.server);

  const kp = generateEcdhKeypair();
  validPubHex = hex(kp.pubCompressed);

  await request
    .post("/auth/otp-request")
    .send({ phone: "+27821234567" })
    .expect(200);

  const res = await request
    .post("/auth/otp-verify")
    .send({ phone: "+27821234567", otp: "000000" })
    .expect(200);

  authToken = (res.body as { token: string }).token;
});

afterAll(async () => {
  await app.close();
});

// ── POST /qr-sessions ────────────────────────────────────────────────────────

describe("POST /qr-sessions", () => {
  it("happy path — returns session_id, server_pub, ws url, expires_at", async () => {
    const res = await request
      .post("/qr-sessions")
      .set("authorization", `Bearer ${authToken}`)
      .send({ patient_pub_compressed_hex: validPubHex })
      .expect(200);

    const body = res.body as {
      session_id: string;
      qr_bytes_hex: string;
      server_pub_compressed_hex: string;
      expires_at: string;
      websocket_url: string;
    };

    expect(body.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.server_pub_compressed_hex).toHaveLength(66);
    expect(body.websocket_url).toMatch(/^ws:\/\//);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects missing patient pubkey", async () => {
    const res = await request
      .post("/qr-sessions")
      .set("authorization", `Bearer ${authToken}`)
      .send({})
      .expect(400);

    expect((res.body as { error: string }).error).toMatch(/patient_pub_compressed_hex required/i);
  });

  it("rejects malformed (wrong-length) pubkey", async () => {
    const res = await request
      .post("/qr-sessions")
      .set("authorization", `Bearer ${authToken}`)
      .send({ patient_pub_compressed_hex: "deadbeef" }) // too short
      .expect(400);

    expect((res.body as { error: string }).error).toMatch(/33-byte/i);
  });

  it("rejects unauthenticated requests with 401", async () => {
    await request
      .post("/qr-sessions")
      .send({ patient_pub_compressed_hex: validPubHex })
      .expect(401);
  });

  it("rate-limits after exceeding max (3 per minute in test config)", async () => {
    // Isolated fresh app so the counter starts at zero
    const rateApp = await buildApp({ rateLimitMax: 3, silent: true });
    await rateApp.ready();
    const rateReq = supertest(rateApp.server);

    // Auth uses slots 1 + 2
    await rateReq.post("/auth/otp-request").send({ phone: "+27829111111" });
    const { body: { token } } = await rateReq
      .post("/auth/otp-verify")
      .send({ phone: "+27829111111", otp: "000000" });

    // Slot 3: one valid session creation
    const kp = generateEcdhKeypair();
    await rateReq
      .post("/qr-sessions")
      .set("authorization", `Bearer ${token}`)
      .send({ patient_pub_compressed_hex: hex(kp.pubCompressed) });

    // 4th request must be rate-limited — status code is the contract
    await rateReq
      .post("/qr-sessions")
      .set("authorization", `Bearer ${token}`)
      .send({ patient_pub_compressed_hex: validPubHex })
      .expect(429);

    await rateApp.close();
  });
});

// ── GET /qr-sessions/:id/payload ─────────────────────────────────────────────

describe("GET /qr-sessions/:id/payload", () => {
  let sessionId: string;

  beforeAll(async () => {
    // Create a fresh session for these tests (fresh app → fresh rate limit)
    const freshApp = await buildApp({ rateLimitMax: 60, silent: true });
    await freshApp.ready();
    const req = supertest(freshApp.server);

    await req.post("/auth/otp-request").send({ phone: "+27829999999" });
    const authRes = await req.post("/auth/otp-verify").send({ phone: "+27829999999", otp: "000000" });
    const token = (authRes.body as { token: string }).token;

    const kp = generateEcdhKeypair();
    const sessRes = await req
      .post("/qr-sessions")
      .set("authorization", `Bearer ${token}`)
      .send({ patient_pub_compressed_hex: hex(kp.pubCompressed) });

    sessionId = (sessRes.body as { session_id: string }).session_id;
    await freshApp.close();
  });

  it("returns session details for a pending session", async () => {
    const res = await request
      .get(`/qr-sessions/${sessionId}/payload`)
      .set("authorization", `Bearer ${authToken}`)
      .expect(200);

    const body = res.body as {
      session_id: string;
      server_pub_compressed_hex: string;
      expires_at: string;
    };
    expect(body.session_id).toBe(sessionId);
    expect(body.server_pub_compressed_hex).toHaveLength(66);
  });

  it("returns 400 for invalid UUID format", async () => {
    await request
      .get("/qr-sessions/not-a-uuid/payload")
      .set("authorization", `Bearer ${authToken}`)
      .expect(400);
  });

  it("returns 404 for unknown session id", async () => {
    await request
      .get("/qr-sessions/00000000-0000-0000-0000-000000000000/payload")
      .set("authorization", `Bearer ${authToken}`)
      .expect(404);
  });

  it("returns 410 for a consumed session", async () => {
    const freshApp = await buildApp({ rateLimitMax: 60, silent: true });
    await freshApp.ready();
    const req = supertest(freshApp.server);

    await req.post("/auth/otp-request").send({ phone: "+27820000001" });
    const { body: { token } } = await req.post("/auth/otp-verify").send({ phone: "+27820000001", otp: "000000" });

    const kp = generateEcdhKeypair();
    const { body: { session_id } } = await req
      .post("/qr-sessions")
      .set("authorization", `Bearer ${token}`)
      .send({ patient_pub_compressed_hex: hex(kp.pubCompressed) });

    // Simulate consumed: set status='consumed' via DB (import pool directly)
    const { pool } = await import("../src/db.js");
    await pool.query(`update qr_sessions set status='consumed' where id=$1`, [session_id]);

    const res = await req
      .get(`/qr-sessions/${session_id}/payload`)
      .set("authorization", `Bearer ${token}`)
      .expect(410);

    expect((res.body as { error: string }).error).toMatch(/consumed/);
    await freshApp.close();
  });
});

// ── POST /qr-sessions/:id/revoke ─────────────────────────────────────────────

describe("POST /qr-sessions/:id/revoke", () => {
  it("revokes a pending session and returns { revoked: true }", async () => {
    const freshApp = await buildApp({ rateLimitMax: 60, silent: true });
    await freshApp.ready();
    const req = supertest(freshApp.server);

    await req.post("/auth/otp-request").send({ phone: "+27820000002" });
    const { body: { token } } = await req.post("/auth/otp-verify").send({ phone: "+27820000002", otp: "000000" });

    const kp = generateEcdhKeypair();
    const { body: { session_id } } = await req
      .post("/qr-sessions")
      .set("authorization", `Bearer ${token}`)
      .send({ patient_pub_compressed_hex: hex(kp.pubCompressed) });

    const res = await req
      .post(`/qr-sessions/${session_id}/revoke`)
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    expect((res.body as { revoked: boolean }).revoked).toBe(true);

    // Subsequent payload fetch should return 410
    await req
      .get(`/qr-sessions/${session_id}/payload`)
      .set("authorization", `Bearer ${token}`)
      .expect(410);

    await freshApp.close();
  });

  it("returns 404 when revoking an already-revoked session", async () => {
    const freshApp = await buildApp({ rateLimitMax: 60, silent: true });
    await freshApp.ready();
    const req = supertest(freshApp.server);

    await req.post("/auth/otp-request").send({ phone: "+27820000003" });
    const { body: { token } } = await req.post("/auth/otp-verify").send({ phone: "+27820000003", otp: "000000" });

    const kp = generateEcdhKeypair();
    const { body: { session_id } } = await req
      .post("/qr-sessions")
      .set("authorization", `Bearer ${token}`)
      .send({ patient_pub_compressed_hex: hex(kp.pubCompressed) });

    await req.post(`/qr-sessions/${session_id}/revoke`).set("authorization", `Bearer ${token}`);

    await req
      .post(`/qr-sessions/${session_id}/revoke`)
      .set("authorization", `Bearer ${token}`)
      .expect(404);

    await freshApp.close();
  });

  it("returns 400 for invalid UUID format", async () => {
    await request
      .post("/qr-sessions/bad-id/revoke")
      .set("authorization", `Bearer ${authToken}`)
      .expect(400);
  });
});
