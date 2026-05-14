-- QuroVita Phase 1 schema expansion.
-- Extends the v0 baseline in 0001_init.sql.
-- NEVER edit 0001_init.sql — that file is the immutable v0 baseline.
-- POPIA: every user-data table has RLS enabled and an owning policy.
-- Crypto: CSIR-mandated ECDH P-256 / ECDSA P-256 / HKDF-SHA256 / AES-256-GCM only.

-- ---------------------------------------------------------------------------
-- Extend users table (0001 has only id, display_name, created_at)
-- ---------------------------------------------------------------------------

alter table users
  add column if not exists hpid            text,
  add column if not exists phone_e164      text unique,
  add column if not exists preferred_language text not null default 'en'
    check (preferred_language in ('en','zu','st')),
  add column if not exists popia_consent_version text,
  add column if not exists kyc_status      text not null default 'unverified'
    check (kyc_status in ('unverified','pending','verified','failed'));

-- ---------------------------------------------------------------------------
-- FHIR R4 resources — one row per FHIR resource, owned by a user
-- ---------------------------------------------------------------------------

create table if not exists fhir_resources (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null references users(id) on delete cascade,
  resource_type text not null,
  fhir_id      text,                          -- HAPI-assigned ID
  version_id   text,
  data         jsonb not null,                -- full R4 resource
  source       text check (source in ('manual','ocr','bundle_import','hapi_sync')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists fhir_resources_user_idx on fhir_resources (user_id);
create index if not exists fhir_resources_type_idx on fhir_resources (user_id, resource_type);
-- GIN index for full FHIR JSON search
create index if not exists fhir_resources_data_gin on fhir_resources using gin (data);

-- ---------------------------------------------------------------------------
-- Documents — S3 objects, metadata only (no clinical values — SAHPRA Class A)
-- ---------------------------------------------------------------------------

create table if not exists documents (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references users(id) on delete cascade,
  s3_bucket       text not null,
  s3_key          text not null,
  mime_type       text not null,
  file_size_bytes bigint,
  -- OCR-extracted metadata (no clinical values — see CLAUDE.md non-negotiables)
  doc_type        text check (doc_type in ('lab','prescription','discharge','imaging','referral','other')),
  doc_date        date,
  facility_name   text,
  patient_name    text,
  fhir_ref_id     uuid references fhir_resources(id),
  ocr_status      text not null default 'pending'
    check (ocr_status in ('pending','processing','complete','failed')),
  created_at      timestamptz not null default now()
);

create index if not exists documents_user_idx on documents (user_id);
create index if not exists documents_s3_key_idx on documents (s3_bucket, s3_key);

-- ---------------------------------------------------------------------------
-- Consent records — versioned, with SHA-256 hash of the exact consent text
-- Populated when user accepts the privacy policy / data sharing consent.
-- ---------------------------------------------------------------------------

create table if not exists consent_records (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references users(id) on delete cascade,
  consent_type    text not null check (consent_type in ('privacy_policy','data_sharing','research')),
  version         text not null,
  text_sha256     text not null,   -- SHA-256 of the exact text the user saw
  ip_address      text,
  user_agent      text,
  granted         boolean not null,
  granted_at      timestamptz not null default now()
);

create index if not exists consent_records_user_idx on consent_records (user_id);

-- ---------------------------------------------------------------------------
-- KYC verifications — Smile ID transaction IDs only (no biometric blobs)
-- ---------------------------------------------------------------------------

create table if not exists kyc_verifications (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references users(id) on delete cascade,
  vendor          text not null default 'smile_id',
  vendor_txn_id   text not null,               -- Smile ID job_id; no biometric data stored here
  id_type         text,
  country         text not null default 'ZA',
  status          text not null default 'pending'
    check (status in ('pending','approved','declined','error')),
  score           numeric(5,4),               -- confidence score if provided
  webhook_payload jsonb,                       -- raw vendor response (redacted of biometrics)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists kyc_verifications_user_idx on kyc_verifications (user_id);
create index if not exists kyc_verifications_txn_idx on kyc_verifications (vendor, vendor_txn_id);

-- ---------------------------------------------------------------------------
-- WhatsApp sessions — Redis-backed at runtime; DB is the durable record
-- ---------------------------------------------------------------------------

create table if not exists whatsapp_sessions (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references users(id) on delete set null,
  wa_phone        text not null,
  language        text not null default 'en'
    check (language in ('en','zu','st')),
  state           text not null default 'IDLE',
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists whatsapp_sessions_phone_idx on whatsapp_sessions (wa_phone);

-- ---------------------------------------------------------------------------
-- AI compliance log — HPCSA Booklet 20 evidence trail
-- system_prompt_sha256 ensures any prompt change is detectable.
-- ---------------------------------------------------------------------------

create table if not exists ai_compliance_log (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid references users(id) on delete set null,
  session_id          uuid references qr_sessions(id) on delete set null,
  language            text not null default 'en',
  user_message        text not null,
  model_response      text,
  verdict             text not null check (verdict in ('allowed','blocked')),
  violation_tags      text[],
  system_prompt_sha256 text not null,
  occurred_at         timestamptz not null default now()
);

create index if not exists ai_compliance_log_user_idx on ai_compliance_log (user_id);
create index if not exists ai_compliance_log_verdict_idx on ai_compliance_log (verdict, occurred_at);

-- ---------------------------------------------------------------------------
-- POPIA breach candidates — populated by breach.ts when cross-user query detected
-- ---------------------------------------------------------------------------

create table if not exists breach_candidates (
  id              uuid primary key default uuid_generate_v4(),
  actor_id        uuid references users(id) on delete set null,
  actor_kind      text not null check (actor_kind in ('patient','provider','system')),
  target_user_id  uuid references users(id) on delete set null,
  query_context   jsonb,
  sentry_event_id text,
  reviewed        boolean not null default false,
  detected_at     timestamptz not null default now()
);

create index if not exists breach_candidates_actor_idx on breach_candidates (actor_id, detected_at);

-- ---------------------------------------------------------------------------
-- Enforce append-only on new compliance-critical tables (mirrors audit_log)
-- ---------------------------------------------------------------------------

create or replace function immutable_table() returns trigger as $$
begin
  raise exception '% is append-only (compliance log)', TG_TABLE_NAME;
end;
$$ language plpgsql;

drop trigger if exists ai_compliance_log_no_update on ai_compliance_log;
drop trigger if exists ai_compliance_log_no_delete on ai_compliance_log;
create trigger ai_compliance_log_no_update before update on ai_compliance_log
  for each row execute function immutable_table();
create trigger ai_compliance_log_no_delete before delete on ai_compliance_log
  for each row execute function immutable_table();

drop trigger if exists breach_candidates_no_update on breach_candidates;
create trigger breach_candidates_no_update before update on breach_candidates
  for each row execute function immutable_table();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Enable on all user-data tables. Policies enforced by the application layer
-- (backend passes user_id from JWT; Supabase enforces via auth.uid() in prod).
-- In the current demo stack, RLS is enabled but policies are permissive
-- (all operations allowed) — tighten when Supabase auth is wired (T6+).
-- ---------------------------------------------------------------------------

alter table fhir_resources enable row level security;
alter table documents enable row level security;
alter table consent_records enable row level security;
alter table kyc_verifications enable row level security;
alter table whatsapp_sessions enable row level security;
alter table ai_compliance_log enable row level security;
alter table breach_candidates enable row level security;

-- Permissive service-role bypass (backend Postgres user = qurovita).
-- DROP first to make this migration safe to re-run during development.
drop policy if exists fhir_resources_service on fhir_resources;
create policy fhir_resources_service on fhir_resources to qurovita using (true) with check (true);

drop policy if exists documents_service on documents;
create policy documents_service on documents to qurovita using (true) with check (true);

drop policy if exists consent_records_service on consent_records;
create policy consent_records_service on consent_records to qurovita using (true) with check (true);

drop policy if exists kyc_verifications_service on kyc_verifications;
create policy kyc_verifications_service on kyc_verifications to qurovita using (true) with check (true);

drop policy if exists whatsapp_sessions_service on whatsapp_sessions;
create policy whatsapp_sessions_service on whatsapp_sessions to qurovita using (true) with check (true);

drop policy if exists ai_compliance_log_service on ai_compliance_log;
create policy ai_compliance_log_service on ai_compliance_log to qurovita using (true) with check (true);

drop policy if exists breach_candidates_service on breach_candidates;
create policy breach_candidates_service on breach_candidates to qurovita using (true) with check (true);
