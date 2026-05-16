// backend/src/services/sample-fhir.ts
//
// Builds and seeds a realistic SA PHC sample bundle for a given patient.
// T2.4: on first login the bundle is written into the FHIR store; the share
// flow reads live data instead of returning hardcoded JSON.
//
// The sample represents: HIV (on ART), hypertension, one allergy.
// In production this comes from the patient's WatermelonDB via their own uploads.
import { pool } from "../db.js";
import { fhirClient } from "../fhir/client.js";
import type { Bundle } from "@medplum/fhirtypes";

/** Build the sample FHIR bundle for patientId (no DB writes). */
export function sampleBundle(patientId: string): Bundle {
  return {
    resourceType: "Bundle",
    id: `bundle-${patientId}`,
    type: "collection",
    timestamp: new Date().toISOString(),
    entry: [
      { resource: { resourceType: "Patient", id: patientId,
        name: [{ family: "Demo", given: ["Patient"] }],
        gender: "female", birthDate: "1985-03-12",
        address: [{ city: "Khayelitsha", country: "ZA" }] } },
      { resource: { resourceType: "Condition", id: "cond-hiv",
        subject: { reference: `Patient/${patientId}` },
        code: { text: "HIV (on ART)" }, recordedDate: "2019-08-14" } },
      { resource: { resourceType: "Condition", id: "cond-htn",
        subject: { reference: `Patient/${patientId}` },
        code: { text: "Hypertension" }, recordedDate: "2022-04-02" } },
      { resource: { resourceType: "MedicationStatement", id: "med-tld",
        subject: { reference: `Patient/${patientId}` }, status: "active",
        medicationCodeableConcept: { text: "Tenofovir/Lamivudine/Dolutegravir (TLD)" },
        dosage: [{ text: "1 tablet daily" }] } },
      { resource: { resourceType: "MedicationStatement", id: "med-amlo",
        subject: { reference: `Patient/${patientId}` }, status: "active",
        medicationCodeableConcept: { text: "Amlodipine 5mg" },
        dosage: [{ text: "1 tablet daily" }] } },
      { resource: { resourceType: "Observation", id: "obs-cd4",
        subject: { reference: `Patient/${patientId}` }, status: "final",
        code: { text: "CD4 count" },
        valueQuantity: { value: 612, unit: "cells/uL" },
        effectiveDateTime: "2026-01-14" } },
      { resource: { resourceType: "Observation", id: "obs-vl",
        subject: { reference: `Patient/${patientId}` }, status: "final",
        code: { text: "HIV viral load" }, valueString: "Undetectable",
        effectiveDateTime: "2026-01-14" } },
      { resource: { resourceType: "Observation", id: "obs-bp",
        subject: { reference: `Patient/${patientId}` }, status: "final",
        code: { text: "Blood pressure" }, valueString: "138/86 mmHg",
        effectiveDateTime: "2026-04-03" } },
      { resource: { resourceType: "AllergyIntolerance", id: "allergy-pen",
        patient: { reference: `Patient/${patientId}` },
        code: { text: "Penicillin" },
        reaction: [{ manifestation: [{ text: "Rash" }] }] } },
    ],
  };
}

const SEED_RESOURCE_COUNT = 9;

/**
 * Seed sample FHIR resources for userId if the full seed hasn't been applied.
 * Idempotent: no-ops only when the full expected count is present. A partial
 * seed (e.g. from a crashed first run) triggers a full upsert to complete it.
 */
export async function seedSampleData(userId: string): Promise<void> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from fhir_resources where user_id = $1`,
    [userId],
  );
  if (rows[0].n >= SEED_RESOURCE_COUNT) return;

  const client = fhirClient(userId);
  const bundle = sampleBundle(userId);
  await client.bundleTransaction(bundle);
}
