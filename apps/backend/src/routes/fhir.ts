// apps/backend/src/routes/fhir.ts
//
// Passthrough FHIR R4 routes for the resource types QuroVita uses.
// Access control: a patient may only read/write resources where user_id == their sub.
// Any cross-user read triggers POPIA breach detection (checkFhirAccess).
import type { FastifyInstance } from "fastify";
import type { ResourceType } from "@medplum/fhirtypes";
import { fhirClient } from "../fhir/client.js";
import { checkFhirAccess } from "../popia/breach.js";
import { auditLog } from "../services/audit.js";

const ALLOWED_TYPES = new Set<ResourceType>([
  "Patient", "Observation", "MedicationStatement",
  "Condition", "AllergyIntolerance", "DocumentReference", "Bundle",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function fhirRoutes(app: FastifyInstance) {
  /**
   * POST /fhir/:type — create or upsert a FHIR resource.
   * Patient can only create resources for themselves.
   */
  app.post<{ Params: { type: string } }>("/fhir/:type", async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const resourceType = req.params.type as ResourceType;

    if (!ALLOWED_TYPES.has(resourceType)) {
      return reply.code(400).send({ error: `Unsupported resource type: ${resourceType}` });
    }

    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "Request body must be a FHIR resource JSON object" });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resource = { ...body, resourceType } as any;

    const stored = await fhirClient(userId).create(resource);

    await auditLog({
      actor_id: userId, actor_kind: "patient",
      action: "fhir.resource.create", target_type: "FhirResource", target_id: stored.id ?? "",
      details: { resourceType },
    });

    return reply.code(201).send(stored);
  });

  /**
   * GET /fhir/:type — search resources owned by the authenticated patient.
   */
  app.get<{ Params: { type: string } }>("/fhir/:type", async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const resourceType = req.params.type as ResourceType;

    if (!ALLOWED_TYPES.has(resourceType)) {
      return reply.code(400).send({ error: `Unsupported resource type: ${resourceType}` });
    }

    const resources = await fhirClient(userId).search(resourceType);
    return reply.send({
      resourceType: "Bundle",
      type: "searchset",
      total: resources.length,
      entry: resources.map(r => ({ resource: r })),
    });
  });

  /**
   * GET /fhir/:type/:id — read a single FHIR resource.
   * POPIA: if the authenticated user is not the owner, log to breach_candidates and return 403.
   */
  app.get<{ Params: { type: string; id: string } }>("/fhir/:type/:id", async (req, reply) => {
    const actorId = (req.user as { sub: string }).sub;
    const resourceType = req.params.type as ResourceType;
    const fhirId = req.params.id;

    if (!ALLOWED_TYPES.has(resourceType)) {
      return reply.code(400).send({ error: `Unsupported resource type: ${resourceType}` });
    }
    if (!UUID_RE.test(fhirId)) {
      return reply.code(400).send({ error: "id must be a UUID" });
    }

    // To enforce the cross-user check we need the resource's owner.
    // We attempt a direct DB read using an admin pool query to discover owner.
    const { pool } = await import("../db.js");
    const ownerRow = await pool.query<{ user_id: string }>(
      `select user_id from fhir_resources where resource_type = $1 and fhir_id = $2`,
      [resourceType, fhirId],
    );

    if (ownerRow.rowCount === 0) {
      return reply.code(404).send({ error: "Resource not found" });
    }

    const targetUserId = ownerRow.rows[0].user_id;

    // CRITICAL: breach check must run on every cross-user access
    await checkFhirAccess({
      actorId,
      actorKind: "patient",
      targetUserId,
      resourceType,
      queryParams: { id: fhirId },
    });

    if (actorId !== targetUserId) {
      return reply.code(403).send({ error: "Access denied" });
    }

    const resource = await fhirClient(actorId).read(resourceType, fhirId);
    if (!resource) {
      return reply.code(404).send({ error: "Resource not found" });
    }

    return reply.send(resource);
  });

  /**
   * POST /fhir/Bundle — transaction bundle endpoint.
   */
  app.post("/fhir/Bundle", async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bundle = req.body as any;

    if (bundle?.resourceType !== "Bundle") {
      return reply.code(400).send({ error: "Body must be a FHIR Bundle resource" });
    }

    const result = await fhirClient(userId).bundleTransaction(bundle);
    return reply.code(200).send(result);
  });
}
