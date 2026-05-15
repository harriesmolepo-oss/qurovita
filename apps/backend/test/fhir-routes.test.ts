// T2.3 acceptance criterion tests — must all pass before merging T2.3.
// Verifies: FHIR CRUD, cross-user 403 enforcement, breach_candidates insertion.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import { type FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db.js";

let app: FastifyInstance;
let request: ReturnType<typeof supertest>;

// Two independent users
let tokenA: string;
let userIdA: string;
let tokenB: string;
let userIdB: string;

beforeAll(async () => {
  app = await buildApp({ rateLimitMax: 100, silent: true });
  await app.ready();
  request = supertest(app.server);

  // Register + auth user A
  await request.post("/auth/otp-request").send({ phone: "+27830000001" });
  const resA = await request.post("/auth/otp-verify").send({ phone: "+27830000001", otp: "000000" });
  tokenA = (resA.body as { token: string }).token;
  userIdA = (app.jwt.verify(tokenA) as { sub: string }).sub;

  // Register + auth user B
  await request.post("/auth/otp-request").send({ phone: "+27830000002" });
  const resB = await request.post("/auth/otp-verify").send({ phone: "+27830000002", otp: "000000" });
  tokenB = (resB.body as { token: string }).token;
  userIdB = (app.jwt.verify(tokenB) as { sub: string }).sub;
});

afterAll(async () => {
  await app.close();
});

// ── POST /fhir/:type ─────────────────────────────────────────────────────────

describe("POST /fhir/:type", () => {
  it("creates a Patient resource and returns 201", async () => {
    const res = await request
      .post("/fhir/Patient")
      .set("authorization", `Bearer ${tokenA}`)
      .send({ resourceType: "Patient", name: [{ family: "Dlamini", given: ["Sipho"] }] })
      .expect(201);

    expect((res.body as { resourceType: string }).resourceType).toBe("Patient");
    expect((res.body as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns 400 for unsupported resource type", async () => {
    await request
      .post("/fhir/Practitioner")
      .set("authorization", `Bearer ${tokenA}`)
      .send({ resourceType: "Practitioner" })
      .expect(400);
  });

  it("returns 401 for unauthenticated request", async () => {
    await request
      .post("/fhir/Patient")
      .send({ resourceType: "Patient" })
      .expect(401);
  });
});

// ── GET /fhir/:type ───────────────────────────────────────────────────────────

describe("GET /fhir/:type", () => {
  it("returns a searchset Bundle of the patient's own resources", async () => {
    // Seed one Observation for user A
    await request
      .post("/fhir/Observation")
      .set("authorization", `Bearer ${tokenA}`)
      .send({ resourceType: "Observation", status: "final",
        code: { coding: [{ system: "http://loinc.org", code: "2339-0" }] } })
      .expect(201);

    const res = await request
      .get("/fhir/Observation")
      .set("authorization", `Bearer ${tokenA}`)
      .expect(200);

    const bundle = res.body as { resourceType: string; type: string; total: number };
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("searchset");
    expect(bundle.total).toBeGreaterThanOrEqual(1);
  });
});

// ── GET /fhir/:type/:id — cross-user breach check (T2.3 acceptance criterion) ─

describe("GET /fhir/:type/:id — cross-user breach check", () => {
  let patientIdOwnedByA: string;

  beforeAll(async () => {
    // User A creates a Patient resource
    const res = await request
      .post("/fhir/Patient")
      .set("authorization", `Bearer ${tokenA}`)
      .send({ resourceType: "Patient", name: [{ family: "Nkosi" }] })
      .expect(201);
    patientIdOwnedByA = (res.body as { id: string }).id;
  });

  it("owner (user A) can read their own resource", async () => {
    await request
      .get(`/fhir/Patient/${patientIdOwnedByA}`)
      .set("authorization", `Bearer ${tokenA}`)
      .expect(200);
  });

  it("(a) cross-user read returns 403", async () => {
    await request
      .get(`/fhir/Patient/${patientIdOwnedByA}`)
      .set("authorization", `Bearer ${tokenB}`)
      .expect(403);
  });

  it("(b) cross-user read inserts exactly one breach_candidates row with correct metadata", async () => {
    // Drain any pre-existing rows for this actor/target pair
    await pool.query(
      `delete from breach_candidates where actor_id = $1 and target_user_id = $2`,
      [userIdB, userIdA],
    );

    await request
      .get(`/fhir/Patient/${patientIdOwnedByA}`)
      .set("authorization", `Bearer ${tokenB}`)
      .expect(403);

    const r = await pool.query<{
      actor_id: string; target_user_id: string; actor_kind: string; query_context: unknown;
    }>(
      `select actor_id, target_user_id, actor_kind, query_context
       from breach_candidates
       where actor_id = $1 and target_user_id = $2`,
      [userIdB, userIdA],
    );

    expect(r.rowCount).toBe(1);
    const row = r.rows[0];
    expect(row.actor_id).toBe(userIdB);
    expect(row.target_user_id).toBe(userIdA);
    expect(row.actor_kind).toBe("patient");
    const ctx = row.query_context as { resourceType: string };
    expect(ctx.resourceType).toBe("Patient");
  });

  it("returns 400 for invalid UUID id", async () => {
    await request
      .get("/fhir/Patient/not-a-uuid")
      .set("authorization", `Bearer ${tokenA}`)
      .expect(400);
  });

  it("returns 404 for unknown resource id", async () => {
    await request
      .get("/fhir/Patient/00000000-0000-0000-0000-000000000000")
      .set("authorization", `Bearer ${tokenA}`)
      .expect(404);
  });
});

// ── POST /fhir/Bundle ─────────────────────────────────────────────────────────

describe("POST /fhir/Bundle", () => {
  it("stores all entries and returns a transaction-response Bundle", async () => {
    const res = await request
      .post("/fhir/Bundle")
      .set("authorization", `Bearer ${tokenA}`)
      .send({
        resourceType: "Bundle",
        type: "transaction",
        entry: [
          { resource: { resourceType: "Condition",
            clinicalStatus: { coding: [{ code: "active" }] },
            subject: { reference: `Patient/${userIdA}` } } },
          { resource: { resourceType: "AllergyIntolerance",
            clinicalStatus: { coding: [{ code: "active" }] },
            patient: { reference: `Patient/${userIdA}` } } },
        ],
      })
      .expect(200);

    const bundle = res.body as { resourceType: string; type: string; entry: unknown[] };
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("transaction-response");
    expect(bundle.entry).toHaveLength(2);
  });

  it("returns 400 for non-Bundle body", async () => {
    await request
      .post("/fhir/Bundle")
      .set("authorization", `Bearer ${tokenA}`)
      .send({ resourceType: "Patient" })
      .expect(400);
  });
});
