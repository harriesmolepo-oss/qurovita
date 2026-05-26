/**
 * Offline-first WatermelonDB sync adapter for /fhir/* and related patient data.
 *
 * Pull: fetch server resources, apply locally when server_updated_at > watermark.
 * Push: POST local rows with needs_push=true, then mark synced.
 *
 * All writes use database.write() to avoid SQLite thread collisions.
 */
import { Q } from '@nozbe/watermelondb';
import * as SecureStore from 'expo-secure-store';

import { API_BASE_URL } from '../config/api';
import { getDatabase } from './index';
import FhirResource from './models/FhirResource';
import Document from './models/Document';
import ConsentRecord from './models/ConsentRecord';
import SyncMetadata from './models/SyncMetadata';

const WATERMARK_SECURE_KEY = 'qurovita_sync_watermark_ms';
const WATERMARK_META_KEY = 'fhir_pull_watermark_ms';

/** FHIR types mirrored from apps/backend/src/routes/fhir.ts */
export const FHIR_SYNC_RESOURCE_TYPES = [
  'Patient',
  'Observation',
  'MedicationStatement',
  'Condition',
  'AllergyIntolerance',
  'DocumentReference',
] as const;

export type FhirSyncResourceType = (typeof FHIR_SYNC_RESOURCE_TYPES)[number];

export interface SyncResult {
  pulled: number;
  pushed: number;
  documentsPulled: number;
  consentPushed: number;
  watermarkMs: number;
  errors: string[];
}

interface FhirResourceJson {
  resourceType: string;
  id?: string;
  meta?: { lastUpdated?: string };
}

interface FhirSearchBundle {
  resourceType?: string;
  entry?: Array<{ resource?: FhirResourceJson }>;
}

interface RemoteDocumentRow {
  id: string;
  s3_bucket?: string;
  s3_key?: string;
  mime_type?: string;
  doc_type?: string;
  doc_date?: string;
  facility_name?: string;
  fhir_ref_id?: string;
  ocr_status?: string;
  updated_at?: string;
  created_at?: string;
}

function parseLastUpdated(resource: FhirResourceJson): number {
  const meta = resource.meta?.lastUpdated;
  if (meta) {
    const ms = Date.parse(meta);
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

async function getWatermarkMs(): Promise<number> {
  const stored = await SecureStore.getItemAsync(WATERMARK_SECURE_KEY);
  if (stored) {
    const n = Number(stored);
    if (!Number.isNaN(n) && n > 0) return n;
  }

  const db = getDatabase();
  const meta = await db
    .get<SyncMetadata>('sync_metadata')
    .query(Q.where('key', WATERMARK_META_KEY))
    .fetch();

  if (meta.length > 0) {
    const n = Number(meta[0].value);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 0;
}

async function setWatermarkMs(ms: number): Promise<void> {
  await SecureStore.setItemAsync(WATERMARK_SECURE_KEY, String(ms));
  const db = getDatabase();
  await db.write(async () => {
    const existing = await db
      .get<SyncMetadata>('sync_metadata')
      .query(Q.where('key', WATERMARK_META_KEY))
      .fetch();
    if (existing.length > 0) {
      await existing[0].update((row) => {
        row.value = String(ms);
      });
    } else {
      await db.get<SyncMetadata>('sync_metadata').create((row) => {
        row.key = WATERMARK_META_KEY;
        row.value = String(ms);
      });
    }
  });
}

async function fetchWithAuth(
  path: string,
  jwt: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
      ...(init?.headers ?? {}),
    },
  });
}

