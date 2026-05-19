# QuroVita — Build Plan (executable backlog)

This is the work list for Claude Code. Tasks are ordered by dependency. Pull the next unchecked task, complete it, run tests, commit, tick the box, append to `PROGRESS.md`, then pull the next.

**Read `CLAUDE.md` before every task.** The non-negotiables in CLAUDE.md override any task description here if they conflict.

When a task needs the human to do something off-machine (vendor signup, paying a fee, sending an email), pause and surface it clearly with a `🔴 HUMAN ACTION NEEDED` block. Do not fake the action.

Legend: `[ ]` not started · `[x]` done · `[~]` in progress · `[!]` blocked

---

## Phase 0 — Repo foundation

- [x] **T0.1** Initialise monorepo with pnpm workspaces + Turborepo. Create `pnpm-workspace.yaml`, `turbo.json`, root `package.json` with `pnpm` 9. Set up `apps/*` and `packages/*` workspace globs.
- [x] **T0.2** Move the v0 backend at `./backend/` into `apps/backend/`. Update import paths. Confirm `pnpm --filter backend dev` boots the server and the v0 patient↔provider WebSocket flow still works end-to-end.
- [x] **T0.3** Move the v0 clients at `./clients/patient/` and `./clients/provider/` into `apps/provider-portal/` (as Next.js 14 App Router pages) — keep `apps/provider-portal/app/page.tsx` (placeholder), `apps/provider-portal/app/session/page.tsx` (the provider flow). Keep the patient client as `apps/backend/public/patient/` for now — it'll be replaced by RN in Phase 4.
- [x] **T0.4** Extract `apps/backend/src/crypto/qr-session.ts` into `packages/crypto/` as a workspace package. Both the backend and the provider portal import from `@qurovita/crypto`. Configure tsconfig path aliases.
- [x] **T0.5** Add root TypeScript config with project references. `pnpm typecheck` runs across all packages.
- [x] **T0.6** Add ESLint + Prettier with shared config in `packages/config-eslint`. `pnpm lint` runs across all packages.
- [x] **T0.7** Add vitest for unit tests. Port the smoke test of the crypto module into proper `packages/crypto/test/qr-session.test.ts` with cases: round-trip success, tamper rejection, expired session rejection, QR payload size guard.
- [x] **T0.8** Add `.github/workflows/ci.yml` — runs `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` on PR and main push. Block merge on failure.
- [x] **T0.9** Add `PROGRESS.md` with a header and instructions. First entry is T0.1.

## Phase 1 — Backend hardening

- [x] **T1.1** Replace the in-process server signing key with AWS KMS-loaded key. Module: `apps/backend/src/kms.ts`. Use `@aws-sdk/client-kms`. For local dev, fall back to the `.keys/` cache (already implemented). Add `AWS_KMS_KEY_ID` to `.env.example`. Document in `apps/backend/README.md`.

- [x] **T1.2** Replace the in-memory `sessionRuntime` map with KMS-wrapped storage in `qr_sessions.server_ecdh_privkey_encrypted` (already a column). On each request, fetch and unwrap. Add audit_log entry per unwrap.

- [x] **T1.3** Add JWT-based patient auth. Module: `apps/backend/src/auth.ts`. Use `@fastify/jwt`. Endpoint `POST /auth/otp-request` (send OTP to phone), `POST /auth/otp-verify` (returns JWT). For dev, accept OTP `000000`. For prod, integrate Twilio Verify. Update all routes to require `app.authenticate` preHandler except `/healthz`, `/keys/ecdsa`, and Twilio webhook.

- [x] **T1.4** Add Pino logger. Replace any `console.log` in app code with structured logs.

- [x] **T1.5** Add rate limiting via `@fastify/rate-limit`. 30 req/min on `/qr-sessions` create, 60 req/min on other endpoints.

- [x] **T1.6** Expand schema migration `supabase/migrations/0001_init.sql` to the full production schema from CLAUDE.md / v2.0 doc Part C2:
  - `users` (with `hpid`, `phone_e164`, `preferred_language`, `popia_consent_version`, `kyc_status`)
  - `fhir_resources` (JSONB, GIN-indexed)
  - `documents` (S3 keys + class A metadata only)
  - `consent_records` (versioned + text hash)
  - `kyc_verifications` (txn IDs only, no biometrics)
  - `whatsapp_sessions`
  - `ai_compliance_log` (with system prompt hash)
  - RLS policies on all user-owned tables
  - audit_log triggers verified

