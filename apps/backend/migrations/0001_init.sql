-- QuroVita v0 demo schema. Subset of production schema (see Part C2 of build plan).
-- Same patterns as production: append-only audit log enforced at DB level.

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- Minimal users table for demo. In prod: HPID, KYC status, language, POPIA consent version.
create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  display_name text not null,
  created_at timestamptz not null default now()
);

-- QR sessions — same fields as production
create table if not exists qr_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id),
  patient_ecdh_pubkey bytea not null,
  server_ecdh_pubkey bytea not null,
  server_ecdh_privkey bytea not null,    -- prod: KMS-wrapped
  resource_ids uuid[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending','consumed','expired','revoked')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists qr_sessions_status_idx on qr_sessions (status, expires_at);

-- Append-only audit log — HPCSA Booklet 9 pattern
create table if not exists audit_log (
  id uuid primary key default uuid_generate_v4(),
  actor_id uuid,
  actor_kind text not null check (actor_kind in ('patient','provider','system')),
  action text not null,
  target_type text not null,
  target_id uuid,
  details jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists audit_log_target_idx on audit_log (target_type, target_id);

-- Enforce append-only at the database level
create or replace function audit_log_immutable() returns trigger as $$
begin
  raise exception 'audit_log is append-only (HPCSA Booklet 9)';
end;
$$ language plpgsql;

drop trigger if exists audit_log_no_update on audit_log;
drop trigger if exists audit_log_no_delete on audit_log;
create trigger audit_log_no_update before update on audit_log
  for each row execute function audit_log_immutable();
create trigger audit_log_no_delete before delete on audit_log
  for each row execute function audit_log_immutable();

-- Seed a demo patient so we don't need an auth flow in v0
insert into users (id, display_name)
values ('11111111-1111-1111-1111-111111111111', 'Demo Patient')
on conflict (id) do nothing;
