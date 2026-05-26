import { Model } from '@nozbe/watermelondb';
import { field, date, readonly } from '@nozbe/watermelondb/decorators';
/** Minimal FHIR resource shape stored as JSON in WatermelonDB. */
export interface StoredFhirResource {
  resourceType: string;
  id?: string;
  meta?: { lastUpdated?: string };
  code?: { coding?: { display?: string }[]; text?: string };
  medicationCodeableConcept?: { coding?: { display?: string }[] };
  type?: { coding?: { display?: string }[] };
  effectiveDateTime?: string;
  recordedDate?: string;
  date?: string;
}

export default class FhirResource extends Model {
  static table = 'fhir_resources';

  @field('fhir_id') fhirId!: string;
  @field('resource_type') resourceType!: string;
  @field('data_json') dataJson!: string;
  @field('server_updated_at') serverUpdatedAt!: number;
  @field('synced_at') syncedAt!: number | null;
  @field('needs_push') needsPush!: boolean;
  @field('is_deleted') isDeleted!: boolean;

  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;

  get resource(): StoredFhirResource {
    return JSON.parse(this.dataJson) as StoredFhirResource;
  }

  get displayTitle(): string {
    const r = this.resource;
    if (r.resourceType === 'Observation') {
      const code = r.code?.coding?.[0]?.display ?? r.code?.text ?? 'Observation';
      return code;
    }
    if (r.resourceType === 'Condition') {
      return r.code?.coding?.[0]?.display ?? r.code?.text ?? 'Condition';
    }
    if (r.resourceType === 'MedicationStatement') {
      return r.medicationCodeableConcept?.coding?.[0]?.display ?? 'Medication';
    }
    if (r.resourceType === 'DocumentReference') {
      return r.type?.coding?.[0]?.display ?? 'Document';
    }
    return r.resourceType ?? 'Record';
  }

  get displayDate(): string {
    const r = this.resource;
    const raw =
      r.meta?.lastUpdated ??
      (r as { effectiveDateTime?: string }).effectiveDateTime ??
      (r as { recordedDate?: string }).recordedDate ??
      (r as { date?: string }).date;
    if (!raw) return '';
    try {
      return new Date(raw).toLocaleDateString();
    } catch {
      return String(raw);
    }
  }
}