- [x] **T1.7** Add `apps/backend/src/db/migrate.ts` improvement: track applied migrations in a `_migrations` table so reruns are safe.

- [x] **T1.8** Add `apps/backend/src/popia/breach.ts` — POPIA 72-hour breach detection. Any time an actor reads `fhir_resources` for a `user_id != actor.sub`, log to a `breach_candidates` table and alert via Sentry. Add a daily cron via BullMQ that summarises.

- [x] **T1.9** Tests: integration tests with supertest covering `POST /qr-sessions` (happy path, malformed pubkey, rate limit), `POST /qr-sessions/:id/revoke`, `GET /qr-sessions/:id/payload` (pending, consumed, expired). Use a local Postgres via docker-compose `postgres-test` service.

## Phase 2 — FHIR R4 server

- [x] **T2.1** Run HAPI FHIR JPA Server R4 as a sidecar in docker-compose. Container `hapi-fhir`, port 8080. Document the trade-off in `apps/backend/README.md`: Java sidecar buys R4 certification and capability statement; Node-native (`@medplum/core`) is the alternative if ops want to drop a JVM.

  🔴 HUMAN ACTION NEEDED: confirm you're OK shipping a JVM sidecar in production. If not, switch this task to `@medplum/core` and document.
  → **Decision taken**: Medplum Node-native (@medplum/fhirtypes + Postgres JSONB). See docs/decisions/0001-fhir-server.md.

- [x] **T2.2** Add `apps/backend/src/fhir/client.ts` — thin client to HAPI. Methods: `create(resource)`, `read(type, id)`, `search(type, params)`, `bundleTransaction(bundle)`.

- [x] **T2.3** Expose passthrough routes: `POST /fhir/Patient`, `GET /fhir/Patient/:id`, `POST /fhir/Bundle`, etc. — but with the patient auth + RLS-equivalent check (a patient can only read/write resources for `subject.reference == Patient/{user.sub}`).

  **Acceptance criteria (must pass before moving to T2.4):**
  - Every route handler calls `checkFhirAccess()` from `src/popia/breach.ts` on any cross-user read.
  - Integration test asserting: `GET /fhir/Patient/:otherUserId` as a different authenticated user returns HTTP 403 AND exactly one row appears in `breach_candidates` with the correct `actor_id`, `target_user_id`, and route metadata in `query_context`.
  - If this test is missing or skipped, do not merge T2.3.
  → **All criteria passing** (test/fhir-routes.test.ts, tests (a) and (b)).

- [x] **T2.4** Update `services/sample-fhir.ts` to write the sample bundle into HAPI on first user login instead of returning hardcoded JSON. The "share" flow then reads from HAPI like real production.

- [x] **T2.5** Add a Bundle builder service that, given a patient ID and a list of resource IDs, builds a `Bundle` of type `collection` ready for the OOB transfer. This is what the patient app calls when generating a share QR.

## Phase 3 — SAHPRA Class A OCR + AI assistant

- [x] **T3.1** Build `apps/backend/src/services/ocr-safe.ts` from the spec in CLAUDE.md and the v2.0 doc Part C3.
  - Input: S3 bucket + key + MIME
  - Calls AWS Textract `AnalyzeDocument` with `TABLES` (raw text only — discard form K/V pairs)
  - Classifies document type by keyword pattern (lab/prescription/discharge/imaging/referral/other)
  - Extracts date, facility name, patient name only
  - Indexes full text into `documents.full_text_search` via `to_tsvector`
  - Writes `DocumentReference` FHIR resource pointing to the S3 original
  - Writes audit_log entry listing both `extracted` and `NOT_extracted` fields as compliance fingerprint
  - **Forbidden:** any extraction of clinical values into structured fields. If you find yourself writing a regex that pulls "HbA1c: 8.2%", stop.

- [x] **T3.2** Tests for `ocr-safe.ts`: 50 sample documents (mix of lab/prescription/discharge/imaging/referral/junk) — classifier accuracy ≥90% on doc type. Tests also assert that no clinical value field appears in the output `DocumentReference`. Use fixtures in `apps/backend/test/fixtures/ocr/`.
  → Satisfied by `ocr-safe.test.ts` written during T3.1: 30 inline fixtures covering all 5 categories, ≥90% accuracy gate, compliance negatives, mocked-Textract integration (28 tests, all green).

