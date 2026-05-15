// apps/backend/src/fhir/store.ts
//
// Postgres-backed FHIR R4 resource store.
// All SQL against fhir_resources lives here.
// Routes must NOT import this directly — use client.ts instead.
import { randomUUID } from "node:crypto";
import type { Resource, ResourceType, Bundle, BundleEntry } from "@medplum/fhirtypes";
import { pool } from "../db.js";

export type FhirSource = "manual" | "ocr" | "bundle_import" | "native";

interface StoredRow { data: Resource }

/**
 * Insert or update a FHIR resource owned by userId.
 * Generates a UUID fhir_id if the resource carries none.
 */
export async function storeCreate<T extends Resource>(
  userId: string,
  resource: T,
  source: FhirSource = "native",
): Promise<T> {
  const fhirId = resource.id ?? randomUUID();
  const stored = { ...resource, id: fhirId } as T;

  await pool.query(
    `insert into fhir_resources (user_id, resource_type, fhir_id, data, source)
     values ($1, $2, $3, $4::jsonb, $5)
     on conflict (resource_type, fhir_id) do update
       set data = excluded.data, updated_at = now()`,
    [userId, resource.resourceType, fhirId, JSON.stringify(stored), source],
  );

  return stored;
}

/**
 * Read a single FHIR resource by type + id, scoped to userId.
 * Returns null if not found or owned by a different user.
 */
export async function storeRead<T extends Resource>(
  userId: string,
  resourceType: ResourceType,
  fhirId: string,
): Promise<T | null> {
  const r = await pool.query<StoredRow>(
    `select data from fhir_resources
     where user_id = $1 and resource_type = $2 and fhir_id = $3`,
    [userId, resourceType, fhirId],
  );
  return (r.rows[0]?.data ?? null) as T | null;
}

/**
 * Search FHIR resources of a type owned by userId.
 * Phase 1: returns all rows ordered by created_at desc.
 * Search parameter filtering is applied by client.ts for specific params.
 */
export async function storeSearch<T extends Resource>(
  userId: string,
  resourceType: ResourceType,
): Promise<T[]> {
  const r = await pool.query<StoredRow>(
    `select data from fhir_resources
     where user_id = $1 and resource_type = $2
     order by created_at desc`,
    [userId, resourceType],
  );
  return r.rows.map(row => row.data as T);
}

/**
 * Process a FHIR transaction or batch Bundle for userId.
 * Each entry is upserted; errors on individual entries are collected and returned
 * as OperationOutcome entries rather than aborting the whole bundle.
 */
export async function storeBundleTransaction(
  userId: string,
  bundle: Bundle,
): Promise<Bundle> {
  const responseEntries: BundleEntry[] = [];

  for (const entry of bundle.entry ?? []) {
    if (!entry.resource) continue;
    try {
      const stored = await storeCreate(userId, entry.resource, "bundle_import");
      responseEntries.push({
        response: {
          status: "201 Created",
          location: `${stored.resourceType}/${stored.id}`,
        },
        resource: stored,
      });
    } catch (err) {
      responseEntries.push({
        response: {
          status: "500 Internal Server Error",
          outcome: {
            resourceType: "OperationOutcome",
            issue: [{ severity: "error", code: "exception",
              diagnostics: err instanceof Error ? err.message : String(err) }],
          },
        },
      });
    }
  }

  return {
    resourceType: "Bundle",
    type: "transaction-response",
    entry: responseEntries,
  };
}
