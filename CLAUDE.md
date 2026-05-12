# QuroVita — Project Context for Claude Code

You are building QuroVita, a patient-sovereign health records platform for South Africa. The MVP is documented in `QuroVita_Master_Document_v2.docx` (the v2.0 master) and `BUILD_PLAN.md` (the executable backlog).

You already have a working v0 demo in the repo root (`backend/`, `clients/`). Your job is to evolve that into the full Phase 1 MVP per the build plan, while honouring the non-negotiables below.

---

## Non-negotiables — never violate

### Architecture
- **QR payload is a session initiator only (~2KB max).** Never put a FHIR bundle in a QR. The bundle transfers peer-to-peer (BLE / Wi-Fi Direct / WebSocket fallback) after the QR is scanned. QR Version 40 caps at 2,953 bytes; if a payload approaches 2,900 bytes, fail loudly.
- **Crypto algorithms (CSIR-mandated):** ECDH P-256, ECDSA P-256, HKDF-SHA256, AES-256-GCM. Use `@noble/curves` and `@noble/hashes`. Do not invent new schemes. Plan migration to post-quantum by 2028 but do not switch yet.
- **All data lives in AWS `af-south-1`** (Cape Town) — POPIA data residency. No cross-border resources. Supabase project must be in af-south-1. S3 buckets in af-south-1 with KMS encryption. Reject any AWS resource definition that omits or contradicts the region.
- **Append-only audit log enforced at the DB level** via REVOKE UPDATE/DELETE + trigger. Never relax this. Any code path that mutates `audit_log` outside an INSERT is a bug.

### SAHPRA Class A maintenance (Correction #3 from v2.0)
The OCR service is permitted to do:
- Document type classification (lab/prescription/discharge/imaging via pattern matching)
- Metadata extraction (date, facility name, patient name only)
- Full-text search indexing
- Write a `DocumentReference` FHIR resource pointing to the S3 original

The OCR service is **forbidden** from:
- Extracting clinical values (HbA1c, CD4, BP, glucose, etc.) into structured fields
- Flagging abnormal values
- Populating medication lists from images
- Any clinical interpretation

If you find yourself writing code that pulls a number out of a lab result into a typed field, **stop**. That is Class B/C territory and kills the project's regulatory pathway. The original document image is always the source of truth; clinicians view the original.

Every OCR job must write an audit_log entry that records both what was extracted AND what was deliberately NOT extracted, as a compliance fingerprint.

### HPCSA Booklet 20 AI compliance (Correction #5 from v2.0)
The AI assistant is permitted to:
- Define medical terms using WHO standard definitions
- Explain in general what a type of test measures (generic physiology)
- Suggest questions the patient could ask their doctor

The AI assistant is **forbidden** from:
- Interpreting a specific patient value
- Telling a patient what their numbers mean for them
- Suggesting a diagnosis
- Suggesting/changing/recommending medication, dosage, or treatment
- Analysing an uploaded patient document

The system prompt is hard-coded (see `apps/backend/src/services/ai-assistant.ts`). Do not modify it without written sign-off from a SA health-law attorney — flag the change to the user and ask for explicit confirmation before touching the prompt or the violation patterns.

Every AI call is logged to `ai_compliance_log` with a SHA-256 hash of the system prompt — this is the evidence trail. Tampering with the prompt changes the hash and breaks the trail.

Post-generation: every AI response is scanned by a regex/keyword classifier. Any response containing clinical interpretation, value commentary, diagnosis, or treatment suggestion is **blocked**, replaced with a safe fallback in the user's language (en/zu/st), and the violation is logged.

### POPIA
- Information Officer registration is admin work; you don't do it. But the privacy policy text, consent screen text, and 72-hour breach notification alerting are code: build them and surface drafts for human review.
- KYC: never store raw biometric blobs in the DB. Only Smile ID transaction IDs, status, scores.
- Row Level Security on every user-data table.
- Consent records are versioned with a SHA-256 hash of the exact text the user saw.

### Procurement reality
- Direct DoH / WCG procurement is **not** a Phase 1 path (PFMA Section 217, 18-24 month lead time). NGO MOUs only.
- If you generate any go-to-market or pilot copy, target TB HIV Care, Anova Health Institute, Right to Care, MSF Southern Africa. Never imply direct government procurement is happening in MVP.

---

## Stack you must use

