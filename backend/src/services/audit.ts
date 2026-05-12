// backend/src/services/audit.ts
import { pool } from "../db.js";

export interface AuditEvent {
  actor_id?: string | null;
  actor_kind: "patient" | "provider" | "system";
  action: string;
  target_type: string;
  target_id?: string | null;
  details?: unknown;
}

export async function auditLog(e: AuditEvent): Promise<void> {
  await pool.query(
    `insert into audit_log (actor_id, actor_kind, action, target_type, target_id, details)
     values ($1,$2,$3,$4,$5,$6)`,
    [e.actor_id ?? null, e.actor_kind, e.action, e.target_type, e.target_id ?? null, e.details ?? null],
  );
}
