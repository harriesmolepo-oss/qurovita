// apps/backend/src/services/bundle-builder.ts
//
// Builds a FHIR Bundle of type "collection" for the OOB (QR/BLE/WS) share flow.
// Called by the patient app when generating a share QR — assembles the resources
// the patient has authorised to share into a single transferable bundle.
import type { Bundle, Resource, ResourceType } from "@medplum/fhirtypes";
import { fhirClient } from "../fhir/client.js";

/** Resource types included in a full share bundle. */
export const SHARE_RESOURCE_TYPES: ResourceType[] = [
  "Patient",
  "Condition",
  "MedicationStatement",
  "Observation",
  "AllergyIntolerance",
  "DocumentReference",
];

export interface BuildBundleOptions {
  /** UUID of the patient whose resources are being shared. */
  patientId: string;
  /**
   * Optional allow-list of specific fhir_id values to include.
   * If omitted all resources of each SHARE_RESOURCE_TYPES type are included.
   */
  resourceIds?: string[];
}

/**
 * Build a FHIR collection Bundle for the given patient.
 * Only includes resource types in SHARE_RESOURCE_TYPES.
 * If resourceIds is supplied only matching resources are included.
 */
export async function buildShareBundle(opts: BuildBundleOptions): Promise<Bundle> {
  const client = fhirClient(opts.patientId);
  const entries: { resource: Resource }[] = [];

  for (const type of SHARE_RESOURCE_TYPES) {
    const resources = await client.search(type);
    for (const r of resources) {
      if (opts.resourceIds && !opts.resourceIds.includes(r.id ?? "")) continue;
      entries.push({ resource: r });
    }
  }

  return {
    resourceType: "Bundle",
    type: "collection",
    timestamp: new Date().toISOString(),
    total: entries.length,
    entry: entries,
  };
}
