import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const SCHEMA_VERSION = 1;

export const schema = appSchema({
  version: SCHEMA_VERSION,
  tables: [
    tableSchema({
      name: 'fhir_resources',
      columns: [
        { name: 'fhir_id', type: 'string', isIndexed: true },
        { name: 'resource_type', type: 'string', isIndexed: true },
        { name: 'data_json', type: 'string' },
        { name: 'server_updated_at', type: 'number', isIndexed: true },
        { name: 'synced_at', type: 'number', isOptional: true },
        { name: 'needs_push', type: 'boolean' },
        { name: 'is_deleted', type: 'boolean' },
      ],
    }),
    tableSchema({
      name: 'documents',
      columns: [
        { name: 'server_id', type: 'string', isIndexed: true },
        { name: 's3_bucket', type: 'string', isOptional: true },
        { name: 's3_key', type: 'string', isOptional: true },
        { name: 'local_uri', type: 'string', isOptional: true },
        { name: 'mime_type', type: 'string', isOptional: true },
        { name: 'doc_type', type: 'string', isOptional: true },
        { name: 'doc_date', type: 'string', isOptional: true },
        { name: 'facility_name', type: 'string', isOptional: true },
        { name: 'fhir_ref_id', type: 'string', isOptional: true },
        { name: 'ocr_status', type: 'string', isOptional: true },
        { name: 'server_updated_at', type: 'number', isIndexed: true },
        { name: 'synced_at', type: 'number', isOptional: true },
        { name: 'needs_push', type: 'boolean' },
        { name: 'is_deleted', type: 'boolean' },
      ],
    }),
    tableSchema({
      name: 'consent_records',
      columns: [
        { name: 'server_id', type: 'string', isOptional: true },
        { name: 'consent_type', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'text_sha256', type: 'string' },
        { name: 'granted', type: 'boolean' },
        { name: 'granted_at', type: 'number' },
        { name: 'language', type: 'string', isOptional: true },
        { name: 'synced_at', type: 'number', isOptional: true },
        { name: 'needs_push', type: 'boolean' },
      ],
    }),
    tableSchema({
      name: 'sync_metadata',
      columns: [
        { name: 'key', type: 'string', isIndexed: true },
        { name: 'value', type: 'string' },
      ],
    }),
  ],
});
