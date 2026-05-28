import { describe, it, beforeAll, afterAll } from "vitest";
import { type FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ rateLimitMax: 100, silent: true });
  await app.ready();
});

afterAll(async () => { await app.close(); });

describe("POST /qr-sessions", () => {
  it.todo("201 with sessionId, payload (base64 CBOR), signature, expiresAt");
  it.todo("expires_at − now is within 300 s ±2 s (TTL guard)");
  it.todo("400 for missing patientPubKey");
  it.todo("400 for wrong-length patientPubKey (not 33-byte compressed)");
  it.todo("401 for unauthenticated request");
  it.todo("429 when rate limit is exceeded");
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
