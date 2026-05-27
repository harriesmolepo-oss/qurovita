-- Redesign qr_sessions for the OOB P2P handshake architecture (master doc §4.1).
--
-- The v0 demo table (0001_init.sql) used a status-enum + consumed_at pattern and
-- stored compressed P-256 pubkeys (33 bytes). The new architecture:
--   - Stores raw uncompressed P-256 keys as BYTEA (65 bytes for pubkeys, 32 for privkey).
--   - Replaces the status enum with two nullable timestamp columns (revoked_at, claimed_at)
--     so the lifecycle is expressed as data, not a magic string, and the table stays
--     insert-mostly without a status UPDATE path.
--   - Adds BLE address and Wi-Fi Direct SSID transport-hint columns.
--   - Removes resource_ids (bundle linkage is handled separately in later phases).
--
-- CASCADE drops the FK from ai_compliance_log.session_id; we re-add it below.
-- No production data exists in qr_sessions — safe to drop.

drop table if exists qr_sessions cascade;

create table qr_sessions (
  id                uuid        primary key default gen_random_uuid(),
  patient_user_id   uuid        not null references users(id),
  patient_pubkey    bytea       not null,     -- raw uncompressed P-256 (65 bytes, 0x04 prefix)
  server_privkey    bytea       not null,     -- raw P-256 scalar (32 bytes); TODO: KMS-wrap in prod
  server_pubkey     bytea       not null,     -- raw uncompressed P-256 (65 bytes, 0x04 prefix)
  ble_address       text,
  wifi_direct_ssid  text,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  revoked_at        timestamptz,
  claimed_at        timestamptz
);

-- Partial index: active sessions per patient (null revoked_at = not revoked).
-- Used by the status endpoint and the session-creation duplicate-check.
create index qr_sessions_patient_active_idx
  on qr_sessions (patient_user_id, expires_at)
  where revoked_at is null;

-- Re-add the FK from ai_compliance_log that CASCADE dropped above.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_compliance_log_session_fk'
      and conrelid = 'ai_compliance_log'::regclass
  ) then
    alter table ai_compliance_log
      add constraint ai_compliance_log_session_fk
      foreign key (session_id) references qr_sessions(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Column-level privilege grants for the qurovita application role.
--
-- Why qr_sessions allows column-scoped UPDATE while audit_log does not:
--   audit_log is an immutable compliance trail (HPCSA Booklet 9) — no row
--   may ever change after insertion. qr_sessions holds operational state:
--   a session must be revocable (revoked_at) and claimable (claimed_at).
--   Restricting UPDATE to only those two columns prevents the application
--   from silently overwriting crypto material (patient_pubkey, server_privkey,
--   server_pubkey) or the expiry timestamp — fields that, once written, must
--   be immutable for security and audit correctness.
--
-- Note: In this dev stack, qurovita is the table OWNER, so Postgres built-in
-- owner privileges mean the REVOKE below does not actually restrict the owner.
-- These statements are scaffolding for when a separate low-privilege app role
-- (e.g. qurovita_app) is introduced in production, at which point the OWNER
-- would be a superuser/admin role and qurovita_app would hold only these grants.
-- ---------------------------------------------------------------------------

revoke all on qr_sessions from qurovita;
grant select, insert on qr_sessions to qurovita;
grant update (revoked_at, claimed_at) on qr_sessions to qurovita;
