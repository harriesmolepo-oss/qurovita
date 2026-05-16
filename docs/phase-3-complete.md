# Phase 3 Complete — Compliance Summary for SAHPRA / Clinical Advisors

**Date:** 2026-05-16  
**Prepared by:** QuroVita engineering team  
**Purpose:** One-page record of what regulatory rules are now enforced in code, where they live, and what still needs human action before patient #1.

---

## What Phase 3 built

Two services that sit between patients and their health data:

1. **Document ingestion** (`POST /documents`) — a patient uploads a file (PDF, JPEG, PNG, TIFF). The system validates it, stores the original on encrypted AWS S3 in Cape Town (`af-south-1`), and runs text extraction to make the document searchable. The original file is always the source of truth; no clinical values are extracted.

2. **Health literacy assistant** (`POST /assistant/ask`) — a patient can ask plain-language health questions. The system answers using the Anthropic AI model, but only within strictly defined boundaries. Clinical interpretation is blocked before a response ever reaches the patient.

---

## SAHPRA Class A boundary — OCR service

**What the code is permitted to do:**
- Classify document type (lab report, prescription, discharge summary, imaging, referral)
- Extract administrative metadata: document date, facility name, patient name only
- Index full text for search
- Create a FHIR DocumentReference record pointing to the S3 original

**What the code explicitly does not do (enforced, not aspirational):**
- Extract clinical values (HbA1c, CD4 count, glucose, blood pressure, etc.) into structured fields
- Flag or evaluate whether a result is normal or abnormal
- Populate medication lists from images
- Produce any clinical interpretation

**Where it lives:**  
`apps/backend/src/services/ocr-safe.ts` (434 lines)
- Lines 3–66: compliance boundary comment block and design rationale
- Lines 159–174: `CLASSIFIER_VERSION_SHA256` — a hash of all classifier patterns, recorded in every audit log entry so a future regulator can verify exactly which classifier processed each document
- Lines 176–285: `classifyDocument()`, `extractDate()`, `extractFacilityName()`, `extractPatientName()` — the only permitted extraction functions
- Lines 381–420: mandatory `audit_log` INSERT on every OCR job, recording both what was extracted and what was deliberately not extracted

`apps/backend/src/routes/documents.ts` (147 lines): validates MIME type and file magic bytes before any processing begins. A file claiming to be a PDF is rejected if its binary content is not actually a PDF.

---

## HPCSA Booklet 20 boundary — AI assistant

**What the AI is permitted to say:**
- Definitions of medical terms (using WHO standard definitions)
- General explanations of what a type of test measures (physiology only, no patient-specific context)
- Questions the patient could ask their doctor

**What the AI is blocked from saying:**
- Any interpretation of a specific patient result or value
- Any suggestion, implication, or confirmation of a diagnosis
- Any recommendation about medication, dosage, or treatment
- Any analysis of an uploaded patient document

**How the block is enforced — two layers:**

1. **Pre-flight check** (before the AI model is called): five regex patterns scan the patient's input. If the question is clearly asking for clinical interpretation ("what does my result mean?", "do I have diabetes?"), the request is blocked immediately. The AI model is never called. Cost: zero.

2. **Post-generation check** (after the AI model responds): seven regex patterns scan the model's output. If the model produces a value judgment, diagnosis suggestion, or treatment recommendation despite the system prompt, the response is replaced with a safe fallback before the patient sees it.

Every call — allowed, blocked, pre-flight, or timeout — writes a row to `ai_compliance_log` with the system prompt's SHA-256 hash. This means any modification to the system prompt is detectable from the evidence trail.

**Where it lives:**  
`apps/backend/src/services/ai-assistant.ts` (321 lines)
- Lines 23–47: `SYSTEM_PROMPT` — the hard-coded, immutable instruction to the AI model. Changing this text changes the SHA-256 hash recorded in all future log rows, breaking the evidence chain. Requires SA health-law attorney written sign-off.
- Lines 80–112: `PRE_FLIGHT_PATTERNS` — 5 named patterns applied to patient input
- Lines 114–161: `POST_GEN_PATTERNS` — 7 named patterns applied to model output
- Lines 200–225: `writeComplianceLog()` — mandatory `ai_compliance_log` INSERT on every call

`apps/backend/src/routes/assistant.ts` (43 lines): HTTP endpoint. Returns `{ verdict, text, violations }` with HTTP 200 for both allowed and blocked responses — the mobile app branches on `verdict`, not the HTTP status code.

`docs/observability/popia-monitoring.sql`: five daily SQL queries for POPIA monitoring — pre-flight block storms (possible abuse indicator), post-generation violations (highest-priority review), i18n fallback usage, API timeout rate, and system prompt hash drift detection.

---

## Pending before patient #1 — human actions required

These three items cannot be completed by the engineering team:

1. **AWS credentials and S3 bucket** — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and an IAM user with `s3:PutObject` on `qurovita-documents` (Cape Town, `af-south-1`, SSE-KMS). Until provisioned, document uploads fail at the S3 step. Set in `.env.local` (never committed). See `.env.example` for the full list.

2. **Anthropic API key** — `ANTHROPIC_API_KEY` in `.env.local`. Production key must be stored in AWS Secrets Manager, not in any file. Until set, the AI assistant returns a configuration error on live calls (mocked tests pass without it).

3. **isiZulu and Sesotho fallback string review** — the safe fallback responses shown to patients when a query is blocked are currently drafted but marked unreviewed (`ZU_ST_TRANSLATIONS_REVIEWED = false` in `ai-assistant.ts`, line 55). Until a clinical advisor and native speaker sign off on each translation, the system falls back to English for all blocked isiZulu and Sesotho queries. This is a named gate in `BUILD_PLAN.md` Launch Readiness — it must be `true` before patient-facing rollout.

---

## Test coverage

| Component | Tests | Coverage focus |
|---|---|---|
| OCR classifier (`ocr-safe.ts`) | 28 | ≥90% accuracy on 30 document fixtures; no clinical-value fields in output |
| Document upload (`POST /documents`) | 9 | S3, OCR, MIME validation, magic bytes, idempotency, pre-insert ordering |
| AI assistant | 15 | All 8 CLAUDE.md compliance cases; log integrity; system prompt literal match; SHA-256 consistency |

All 78 tests pass. Round-trip crypto verification (patient → encrypted bundle → provider → decrypted) also passes end-to-end.