async function pullFhirResources(
  jwt: string,
  watermarkMs: number,
): Promise<{ count: number; maxUpdated: number; errors: string[] }> {
  const db = getDatabase();
  const collection = db.get<FhirResource>('fhir_resources');
  let count = 0;
  let maxUpdated = watermarkMs;
  const errors: string[] = [];

  for (const resourceType of FHIR_SYNC_RESOURCE_TYPES) {
    try {
      const res = await fetchWithAuth(`/fhir/${resourceType}?_since=${watermarkMs}`, jwt);
      if (!res.ok) {
        if (res.status === 404) continue;
        errors.push(`Pull ${resourceType}: HTTP ${res.status}`);
        continue;
      }
      const bundle = (await res.json()) as FhirSearchBundle;
      const entries = bundle.entry ?? [];

      await db.write(async () => {
        for (const entry of entries) {
          const resource = entry.resource;
          if (!resource?.id || !resource.resourceType) continue;

          const serverUpdatedAt = parseLastUpdated(resource);
          if (serverUpdatedAt <= watermarkMs) continue;

          const existing = await collection
            .query(
              Q.and(
                Q.where('fhir_id', resource.id),
                Q.where('resource_type', resource.resourceType),
              ),
            )
            .fetch();

          const payload = JSON.stringify(resource);

          if (existing.length > 0) {
            await existing[0].update((row) => {
              row.dataJson = payload;
              row.serverUpdatedAt = serverUpdatedAt;
              row.syncedAt = Date.now();
              row.needsPush = false;
              row.isDeleted = false;
            });
          } else {
            await collection.create((row) => {
              row.fhirId = resource.id;
              row.resourceType = resource.resourceType;
              row.dataJson = payload;
              row.serverUpdatedAt = serverUpdatedAt;
              row.syncedAt = Date.now();
              row.needsPush = false;
              row.isDeleted = false;
            });
          }

          count += 1;
          if (serverUpdatedAt > maxUpdated) maxUpdated = serverUpdatedAt;
        }
      });
    } catch (e) {
      errors.push(
        `Pull ${resourceType}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { count, maxUpdated, errors };
}

async function pushFhirResources(jwt: string): Promise<{ count: number; errors: string[] }> {
  const db = getDatabase();
  const pending = await db
    .get<FhirResource>('fhir_resources')
    .query(Q.where('needs_push', true), Q.where('is_deleted', false))
    .fetch();

  let count = 0;
  const errors: string[] = [];

  for (const row of pending) {
    try {
      const resource = JSON.parse(row.dataJson) as FhirResourceJson;
      const res = await fetchWithAuth(`/fhir/${row.resourceType}`, jwt, {
        method: 'POST',
        body: JSON.stringify(resource),
      });
      if (!res.ok) {
        errors.push(`Push ${row.resourceType}/${row.fhirId}: HTTP ${res.status}`);
        continue;
      }
      const stored = (await res.json()) as FhirResourceJson;
      await db.write(async () => {
        await row.update((r) => {
          r.dataJson = JSON.stringify(stored);
          r.fhirId = stored.id ?? r.fhirId;
          r.serverUpdatedAt = parseLastUpdated(stored);
          r.syncedAt = Date.now();
          r.needsPush = false;
        });
      });
      count += 1;
    } catch (e) {
      errors.push(
        `Push ${row.resourceType}/${row.fhirId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { count, errors };
}

async function pullDocuments(
  jwt: string,
  watermarkMs: number,
): Promise<{ count: number; maxUpdated: number; errors: string[] }> {
  const db = getDatabase();
  const collection = db.get<Document>('documents');
  let count = 0;
  let maxUpdated = watermarkMs;
  const errors: string[] = [];

  try {
    const res = await fetchWithAuth(`/documents?since=${watermarkMs}`, jwt);
    if (res.status === 404) {
      return { count: 0, maxUpdated, errors };
    }
    if (!res.ok) {
      errors.push(`Pull documents: HTTP ${res.status}`);
      return { count, maxUpdated, errors };
    }

    const rows = (await res.json()) as RemoteDocumentRow[];
    if (!Array.isArray(rows)) {
      return { count, maxUpdated, errors };
    }

    await db.write(async () => {
      for (const doc of rows) {
        const serverUpdatedAt = doc.updated_at
          ? Date.parse(doc.updated_at)
          : doc.created_at
            ? Date.parse(doc.created_at)
            : Date.now();
        if (Number.isNaN(serverUpdatedAt) || serverUpdatedAt <= watermarkMs) continue;

        const existing = await collection
          .query(Q.where('server_id', doc.id))
          .fetch();

        if (existing.length > 0) {
          await existing[0].update((row) => {
            row.s3Bucket = doc.s3_bucket ?? row.s3Bucket;
            row.s3Key = doc.s3_key ?? row.s3Key;
            row.mimeType = doc.mime_type ?? row.mimeType;
            row.docType = doc.doc_type ?? row.docType;
            row.docDate = doc.doc_date ?? row.docDate;
            row.facilityName = doc.facility_name ?? row.facilityName;
            row.fhirRefId = doc.fhir_ref_id ?? row.fhirRefId;
            row.ocrStatus = doc.ocr_status ?? row.ocrStatus;
            row.serverUpdatedAt = serverUpdatedAt;
            row.syncedAt = Date.now();
            row.needsPush = false;
            row.isDeleted = false;
          });
        } else {
          await collection.create((row) => {
            row.serverId = doc.id;
            row.s3Bucket = doc.s3_bucket ?? null;
            row.s3Key = doc.s3_key ?? null;
            row.localUri = null;
            row.mimeType = doc.mime_type ?? null;
            row.docType = doc.doc_type ?? null;
            row.docDate = doc.doc_date ?? null;
            row.facilityName = doc.facility_name ?? null;
            row.fhirRefId = doc.fhir_ref_id ?? null;
            row.ocrStatus = doc.ocr_status ?? 'pending';
            row.serverUpdatedAt = serverUpdatedAt;
            row.syncedAt = Date.now();
            row.needsPush = false;
            row.isDeleted = false;
          });
        }
        count += 1;
        if (serverUpdatedAt > maxUpdated) maxUpdated = serverUpdatedAt;
      }
    });
  } catch (e) {
    errors.push(`Pull documents: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { count, maxUpdated, errors };
}

async function pushConsentRecords(jwt: string): Promise<{ count: number; errors: string[] }> {
  const db = getDatabase();
  const pending = await db
    .get<ConsentRecord>('consent_records')
    .query(Q.where('needs_push', true))
    .fetch();

  let count = 0;
  const errors: string[] = [];

  for (const row of pending) {
    try {
      const res = await fetchWithAuth('/consent', jwt, {
        method: 'POST',
        body: JSON.stringify({
          consent_type: row.consentType,
          version: row.version,
          text_sha256: row.textSha256,
          granted: row.granted,
          language: row.language,
        }),
      });
      if (res.status === 404) {
        await db.write(async () => {
          await row.update((r) => {
            r.syncedAt = Date.now();
            r.needsPush = false;
          });
        });
        count += 1;
        continue;
      }
      if (!res.ok) {
        errors.push(`Push consent: HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { id?: string };
      await db.write(async () => {
        await row.update((r) => {
          r.serverId = body.id ?? r.serverId;
          r.syncedAt = Date.now();
          r.needsPush = false;
        });
      });
      count += 1;
    } catch (e) {
      errors.push(`Push consent: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { count, errors };
}

/** Persist POPIA consent locally (push when /consent endpoint is available). */
export async function recordLocalConsent(args: {
  consentType: string;
  version: string;
  textSha256: string;
  granted: boolean;
  language: string;
}): Promise<void> {
  const db = getDatabase();
  const existing = await db
    .get<ConsentRecord>('consent_records')
    .query(
      Q.and(
        Q.where('consent_type', args.consentType),
        Q.where('version', args.version),
        Q.where('text_sha256', args.textSha256),
      ),
    )
    .fetch();

  if (existing.length > 0) return;

  await db.write(async () => {
    await db.get<ConsentRecord>('consent_records').create((row) => {
      row.serverId = null;
      row.consentType = args.consentType;
      row.version = args.version;
      row.textSha256 = args.textSha256;
      row.granted = args.granted;
      row.grantedAt = Date.now();
      row.language = args.language;
      row.syncedAt = null;
      row.needsPush = true;
    });
  });
}

/**
 * Full bidirectional sync: pull FHIR + documents, push pending FHIR + consent.
 */
export async function syncPatientData(jwt: string): Promise<SyncResult> {
  const watermarkMs = await getWatermarkMs();
  const errors: string[] = [];

  const pull = await pullFhirResources(jwt, watermarkMs);
  errors.push(...pull.errors);

  const docPull = await pullDocuments(jwt, watermarkMs);
  errors.push(...docPull.errors);

  const push = await pushFhirResources(jwt);
  errors.push(...push.errors);

  const consentPush = await pushConsentRecords(jwt);
  errors.push(...consentPush.errors);

  const newWatermark = Math.max(watermarkMs, pull.maxUpdated, docPull.maxUpdated, Date.now());
  await setWatermarkMs(newWatermark);

  return {
    pulled: pull.count,
    pushed: push.count,
    documentsPulled: docPull.count,
    consentPushed: consentPush.count,
    watermarkMs: newWatermark,
    errors,
  };
}

export async function pullOnly(jwt: string): Promise<SyncResult> {
  return syncPatientData(jwt);
}
