-- docs/observability/popia-monitoring.sql
--
-- Daily aggregate queries for POPIA breach-detection monitoring of the AI
-- assistant. Run via cron (e.g. BullMQ daily job) or paste into Supabase
-- SQL editor. None of these queries modify data.
--
-- See BUILD_PLAN.md T6.3 for Datadog wiring; these are the manual controls.

-- ── 1. Pre-flight block storm detection ───────────────────────────────────────
-- Users with >50 pre-flight blocks in the past 24 hours.
-- Indicators: scripted abuse, confused patient looping, UI bug re-submitting.
select
  user_id,
  count(*)                          as preflight_blocks_24h,
  array_agg(distinct violation_tags) as tag_breakdown
from ai_compliance_log,
     unnest(violation_tags) as t(tag)
where
  verdict     = 'blocked'
  and occurred_at > now() - interval '24 hours'
  and tag like 'preflight.%'
group by user_id
having count(*) > 50
order by preflight_blocks_24h desc;

-- ── 2. Post-generation violations (past 7 days) ────────────────────────────────
-- Model output that slipped past the pre-flight check.
-- Highest priority: the model generated something it should not have.
-- Each row here is a potential HPCSA Booklet 20 compliance event.
select
  occurred_at::date as day,
  violation_tags,
  user_id,
  left(user_message, 120)  as truncated_input,
  left(model_response, 200) as truncated_output
from ai_compliance_log
where
  verdict     = 'blocked'
  and occurred_at > now() - interval '7 days'
  and violation_tags && array[
    'postgen.value_judgment',
    'postgen.diagnosis',
    'postgen.treatment_recommend',
    'postgen.document_analysis',
    'postgen.abnormal_flag',
    'postgen.value_with_unit',
    'postgen.dose_change'
  ]
order by occurred_at desc;

-- ── 3. i18n unreviewed-translation fallback usage ─────────────────────────────
-- Patients receiving un-reviewed isiZulu / Sesotho translations.
-- Should be zero once ZU_ST_TRANSLATIONS_REVIEWED is set true in ai-assistant.ts.
select
  count(*) as unreviewed_i18n_blocks_24h
from ai_compliance_log
where
  occurred_at > now() - interval '24 hours'
  and violation_tags @> array['i18n.unreviewed_fallback'];

-- ── 4. API timeout rate (past 30 days) ────────────────────────────────────────
-- Rising timeout rate is an early signal of Anthropic API degradation or
-- prompt token creep from future message-history features.
select
  occurred_at::date                                                         as day,
  count(*) filter (where violation_tags @> array['timeout'])                as timeouts,
  count(*)                                                                  as total_calls,
  round(
    100.0
    * count(*) filter (where violation_tags @> array['timeout'])
    / nullif(count(*), 0),
    1
  )                                                                         as timeout_pct
from ai_compliance_log
where occurred_at > now() - interval '30 days'
group by occurred_at::date
order by day desc;

-- ── 5. System prompt hash drift ────────────────────────────────────────────────
-- If multiple distinct hashes appear, the system prompt was modified in
-- production without the required SA health-law attorney sign-off.
-- A single hash across all rows is the expected steady state.
select
  system_prompt_sha256,
  min(occurred_at) as first_seen,
  max(occurred_at) as last_seen,
  count(*)         as call_count
from ai_compliance_log
group by system_prompt_sha256
order by first_seen;
