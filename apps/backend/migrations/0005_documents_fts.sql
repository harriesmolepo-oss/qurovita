-- Add full-text search infrastructure to the documents table.
-- full_text_raw:    OCR LINE-block text stored verbatim.
-- full_text_search: tsvector maintained by trigger.
--   (to_tsvector is not immutable in Postgres, so GENERATED ALWAYS AS cannot
--    be used — an explicit BEFORE INSERT OR UPDATE trigger is required.)
-- Existing rows: both columns remain NULL until a future OCR run re-processes
--   the document. No existing rows are modified beyond adding the columns.

alter table documents
  add column if not exists full_text_raw    text,
  add column if not exists full_text_search tsvector;

create index if not exists documents_fts_idx
  on documents using gin (full_text_search);

create or replace function documents_fts_update()
  returns trigger language plpgsql as $$
begin
  new.full_text_search :=
    to_tsvector('english', coalesce(new.full_text_raw, ''));
  return new;
end;
$$;

drop trigger if exists documents_fts_trigger on documents;
create trigger documents_fts_trigger
  before insert or update of full_text_raw
  on documents
  for each row execute function documents_fts_update();