| Layer | Tech |
|---|---|
| Backend | Node 20 + Fastify 4 + TypeScript 5 |
| FHIR | HAPI FHIR R4 server as Docker sidecar (Java), or `@medplum/core` Node-native — recommend HAPI, document the trade |
| DB | PostgreSQL 15 via Supabase (af-south-1) |
| Cache / queue | Redis + BullMQ |
| File storage | AWS S3 (af-south-1) + KMS |
| OCR | AWS Textract (af-south-1) — classification + metadata only |
| AI | Anthropic API, model `claude-sonnet-4-20250514` |
| WhatsApp | Twilio Messaging API + Redis state machine |
| KYC | Smile ID (POPIA Operator agreement required) |
| Mobile | React Native 0.74 + Expo 51, Android-first, min API 26 |
| P2P transport | `react-native-ble-plx@3.2` (peripheral mode) + Wi-Fi Direct fallback |
| Offline store | WatermelonDB |
| Provider portal | Next.js 14 (App Router) + Tailwind + shadcn/ui |
| IaC | Terraform 1.8+, af-south-1 only |
| CI | GitHub Actions |
| Mobile CI | Expo EAS |
| Monitoring | Sentry + Datadog |

Do not substitute these without flagging the trade-off to the user.

---

## Coding conventions
- **TypeScript everywhere** with `strict: true`. No `any` without a comment justifying it.
- **Zod** for every request body and external response.
- **pino** for structured logs (never `console.log` in app code).
- **No secrets in code or `.env` files committed to git.** Use AWS Secrets Manager (prod) and `.env.local` (dev, gitignored).
- **Tests:** vitest for unit, supertest for HTTP, Playwright for E2E. Crypto, OCR classifier, and AI compliance checks must have ≥90% test coverage — they are the legal-stakes pieces.
- **One concern per file.** If a service file passes 300 lines, split it.
- **Conventional commits** (`feat:`, `fix:`, `chore:`, `docs:`).
- **Don't auto-format files you didn't touch.**

---

## Operating instructions for Claude Code itself

1. **Start every session by re-reading `CLAUDE.md` and the current `BUILD_PLAN.md` checklist state.** Don't repeat completed work.
2. **Work one BUILD_PLAN.md task at a time.** Update the checkbox when done. Commit per task with a conventional commit message.
3. **Before writing code that touches OCR, AI, or crypto, restate the relevant non-negotiable in your reasoning.** It's a forcing function against drift.
4. **Run the tests after every meaningful change.** Don't move to the next task if the test suite is red.
5. **When you hit something that needs a human decision** — vendor account creation, secrets, a real signing key, an MOU draft to send — pause and tell the user clearly what you need from them. Don't fake it.
6. **Don't install packages not listed in the stack above without asking.** Check the existing `package.json` first.
7. **When in doubt about a regulatory line, refuse and surface to the user.** Better to ask than to ship something that costs Class A status.
8. **Never modify the AI system prompt or the violation regex patterns without explicit user approval.** These are the HPCSA evidence trail.
9. **Use the v0 demo code in `backend/` and `clients/` as the starting point, not as throw-away.** Refactor it into the monorepo structure described in BUILD_PLAN.md, don't rewrite from scratch.

---

## File map (target structure)

```
qurovita/
├── apps/
│   ├── backend/                  # Fastify + FHIR sidecar config
│   ├── mobile/                   # Expo / React Native
│   ├── provider-portal/          # Next.js 14
│   └── whatsapp-bot/             # Can live inside backend
├── packages/
│   ├── shared-types/             # zod schemas, FHIR types
│   ├── fhir-schemas/             # R4 validators
│   └── crypto/                   # OOB QR handshake + AES-GCM
├── infrastructure/
│   └── terraform/                # af-south-1 stack
├── supabase/
│   └── migrations/
├── .github/workflows/
├── CLAUDE.md
├── BUILD_PLAN.md
├── QuroVita_Master_Document_v2.docx
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

The v0 demo currently lives at the repo root; your first task is to move it into `apps/backend/` and `apps/provider-portal/` + `apps/mobile/` (eventually) without breaking the working flow.

---

## What "done" looks like for the MVP

- 12 weeks of work per `BUILD_PLAN.md`
- A patient on a Samsung A04e (R1k Android Go device) can install the app, complete KYC, scan a clinic QR, and share their FHIR bundle with a provider over BLE in <30 seconds with no cellular data.
- The provider portal renders the bundle read-only with the source-of-truth banner.
- All AI responses pass the 8-case compliance test set (4 allowed, 4 blocked) and zero violations in production logs.
- audit_log REVOKE UPDATE/DELETE is verified by an external DBA.
- SAHPRA SaMD Class A notification is filed and acknowledged.
- Privacy policy is live.
- 5 WC PHC clinics piloting via TB HIV Care or Anova partnership.
- All gates in `BUILD_PLAN.md` § Launch Readiness are green.

---

## When you finish a task, write a one-line entry to `PROGRESS.md`:
```
YYYY-MM-DD  task-id  short summary  commit-sha
```

This is how the human tracks what's been done across Claude Code sessions.
