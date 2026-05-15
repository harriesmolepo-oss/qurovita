-- QuroVita Phase 2 — adapt fhir_resources for Medplum Node-native storage.
-- See docs/decisions/0001-fhir-server.md for the rationale.
--
-- Changes:
--   1. Backfill any null fhir_id values before adding NOT NULL.
--   2. Set fhir_id NOT NULL (IDs are now backend-generated UUIDs).
--   3. Add unique index on (resource_type, fhir_id) for the upsert pattern.
--   4. Add 'native' to the source enum so Node-generated resources are distinct.

update fhir_resources
  set fhir_id = gen_random_uuid()::text
  where fhir_id is null;

alter table fhir_resources
  alter column fhir_id set not null;

create unique index if not exists fhir_resources_type_fhirid_uidx
  on fhir_resources (resource_type, fhir_id);

-- Widen the source check constraint to include 'native'
alter table fhir_resources
  drop constraint if exists fhir_resources_source_check;

alter table fhir_resources
  add constraint fhir_resources_source_check
  check (source in ('manual','ocr','bundle_import','hapi_sync','native'));
