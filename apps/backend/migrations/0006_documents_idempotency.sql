-- Add idempotency_key to documents for safe upload retry / deduplication.
-- Unique constraint is partial (WHERE idempotency_key IS NOT NULL) so rows
-- without a key don't collide with each other.

alter table documents
  add column if not exists idempotency_key text;

create unique index if not exists documents_idempotency_idx
  on documents (user_id, idempotency_key)
  where idempotency_key is not null;
