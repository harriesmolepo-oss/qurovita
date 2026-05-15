# ADR 0001 — FHIR R4 server: Medplum Node-native over HAPI Java sidecar

**Status:** Accepted  
**Date:** 2026-05-14  
**Decider:** Harrie Smolepo (project lead)

---

## Context

QuroVita needs a FHIR R4 storage layer to hold Patient, Observation, MedicationStatement,
Condition, AllergyIntolerance, DocumentReference and Bundle resources.  BUILD_PLAN T2.1
originally specified a HAPI FHIR JPA Server R4 Docker sidecar (Java, port 8080).  Before
implementing T2.1 the decision was reviewed against QuroVita's Phase 1 constraints.

## Decision

Use **Medplum Node-native** with **Postgres JSONB** as the FHIR storage backend.
FHIR R4 TypeScript types come from `@medplum/fhirtypes` (devDependency, compile-time only).
No Java process; FHIR resources are stored in the existing `fhir_resources` table
(JSONB column `data`).  All FHIR access goes through `apps/backend/src/fhir/client.ts`,
which acts as the thin abstraction layer and can be swapped for a HAPI backend later without
touching route code.

Note: `@medplum/core` v5 requires Node ≥22; QuroVita runs Node 20 (pinned in CLAUDE.md).
Using `@medplum/fhirtypes` types-only avoids the runtime engine constraint entirely.

## Reasons

1. **Ops simplicity** — single Node runtime, single set of metrics, single deploy pipeline.
   Solo team in Phase 1 cannot afford JVM-debugging overhead.
2. **Resource budget** — HAPI JPA requires ~512 MB JVM heap + separate ECS task in af-south-1.
   Medplum native adds zero infrastructure cost.
3. **R4 conformance for the required resource subset** — QuroVita needs Patient, Observation,
   MedicationStatement, Condition, AllergyIntolerance, DocumentReference, Bundle.  Medplum's
   TypeScript types and validators provide R4 conformance for this subset without a full
   certification server.
4. **NHI CareConnect timeline** — DoH NHI API is not available until ≥2027.  Full R4
   certification server is not a gate for Phase 1 or the initial five-clinic pilot.
5. **Migration path preserved** — `client.ts` abstraction means switching to HAPI is a
   one-file change if the certification path later requires it.

## Trade-offs

| Concern | Medplum native | HAPI sidecar |
|---|---|---|
| FHIR R4 certification | Partial (resource subset) | Full (HL7 certified) |
| FHIR capability statement | Handcrafted | Auto-generated |
| Search parameters | Implemented manually in SQL | Automatic JPA mapping |
| Ops complexity | Low | High (JVM, separate container) |
| Cold-start latency | Negligible | 15–30 s JVM warm-up |
| Memory footprint | ~0 extra | ~512 MB heap |
| Swap cost later | Low (one file) | — |

## Consequences

- `apps/backend/src/fhir/store.ts` owns all SQL against `fhir_resources`.
- `apps/backend/src/fhir/client.ts` is the only import routes should use — never import
  store.ts directly from a route.
- FHIR search parameters are implemented as SQL predicates in store.ts; complex parameter
  chaining is out of scope for Phase 1.
- If SAHPRA or NHI requires a fully certified R4 capability statement before launch,
  revisit this decision and execute the HAPI migration via client.ts swap.

## Review trigger

Re-evaluate before filing the SAHPRA SaMD Class A notification (BUILD_PLAN T8.x) and
before any NHI integration work (post-Phase 4).
