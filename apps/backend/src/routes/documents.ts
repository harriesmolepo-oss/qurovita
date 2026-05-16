// apps/backend/src/routes/documents.ts
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { pool } from "../db.js";
import { processDocument } from "../services/ocr-safe.js";
import { uploadToS3, checkMagicBytes, MIME_TO_EXT } from "../services/s3.js";
import { logger } from "../logger.js";

const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
]);

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

// UUID v4 — enforced to prevent injection via the Idempotency-Key header.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const documentsRoute: FastifyPluginAsync = async (app) => {
  app.post("/documents", async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    // ── Idempotency ──────────────────────────────────────────────────────────
    // Optional header. If present and a matching row exists, return cached
    // result without re-uploading — safe for mobile retries and double-clicks.
    const idempotencyKey = request.headers["idempotency-key"] as
      | string
      | undefined;
    if (idempotencyKey !== undefined) {
      if (!UUID_RE.test(idempotencyKey)) {
        return reply.status(400).send({ code: "INVALID_IDEMPOTENCY_KEY" });
      }
      const hit = await pool.query<{
        id: string;
        fhir_ref_id: string | null;
        doc_type: string | null;
        ocr_status: string;
      }>(
        `SELECT d.id, fr.fhir_id AS fhir_ref_id, d.doc_type, d.ocr_status
         FROM documents d
         LEFT JOIN fhir_resources fr ON fr.id = d.fhir_ref_id
         WHERE d.idempotency_key = $1 AND d.user_id = $2`,
        [idempotencyKey, userId],
      );
      if (hit.rows[0]) {
        const row = hit.rows[0];
        return reply.status(200).send({
          document_id:               row.id,
          fhir_documentreference_id: row.fhir_ref_id ?? null,
          doc_type:                  row.doc_type ?? null,
          ocr_status:                row.ocr_status,
        });
      }
    }

    // ── Parse multipart ──────────────────────────────────────────────────────
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ code: "NO_FILE" });
    }

    // ── MIME whitelist (declared content-type) ───────────────────────────────
    if (!ALLOWED_MIMES.has(data.mimetype)) {
      data.file.resume(); // drain to prevent memory leak
      return reply.status(400).send({ code: "INVALID_MIME_TYPE" });
    }

    // ── Buffer + size ────────────────────────────────────────────────────────
    const buffer = await data.toBuffer();
    if (buffer.length > MAX_FILE_BYTES) {
      return reply.status(400).send({ code: "FILE_TOO_LARGE" });
    }

    // ── Magic-byte check (actual content vs declared MIME) ───────────────────
    // Malicious clients can label any file as application/pdf. Textract and
    // downstream PDF renderers have been exploited via malformed PDF parsers.
    if (!checkMagicBytes(buffer, data.mimetype)) {
      return reply.status(400).send({ code: "MIME_MISMATCH" });
    }

    // ── Prepare identifiers ──────────────────────────────────────────────────
    const documentId = randomUUID();
    const ext        = MIME_TO_EXT[data.mimetype];
    const bucket     = process.env.AWS_S3_BUCKET ?? "qurovita-documents";
    const key        = `documents/${userId}/${documentId}.${ext}`;

    // ── Pre-insert documents row ─────────────────────────────────────────────
    // Row created BEFORE S3 call so every upload attempt is traceable even
    // when a downstream step fails (audit trail is never gapped).
    await pool.query(
      `INSERT INTO documents
         (id, user_id, s3_bucket, s3_key, mime_type, file_size_bytes,
          ocr_status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
      [
        documentId, userId, bucket, key, data.mimetype,
        buffer.length, idempotencyKey ?? null,
      ],
    );

    // ── S3 upload ────────────────────────────────────────────────────────────
    try {
      await uploadToS3({
        bucket,
        key,
        body: buffer,
        mimeType: data.mimetype,
        kmsKeyId: process.env.AWS_KMS_KEY_ID,
      });
    } catch (err) {
      await pool.query(
        `UPDATE documents SET ocr_status = 'failed' WHERE id = $1`,
        [documentId],
      );
      logger.error({ err, userId, documentId }, "documents: S3 upload failed");
      return reply.status(502).send({ code: "S3_UPLOAD_FAILED" });
    }

    // ── OCR pipeline ─────────────────────────────────────────────────────────
    // Synchronous inline call. Textract takes ~1-4 s per page at MVP scale.
    // Move to BullMQ async queue in Phase 6 when request latency budget tightens.
    let result: Awaited<ReturnType<typeof processDocument>>;
    try {
      result = await processDocument({
        userId,
        documentId,
        bucket,
        key,
        mimeType: data.mimetype,
      });
    } catch (err) {
      // processDocument already marks ocr_status = 'failed'
      logger.error({ err, userId, documentId }, "documents: OCR pipeline failed");
      return reply.status(502).send({ code: "OCR_FAILED" });
    }

    return reply.status(201).send({
      document_id:               documentId,
      fhir_documentreference_id: result.documentReference.id ?? null,
      doc_type:                  result.docType,
      ocr_status:                "complete",
    });
  });
};
