# TASK-330 — Clinical Documentation Harness · Implementation Plan

| Field | Value |
|---|---|
| Ticket | TASK-330 |
| Companion | [`README.md`](./README.md) (HLD v3) · [`research/clinical-harness/`](../../../research/clinical-harness/README.md) (research, 182 sources) |
| Created | 2026-06-06 |
| Status | **Phases 0–3 + 6 implemented (uncommitted)** — Phase 2 (inferential sensors + layered guardrails) **verified end-to-end 2026-06-07**; Phase 3 (institutional RAG) **verified end-to-end 2026-06-07** (README §9; deterministic + synthetic-eval, live full ingest→cite loop gated on the BGE-M3 + reranker + golden-set prerequisite handoff); **Phase 6 (Harness Administration & Observability Console) implemented + integrated-verified 2026-06-07** (builds GREEN across domains/applications/api; vitest domains 1173 ✓ / applications 4857 ✓ / api 1695 ✓ incl. boot-time admin-route audit 15 ✓; harness pytest 443 ✓; ui-playground 1052 ✓; `HarnessPolicyChange` WORM REVOKE enforced on the live dev DB 21 ✓). Phases 4–5 pending. |
| Method | TDD red-green-refactor; layer order Database → Domain → Services → API → Python (`01-development-workflow.mdc`) |
| Durability | **Temporal** (D11) · Stack | **SOTA adopt** (D12) |

> This plan is executable by an engineer with minimal prior familiarity: every task names the **layer**, the
> **exact files/symbols** (from the v3 codebase review, §3.4 of the HLD), a **RED test**, the **GREEN** change, and an
> **exit gate**. Phases are independently shippable and ordered so each de-risks the next.

---

## 0. How to use this plan

- **TDD is mandatory** (`methodology/test-driven-development`): write the failing test first, watch it fail for the
  right reason, then write the minimal code to pass, then refactor. No implementation before a RED test.
- **Layer gates** (`01-development-workflow.mdc`): finish + build + test each layer before the next. For DB changes:
  `pnpm db:migrate` + `pnpm db:generate`; Domain: `pnpm build/test:unit --filter @arcaai/domains`; Services:
  `--filter @arcaai/applications`; API: `pnpm build:api` + `pnpm test:e2e`; Python: `pnpm py:<svc>:test`.
- **Evidence before "done"** (`methodology/verification-before-completion`): paste actual test/build/lint output into
  this ticket; run `ReadLints` on touched files; update barrel exports + module registrations.
- **DB safety**: all migrations here are **additive (new tables / nullable columns / new enum values)**. The one
  data-backfill (`Consultation.status` from `metadata`) is a copy-forward, **non-destructive**. Any `DROP`/`DELETE`/
  `TRUNCATE` requires explicit owner approval (per repo policy) — none are planned.
- **Branch/commit**: one feature branch per phase (`feat/TASK-330-p<N>-<slug>`); do not commit without the owner's ask.

### Open prerequisites to confirm with the owner before Phase 0
1. **Conda env for `apps/harness`** — create a new env (e.g. `hope-harness`) or reuse `smr`/`nlp`'s? (Repo rule: Python
   always runs in conda — name to be confirmed.)
