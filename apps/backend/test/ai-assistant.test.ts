// T3.4 integration tests — POST /assistant/ask
// Mocks: @anthropic-ai/sdk (Anthropic client)
// Real: test DB (Postgres 5434), ai_compliance_log
//
// HPCSA Booklet 20 compliance: tests cover all 4 allowed + 4 blocked cases
// from CLAUDE.md, plus log integrity, prompt literal match, and SHA256 gate.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import supertest from "supertest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db.js";

// ── Mock setup ────────────────────────────────────────────────────────────────
// vi.hoisted — mockCreate is available inside the vi.mock factory.

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function allowedResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

const GENERIC_ALLOWED_TEXT =
  "HbA1c is a measure of average blood glucose levels over the past 2-3 months, according to WHO definitions.";

// Import after mocks are in place
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_SHA256,
} from "../src/services/ai-assistant.js";

// ── App / auth setup ──────────────────────────────────────────────────────────

let app: FastifyInstance;
let request: ReturnType<typeof supertest>;
let token: string;
let userId: string;

beforeAll(async () => {
  app = await buildApp({ silent: true });
  await app.ready();
  request = supertest(app.server);

  await request.post("/auth/otp-request").send({ phone: "+27830000020" });
  const res = await request
    .post("/auth/otp-verify")
    .send({ phone: "+27830000020", otp: "000000" });
  token  = (res.body as { token: string }).token;
  userId = (app.jwt.verify(token) as { sub: string }).sub;
});

afterAll(async () => {
  // ai_compliance_log has ON DELETE SET NULL for user_id. Postgres issues an UPDATE
  // to null-out references when the user row is deleted, but the table's BEFORE UPDATE
  // trigger (append-only guard) blocks that. We accept the orphaned rows in the test DB:
  // the phone "+27830000020" is reserved for these tests and the same userId is reused
  // on subsequent runs via the OTP upsert, so there is no inter-run interference.
  if (userId) {
    await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => { /* see above */ });
  }
  await app.close();
});

