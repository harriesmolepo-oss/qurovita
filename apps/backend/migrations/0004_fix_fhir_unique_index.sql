-- Fix fhir_resources unique index to be scoped per user.
-- The previous index on (resource_type, fhir_id) caused cross-user upsert
-- collisions: inserting "Condition/cond-hiv" for user B would silently update
-- user A's row instead of creating user B's own resource.
-- Correct scope: each user owns their own namespace of (resource_type, fhir_id).

drop index if exists fhir_resources_type_fhirid_uidx;

create unique index fhir_resources_user_type_fhirid_uidx
  on fhir_resources (user_id, resource_type, fhir_id);
