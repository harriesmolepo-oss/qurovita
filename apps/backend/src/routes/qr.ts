// backend/src/routes/qr.ts
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { createSessionAsync, SESSION_TTL_SECONDS } from "@qurovita/crypto";
import { getSigningState } from "../kms.js";
import { auditLog } from "../services/audit.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function qrRoutes(app: FastifyInstance) {
  /**
   * Patient calls this to start a share session.
   * Body: { patient_pub_compressed_hex }
   * Response: { session_id, qr_bytes_hex, server_pub_compressed_hex, expires_at, websocket_url }
   */
  app.post("/qr-sessions", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const body = req.body as { patient_pub_compressed_hex?: string } | undefined;
    if (!body?.patient_pub_compressed_hex) {
      return reply.code(400).send({ error: "patient_pub_compressed_hex required" });
    }
    const patientPub = Buffer.from(body.patient_pub_compressed_hex, "hex");
    if (patientPub.length !== 33) {
      return reply.code(400).send({ error: "patient pubkey must be 33-byte compressed P-256" });
    }

    const { signerFn, wrapPrivkey } = await getSigningState();
    const sessionId = randomUUID();
    const websocketUrl = `ws://localhost:${process.env.PORT ?? 3000}/ws/${sessionId}`;

    const created = await createSessionAsync({
      sessionId,
      patientPubCompressed: new Uint8Array(patientPub),
      websocketUrl,
      signerFn,
    });

    const wrappedPriv = await wrapPrivkey(created.serverEcdhPriv);
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

    await pool.query(
      `insert into qr_sessions
         (id, user_id, patient_ecdh_pubkey, server_ecdh_pubkey, server_ecdh_privkey, expires_at)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        sessionId,
        userId,
        patientPub,
        Buffer.from(created.serverEcdhPubCompressed),
        Buffer.from(wrappedPriv),
        expiresAt,
      ],
    );

    await auditLog({
      actor_id: userId, actor_kind: "patient",
      action: "qr.session.create", target_type: "QrSession", target_id: sessionId,
      details: { ttl_seconds: SESSION_TTL_SECONDS },
    });

    return reply.send({
      session_id: sessionId,
      qr_bytes_hex: Buffer.from(created.qrBytes).toString("hex"),
      server_pub_compressed_hex: Buffer.from(created.serverEcdhPubCompressed).toString("hex"),
      expires_at: expiresAt.toISOString(),
      websocket_url: websocketUrl,
    });
  });

  /**
   * Provider fetches QR payload by session id (demo flow; real flow uses camera scan).
   */
  app.get("/qr-sessions/:id/payload", async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: "session id format invalid" });
    }
    const r = await pool.query(
      `select id, server_ecdh_pubkey, expires_at, status
       from qr_sessions where id = $1`,
      [id],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "session not found" });
    const row = r.rows[0];
    if (row.status !== "pending") return reply.code(410).send({ error: `session ${row.status}` });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return reply.code(410).send({ error: "session expired" });
    }
    return reply.send({
      session_id: id,
      server_pub_compressed_hex: row.server_ecdh_pubkey.toString("hex"),
      expires_at: row.expires_at,
    });
  });

  /**
   * Publishes the QuroVita ECDSA verification public key.
   */
  app.get("/keys/ecdsa", async (_req, reply) => {
    const { pubHex } = await getSigningState();
    return reply.send({ pub_compressed_hex: pubHex });
  });

  /**
   * Patient revokes a pending session.
   */
  app.post("/qr-sessions/:id/revoke", async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const id = (req.params as any).id as string;
    if (!UUID_RE.test(id)) {
      return reply.code(400).send({ error: "session id format invalid" });
    }
    const r = await pool.query(
      `update qr_sessions set status='revoked'
       where id = $1 and status='pending' returning id`,
      [id],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "not found or already consumed" });
    await auditLog({
      actor_id: userId, actor_kind: "patient",
      action: "qr.session.revoke", target_type: "QrSession", target_id: id,
    });
    return reply.send({ revoked: true });
  });
}