2. **Temporal hosting** — self-host via `infrastructure/docker` (dev) + which prod target (VM/cluster)?
3. **Golden-set SME owner** (HLD §7.5 #1) and **institutional-doc formats/approval** (#2) — needed to fill Phase 0/3.
4. **vLLM/LM Studio host** for MiniCheck-7B + ≤20B judge (GPU availability on the harness host).

---

## 1. Architecture recap (what we're building)

`apps/harness` (Python/FastAPI) runs the bounded **`guides → generate → sensors → gate`** loop as a **Temporal
durable workflow**; `apps/api` (NestJS) stays gateway + system-of-record (authZ, tenant/CLS, Postgres, WORM audit,
consent, sign-off). Existing STT / NLP / SMR / Qdrant are reused **as tools** (ACI). See HLD §4.

**Temporal mapping**

| Loop element | Temporal construct |
|---|---|
| guide (NER+link, retrieve, assemble, redact) | Activity (idempotent, retryable) |
| generate (SMR) | Activity |
| sensors (computational + inferential) | Activity (parallelisable) |
| bounded regen | deterministic loop in the Workflow (max N) |
| **gate (clinician sign-off)** | `workflow.wait_condition()` on an **approval Signal** + durable **timer** for SLA/escalation |
| audit/telemetry | Activity → `apps/api` WORM write + Langfuse span |

---

## 2. Prerequisites & infrastructure (Phase-0 setup track)

| Item | Action | Files |
|---|---|---|
| Temporal | add `temporal` + `temporal-ui` services (dev) | `infrastructure/docker/docker-compose*.yml`, `.env*.example` |
| `apps/harness` scaffold | FastAPI app + Temporal worker + conda env + `pyproject`/`uv` | `apps/harness/**`, `turbo.json`, root `package.json` scripts (`py:harness:*`) |
| Self-hosted models | vLLM `guided_json` + MiniCheck-7B + Llama Guard 3 + ≤20B judge via LM Studio | `apps/harness/config`, deployment docs in `research/deployments` |
| Langfuse SDK | wire tracing (currently deployed but uncalled) in harness + SMR with SDK+Collector masking | `apps/harness/**`, `apps/smr/**` |
| PHI redaction | Presidio + clinical NER recognizer (upgrade path JSL) | `apps/harness/guides/phi` |

> These are **infrastructure** tasks (no clinical behaviour) and can land alongside Phase 0.

---

## 3. Data model master reference (additive)

All new schema lives in `packages/database/src/prisma/db_main/*.prisma` with a migration + `pnpm db:generate`, then a
Domain layer (`packages/domains`: Entity/Factory/Mapper/Repository) and barrel/module registration. Introduced
incrementally by phase; consolidated here so the tenant-scope **drift guard** (`TENANT_SCOPED_MODELS`) is updated once
per new scoped model.

| Phase | Schema change | Notes |
|---|---|---|
| 0 | `GoldenSet`, `GoldenCase`, `EvalRun`, `EvalScore` (tenant-scoped) | eval storage; golden transcript→note pairs + judge results |
| 0 | **`HarnessAuditEvent`** (append-only) | WORM: `tenantId, consultationId, contextItemVersionId?, action, modelName, modelVersion, promptTemplateId?, promptVersion?, sensorScores Json, citations Json, gateDecision?, clinicianId?, attestationHash?, prevHash, hash, createdAt`. **No update/soft-delete**; DB role `REVOKE UPDATE, DELETE`; hash-chained |
| 0 | `enum HarnessAuditAction` | `GENERATE, SENSOR_RUN, GATE_DECISION, ATTEST, CONSENT_GIVEN, CONSENT_WITHDRAWN, BREACH_REPORTED, REDUCED_ASSURANCE` |
| 1 | `enum ConsultationStatus` + `Consultation.status` | `OPEN, RECORDING, PENDING_REVIEW, SIGNED, CLOSED, REOPENED`; backfill from `metadata.status` (non-destructive) |
| 1 | `ContextItemType += SIGNED_NOTE` | distinguishes an attested note from a draft version |
| 1 | `ContextItemVersion +=` `attestedAt, attestedBy, attestationHash, modelName, modelVersion, sensorScores Json` | attestation gate becomes schema-enforced (today only `changeReason='approved'`) |
| 1 | `NamedEntity +=` `umlsCui, snomedCode, rxnormCode, icdCode, loincCode, transcriptContextItemId (FK), transcriptStartOffset, transcriptEndOffset` | typed ontology codes + **transcript-span back-link** (faithfulness sensor join) |
| 1 | `SummaryMeta +=` `entityFaithfulnessScore, coverageScore, ragTriadScore, citationsMap Json, guardrailDecisions Json, attestationRef, modelName` | extends TASK-331's `promptResolvedFrom/resolvedPromptId` |
| 3 | `KnowledgeDocument`, `KnowledgeChunk` (tenant-scoped) | institutional RAG corpus: `title, source, version, status(draft/approved), approvedBy, approvedAt`; chunks track Qdrant point IDs |
| 4 | `PatientConsent` + `ConsentEvent` (append-only) | DPDP: purpose, scope, status, version, recordedAt/By, `abdmConsentArtefactId` |
| 4 | `BreachIncident` | `detectedAt, reportedAt, severity, affectedScope, status, dpbReportRef` |
| 4 | `Consultation +=` `abhaId, hprId, hfrId, fhirEncounterId, abdmConsentArtefactId` (nullable) | capture FHIR/ABDM IDs day 1; exchange flag-gated |
| 4 | `Tenant +=` `dataResidencyRegion (default 'IN'), cloudEgressEnabled, cloudEgressConsentRef` | residency toggle |

---

## 4. Phases

Each phase: **Objective · Depends on · Tasks (layered, TDD) · Tests · Exit gate · Regulatory guardrail · Effort.**

### Phase 0 — Verify-first (eval harness + audit/attestation schema) · **eval-first (D8)**
**Objective:** be able to *measure* note quality + persist a tamper-evident audit before changing any generation.
**Depends on:** §2 infra (Temporal optional here), owner inputs #1/#3.

| # | Layer | Task (TDD) | Files / symbols |
|---|---|---|---|
| 0.1 | DB | Add `GoldenSet/GoldenCase/EvalRun/EvalScore` + `HarnessAuditEvent` + `HarnessAuditAction`; migration + generate; add scoped models to drift guard | `db_main/*.prisma`, `extensions/tenant-scope.ts`, `extensions/__tests__/tenant-scope.test.ts` |
| 0.2 | DB | Enforce WORM at DB: migration `REVOKE UPDATE, DELETE` on `HarnessAuditEvent` for the app role; RED test asserts an UPDATE throws | migration SQL + `__tests__` |
| 0.3 | Domain | Entity/Factory/Mapper/Repository for the new models; hash-chain helper (`prevHash→hash`) with RED test for tamper detection | `packages/domains/src/**` |
| 0.4 | Services | `EvalService` (create golden set, run eval, store scores) + `HarnessAuditService` (append-only write, verify chain) | `packages/applications/src/services/**` |
| 0.5 | Python | `apps/harness` eval module: PDSQI-9 judge (Epic OSS prompts) + RAGAS faithfulness + DeepEval metrics; judge runs ≤20B (LM Studio) / Azure·Bedrock | `apps/harness/eval/**` |
| 0.6 | Python/CI | DeepEval + promptfoo wired as **release-blocking** GitHub Actions gates against a **pinned** golden-set version | `.github/workflows/*`, `apps/harness/eval/ci` |
| 0.7 | Python | **Judge calibration** harness: compute ICC / Gwet AC2 vs clinician ratings; RED test fails if ICC < 0.8 | `apps/harness/eval/calibration` |

**Tests:** pytest (judge, metrics, calibration), vitest (audit chain, eval services, drift guard), migration review.
**Exit gate:** golden set (≥50 cases) scored; judge ICC ≥0.8 documented; CI gate blocks a deliberately-regressed PR;
audit UPDATE/DELETE rejected at DB. **No generation behaviour changed.**
**Regulatory:** none triggered (offline). **Effort:** L.

---

### Phase 1 — Computational sensors + activate structure (the accuracy core)
**Objective:** ship the `apps/harness` Temporal loop with deterministic sensors; activate SOAP schema; inject NER;
provenance map in review UI; bounded regen. This is the **highest-leverage** anti-omission/anti-fabrication work.
**Depends on:** Phase 0 (audit + eval), §2 (Temporal + harness scaffold).

| # | Layer | Task (TDD) | Files / symbols |
|---|---|---|---|
| 1.1 | DB | `ConsultationStatus` enum + `Consultation.status` col; **non-destructive backfill** from `metadata.status`; drift-guard update | `db_main/consultation.prisma`, migration, `seed/09-consultation.ts` |
| 1.2 | DB | `ContextItemType += SIGNED_NOTE`; `ContextItemVersion` attestation cols; `NamedEntity` ontology cols + transcript-span FK; `SummaryMeta` sensor/citation cols | `db_main/consultation.prisma` |
| 1.3 | Domain | Extend entities/factories/mappers/repos; `NamedEntityRepository.findByContextItem` returns offsets+codes | `packages/domains/src/**` |
| 1.4 | Services | **NER→prompt injection**: add `nerEntities` to `PromptAssemblyParams`; `buildVariables()` serialises entities; `SummaryProcessor` queries `NamedEntityRepository` before `assemble()` | `prompt-assembly.service.ts:119`, `summary.processor.ts:~119/133` |
| 1.5 | Services | **Activate SOAP `json_schema`**: seed a SOAP `outputSchema` into a template's `metaData.promptConfig`; assert `responseFormat` flows (non-Ollama) | `prompt-assembly.service.ts:97`, `smr-generate.ts:112`, prompt-template seed |
| 1.6 | Python | `apps/harness` Temporal workflow + worker; Activities: `extract_entities`, `assemble_prompt`, `generate`, sensors; bounded regen loop (max N) | `apps/harness/workflow/**`, `activities/**` |
| 1.7 | Python | **Computational sensors** (RED-first, deterministic fixtures): entity-faithfulness (note entity ↔ transcript NER span), coverage/omission (transcript entities absent from note), schema validity, citation-presence, numeric/dose cross-check | `apps/harness/sensors/computational/**` |
| 1.8 | Python | Verdict aggregator (pass / bounded-regen / flag-claims); regen only the offending section | `apps/harness/loop/aggregator.py` |
| 1.9 | API | Gate adapter contract: harness → `apps/api` draft + provenance map + per-claim confidence + flags; status → `PENDING_REVIEW` | `apps/api/src/modules/consultation/**`, SSE `notifyProgress` |
| 1.10 | API | **Attestation gate**: `approveSummary` writes `SIGNED_NOTE` version + attestation fields + `ATTEST` `HarnessAuditEvent`; status → `SIGNED`; **E2E test asserts the gate cannot be bypassed** | `summary.service.ts:~333`, `consultation.controller.ts:~901` |
| 1.11 | SDK/UI | Linked-evidence review UI: click note line → highlight transcript span; unverified/low-confidence floated to top | `packages/agentic-sdk-v2/**`, review UI |

**Tests:** pytest (sensors with crafted transcript/note fixtures — must see RED), vitest (NER injection, attestation,
status machine), Playwright E2E (gate-not-bypassable, provenance surfaced).
**Exit gate:** on golden set, omission + fabrication rates **down vs Phase-0 baseline** (eval proves it); every signed
note has an attestation event + provenance map; structured SOAP active.
**Regulatory:** stays **non-device** (documentation aid + mandatory sign-off). **Effort:** XL.

---

### Phase 2 — Inferential sensors + layered guardrails  ✅ implemented + verified (2026-06-07)
**Objective:** add semantic groundedness + safety; replace SMR regex guardrails; fail-closed PHI.
**Depends on:** Phase 1.

> **Status: ✅ implemented + verified end-to-end 2026-06-07** (README §9). Evidence: harness pytest **316 ✓**,
> applications harness **21 ✓**, apps/api harness controller+guard **12 ✓**, ReadLints/ruff clean; **live eval-delta**
> recording groundedness + `ragTriadScore` via the calibrated `google/gemma-4-e4b` judge (faithful 1.0/1.0 PASS,
> fabricated 0.0/0.333 REGEN, mixed 0.5/0.667 REGEN); **live safety** via Granite Guardian (benign→PASS, violent→FLAG).
> **Intentional deviations from the task rows below:** **2.1** groundedness uses **per-claim entailment via the calibrated
> LM-Studio judge** (`get_runtime_judge_config()`), not a separate Bespoke-MiniCheck-7B deployment; **2.2** reuses that
> **same calibrated judge** rather than a distinct `sensors/judge/**` module (REDUCED_ASSURANCE recorded as specified);
> **2.4** safety = **IBM Granite Guardian 3.3** over Ollama (not Llama Guard 3), and the **SMR regex-guardrail retirement is
> DEFERRED** — `apps/smr` was out of scope for this pass (hard constraint), so `guardrails.py`/`external_guardrail.py` remain
> on the SMR hot path and the Guardrails-AI compose layer is not yet added. **2.3** PHI fail-closed (`guards/phi/`, not
> `guides/phi/`) + **2.5** persistence (`SummaryMeta.guardrailDecisions` + `SENSOR_RUN`/`REDUCED_ASSURANCE` WORM) landed as
> specified. **Exit-gate caveat:** "guardrail triggers visible in **Langfuse**" is **not live-verified** here (no live
> Langfuse in this env); the decisions are persisted to `SummaryMeta` + the WORM audit. Nothing committed.

| # | Layer | Task | Files |
|---|---|---|---|
| 2.1 | Python | **Groundedness sensor**: Bespoke-MiniCheck-7B per-claim entailment vs (transcript ∪ evidence); RAG-triad; refusal path | `apps/harness/sensors/inferential/**` |
| 2.2 | Python | **Reasoning judge** (PDSQI-9-aligned) for borderline claims; ≤20B via LM Studio, large via Azure/Bedrock; record `REDUCED_ASSURANCE` when only computational sensors available | `apps/harness/sensors/judge/**` |
| 2.3 | Python | **PHI redaction guide** (Presidio + clinical NER) on cloud egress; **fail-closed** (no PHI → cloud); upgrade path JSL | `apps/harness/guides/phi/**` |
| 2.4 | Python | **Safety classifier** (Llama Guard 3) + schema enforcement (Outlines+vLLM `guided_json` / OpenAI Structured Outputs) compose via Guardrails AI; **retire SMR regex** `guardrails.py`/`external_guardrail.py` from the hot path | `apps/harness/guards/**`, `apps/smr/**` |
| 2.5 | Services/API | Persist `guardrailDecisions` + sensor scores to `SummaryMeta` + `HarnessAuditEvent` | applications + api |

**Tests:** pytest (MiniCheck/judge/redaction/Llama-Guard with fixtures + fail-closed), vitest (persistence).
**Exit gate:** groundedness scores recorded per claim; PHI fail-closed proven; reduced-assurance logged; guardrail
triggers visible in Langfuse. **Regulatory:** non-device; reduced-assurance fallbacks audited. **Effort:** L.

---

### Phase 3 — Institutional grounding (UC-4)  ✅ implemented + verified (2026-06-07)
**Objective:** light up the **provisioned-but-empty** Qdrant `context_items` (1536-dim) with tenant-owned knowledge.
**Depends on:** Phase 1 (entities) — independent of Phase 2.

> **Status: ✅ implemented (Lanes A/B) + verified end-to-end (Lane C) 2026-06-07** (README §9). A **dedicated
> `knowledge_chunks` Qdrant collection** (named `dense` **1024**-dim/COSINE + sparse `bm25` IDF) was created instead of
> reusing the 1536-dim `context_items` collection — BGE-M3 is 1024-dim and the corpus is tenant-/APPROVED-filtered.
> **Evidence:** harness pytest **412 ✓** (+6 retrieval-eval, +4 RAG integration), vitest db **801**/domains **1173**/
> applications **4849**/api **1665 ✓**; db+domains build GREEN (applications+api builds blocked **solely** by the parallel
> Phase-6 lane — isolated, not Phase 3); retrieval-eval on the synthetic fixture **recall@5=1.0, MRR=1.0,
> citation-validity=1.0, cross-tenant leaks=0**; **4 deterministic RAG e2e** (real in-memory Qdrant engine + real BM25:
> ingest→retrieve→cite, cross-tenant isolation, APPROVED-gate, degrade-safe) **PASS**; Playwright spec authored
> (`--list` 5 tests, live full loop env-gated). **Lane-C integration fix:** `KnowledgeIngestClient` URL aligned to
> `{HARNESS_URL}/api/v1/internal/knowledge/ingest` (was missing the harness `/api/v1` prefix → would 404) + regression
> suite (6 ✓); `X-Service-Token`/`HARNESS_INTERNAL_SERVICE_TOKEN` verified matching both sides.
> **Intentional deviations from the task rows below:** **3.2** embeddings = **self-hosted BGE-M3 via LM Studio
> `/v1/embeddings`** (not cloud `text-embedding-3-small`) + sparse **fastembed BM25** for the hybrid channel, and ingest is
> driven by the **`IngestKnowledgeDocument` BullMQ queue + `KnowledgeDocumentService.approveDocument()`** (no `ContextItem`
> reuse / `qdrantSynced` flag — knowledge lives in its own tables/collection); **3.3** RRF is **server-side RRF** via the
> installed `qdrant-client` 1.17 `FusionQuery(RRF)` (no explicit `k` arg in this API version; `rrf_k=60` carried in
> `RetrievalConfig` for forward-compat) + TEI cross-encoder rerank (`hope-reranker`); **3.4** StrictCitations `[[kb:<id>]]`
> markers are **not stripped** from the persisted note (rendering-layer concern) and `CitationVerifySensor` reuses the
> calibrated `google/gemma-4-e4b` judge (threshold 0.8, REGEN-fixable). **Prerequisite handoff for the LIVE full loop:**
> load **BGE-M3 (1024-dim)** in LM Studio, bring up the **`hope-reranker`** TEI service (:8870), and supply the approved
> institutional corpus + the **N≈132 retrieval golden set** (`retrieval_eval.py --golden-set`, same shape). Nothing committed.

| # | Layer | Task | Files |
|---|---|---|---|
| 3.1 | DB/Domain | `KnowledgeDocument` + `KnowledgeChunk` (tenant-scoped, versioned, approval status) | `db_main/*.prisma`, domains |
| 3.2 | Services | Ingestion job: chunk (400–512 tok, 10–20% overlap) → embed `text-embedding-3-small` → upsert Qdrant; set `ContextItem.qdrantSynced` | applications + BullMQ |
| 3.3 | Python | JIT retriever guide: hybrid BM25+dense → RRF(k≈60) → cross-encoder rerank → top-k; entity-triggered | `apps/harness/guides/retrieval/**` |
| 3.4 | Python | **StrictCitations** (cite chunk ID per claim) + **verify-citations** post-hoc (entailment vs cited chunk); "unverified" badge on degrade | `apps/harness/guides/retrieval`, sensors |

**Tests:** pytest (chunking, RRF, rerank fallback, citation verify), vitest (ingestion, tenant-scope), retrieval eval
on golden set. **Exit gate:** % claims with valid citation tracked; retrieval degrades gracefully.
**Regulatory:** internal+institutional only → **no corpus licensing exposure** (D5). **Effort:** L.

---

### Phase 4 — Interoperability + India governance (D6)
**Objective:** capture FHIR/ABDM identifiers + DPDP machinery; emit OPConsultRecord (exchange flag-gated).
**Depends on:** Phase 1 (signed note + audit).

| # | Layer | Task | Files |
|---|---|---|---|
| 4.1 | DB/Domain | `PatientConsent`+`ConsentEvent`, `BreachIncident`, `Consultation` FHIR-ID cols, `Tenant` residency cols; `HarnessAuditAction` CONSENT_*/BREACH_* | `db_main/*.prisma`, domains |
| 4.2 | Services/API | DPDP consent capture + **withdrawal** + immutable consent log; **≤72-hr breach** report workflow; residency toggle enforced on cloud egress | applications + api |
| 4.3 | Services | **FHIR adapter**: signed note → NRCeS **`OPConsultRecord` DocumentBundle** (Composition-first; SNOMED/LOINC); 3-stage LLM→FHIR (terminology retrieve → schema-constrained → FHIR-validator repair ≤3) | new `fhir` module |
| 4.4 | CI | Validate bundles against **NRCeS profiles** in CI; **flag-gate** live HIP/HIU exchange | `.github/workflows`, tests |
| 4.5 | Docs | DPA template + sub-processor disclosures + "no PHI for training without consent" | `docs/` |

**Tests:** vitest (consent/withdrawal/breach, residency fail-closed), FHIR-validator CI, pytest (LLM→FHIR repair).
**Exit gate:** consent + breach flows tested; OPConsultRecord validates; exchange remains flag-off.
**Regulatory:** DPDP/ABDM/Telemedicine readiness; **non-device** maintained. **Effort:** XL.

---

### Phase 5 — Bounded read-only clinical tools (UC-3, D7)
**Objective:** advisory drug/terminology/history tools — cited, never auto-applied.
**Depends on:** Phase 1–2 (sensors/guardrails).

| # | Layer | Task | Files |
|---|---|---|---|
| 5.1 | Python | `drug_normalize` (RxNorm `rxcui.json?search=2`) + `check_drug_interaction` (**openFDA label**; NLM DDI API is dead) + DDInter 2.0 severity | `apps/harness/tools/drug/**` |
| 5.2 | Python | `normalize_entity` (UMLS/SNOMED via Snowstorm/MCP), `lookup_patient_history`, `get_department_template`, `flag_for_review` | `apps/harness/tools/**` |
| 5.3 | UI | Surface tool output as **provenance chips** only ("⚠ interaction via RxNorm/openFDA"); advisory, tenant-scoped, read-only | review UI |

**Tests:** pytest (tool clients mocked; advisory-only assertions; never-auto-apply). **Exit gate:** tools cited +
advisory; no write/action tool present. **Regulatory:** any "drives management" feature → **separate SaMD track**
(do not ship here). **Effort:** M.

---

### Phase 6 — Harness Administration & Observability Console  ✅ implemented + integrated-verified (2026-06-07)
**Objective:** give platform + tenant admins a first-class surface (in `apps/ui-playground` `/admin/harness`) to **observe**
harness activity (WORM audit + integrity verdict, eval runs, clinician gate queue), **operate** the durable Temporal document
workflows (list / describe / cancel / terminate / re-signal), and **manage** the DB-backed policy that the clinical loop reads
**live** — every policy edit append-only WORM-audited, with platform-vs-tenant role separation. Detailed plan:
[`.cursor/plans/harness_admin_console_68547a26.plan.md`]. Built by three sibling lanes (BP1 TS backend, BP2 Python harness,
BP3 frontend) + this integrated verification/documentation pass.

**Locked governance decisions (carried from the plan).**
- Policy edits are **live + WORM-audited** — the next workflow run picks up the change via the `fetch_policy` activity; every
  edit appends a `HarnessPolicyChange` (before/after) in the same transaction as the row write.
- Workflow ops: **tenant admins** may cancel / terminate / re-signal **their own tenant's** workflows; **platform
  (super-admin)** admins act cross-tenant. Ownership is enforced **server-side** (apps/api re-`describe`s the workflow and
  matches `HarnessTenantId` against the caller's CLS tenant; super-admins bypass).
- Admin home is `apps/ui-playground` `/admin` (there is **no** `apps/admin` in this repo despite the project-context rule).

**Data model (additive, non-destructive) — migration `20260607120000_task_330_phase6_harness_policy`.**
- `HarnessPolicy` (tenant-scoped, `_version` OCC, **unique on `tenantId`**): sensor thresholds
  (`entityFaithfulnessThreshold` 1.0, `coverageThreshold` 0.8, `citationPresenceThreshold` 1.0, `numericDoseThreshold` 1.0,
  `groundednessThreshold` 0.8), guard toggles (`safetyEnabled`, `phiEnabled`, `phiFailClosed`), model selection
  (`safetyProvider`/`safetyModel`, `smrProvider`/`smrModel`), loop knobs (`maxRegen` 2, `gateSlaSeconds` 86400,
  `gateEscalationSeconds` 43200), and `toolAllowlist` Json. The **GLOBAL-DEFAULT** row lives under the system tenant
  `00000000-…-000000000000` (seeded by the migration via `ON CONFLICT (tenantId) DO NOTHING`); tenant rows override it.
- `HarnessPolicyChange` (append-only **WORM**, mirrors `HarnessAuditEvent`): `tenantId, changedBy, policyVersion,
  beforeJson, afterJson, reason, createdAt`. The migration runs a **role-guarded, idempotent** `REVOKE UPDATE, DELETE …
  FROM hope_app_template / hope_app` so the trail is immutable at the **DB-privilege** layer (proven by the live-Postgres
  regression `harness-policy-change-worm.postgres.test.ts` → UPDATE/DELETE rejected with SQLSTATE `42501`).
- Both models added to the `TENANT_SCOPED_MODELS` **drift guard** ([`extensions/tenant-scope.ts`]) + full hand-written
  Domain layer (Entity/Factory/Mapper/Model/Repository) + `CoreDatabaseModule` registration + barrels.

**API surface (`apps/api` `HarnessAdminController`, global prefix → `/api/v1/admin/harness/*`).**

| Method | Path | `@Authorize` ability | Notes |
|---|---|---|---|
| GET | `/admin/harness/policy` | `read HarnessPolicy` | Effective policy (tenant row → global default → code default). `ETag: "<version>"`. |
| PATCH | `/admin/harness/policy` | `manage HarnessPolicy` | Sparse patch; **`If-Match` OCC** (412 drift / 428 missing); appends a `HarnessPolicyChange`. Row created on first edit. |
| GET | `/admin/harness/policy/global` | `read HarnessPolicy` | Platform GLOBAL-DEFAULT (super-admin only → 403). |
| PATCH | `/admin/harness/policy/global` | `manage HarnessPolicy` | GLOBAL-DEFAULT edit (super-admin only); same OCC + WORM. |
| GET | `/admin/harness/audit` | `read HarnessAudit` | Newest-first WORM trail + hash-chain integrity verdict (`?tenantId` platform-only, `?consultationId`, paging). |
| GET | `/admin/harness/eval-runs` | `read HarnessEval` | Eval runs (`?goldenSetId`, paging). |
| GET | `/admin/harness/eval-runs/:id` | `read HarnessEval` | One run + per-case scores. |
| GET | `/admin/harness/gate-queue` | `read HarnessWorkflow` | `Consultation.status = PENDING_REVIEW` + SLA/escalation from the effective policy. |
| GET | `/admin/harness/workflows` | `read HarnessWorkflow` | Temporal list, tenant-filtered (super-admin `?tenantId`; omit = all). |
| GET | `/admin/harness/workflows/:id` | `read HarnessWorkflow` | Describe (`?phase=true`); ownership-checked (403 cross-tenant). |
| POST | `/admin/harness/workflows/:id/cancel` | `manage HarnessWorkflow` | Graceful cancel; tenant-ownership enforced. |
| POST | `/admin/harness/workflows/:id/terminate` | `manage HarnessWorkflow` | Forceful terminate + reason; ownership enforced. |
| POST | `/admin/harness/workflows/:id/signal` | `manage HarnessWorkflow` | Arbitrary signal; ownership enforced. |
| GET | `/internal/harness/policy?tenantId=` | service-token (`@Public`) | **Worker** `fetch_policy` read on `HarnessInternalController`; re-establishes CLS to the requested tenant. |

The 9 `/admin/harness/*` routes all carry a **concrete** `@Authorize([...])`, so the boot-time admin-route permission audit
([`apps/api/src/bootstrap/admin-route-permission-audit.ts`]) passes (no empty-`@Authorize()` admin route). Outbound Temporal
ops go through `HarnessOpsClient` (HTTP-only, `X-Service-Token`, `HARNESS_BASE_URL`→`HARNESS_URL`→`localhost:8866`).

**Harness Temporal admin endpoints (`apps/harness`, mounted at `/api/v1/internal/harness/*`, `X-Service-Token`).**
`GET /workflows` (visibility query, cursor-paged), `GET /workflows/{id}` (`?phase=true` queries the loop phase),
`POST /workflows/{id}/cancel|terminate|signal`. Tenant ownership rides a **custom Keyword search attribute
`HarnessTenantId`** set via `search_attributes=` on `start_workflow`, plus a **memo fallback** (`tenantId`) — if the SA is
not registered on the cluster, both the start and the admin list **degrade** to memo + client-side filtering (never 500 /
never block a consultation). One-time infra: `temporal operator search-attribute create --name HarnessTenantId --type Keyword`.

**Loop injection — `fetch_policy` activity (policy now drives the durable loop).**
At workflow start `HarnessDocWorkflow` runs a new `fetch_policy` **activity** (calls `GET /internal/harness/policy` via the
api client) and threads the result deterministically into the loop body: `maxRegen`/`gateSlaSeconds`/`gateEscalationSeconds`
→ the gate config (bounded-regen budget + the SLA/escalation durable timer); `to_sensor_thresholds()` →
`RunSensorsInput.thresholds` for the computational sensors; `groundednessThreshold` + `safetyEnabled` → the inferential
sensors; `smrProvider`/`smrModel` defaults (workflow input still overrides). When no policy resolves, the input + code
defaults govern (fail-safe). RED proof: `test_policy_injection.py` shows a lowered threshold flips the gate verdict.

**RBAC ([`seed/01-policy.ts`]).** New CASL subjects **`HarnessPolicy` / `HarnessWorkflow` / `HarnessAudit` / `HarnessEval`**.
Two dedicated policies: **`harness-platform-manage`** (`GLOBAL` — manage `HarnessPolicy`/`HarnessWorkflow`, read
`HarnessAudit`/`HarnessEval` cross-tenant) and **`harness-tenant-manage`** (`TENANT` — same abilities, `tenantId`-conditioned).
The existing `tenant-full-access` policy also gains the four tenant-scoped grants.

**Frontend (`apps/ui-playground/src/features/admin/harness/` + routes `_authenticated/admin/harness/*`).** Overview, Audit,
Evals, Workflows (confirm-dialog destructive actions + toasts), Policy (threshold/toggle/model/tool editor with `If-Match`
and a safety-lowering confirm dialog). Nav entry + `RequireAdmin` guards; **platform-only** surfaces (the GLOBAL-DEFAULT
policy editor, cross-tenant lists) are hidden unless the GLOBAL ability is present. TanStack Query + `admin-data-table` +
skeleton loading per the UI rules.

**Deviations reported by the three lanes.**
- The **frontend mirrors the API DTOs locally** (`features/admin/harness/api/harness.ts`) because `@arcaai/applications` is
  server-only and must not be imported into the browser bundle. The integrated check confirmed the mirrors match the live
  controller JSON (builds + ui-playground typecheck clean on the harness files).
- The **audit action/date filters are client-side** (the API returns a newest-first page; filtering by action/date happens
  in the table). Follow-up: server-side audit filters.
- The harness `describe` endpoint surfaces `tenantId` but **ownership is enforced API-side** (apps/api), not in the harness.

**Migration note.** The schema is **additive** (two new tables + indexes + a guarded `REVOKE` + one GLOBAL-DEFAULT seed row).
The committed SQL lives at `…/migrations/20260607120000_task_330_phase6_harness_policy/migration.sql` for `prisma migrate`
environments; on the **db-push dev** environment it was applied via `prisma db execute` (the live WORM test confirms the
table + REVOKE are present). **No `DROP`/`DELETE`/`TRUNCATE`** anywhere; nothing committed.

**Integrated verification evidence (2026-06-07).** `pnpm db:generate` ✓; `pnpm build --filter @arcaai/domains --filter
@arcaai/applications` ✓ (7/7) + `pnpm build:api` ✓ (8/8); vitest **domains 1173 ✓** / **applications 4857 ✓** / **api 1695 ✓**
(incl. **admin-route permission audit 15 ✓**); **`HarnessPolicyChange` WORM 21 ✓** on the live dev DB (UPDATE/DELETE →
`42501`; real `hope_app`/`hope_app_template` roles confirmed REVOKEd); **harness pytest 443 ✓**; **ui-playground 1052 ✓**;
`ReadLints` clean on the changed files. Known **pre-existing, unrelated** non-Phase-6 findings (left as-is): 3 `tsc` errors in
the untouched `ui-playground/.../jobs.ts`+`queues.ts`, a ruff `B017` in the untouched `eval/test_calibration_levers.py`, and
2 `*.postgres.test.ts` in `packages/domains` that self-skip without a live `.env.test` DB. The Phase-3 lane's earlier note of
an "applications+api build blocked by the parallel Phase-6 lane" is **now resolved** — the full monorepo builds GREEN.

**Follow-ups for a future ticket.** Server-side audit action/date filters; **eval-gated policy edits** (block lowering a
safety threshold unless a recent eval run clears it); a managed Temporal `HarnessTenantId` search-attribute provisioning step
in prod IaC; optional dedicated domain-layer unit specs for `HarnessPolicy*` (currently covered indirectly via the service +
WORM + drift-guard tests).

---

### Parallel corrective track (small, independent tickets)
| Item | Fix | Files |
|---|---|---|
| NLP doc-type classifier | replace `michellejieli/emotion_text_classifier` default with a real doc-type model | `apps/nlp/.../config.py:~90` |
| STT speaker store | restore/replace deleted Qdrant vectorstore source (only `.pyc` remains) or document in-memory-only diarization | `apps/stt/**` |

---

## 5. Testing & CI strategy (consolidated)
- **Unit**: pytest (`apps/harness`, Python sensors/tools/guards — deterministic fixtures, RED-first); vitest
  (domains/applications/api).
- **Eval (Phase-0, gates every later phase)**: golden set + PDSQI-9 judge + RAGAS + DeepEval; **pinned dataset
  version**; DeepEval/promptfoo as **release-blocking** CI.
- **Red-team**: promptfoo (dictation-borne injection, PHI leakage, overreliance) — local, no egress.
- **Shadow mode**: new model/prompt/RAG runs silently vs replayed consults; compare scores + edit-rate before
  clinician exposure.
- **E2E (Playwright)**: full loop on synthetic consults; **assert the HITL gate cannot be bypassed**; audit-chain
  completeness; FHIR bundle validates vs NRCeS in CI.
- **Telemetry test**: CI scans exported Langfuse/OTel for PHI patterns (defense-in-depth).
- **Post-deploy**: Langfuse drift on faithfulness + edit-rate; escalate **>15–20% correction**.

## 6. Sequencing & milestones
```
Phase 0 (eval + WORM)  ──►  Phase 1 (computational sensors)  ──►  Phase 2 (inferential + guardrails)
                                      │
                                      ├──►  Phase 3 (institutional RAG)   ──►  Phase 5 (read-only tools)
                                      └──►  Phase 4 (interop + India gov)
Corrective track: anytime (independent)
```
- **M1 = Phase 0**: measurement + audit before any generation change.
- **M2 = Phase 1**: accuracy core (omission/fabrication ↓, attestation, provenance) — biggest clinical win.
- **M3 = Phase 2–3**: semantic grounding + institutional knowledge.
- **M4 = Phase 4–5**: India/interop + advisory tools.

## 7. Risks & rollback
| Risk | Mitigation |
|---|---|
| Temporal ops overhead (D11) | self-host in `infrastructure/docker` first; keep Activities idempotent; document worker runbook |
| Off-the-shelf NLI/PHI degrade on clinical text | budget clinical **fine-tune** of MiniCheck/de-id (HLD risk); force human review meanwhile |
| Latency (realtime) | incremental state updates; async grounding at end-of-consult; cheap hot-path model |
| Local-model assurance gap (D3) | record `REDUCED_ASSURANCE`; computational sensors are model-agnostic |
| Schema/migration regressions | additive-only; drift guard; per-phase migration review; reversible |
| Each phase is independently revertable | feature-flag the harness path; `apps/api` legacy summary path stays until parity |

## 8. Definition of done (per phase — `01-development-workflow.mdc` checklist)
- [ ] New/changed tests pass (paste output) · [ ] affected packages build · [ ] no new lints (`ReadLints`)
- [ ] barrel exports + module registrations (CoreDatabaseModule/ServiceModule) updated
- [ ] drift guard updated for new tenant-scoped models · [ ] migration reviewed (additive)
- [ ] README §9 Implementation Summary updated (files, migrations, endpoints, deviations) + status moved forward
- [ ] eval gate green vs pinned golden set · [ ] evidence captured in this ticket

---

> **Approval needed (Phase-3 gate):** confirm Phase order + the four open prerequisites (§0). On approval, work
> begins at **Phase 0**, TDD, one feature branch per phase.
