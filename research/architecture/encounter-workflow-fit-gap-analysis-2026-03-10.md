# Sequential Analysis: Encounter Workflow Fit Gap Review (2026-03-10)

## Question
How well does the current implementation support the core outpatient encounter workflow (registration/appointment -> primary consult -> technician/specialist collaboration -> provisional diagnosis/disposition -> longitudinal history), across:
- data model + seed data
- DDD layers
- APIs
- `@arcaai/vox` SDK

## Scope
- `packages/database/src/prisma/db_main/**`
- `packages/domains/src/**`
- `packages/applications/src/**`
- `apps/api/src/modules/**`
- `packages/agentic-sdk-v2/src/**`
- Supporting STT flow in `apps/api/src/modules/streaming/**` and `packages/applications/src/services/stt/**`

---

## Evidence Collection

### Evidence 1: Core DB model is consultation-centric, not encounter-centric
- Source: `packages/database/src/prisma/db_main/consultation.prisma`
- Finding:
  - `Consultation` has `patientId`, `appointmentDate`, `doctorId`, optional `parentConsultationId`.
  - There is no explicit `Encounter`, `Appointment`, `OutpatientVisit`, or `Patient` model in Prisma.
  - `ContextItem` and related models (`SummaryMeta`, `NamedEntity`, `ContextItemVersion`, `AudioRecording`) are present and rich.
- Confidence: High

### Evidence 2: Seed data simulates realistic multi-department clinical flows with context artifacts
- Source: `packages/database/src/prisma/db_main/seed/09-consultation.ts`
- Finding:
  - Seeded chains (`parentConsultationId`) and context items (`TRANSCRIPT`, `RAW_SUMMARY`, `PRE_SUMMARY`, `CASE_NOTE`, etc.).
  - Demonstrates sharing-ready data scenarios and longitudinal content versioning.
  - Status-like values exist only in `metadata` (e.g., `OPEN`, `REVIEW`, `CLOSED`), not as structured consultation fields.
- Confidence: High

### Evidence 3: DDD/services implement consult + context lifecycle well, but encounter outcome lifecycle is missing
- Source: `packages/applications/src/services/consultation/consultation/consultation.service.ts`
- Finding:
  - `getOrCreate()` supports deterministic consultation reuse by `(tenantId, patientId, appointmentDate, doctorId)`.
  - `createRevisit()` exists in service but is not exposed by API.
  - No structured consultation/encounter disposition fields in domain entity (`ConsultationEntity`) or response DTOs.
- Confidence: High

### Evidence 4: Shared context behavior is implemented (chain + same-day strategy)
- Source: `packages/applications/src/services/consultation/context/context.service.ts`
- Finding:
  - `getSharedContext()` merges:
    1) chain-based links (`parentConsultationId`)
    2) same patient + same date consultations (cross-department sharing)
  - `addTranscription()` accepts `structuredData` but drops it (delegates to `addTranscript(content)` only).
- Confidence: High

### Evidence 5: Consultation APIs are broad for context/summary but missing key endpoints
- Source: `apps/api/src/modules/consultation/consultation.controller.ts`
- Finding:
  - Present: open/load/list/history/chain/timeline/context/summaries/NER aggregation.
  - Missing: revisit endpoint, consultation job endpoints (`/consultations/jobs/:id` family), close/reopen endpoints.
- Confidence: High

### Evidence 6: SDK/API contract drift exists and can break workflow behavior
- Source:
  - SDK constants/types/hooks in `packages/agentic-sdk-v2/src/**`
  - Backend DTOs in `packages/applications/src/services/consultation/**/dto/**`
- Finding:
  - `OpenSessionInput` uses `department`; backend expects `departmentId`.
  - SDK sends summary options (`transcript`, `promptTemplateId`, `departmentId`), backend summary DTO expects `transcription`, `template`, `contextItemIds`, etc.
  - SDK defines consultation-job endpoints (`CONSULTATION_JOB_ENDPOINTS`) but API has no `consultations/jobs` controller.
  - SDK selectors often use lowercase type names (`transcription`, `case_note`, `summary`), while backend context types are uppercase enums (`TRANSCRIPT`, `CASE_NOTE`, `RAW_SUMMARY`, `PRE_SUMMARY`), causing filter misses.
- Confidence: High

### Evidence 7: Migration/schema drift risk is real
- Source: `packages/database/src/prisma/db_main/migrations/**`
- Finding:
  - Existing migration SQL files do not include `Consultation`, `ContextItem`, `SummaryMeta`, `NamedEntity`, etc.
  - Current Prisma schema/seed assumes those models exist.
- Confidence: High