beforeEach(() => {
  mockCreate.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /assistant/ask", () => {

  // ── Allowed cases (model is called, response passes) ─────────────────────────

  // 1 — Define a medical term (WHO definition)
  it("allowed: returns model response for a term definition request", async () => {
    mockCreate.mockResolvedValueOnce(allowedResponse(GENERIC_ALLOWED_TEXT));

    const res = await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "What is HbA1c?", language: "en" });

    expect(res.status).toBe(200);
    const body = res.body as { verdict: string; text: string; violations: string[] };
    expect(body.verdict).toBe("allowed");
    expect(body.text).toContain("HbA1c");
    expect(body.violations).toHaveLength(0);
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  // 2 — Explain what a test measures (generic physiology)
  it("allowed: returns model response for a generic test explanation", async () => {
    mockCreate.mockResolvedValueOnce(
      allowedResponse("A full blood count measures the number and types of blood cells circulating in your body."),
    );

    const res = await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "What does a full blood count measure in general?", language: "en" });

    expect(res.status).toBe(200);
    expect((res.body as { verdict: string }).verdict).toBe("allowed");
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  // 3 — Suggest questions to ask the doctor
  it("allowed: returns model response for a 'questions for my doctor' request", async () => {
    mockCreate.mockResolvedValueOnce(
      allowedResponse("You could ask your doctor: What does my cholesterol level mean for my heart health?"),
    );

    const res = await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "What questions should I ask my doctor about cholesterol?", language: "en" });

    expect(res.status).toBe(200);
    expect((res.body as { verdict: string }).verdict).toBe("allowed");
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  // 4 — General health education
  it("allowed: returns model response for general health education", async () => {
    mockCreate.mockResolvedValueOnce(
      allowedResponse("The pancreas is a gland that produces insulin and digestive enzymes."),
    );

    const res = await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "What is the role of the pancreas?", language: "en" });

    expect(res.status).toBe(200);
    expect((res.body as { verdict: string }).verdict).toBe("allowed");
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  // ── Blocked cases — pre-flight (model is NOT called) ─────────────────────────

  // 5 — Pre-flight: interpret specific result
  it("blocked pre-flight: 'what does my HbA1c result mean' is blocked before API call", async () => {
    const res = await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "What does my HbA1c result mean?", language: "en" });

    expect(res.status).toBe(200);
    const body = res.body as { verdict: string; violations: string[] };
    expect(body.verdict).toBe("blocked");
    expect(body.violations).toContain("preflight.what_does_mine_mean");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // 6 — Pre-flight: "do I have diabetes"
  it("blocked pre-flight: 'do I have diabetes' is blocked before API call", async () => {
    const res = await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Do I have diabetes?", language: "en" });

    expect(res.status).toBe(200);
    const body = res.body as { verdict: string; violations: string[] };
    expect(body.verdict).toBe("blocked");
    expect(body.violations).toContain("preflight.do_i_have");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── Blocked cases — post-generation (model IS called, output blocked) ─────────

  // 7 — Post-gen: value judgment in model output
  it("blocked post-gen: model output containing value judgment is blocked", async () => {
    mockCreate.mockResolvedValueOnce(
      allowedResponse("Your HbA1c level is elevated based on standard reference ranges."),
    );

    const res = await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "What is HbA1c in general terms?", language: "en" });

    expect(res.status).toBe(200);
    const body = res.body as { verdict: string; violations: string[] };
    expect(body.verdict).toBe("blocked");
    expect(body.violations).toContain("postgen.value_judgment");
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  // 8 — Post-gen: diagnosis suggestion in model output
  it("blocked post-gen: model output containing diagnosis suggestion is blocked", async () => {
    mockCreate.mockResolvedValueOnce(
      allowedResponse("Based on your description, you may have type 2 diabetes or pre-diabetes."),
    );

    const res = await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Tell me about glucose tests.", language: "en" });

    expect(res.status).toBe(200);
    const body = res.body as { verdict: string; violations: string[] };
    expect(body.verdict).toBe("blocked");
    expect(body.violations).toContain("postgen.diagnosis");
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  // ── Additional tests ──────────────────────────────────────────────────────────

  // 9 — Disclaimer is appended when the model omits it
  it("appends disclaimer when model response does not include it", async () => {
    mockCreate.mockResolvedValueOnce(
      allowedResponse("The liver is the largest internal organ and performs over 500 functions."),
    );

    const res = await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "What does the liver do?", language: "en" });

    expect(res.status).toBe(200);
    const body = res.body as { verdict: string; text: string };
    expect(body.verdict).toBe("allowed");
    expect(body.text).toContain("This is general health information only");
    expect(body.text).toContain("Please discuss your personal health with your doctor");
  });

  // 10 — ai_compliance_log row is written correctly for allowed calls
  it("writes an ai_compliance_log row with correct data for an allowed call", async () => {
    mockCreate.mockResolvedValueOnce(allowedResponse("Haemoglobin carries oxygen in red blood cells."));

    await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "What is haemoglobin?", language: "en" });

    const row = await pool.query<{
      verdict: string;
      model_response: string | null;
      violation_tags: string[] | null;
      system_prompt_sha256: string;
    }>(
      `SELECT verdict, model_response, violation_tags, system_prompt_sha256
       FROM ai_compliance_log
       WHERE user_id = $1
       ORDER BY occurred_at DESC LIMIT 1`,
      [userId],
    );

    expect(row.rows[0]?.verdict).toBe("allowed");
    expect(row.rows[0]?.model_response).not.toBeNull();
    expect(row.rows[0]?.violation_tags).toEqual([]);
    expect(row.rows[0]?.system_prompt_sha256).toBe(SYSTEM_PROMPT_SHA256);
  });

  // 11 — Pre-flight blocked call records model_response = null in the log
  it("records model_response = null in ai_compliance_log for pre-flight blocks", async () => {
    await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Is my glucose level too high?", language: "en" });

    const row = await pool.query<{
      verdict: string;
      model_response: string | null;
      violation_tags: string[];
    }>(
      `SELECT verdict, model_response, violation_tags
       FROM ai_compliance_log
       WHERE user_id = $1
       ORDER BY occurred_at DESC LIMIT 1`,
      [userId],
    );

    expect(row.rows[0]?.verdict).toBe("blocked");
    expect(row.rows[0]?.model_response).toBeNull();
    expect(row.rows[0]?.violation_tags).toContain("preflight.is_my_x_bad");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // 12 — SYSTEM_PROMPT_SHA256 exported by the module matches the prompt
  it("SYSTEM_PROMPT_SHA256 is the correct SHA-256 of SYSTEM_PROMPT", () => {
    const computed = createHash("sha256").update(SYSTEM_PROMPT).digest("hex");
    expect(SYSTEM_PROMPT_SHA256).toBe(computed);
  });

  // 13 — Unauthenticated request returns 401
  it("returns 401 for unauthenticated request", async () => {
    await request
      .post("/assistant/ask")
      .send({ message: "What is cholesterol?", language: "en" })
      .expect(401);
  });

  // 14 — Message exceeding 500 characters returns 400 INPUT_TOO_LONG
  it("returns 400 INPUT_TOO_LONG for messages exceeding 500 characters", async () => {
    const longMessage = "a".repeat(501);

    const res = await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: longMessage, language: "en" });

    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("INPUT_TOO_LONG");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // 15 — Positive control: system prompt literal match + SHA256 in DB
  // Protects against the failure mode where someone refactors SYSTEM_PROMPT
  // and tests still pass because the mock was not updated to care about the prompt.
  it("positive control: mockCreate is called with the literal SYSTEM_PROMPT and log SHA256 matches", async () => {
    mockCreate.mockResolvedValueOnce(allowedResponse("Cholesterol is a fatty substance found in all cells."));

    await request
      .post("/assistant/ask")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "What is cholesterol?", language: "en" });

    // Assert the exact system prompt was passed to the Anthropic SDK.
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArg = mockCreate.mock.calls[0]?.[0] as { system?: string };
    expect(callArg.system).toBe(SYSTEM_PROMPT);

    // Assert the SHA-256 written to the DB matches the prompt actually used.
    const expectedSha = createHash("sha256").update(SYSTEM_PROMPT).digest("hex");
    const row = await pool.query<{ system_prompt_sha256: string }>(
      `SELECT system_prompt_sha256
       FROM ai_compliance_log
       WHERE user_id = $1
       ORDER BY occurred_at DESC LIMIT 1`,
      [userId],
    );
    expect(row.rows[0]?.system_prompt_sha256).toBe(expectedSha);
  });

});
