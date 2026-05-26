import { Model } from '@nozbe/watermelondb';
import { field, readonly, date } from '@nozbe/watermelondb/decorators';

export default class Document extends Model {
  static table = 'documents';

  @field('server_id') serverId!: string;
  @field('s3_bucket') s3Bucket!: string | null;
  @field('s3_key') s3Key!: string | null;
  @field('local_uri') localUri!: string | null;
  @field('mime_type') mimeType!: string | null;
  @field('doc_type') docType!: string | null;
  @field('doc_date') docDate!: string | null;
  @field('facility_name') facilityName!: string | null;
  @field('fhir_ref_id') fhirRefId!: string | null;
  @field('ocr_status') ocrStatus!: string | null;
  @field('server_updated_at') serverUpdatedAt!: number;
  @field('synced_at') syncedAt!: number | null;
  @field('needs_push') needsPush!: boolean;
  @field('is_deleted') isDeleted!: boolean;

  @readonly @date('created_at') createdAt!: Date;
  @readonly @date('updated_at') updatedAt!: Date;
}
