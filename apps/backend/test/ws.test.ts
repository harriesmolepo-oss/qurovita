import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import WebSocket from "ws";
import type { AddressInfo } from "net";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { generateEcdhKeypair } from "@qurovita/crypto";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let request: ReturnType<typeof supertest>;
let wsBase: string;
let authToken: string;
let validPubKeyB64: string;

// Opens a WS, resolves with the socket + its first JSON message.
function connect(path: string): Promise<{ ws: WebSocket; first: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${path}`);
    ws.once("message", (data) => {
      try { resolve({ ws, first: JSON.parse(data.toString()) as Record<string, unknown> }); }
      catch (e) { reject(e); }
    });
    ws.once("error", reject);
  });
}

// Waits for a socket to emit "close".
function closed(ws: WebSocket): Promise<void> {
  return new Promise(resolve => ws.once("close", resolve));
}

// Decodes the userId from the shared authToken.
function userId(): string {
  return JSON.parse(Buffer.from(authToken.split(".")[1], "base64url").toString()).sub as string;
}

beforeAll(async () => {
  app = await buildApp({ silent: true });
  await app.listen({ port: 0 });
  wsBase = `ws://localhost:${(app.server.address() as AddressInfo).port}`;
  request = supertest(app.server);

  const kp = generateEcdhKeypair();
  validPubKeyB64 = Buffer.from(kp.pubCompressed).toString("base64");

  await request.post("/auth/otp-request").send({ phone: "+27860000001" }).expect(200);
  const res = await request
    .post("/auth/otp-verify").send({ phone: "+27860000001", otp: "000000" }).expect(200);
  authToken = (res.body as { token: string }).token;
});

afterAll(async () => { await app.close(); });

// Creates a fresh active session; returns its id.
async function newSession(): Promise<string> {
  const res = await request
    .post("/qr-sessions")
    .set("authorization", `Bearer ${authToken}`)
    .send({ patientPubKey: validPubKeyB64 })
    .expect(201);
  return (res.body as { sessionId: string }).sessionId;
}

describe("ws gate — rejected sessions", () => {
  it("expired session → error + close", async () => {
    const { pool: db } = await import("../src/db.js");
    const id = randomUUID();
    const kp = generateEcdhKeypair();
    await db.query(
      `insert into qr_sessions
         (id, patient_user_id, patient_pubkey, server_privkey, server_pubkey, expires_at)
       values ($1,$2,$3,$4,$5, now() - interval '1 minute')`,
      [id, userId(), Buffer.from(kp.pubCompressed), Buffer.alloc(32, 0xaa), Buffer.from(kp.pubCompressed)],
    );
    const { first, ws } = await connect(`/shared/ws/${id}?role=patient`);
    expect(first.type).toBe("error");
    expect(String(first.error)).toMatch(/expired/);
    await closed(ws);
  });

  it("revoked session → error + close", async () => {
    const { pool: db } = await import("../src/db.js");
    const id = randomUUID();
    const kp = generateEcdhKeypair();
    await db.query(
      `insert into qr_sessions
         (id, patient_user_id, patient_pubkey, server_privkey, server_pubkey,
          expires_at, revoked_at)
       values ($1,$2,$3,$4,$5, now() + interval '5 minutes', now())`,
      [id, userId(), Buffer.from(kp.pubCompressed), Buffer.alloc(32, 0xaa), Buffer.from(kp.pubCompressed)],
    );
    const { first, ws } = await connect(`/shared/ws/${id}?role=patient`);
    expect(first.type).toBe("error");
    expect(String(first.error)).toMatch(/revoked/);
    await closed(ws);
  });
});

describe("ws relay — active session", () => {
  it("patient and provider both get joined with correct role + peer count", async () => {
    const sid = await newSession();
    const { ws: patientWs, first: j1 } = await connect(`/shared/ws/${sid}?role=patient`);
    expect(j1).toMatchObject({ type: "joined", role: "patient", peers: 1 });

    const { ws: providerWs, first: j2 } = await connect(`/shared/ws/${sid}?role=provider`);
    expect(j2).toMatchObject({ type: "joined", role: "provider", peers: 2 });

    patientWs.close();
    providerWs.close();
    await Promise.all([closed(patientWs), closed(providerWs)]);
  });

  it("binary payload relayed verbatim from patient to provider", async () => {
    const sid = await newSession();
    const { ws: patientWs } = await connect(`/shared/ws/${sid}?role=patient`);
    const { ws: providerWs } = await connect(`/shared/ws/${sid}?role=provider`);

    const payload = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0xde, 0xad]);
    const received = await new Promise<Buffer>((resolve, reject) => {
      providerWs.once("message", d => resolve(d as Buffer));
      providerWs.once("error", reject);
      patientWs.send(payload);
    });

    expect(Buffer.compare(received, payload)).toBe(0);
    patientWs.close();
    providerWs.close();
    await Promise.all([closed(patientWs), closed(providerWs)]);
  });

  it("bundle_transferred closes all room sockets", async () => {
    const sid = await newSession();
    const { ws: patientWs } = await connect(`/shared/ws/${sid}?role=patient`);
    const { ws: providerWs } = await connect(`/shared/ws/${sid}?role=provider`);

    await new Promise<void>((resolve) => {
      let n = 0;
      const done = () => { if (++n === 2) resolve(); };
      patientWs.once("close", done);
      providerWs.once("close", done);
      patientWs.send(JSON.stringify({ type: "bundle_transferred", bytes: 512 }));
    });
  });

  it("late joiner after bundle_transferred finds no peer (peers: 1)", async () => {
    const sid = await newSession();
    const { ws: patientWs } = await connect(`/shared/ws/${sid}?role=patient`);
    const { ws: providerWs } = await connect(`/shared/ws/${sid}?role=provider`);

    await new Promise<void>((resolve) => {
      let n = 0;
      const done = () => { if (++n === 2) resolve(); };
      patientWs.once("close", done);
      providerWs.once("close", done);
      patientWs.send(JSON.stringify({ type: "bundle_transferred", bytes: 512 }));
    });

    // Session is still valid (not expired, not revoked) — late joiner can connect.
    const { ws: lateWs, first } = await connect(`/shared/ws/${sid}?role=provider`);
    expect(first).toMatchObject({ type: "joined", peers: 1 });
    lateWs.close();
    await closed(lateWs);
  });

  it("close cleanup: peer departure does not orphan remaining peers", async () => {
    const sid = await newSession();
    const { ws: patientWs } = await connect(`/shared/ws/${sid}?role=patient`);
    const { ws: providerWs } = await connect(`/shared/ws/${sid}?role=provider`);

    // Patient leaves.
    patientWs.close();
    await closed(patientWs);
    // Drain the server-side close handler before the next connect.
    await new Promise(r => setImmediate(r));

    // Second patient joins the room that still holds the provider.
    const { ws: patient2Ws } = await connect(`/shared/ws/${sid}?role=patient`);

    const payload = Buffer.from([0xf0, 0x0d]);
    const relayed = await new Promise<Buffer>((resolve, reject) => {
      providerWs.once("message", d => resolve(d as Buffer));
      providerWs.once("error", reject);
      patient2Ws.send(payload);
    });

    expect(Buffer.compare(relayed, payload)).toBe(0);
    providerWs.close();
    patient2Ws.close();
    await Promise.all([closed(providerWs), closed(patient2Ws)]);
  });
});