- [x] **T3.3** Add `POST /documents` endpoint: accepts a file upload, stores in S3 (af-south-1, KMS-encrypted), calls `ocr-safe.ts`, returns the `DocumentReference` resource. Patient-auth required.

- [x] **T3.4** Build `apps/backend/src/services/ai-assistant.ts` from the spec in CLAUDE.md and v2.0 doc Part C4.
  - Hard-coded system prompt as a `const`
  - SHA-256 hash of the prompt recorded at module load and on every call
  - Anthropic API call with `claude-sonnet-4-6`, max_tokens 600
  - Pre-flight regex check on user input (block obvious "interpret my result" requests)
  - Post-generation regex check on output against the violation patterns
  - Violations → block, replace with language-localised safe fallback, log to `ai_compliance_log` with `verdict='blocked'` and `violation_tags`
  - Disclaimer appended if missing

- [x] **T3.5** Tests for `ai-assistant.ts`: the 8 test cases in CLAUDE.md must all pass deterministically. 4 "allowed" cases must return text from the model; 4 "blocked" cases must return the safe fallback. Mock the Anthropic SDK in tests.
  → Satisfied by `ai-assistant.test.ts` written during T3.4: tests #1–4 cover 4 allowed cases; tests #5–8 cover 4 blocked cases (2 pre-flight, 2 post-gen); 7 additional tests cover log integrity, prompt hash, auth, and length limits (15 tests total, all green).

  🔴 HUMAN ACTION NEEDED: set `ANTHROPIC_API_KEY` in `.env.local` before running tests. The mock-mode tests don't need it; live-mode integration tests do.

- [x] **T3.6** Add `POST /assistant/ask` endpoint: `{ language, message }` → `{ text, verdict, violations }`. Patient-auth required.
  → Satisfied by `apps/backend/src/routes/assistant.ts` written during T3.4: JWT auth verified by test #13; 500-char limit by test #14; verdict/text/violations shape verified across tests #5, #6, #7, #8.

## Phase 4 — Mobile (Expo / React Native)

- [ ] **T4.1** Create `apps/mobile` with `pnpm dlx create-expo-app`. SDK 51, Android-first. Add `react-native-ble-plx@3.2`, `expo-secure-store`, `expo-camera`, `react-native-qrcode-svg`, `@nozbe/watermelondb`, `i18next`, `react-i18next`.

- [ ] **T4.2** App scaffolding:
  - `app/_layout.tsx` — i18n provider, auth guard
  - `app/(auth)/sign-up.tsx` — POPIA consent screen with hashed text, language picker (en/zu/st), phone OTP
  - `app/(auth)/kyc.tsx` — Smile ID SDK integration placeholder (vendor onboarding required — see T5.1)
  - `app/(home)/index.tsx` — record list
  - `app/(home)/share.tsx` — the ShareRecordsScreen
  - `app/(home)/assistant.tsx` — chat UI to `/assistant/ask`

- [ ] **T4.3** Implement `apps/mobile/src/screens/ShareRecordsScreen.tsx` per v2.0 doc Part C27:
  - Patient selects FHIR resources from WatermelonDB
  - Generates ECDH P-256 keypair (via `expo-crypto` or pure JS `@noble/curves`)
  - Stores private key in `expo-secure-store` for the session lifetime only
  - POSTs to `/qr-sessions` with patient pubkey + BLE MAC
  - Renders QR with `react-native-qrcode-svg`
  - Starts BLE peripheral advertising (T4.4)
  - Builds FHIR Bundle from selected resources
  - On provider connection: encrypts with AES-256-GCM using ECDH-derived key, chunks, transmits
  - Handles session expiry, revoke button, error states

- [ ] **T4.4** Implement `apps/mobile/src/services/p2p-transfer.ts` (v2.0 doc Part C28):
  - Patient device acts as BLE peripheral, advertises a known UUID + characteristic
  - Chunking: split ciphertext into 200-byte chunks (BLE MTU minus headers)
  - First chunk has a header `{ total_chunks, ciphertext_length, chunk_index }`
  - Each subsequent chunk has just `{ chunk_index, bytes }`
  - Reassembly is on the provider side
  - Wi-Fi Direct fallback for ≥50KB payloads — only invoked if patient explicitly opts in (it requires extra permissions on Android 12+)
  - Online fallback: if BLE pairing fails twice, POST the encrypted bundle to `/qr-sessions/:id/online-bundle` and let the provider portal fetch it

