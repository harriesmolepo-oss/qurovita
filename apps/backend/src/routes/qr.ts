import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { generateEcdhKeypair } from "@qurovita/crypto";
import { encodePayload } from "../qr/payload.js";
import { auditLog } from "../services/audit.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function qrRoutes(app: FastifyInstance) {
  app.get("/keys/ecdsa", async (_req, reply) => {
    return reply.send({ pub_compressed_hex: app.kms.pubHex });
  });

  app.post("/qr-sessions", async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const body = req.body as {
      patientPubKey?: string;
      ble?: string;
      wfd?: string;
    } | undefined;

    if (!body?.patientPubKey) {
      return reply.code(400).send({ error: "patientPubKey required" });
    }
    const patientPub = Buffer.from(body.patientPubKey, "base64");
    if (patientPub.length !== 33) {
      return reply.code(400).send({ error: "patientPubKey must be 33-byte compressed P-256" });
    }
    if (patientPub[0] !== 0x02 && patientPub[0] !== 0x03) {
      return reply.code(400).send({ error: "patientPubKey must be compressed P-256 (0x02 or 0x03 prefix)" });
    }

    const { priv: serverPriv, pubCompressed: serverPub } = generateEcdhKeypair();
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const sidBuf = Buffer.from(sessionId.replace(/-/g, ""), "hex");
    const cborPayload = encodePayload({
      v: 1,
      sid: sidBuf,
      spk: Buffer.from(serverPub),
      exp: Math.floor(expiresAt.getTime() / 1000),
      ...(body.ble && { ble: body.ble }),
      ...(body.wfd && { wfd: body.wfd }),
    });

    // SHA-256 is applied internally by signerFn — pass raw CBOR bytes, do not pre-hash
    const sig = await app.kms.signerFn(cborPayload);
    // server_privkey stores wrapPrivkey() ciphertext (60 bytes dev / KMS blob prod),
    // not the raw 32-byte scalar. Callers must unwrapPrivkey() before deriveSharedKey().
    const wrappedPriv = await app.kms.wrapPrivkey(serverPriv);

    await pool.query(
      `insert into qr_sessions
         (id, patient_user_id, patient_pubkey, server_privkey, server_pubkey,
          ble_address, wifi_direct_ssid, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        sessionId,
        userId,
        patientPub,
        Buffer.from(wrappedPriv),
        Buffer.from(serverPub),
        body.ble ?? null,
        body.wfd ?? null,
        expiresAt,
      ],
    );

    await auditLog({
      actor_id: userId, actor_kind: "patient",
      action: "qr.session.create", target_type: "QrSession", target_id: sessionId,
      details: { ttl_seconds: 5 * 60 },
    });

    return reply.code(201).send({
      sessionId,
      payload: cborPayload.toString("base64"),
      signature: Buffer.from(sig).toString("base64"),
      expiresAt: expiresAt.toISOString(),
    });
  });

  /**
   * Provider or patient reads session liveness.
   * Pure read — never gates, never 410. Reports derived booleans from timestamp columns.
   * Auth-exempt: /shared/ prefix is in the isExempt set; no isExempt edit needed.
   */
  app.get("/shared/qr-sessions/:id/status", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: "session id format invalid" });
    }
    const r = await pool.query<{
      expires_at: Date;
      revoked_at: Date | null;
      claimed_at: Date | null;
    }>(
      `select expires_at, revoked_at, claimed_at from qr_sessions where id = $1`,
      [id],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "session not found" });
    const row = r.rows[0];
    const active =
      row.expires_at.getTime() > Date.now() &&
      row.revoked_at === null &&
      row.claimed_at === null;
    return reply.send({
      active,
      expiresAt: row.expires_at.toISOString(),
      claimed: row.claimed_at !== null,
    });
  });

  /**
   * Patient revokes their own session (sets revoked_at). Idempotent — second
   * call is a no-op (COALESCE keeps existing timestamp) and still returns 204.
   * Returns 403 if the JWT sub does not match patient_user_id.
   */
  app.post("/qr-sessions/:id/revoke", async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const id = (req.params as { id: string }).id;
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: "session id format invalid" });
    }
    const r = await pool.query<{ patient_user_id: string }>(
      `select patient_user_id from qr_sessions where id = $1`,
      [id],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "session not found" });
    if (r.rows[0].patient_user_id !== userId) {
      return reply.code(403).send({ error: "forbidden" });
    }
    await pool.query(
      `update qr_sessions set revoked_at = coalesce(revoked_at, now()) where id = $1`,
      [id],
    );
    await auditLog({
      actor_id: userId, actor_kind: "patient",
      action: "qr.session.revoke", target_type: "QrSession", target_id: id,
    });
    return reply.code(204).send();
  });

  /**
   * Provider claims a pending session (sets claimed_at). NOT idempotent.
   * Claim-order contract (hard): expired(410) > revoked(409) > claimed(409) > set+204.
   * expires_at is evaluated first — it wins over all status columns.
   * Auth-exempt: /shared/ prefix is in the isExempt set; no isExempt edit needed.
   */
  app.post("/shared/qr-sessions/:id/claim", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: "session id format invalid" });
    }
    const r = await pool.query<{
      patient_user_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      claimed_at: Date | null;
    }>(
      `select patient_user_id, expires_at, revoked_at, claimed_at
       from qr_sessions where id = $1`,
      [id],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "session not found" });
    const row = r.rows[0];
    // [1] expires_at checked FIRST — wins over revoked and already-claimed.
    if (row.expires_at.getTime() < Date.now()) {
      // INSERT-only for expired rows: log the attempt with claimed_at pre-set to expires_at.
      await auditLog({
        actor_id: null, actor_kind: "provider",
        action: "qr.session.claim", target_type: "QrSession", target_id: id,
        details: { failed_reason: "expired", claimed_at: row.expires_at.toISOString() },
      });
      return reply.code(410).send({ error: "session expired" });
    }
    // [2] revoked
    if (row.revoked_at !== null) return reply.code(409).send({ error: "session revoked" });
    // [3] already claimed
    if (row.claimed_at !== null) return reply.code(409).send({ error: "session already claimed" });
    // [4] set + 204
    await pool.query(
      `update qr_sessions set claimed_at = now() where id = $1`,
      [id],
    );
    await auditLog({
      actor_id: null, actor_kind: "provider",
      action: "qr.session.claim", target_type: "QrSession", target_id: id,
      details: { patient_user_id: row.patient_user_id },
    });
    return reply.code(204).send();
  });
}
