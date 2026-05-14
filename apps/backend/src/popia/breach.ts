// apps/backend/src/popia/breach.ts
//
// POPIA 72-hour breach detection.
//
// Rule: any server-side read of fhir_resources where user_id !== actor.sub
// is treated as a potential breach.  The caller MUST pass actorId and
// targetUserId; this module decides whether to log the access as suspicious.
//
// On detection:
//   1. Insert a row into breach_candidates (append-only audit trail).
//   2. Capture a Sentry event (SENTRY_DSN required in prod).
//   3. The daily BullMQ summary job collects unreviewed rows and could page
//      the Information Officer (wired in T6.4 — HUMAN ACTION NEEDED).
//
// The daily cron is registered at startup by calling scheduleDailySummary().

import type { Pool } from "pg";
import { pool as defaultPool } from "../db.js";
import { logger } from "../logger.js";
import * as Sentry from "@sentry/node";

// Lazy-init Sentry so missing DSN in dev is not fatal
let sentryReady = false;
function ensureSentry() {
  if (sentryReady) return;
  const dsn = process.env.SENTRY_DSN;
  if (dsn) {
    Sentry.init({ dsn, environment: process.env.NODE_ENV ?? "development" });
    sentryReady = true;
  }
}

export interface FhirAccessContext {
  actorId: string;
  actorKind: "patient" | "provider" | "system";
  targetUserId: string;
  resourceType?: string;
  queryParams?: Record<string, unknown>;
}

/**
 * Call this whenever server-side code reads fhir_resources.
 * If actorId !== targetUserId the access is logged to breach_candidates
 * and reported to Sentry.
 *
 * @param ctx  Access context
 * @param db   Overrideable pool — pass a mock in tests
 */
export async function checkFhirAccess(ctx: FhirAccessContext, db: Pool = defaultPool): Promise<void> {
  if (ctx.actorId === ctx.targetUserId) return;

  logger.warn(
    { actorId: ctx.actorId, targetUserId: ctx.targetUserId, resourceType: ctx.resourceType },
    "POPIA: cross-user fhir_resources access detected",
  );

  ensureSentry();
  const sentryEventId = sentryReady
    ? Sentry.captureMessage("POPIA: cross-user fhir_resources access", {
        level: "error",
        extra: { actorId: ctx.actorId, targetUserId: ctx.targetUserId, resourceType: ctx.resourceType },
      })
    : undefined;

  await db.query(
    `insert into breach_candidates
       (actor_id, actor_kind, target_user_id, query_context, sentry_event_id)
     values ($1, $2, $3, $4, $5)`,
    [
      ctx.actorId,
      ctx.actorKind,
      ctx.targetUserId,
      JSON.stringify({ resourceType: ctx.resourceType, queryParams: ctx.queryParams }),
      sentryEventId ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// Daily summary cron via BullMQ
// ---------------------------------------------------------------------------

/**
 * Register the daily breach-summary job.
 * Must be called once at server startup (see server.ts).
 * Requires Redis (REDIS_URL env var).
 *
 * 🔴 HUMAN ACTION NEEDED (T6.4): wire Sentry alert rule + PagerDuty integration
 * so the Information Officer is paged within 30 minutes of a new breach_candidate.
 */
export async function scheduleDailySummary(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.warn("REDIS_URL not set — breach summary cron not started");
    return;
  }

  const { Queue, Worker } = await import("bullmq");
  const connection = { url: redisUrl };

  const queue = new Queue("popia-breach-summary", { connection });

  // Repeatable job: every day at 08:00 SAST (UTC+2 = 06:00 UTC)
  await queue.upsertJobScheduler(
    "daily-breach-summary",
    { pattern: "0 6 * * *" },
    { name: "daily-breach-summary", data: {} },
  );

  new Worker(
    "popia-breach-summary",
    async () => {
      const result = await defaultPool.query<{ count: string }>(
        `select count(*)::text from breach_candidates where reviewed = false`,
      );
      const count = Number(result.rows[0].count);
      if (count > 0) {
        logger.error({ unreviewed_count: count }, `POPIA breach summary: ${count} unreviewed breach candidate(s)`);
        ensureSentry();
        if (sentryReady) {
          Sentry.captureMessage(`POPIA daily summary: ${count} unreviewed breach candidate(s)`, {
            level: "error",
            extra: { unreviewed_count: count },
          });
        }
      } else {
        logger.info("POPIA daily summary: no unreviewed breach candidates");
      }
    },
    { connection },
  );

  logger.info("POPIA breach summary cron scheduled (daily at 08:00 SAST)");
}
