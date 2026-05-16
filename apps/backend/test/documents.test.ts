// T3.3 integration tests — POST /documents
// Mocks: @aws-sdk/client-s3 (S3), @aws-sdk/client-textract (Textract)
// Real: test DB (Postgres 5434), FHIR native client, audit_log
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import supertest from "supertest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db.js";

// ── Mock setup ────────────────────────────────────────────────────────────────

const { mockS3Send, mockTextractSend } = vi.hoisted(() => ({
  mockS3Send:      vi.fn(),
  mockTextractSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client:        vi.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: vi.fn().mockImplementation((p: unknown) => p),
}));

vi.mock("@aws-sdk/client-textract", () => ({
  TextractClient:      vi.fn().mockImplementation(() => ({ send: mockTextractSend })),
  AnalyzeDocumentCommand: vi.fn().mockImplementation((p: unknown) => p),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function lineBlock(text: string) {
  return { BlockType: "LINE", Text: text, Id: randomUUID() };
}

// Textract response for a generic lab document — enough to classify as "lab".
const labBlocks = [
  lineBlock("laboratory specimen pathologist"),
  lineBlock("Hospital: Test Lab Facility"),
  lineBlock("Date: 2026-01-14"),
  lineBlock("Patient Name: Test Patient"),
];

// Canonical PDF file — starts with %PDF (magic bytes for application/pdf).
const pdfBuffer = Buffer.from("%PDFtest document content here");

// ── App / auth setup ──────────────────────────────────────────────────────────

let app: FastifyInstance;
let request: ReturnType<typeof supertest>;
let token: string;
let userId: string;

beforeAll(async () => {
  app = await buildApp({ silent: true });
  await app.ready();
  request = supertest(app.server);

  // Use a unique phone to avoid conflicts with other test files.
  await request.post("/auth/otp-request").send({ phone: "+27830000010" });
  const res = await request
    .post("/auth/otp-verify")
    .send({ phone: "+27830000010", otp: "000000" });
  token  = (res.body as { token: string }).token;
  userId = (app.jwt.verify(token) as { sub: string }).sub;
});

afterAll(async () => {
  if (userId) {
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  }
  await app.close();
});

beforeEach(() => {
  mockS3Send.mockReset();
  mockTextractSend.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /documents", () => {
  // 1 — Happy path ─────────────────────────────────────────────────────────────
  it("uploads a PDF, runs OCR, returns 201 with document metadata", async () => {
    mockS3Send.mockResolvedValueOnce({});
    mockTextractSend.mockResolvedValueOnce({ Blocks: labBlocks });

    const res = await request
      .post("/documents")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pdfBuffer, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const body = res.body as {
      document_id: string;
      fhir_documentreference_id: string;
      doc_type: string;
      ocr_status: string;
    };
    expect(body.document_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.fhir_documentreference_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.doc_type).toBe("lab");
    expect(body.ocr_status).toBe("complete");
  });

  // 2 — Unauthenticated ────────────────────────────────────────────────────────
  it("returns 401 for unauthenticated request", async () => {
    await request
      .post("/documents")
      .attach("file", pdfBuffer, { filename: "test.pdf", contentType: "application/pdf" })
      .expect(401);
  });

  // 3 — Invalid MIME type (whitelist) ──────────────────────────────────────────
  it("returns 400 INVALID_MIME_TYPE for disallowed content-type", async () => {
    const res = await request
      .post("/documents")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("not a real doc"), {
        filename:    "evil.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("INVALID_MIME_TYPE");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  // 4 — Magic-byte mismatch (new — Tightening 1) ───────────────────────────────
  // Declares image/jpeg but sends PDF bytes. MIME whitelist passes;
  // magic-byte check catches the mismatch.
  it("returns 400 MIME_MISMATCH when declared MIME disagrees with file magic bytes", async () => {
    const res = await request
      .post("/documents")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pdfBuffer, { filename: "fake.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("MIME_MISMATCH");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  // 5 — File too large ─────────────────────────────────────────────────────────
  it("returns 400 FILE_TOO_LARGE for a file exceeding 20 MB", async () => {
    const bigBuffer = Buffer.alloc(21 * 1024 * 1024, 0x00);

    const res = await request
      .post("/documents")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", bigBuffer, { filename: "large.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("FILE_TOO_LARGE");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  // 6 — S3 failure ─────────────────────────────────────────────────────────────
  it("returns 502 and marks ocr_status=failed when S3 upload throws", async () => {
    mockS3Send.mockRejectedValueOnce(new Error("S3 unavailable"));

    const res = await request
      .post("/documents")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pdfBuffer, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(502);
    expect((res.body as { code: string }).code).toBe("S3_UPLOAD_FAILED");

    // Verify the documents row was pre-inserted and then marked failed.
    const row = await pool.query<{ ocr_status: string }>(
      `SELECT ocr_status FROM documents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(row.rows[0]?.ocr_status).toBe("failed");
  });

  // 7 — OCR / Textract failure ─────────────────────────────────────────────────
  it("returns 502 and marks ocr_status=failed when Textract throws", async () => {
    mockS3Send.mockResolvedValueOnce({});
    mockTextractSend.mockRejectedValueOnce(new Error("Textract unavailable"));

    const res = await request
      .post("/documents")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pdfBuffer, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(502);
    expect((res.body as { code: string }).code).toBe("OCR_FAILED");

    const row = await pool.query<{ ocr_status: string }>(
      `SELECT ocr_status FROM documents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(row.rows[0]?.ocr_status).toBe("failed");
  });

  // 8 — Pre-insert ordering ────────────────────────────────────────────────────
  // Assert the documents row exists with ocr_status='pending' at the moment
  // S3 is called — proves the INSERT happens BEFORE the upload, not after.
  it("pre-inserts the documents row before calling S3", async () => {
    let capturedDocId: string | undefined;

    mockS3Send.mockImplementationOnce(async (cmd: { Key: string }) => {
      capturedDocId = cmd.Key.split("/")[2]?.split(".")[0];
      const row = await pool.query<{ ocr_status: string }>(
        "SELECT ocr_status FROM documents WHERE id = $1",
        [capturedDocId],
      );
      expect(row.rows[0]?.ocr_status).toBe("pending");
      return {};
    });
    mockTextractSend.mockResolvedValueOnce({ Blocks: labBlocks });

    const res = await request
      .post("/documents")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pdfBuffer, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(capturedDocId).toBeDefined();
  });

  // 9 — Idempotency replay (new — Tightening 2) ────────────────────────────────
  // Second upload with the same Idempotency-Key returns the cached result
  // without calling S3 or Textract again.
  it("returns cached result on idempotency replay without re-uploading", async () => {
    const key = randomUUID();

    // First request — full pipeline
    mockS3Send.mockResolvedValueOnce({});
    mockTextractSend.mockResolvedValueOnce({ Blocks: labBlocks });

    const res1 = await request
      .post("/documents")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", key)
      .attach("file", pdfBuffer, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res1.status).toBe(201);
    const firstDocId = (res1.body as { document_id: string }).document_id;

    // Clear call counts before the second request.
    mockS3Send.mockClear();
    mockTextractSend.mockClear();

    // Second request — same key, same user
    const res2 = await request
      .post("/documents")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", key)
      .attach("file", pdfBuffer, { filename: "test.pdf", contentType: "application/pdf" });

    expect(res2.status).toBe(200);
    expect((res2.body as { document_id: string }).document_id).toBe(firstDocId);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockTextractSend).not.toHaveBeenCalled();
  });
});