### Evidence 8: Latest best-practice baseline (2025-2026)
- Source summary from standards/research:
  - FHIR Encounter, EncounterHistory, DocumentReference, Provenance
  - HL7 AI Transparency guidance
  - USCDI encounter identifier guidance
- Finding:
  - Best practice strongly separates patient identity vs encounter identity.
  - AI-generated notes/transcripts should carry provenance and structured attribution.
  - Disposition and longitudinal state transitions should be first-class structured data.
- Confidence: Medium-High

---

## Hypotheses

### Hypothesis A: System already supports collaborative multi-consultation context workflows, but at consultation granularity
- Supporting evidence: E1, E2, E3, E4, E5
- Contradicting evidence: No explicit encounter model (E1), missing outcome lifecycle (E3/E5)
- Probability: 85%

### Hypothesis B: Core business gaps are mostly model/contract gaps, not absence of context-processing capability
- Supporting evidence: E2, E3, E4, E5, E6
- Contradicting evidence: Some missing routes materially block workflows (E5/E6)
- Probability: 80%

### Hypothesis C: Current state has production risk from schema drift and SDK/API mismatch
- Supporting evidence: E6, E7
- Contradicting evidence: None found
- Probability: 90%

---

## Testing / Verification Actions

### Test 1: Encounter entity existence
- Action: Checked Prisma models for patient/appointment/encounter/outpatient visit.
- Expected (if fully aligned): Explicit encounter-level model + ID.
- Actual: No such model; consultation acts as proxy.
- Result: Hypothesis A confirmed (partial support only).

### Test 2: Workflow sharing support
- Action: Verified shared-context algorithm and chain model.
- Expected: Prior consultations/context visible to downstream providers.
- Actual: Implemented via chain + same-day same-patient merge.
- Result: Hypothesis A confirmed (meets most sharing needs).

### Test 3: API + SDK contract compatibility
- Action: Compared SDK payload/types/constants with backend DTOs/routes.
- Expected: Field and endpoint parity.
- Actual: Multiple field and route mismatches.
- Result: Hypothesis C confirmed.

### Test 4: Deployment consistency for data layer
- Action: Checked migration SQL presence for consultation-context models.
- Expected: Migration SQL creates schema used by Prisma models.
- Actual: Migration files do not contain these model tables.
- Result: Hypothesis C confirmed.

---

## Workflow Brief Fit (Meets vs Does Not Meet)

### 1) Registration/appointment creates outpatient visit + unique encounter ID
**Meets**
- Consultation open/get-or-create exists and uses deterministic identity dimensions (`patientId` + `appointmentDate` + doctor + tenant).
- Consultation has UUID id (`Consultation.id`) and can be treated as an internal visit record.

**Does Not Meet**
- No explicit appointment entity.
- No explicit encounter/outpatient-visit entity.
- No first-class encounter identifier separate from patient identity.
- No structured encounter lifecycle resource (status, transitions, closure outcome) outside free-form metadata.

### 2) Primary physician consultation with ingested historical records, transcription and summary persisted as context items
**Meets**
- `ContextItem` model supports `TRANSCRIPT`, `CASE_NOTE`, `RAW_SUMMARY`, `PRE_SUMMARY`, `MODIFIED_SUMMARY`.
- Service/API support add/list/update/versioning of context items and summary generation.
- Seed data demonstrates realistic transcript + summary + version history flow.

**Does Not Meet**
- Structured payload (`structuredData`) from SDK transcription path is not persisted through `addTranscription`.
- Summary type contract is inconsistent between SDK assumptions and backend payload reality.

### 3) Orders routed to technicians; new consultation shares previous context; technicians ingest context
**Meets**
- Parent-child consultation chain exists (`parentConsultationId`).
- Shared context retrieval supports chain and same-day same-patient cross-department sharing.
- New context ingestion is supported in current consultation.

**Does Not Meet**
- API has no explicit `create revisit/referral` endpoint despite service-level support.
- Chain retrieval is one-level root+children and can miss deeper descendant trees.
- No clear API contract for referral/handoff semantics (assigned role, source consult, receiving specialty).

### 4) Back to primary physician; specialist consultations over shared clinical data
**Meets**
- Context-sharing strategy supports specialist visibility into same-day and linked consultations.
- Comprehensive summary endpoint exists for cross-consultation synthesis.

**Does Not Meet**
- No explicit role-scoped sharing controls per consultation participant.
- Possible over-sharing risk (same-day merge broadens visibility without granular policy).
- No first-class participant/provenance model for who authored which clinical artifact (beyond basic source + createdBy).

