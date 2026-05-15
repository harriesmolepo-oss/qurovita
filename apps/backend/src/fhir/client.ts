// apps/backend/src/fhir/client.ts
//
// Thin FHIR client abstraction used by all route handlers.
// Internally delegates to the Postgres store.
// If the backend ever migrates to HAPI, only this file changes — routes stay untouched.
import type { Resource, ResourceType, Bundle } from "@medplum/fhirtypes";
import {
  storeCreate,
  storeRead,
  storeSearch,
  storeBundleTransaction,
  type FhirSource,
} from "./store.js";

export class FhirClient {
  constructor(private readonly userId: string) {}

  /**
   * Create or update a FHIR resource owned by this client's userId.
   * Assigns a UUID fhir_id if the resource carries none.
   */
  async create<T extends Resource>(resource: T, source?: FhirSource): Promise<T> {
    return storeCreate(this.userId, resource, source);
  }

  /**
   * Read a FHIR resource by type and id.
   * Returns null if not found or owned by a different user (no 403 here — callers handle that).
   */
  async read<T extends Resource>(type: ResourceType, id: string): Promise<T | null> {
    return storeRead<T>(this.userId, type, id);
  }

  /**
   * List all resources of a type owned by this client's userId.
   * Phase 1: no parameter filtering. Will grow in T2.3 as routes need it.
   */
  async search<T extends Resource>(type: ResourceType): Promise<T[]> {
    return storeSearch<T>(this.userId, type);
  }

  /**
   * Process a FHIR transaction or batch Bundle.
   * Each entry is upserted; per-entry errors are returned as OperationOutcome entries.
   */
  async bundleTransaction(bundle: Bundle): Promise<Bundle> {
    return storeBundleTransaction(this.userId, bundle);
  }
}

/** Convenience factory — use this in route handlers. */
export function fhirClient(userId: string): FhirClient {
  return new FhirClient(userId);
}
