# Build Progress

One line per completed BUILD_PLAN task. Newest at top.

Format: `YYYY-MM-DD  task-id  short summary  commit-sha`

---

<!-- entries will appear below this line -->
2026-05-16  T3.3  POST /documents: S3 upload + magic-byte check + idempotency + OCR pipeline; 9 tests green  01bc121
2026-05-16  T3.1  ocr-safe.ts: SAHPRA Class A classifier + audit_log fingerprint; 0005_documents_fts.sql; 28 tests green  bf00765
2026-05-16  T2.x  fix: per-user FHIR unique index (user_id,resource_type,fhir_id); seedSampleData count-guard; all Phase 2 checks pass  4ebad15
2026-05-15  T2.5  bundle-builder.ts: buildShareBundle() assembles FHIR collection Bundle for OOB share flow
2026-05-15  T2.4  sample-fhir.ts: seedSampleData() writes bundle to store on first login; /sample-bundle reads live data
2026-05-15  T2.3  FHIR routes GET/POST; cross-user 403 + breach_candidates; T2.3 acceptance criteria pass; auth upserts real user rows
2026-05-15  T2.2  FhirClient abstraction (create/read/search/bundleTransaction) over Postgres store
2026-05-15  T2.1  Medplum Node-native decision; ADR 0001; 0003_fhir_native.sql; @medplum/fhirtypes devDep
2026-05-14  T1.9  12 supertest integration tests for QR session endpoints (create/payload/revoke); rate-limit isolated to fresh app; @fastify/rate-limit downgraded to v8
2026-05-13  T1.8  breach.ts: POPIA cross-user fhir_resources detection → breach_candidates + Sentry; daily BullMQ cron; 3-case vitest
2026-05-13  T1.7  migrate.ts: _migrations tracking table; reruns skip already-applied files
2026-05-13  T1.6  0002_phase1_schema.sql: fhir_resources, documents, consent_records, kyc_verifications, whatsapp_sessions, ai_compliance_log, breach_candidates; RLS on all
2026-05-13  T1.5  @fastify/rate-limit v8: 60 req/min global (per-route limit deferred; v9 incompatible with Fastify 4)
2026-05-13  T1.4  Pino logger: shared logger.ts; console.log removed from keys.ts, migrate.ts, server.ts
2026-05-13  T1.3  JWT auth: POST /auth/otp-request + otp-verify; OTP 000000 dev shortcut; all routes guarded; verify-roundtrip updated
2026-05-13  T1.2  AES-256-GCM wrap/unwrap for server ECDH privkey in DB; sessionRuntime removed; provider join audit-logged
2026-05-13  T1.1  KMS signing key: getSigningState() dev/prod switch; createSessionAsync() in crypto pkg; @aws-sdk/client-kms installed
2026-05-13  T0.9  PROGRESS.md complete; BUILD_PLAN T0.1–T0.9 all checked done  e8dc5fb
2026-05-13  T0.8  .github/workflows/ci.yml — typecheck + lint + test on PR and main push  3565855
2026-05-13  T0.7  vitest 4-case crypto smoke test (round-trip, tamper, expired, size guard) all pass  2bcd7ea
2026-05-13  T0.6  ESLint 9 flat config + Prettier; shared @qurovita/config-eslint package; pnpm lint clean  a45ad8c
2026-05-13  T0.5  root tsconfig.json + per-package typecheck scripts; all 3 packages pass tsc --noEmit  a80a7a2
2026-05-13  T0.4  packages/crypto extracted as @qurovita/crypto; backend + portal import from it  d5328d5
2026-05-13  T0.3  provider-portal Next.js 14 scaffold; clients/ → apps/backend/public/; CORS  d1d63e5
2026-05-13  T0.2  move backend → apps/backend/, rename to @qurovita/backend, pin @noble/hashes@1.x  2623950
2026-05-12  T0.1  pnpm workspaces + Turborepo scaffold (pnpm-workspace.yaml, turbo.json, root package.json)  1e62a58
2026-05-12  pre-T0.1  fix CDN deps → local vendor bundles, full UUID display, UUID validation, .gitignore, port 5433  a67685f