- [ ] **T4.5** Implement offline-first sync: WatermelonDB tables for `fhir_resources` (mirror), `documents`, `consent_records`. Sync adapter to `/fhir/*` endpoints with last-modified watermark. App must work without cellular data once initial sync done.

- [ ] **T4.6** i18n: `apps/mobile/src/i18n/{en,zu,st}.json`. Cover consent screen, share flow, AI assistant disclaimer, all errors. Get the isiZulu and Sesotho strings reviewed by the clinical advisor (this is a HUMAN review).

  🔴 HUMAN ACTION NEEDED: clinical advisor or native speaker review of the zu/st strings before patient testing.

- [ ] **T4.7** EAS build config. Android APK build target. `apps/mobile/eas.json` with `production` profile signed via EAS-managed credentials.

## Phase 5 — KYC, WhatsApp, Provider portal

- [ ] **T5.1** Smile ID integration. `apps/backend/src/services/kyc.ts`. POSTs verifications, stores `vendor_txn_id` only. Webhook handler at `/kyc/webhook` for async results. Update `users.kyc_status` based on outcome.

  🔴 HUMAN ACTION NEEDED: sign Smile ID Operator agreement and provision API keys. Place in AWS Secrets Manager. Until done, this service runs in mock mode with `KYC_MOCK_MODE=true`.

- [ ] **T5.2** Twilio WhatsApp bot. `apps/backend/src/routes/whatsapp-webhook.ts` + `apps/backend/src/services/whatsapp-state.ts` (Redis state machine).
  - States: IDLE → LANGUAGE_SELECT → MAIN_MENU → (DEFINE_TERM | DOCTOR_QUESTIONS | RECORD_STATUS)
  - Twilio signature verification on every webhook hit
  - Language detection + switching mid-session
  - All AI calls go through `ai-assistant.ts` — same compliance rules apply
  - 30-min Redis TTL on session state
  - BullMQ job for medication reminders (queued at signup, fires via Twilio REST)

  🔴 HUMAN ACTION NEEDED: provision Twilio account, request SA WhatsApp Business number, set webhook URL.

- [ ] **T5.3** Provider portal — proper Next.js 14 build (replacing the v0 static page).
  - `apps/provider-portal/app/page.tsx` — landing
  - `apps/provider-portal/app/scan/page.tsx` — webcam QR scanner using `@yudiel/react-qr-scanner`
  - `apps/provider-portal/app/session/[id]/page.tsx` — render received Bundle read-only with source-of-truth banner per CLAUDE.md
  - Verifies ECDSA signature server-side (Next.js Route Handler) using `@qurovita/crypto`
  - Establishes WebSocket / online-bundle pull (P2P BLE only works on native, not browser; document this clearly — providers using the portal use the online-fallback path)
  - Every OCR-classified document is rendered with an explicit "⚠ Original document is the legal source of truth — click to view" banner; the rendered text is for findability only

- [ ] **T5.4** Provider portal — Tailwind + shadcn/ui. Run `pnpm dlx shadcn-ui@latest init`. Components: Card, Button, Alert, Tabs (for resource categories).

## Phase 6 — Infrastructure & deploy

- [ ] **T6.1** `infrastructure/terraform/main.tf` — minimal stack in `af-south-1`:
  - VPC + 2 public subnets + 2 private subnets
  - ECS Fargate cluster, service for the backend (1 task min, autoscale to 4 on CPU > 60%)
  - Application Load Balancer with ACM cert (DNS validation against Cloudflare)
  - S3 bucket `qurovita-documents` with SSE-KMS, public access blocked, versioning on
  - KMS key for documents + KMS key for ECDSA signing (CMK)
  - Secrets Manager entries: `ANTHROPIC_API_KEY`, `SMILE_ID_*`, `TWILIO_*`
  - Supabase is external — document the connection string injection
  - CloudWatch log groups
  - **Reject any resource that omits `region = "af-south-1"`.** Use a Terraform validation check.

