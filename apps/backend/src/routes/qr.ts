import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { generateEcdhKeypair } from "@qurovita/crypto";
import { encodePayload } from "../qr/payload.js";
import { auditLog } from "../services/audit.js";

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
}