### 5) Workflow concludes with provisional diagnosis + disposition recorded in encounter + longitudinal history
**Meets**
- Context item versions preserve textual change history.
- Named entities can include coded findings in metadata.

**Does Not Meet**
- No structured provisional diagnosis model.
- No structured disposition field/state transition on encounter/consultation.
- No explicit encounter closure API and outcome schema.
- Longitudinal history is derived from consultation/context chains, not modeled as explicit encounter-history records.

---

## Area-by-Area Review

### Data Models + Seeding Data
**Meets**
- Strong consultation-context schema for transcription/summaries/NER/versioning.
- Seed data provides realistic multi-department workflows and context evolution.

**Does Not Meet**
- Missing encounter-level normalization (`Encounter`, `Appointment`, participant attribution).
- Outcome/disposition and diagnosis are not first-class structured data.
- Migration SQL does not match current consultation-context schema usage.

### DDD Layers
**Meets**
- Good separation of repository/service/controller responsibilities for consultation and context operations.
- Domain entities/factories represent consultation and context operations consistently.

**Does Not Meet**
- Revisit workflow exists in service but is not exposed at API.
- Encounter lifecycle and disposition logic not modeled at domain level.
- Chain query implementation is shallow for deep referral trees.

### Current APIs
**Meets**
- Rich consultation/context/summary/timeline endpoints cover most day-to-day operations.

**Does Not Meet**
- Missing consultation close/reopen endpoints despite SDK expectations.
- Missing consultation job status/cancel/SSE controller endpoints despite service and SDK constants.
- Some route handlers ignore route consultation id consistency for nested resources (`:id/context/:contextId` etc.).

### `@arcaai/vox` SDK
**Meets**
- Strong orchestration for audio -> transcription -> context -> summary with hooks and store.
- Good endpoint coverage constants and convenient APIs for context/summaries/history.

**Does Not Meet**
- Request field drift (`department` vs `departmentId`, `transcript` vs `transcription` etc.).
- Selector/type casing drift (lowercase expected vs uppercase backend enums) can hide data in UI state.
- Endpoint drift for job lifecycle + close/reopen.
- Structured context metadata accepted by SDK but not preserved end-to-end.

---

## Critical Risks (Prioritized)

1. **High**: Migration/schema drift can break environment parity and deployment confidence.
2. **High**: SDK/API contract mismatches can silently degrade workflow behavior.
3. **High**: Missing structured encounter outcome model blocks final workflow milestone (diagnosis/disposition).
4. **Medium-High**: Shared-context overreach risk without participant/role scoping controls.
5. **Medium**: Shallow consultation-chain retrieval can truncate longitudinal context.

---

## Enhancement Suggestions (Best-Practice Aligned)

### Near-term (1-2 sprints)
- Introduce contract adapter layer between SDK and API:
  - normalize `department <-> departmentId`
  - normalize summary keys (`transcript`/`transcription`, template fields)
  - normalize enum casing for context and summary types.
- Add missing API routes:
  - `POST /consultations/:id/revisit`
  - consultation job status/cancel/SSE endpoints
  - consultation close/reopen endpoints or remove from SDK surface.
- Persist `structuredData` for transcription/context in backend DTO + service path.
- Fix SDK selectors to handle canonical backend enum values.

### Mid-term (2-4 sprints)
- Add first-class encounter model (or rename consultation to encounter with explicit semantics) with:
  - `encounterId`
  - status lifecycle
  - participant attribution
  - disposition/provisional diagnosis fields.
- Add recursive chain resolution or `rootEncounterId` strategy for full graph retrieval.
- Add scoped sharing controls (`chainOnly`, role/department constraints, temporal filters).

### Longer-term (standards alignment)
- Map artifacts to FHIR-compatible resources:
  - encounter lifecycle (`Encounter`, `EncounterHistory`)
  - transcripts/summaries (`DocumentReference`)
  - findings (`Observation`, `Condition`)
  - provenance (`Provenance` + AI model/device attribution).
- Implement structured, auditable longitudinal updates rather than relying mostly on free text and metadata.

---

## Conclusion
**Answer**: The platform already supports a strong consultation-context workflow (transcripts/summaries/shared context/versioning), but it does **not yet fully meet** the core business brief because encounter-level identity/lifecycle/outcome modeling and key API/SDK contracts are incomplete.

**Confidence**: 8.5/10

**Key Evidence**:
- Rich consultation/context implementation is present.
- Encounter-level model and disposition lifecycle are absent.
- Clear SDK/API/migration drifts exist and are verifiable from code.

**Recommended Next Action**:
- Prioritize a contract-hardening sprint (SDK/API parity + missing routes + selector fixes) before introducing encounter-domain schema changes.