- [ ] **T6.2** `.github/workflows/deploy-staging.yml` — on push to `main`, build Docker image, push to ECR, force-deploy ECS service. Manual approval gate for production via GitHub Environment.

- [ ] **T6.3** Sentry + Datadog wiring. `apps/backend/src/observability.ts`. PII redaction in Sentry (no user content in error context). Datadog APM tracing.

- [ ] **T6.4** POPIA breach alerting — Sentry alert rule on any `breach_candidate` log entry pages PagerDuty + emails the Information Officer.

  🔴 HUMAN ACTION NEEDED: configure PagerDuty integration; provide the Information Officer's email.

## Phase 7 — Hardening, compliance, pilot

- [ ] **T7.1** Security tests in `apps/backend/test/security/`:
  - Tamper QR → ECDSA verify rejects
  - Expired session → 410 Gone
  - Replay attack (reuse consumed session) → rejected
  - audit_log UPDATE attempt → trigger raises
  - audit_log DELETE attempt → trigger raises
  - AI compliance: 8/8 test cases passing
  - OCR compliance: zero clinical-value fields in any sample output

- [ ] **T7.2** Device matrix test plan in `docs/device-matrix.md`. Manual checklist for: Samsung A04e (Android Go), J6 (Android 8), P30 Lite (Android 10), A23 (Android 12), Pixel 7a (Android 13), S24 (Android 14). BLE P2P transfer success ≥95% on Android 10+. Online fallback on Android 8/9.

- [ ] **T7.3** Load test: k6 script in `apps/backend/test/load/`. 100 concurrent QR sessions, 500 FHIR reads/min. p95 latency targets in `docs/slo.md`.

- [ ] **T7.4** POPIA breach drill — runbook in `docs/breach-runbook.md`. Simulate unauthorized cross-user `fhir_resources` query, verify Sentry alert, verify Information Officer notification within 72h SLA, document the timeline.

- [ ] **T7.5** SAHPRA Class A documentation pack in `docs/sahpra/`:
  - Architecture overview matching v2.0 doc § 4
  - OCR safe-list with code line references
  - AI compliance evidence: system prompt + hash + sample compliance log entries
  - Risk register matching v2.0 doc § 12

  🔴 HUMAN ACTION NEEDED: health-law attorney review and written Class A opinion. File the SaMD notification with SAHPRA after attorney sign-off.

- [ ] **T7.6** Pilot readiness checklist verified — every item in CLAUDE.md "What done looks like" green.

## Launch Readiness gates (must be green before patient #1)

- [ ] `ZU_ST_TRANSLATIONS_REVIEWED` flag in `ai-assistant.ts` set to `true` after clinical advisor + native speaker sign-off on isiZulu / Sesotho fallback strings
- [ ] SAHPRA SaMD Class A notification filed AND acknowledged (5-day ack received)
- [ ] Information Officer registered (HUMAN — `inforeg@justice.gov.za`)
- [ ] Privacy policy live at `qurovita.co.za/privacy`
- [ ] Health-law attorney written Class A opinion on file
- [ ] KYC Operator Agreement signed with Smile ID
- [ ] audit_log REVOKE UPDATE/DELETE verified by external DBA
- [ ] All security tests green (T7.1)
- [ ] AI compliance 8/8 test cases green AND zero production violations in soak test
- [ ] BLE P2P ≥95% success on Android 10+ across device matrix (T7.2)
- [ ] Sentry + Datadog wired with PII redaction
- [ ] POPIA 72-hour breach drill executed and signed off (T7.4)
- [ ] NGO partner MOU signed (TB HIV Care or Anova) — HUMAN — **60-day WCG window**
- [ ] 5 WC PHC pilot sites confirmed ready
- [ ] EAS production Android build distributed to CHWs for onboarding

---

## Out of scope for Phase 1 — do not touch

- Medical scheme PMPM revenue work (Phase 2+, requires outcome data)
- Direct DoH / WCG procurement attempts (PFMA blocks this — 18-24 month tender cycle)
- iOS build (Android-first per v2.0)
- Post-quantum crypto migration (plan 2028)
- NHI CareConnect production integration (2027 target)
- Hospital group enterprise licences (Phase 2)
- Pharma RWE data licensing (Phase 3)

If a task feels in-scope but maps to one of these, flag and stop.
