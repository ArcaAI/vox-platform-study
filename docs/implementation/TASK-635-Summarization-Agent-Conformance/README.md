# TASK-635 — Summarization Agent Conformance, Prompt Test Bench & Live-Agent Architecture

| | |
|---|---|
| **Status** | In Progress |
| **Classification** | feature + bugfix + refactor (multi-lane program) |
| **Created** | 2026-08-07 |
| **Branch** | dev-2.1 |
| **Related tickets** | TASK-634 (pre-summary/summary prompt fidelity — in flight, uncommitted), TASK-592 (compat SMR integration), TASK-588 (tenant-configurable SMR selection), TASK-560 (v1→v2 compat), TASK-599 (DNA style), TASK-548 (golden library) |
| **Execution model** | Parallel agent team; per-task model tier + effort assignments in §5 |

---

## 1. Requirement Analysis

The product owner specified the target behavior for summarization "agent" activation across both SDK surfaces, plus one hard platform capability. Verbatim requirements, restated:

### 1.1 Native path (`@arcaai/vox` v2 SDK)

- **R-N1 (live)**: During recording, live summarization MUST be handled by a **specific, configurable agent** — configured with a specific prompt, **tools**, and backed by a **selected LLM provider** — which performs **tool calling** for named-entity recognition / highlighting of important findings using the NLP service or other existing medical AI models.
- **R-N2 (finalize)**: After stop recording, **the same specific agent** reviews and finalizes the summarization.

### 1.2 Compat path (`@arcaai/vox/compat` SDK + `smr-compat` API)

- **R-C1**: Start recording → realtime **transcript only** (no live summarization loop).
- **R-C2**: Stop recording → activate a summarization agent **by department AND visit-type**; the LLM MUST be the **default set by the tenant admin**.
- **R-C3**: An extra activity allows pre-summarization using a **default fallback instruction without any indicator about department or visit-type**.

### 1.3 Platform capability (hard MUST)

- **R-T1**: A tenant admin MUST be able to **test any prompt instruction template** using a **predefined example or a given example data**.
- **R-T2**: The tenant admin MUST be able to **select the LLM provider** used for the test summarization run.

---

## 2. Current State Evaluation (verified 2026-08-07, dev-2.1 working tree incl. uncommitted TASK-634 changes)

### 2.0 Conformance scorecard

| Req | Verdict | One-line reason |
|---|---|---|
| R-C1 | ✅ CONFORMS | Compat exposes only 2 generation routes; no live hook in `src/compat/` |
| R-C2 | ⚠️ PARTIAL | Dept×visit works via legacy columns; tenant LLM honored — but the agent tier collapses visit-type when present (F-01), and `DepartmentAgent` carries no LLM/tools (F-02) |
| R-C3 | ⚠️ PARTIAL | Resolution chain conforms; the **prompt text** still interpolates `{current_department}`/`{visit_type}` (F-03, → OD-1) |
| R-N1 | ❌ DOES NOT CONFORM | Live prompt hardcoded; NER hardcoded orchestration, not tool-calling; no agent abstraction (F-04) |
| R-N2 | ❌ DOES NOT CONFORM | Live/finalize share nothing; warm-start review off-by-default AND broken by an encryption bug (F-05, B-02) |
| R-T1 | ⚠️ PARTIAL | Test endpoint exists (user-supplied sample only, persisting write, mutable draft) — no predefined-example source (F-06) |
| R-T2 | ❌ MISSING on the test route | Provider hardwired to tenant policy; provider selection exists only on the disconnected playground path (F-07) |

### 2.1 How activation works today (both stacks)

Two parallel stacks, both funneling into `PromptResolutionService.resolve()` (`packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts:235`):

- **Compat**: free-text department → `matchTenantDepartment()` (`apps/api/src/modules/smr-compat/department-match.ts:29`; exact code → exact name → v1 alias via `resolveDepartmentKey`, `dept-templates.ts:107`) → real `Department` UUID → resolver. Visit type normalized by `normalizeVisitType()` (`dept-templates.ts:67`) → `toSummaryPromptType()` → `'new-patient' | 'revisit'` (`smr-compat-template.service.ts:36-38`).
- **Native**: explicit `departmentId` on `POST /consultations/open`, stamped on the `Consultation`; visit type derived from `parentConsultationId` lineage (`summary.service.ts:382`).

**Summary resolution chain** (`prompt-resolution.service.ts:313-375`): tier-0 doctor-preferred → tier-1a **DepartmentAgent default** (`resolveDepartmentAgent`, `:563-593`; serves the immutable `PromptVersion` snapshot at `pinnedVersionNumber ?? approvedVersionNumber ?? latest`) → tier-1b legacy `Department.newPatientPromptId`/`revisitPromptId` columns → tier-2 `SYSTEM_DEFAULTS.promptId` (CATCHALL_SOAP, hardcoded at `:171`).

**Pre-summary chain** (`:377-436`, TASK-634): deliberately consults NEITHER preferred, NOR agent, NOR department columns — tenant `TENANT_DEFAULT` (tag-convention lookup `findTenantPreSummaryTemplateId`, `:463-475`) → `SYSTEM_DEFAULTS.preSummaryPromptId` (`…040`) → **503 fail-closed**.

**Tenant LLM default** (TASK-588): `HarnessPolicyService.resolveSmrSelection(tenantId, task)` (`harness-policy.service.ts:531-560`), task ∈ `'live' | 'finalize'` (`:35`), AiTaskDefault keys `smr.live`/`smr.finalize` + `.fallback` variants (`ai-task-default/constants.ts:22-34`), tenant-writable (excluded from `GLOBAL_ADMIN_ONLY_TASK_PREFIXES`, `:72-77`), descriptors `models.smr.*` (`settings-registry/descriptors/model-defaults.descriptors.ts:45-91`), admin routes `GET/PUT admin/ai-task-defaults/row`, UI `apps/admin-console/src/features/ai-task-defaults/components/smr-models-section.tsx` on the tenant `/ai-configuration` screen. Fail-closed if unresolved.

### 2.2 Findings (F-*) — detailed

#### F-01 — The visit-type collapse trap (blocks R-C2 being robust)
The agent tier returns **before** the visit-type columns are read (`prompt-resolution.service.ts:339-352` returns; `:327` reads `revisitPromptId`/`newPatientPromptId` only in tier-1b). A `DepartmentAgent` binds exactly ONE template per department. Consequence: any department with a default agent serves the **same** prompt for new-patient and revisit. Today's ArcaAI dept×visit fidelity works **only because the seed deliberately creates zero ArcaAI DepartmentAgent rows** (`07a-agent-golden-library.ts:270-280`, `04-department.ts:352-355` document the invariant). The invariant is **unguarded** — no test asserts it (see B-05); the `AgentTemplateResyncService` sweep (kill-switch seeded at `11-global-setting.ts:528-556`) or tenant provisioning could silently re-add an agent and collapse the split with nothing failing. Demonstrated at scale on the Global tenant: all 18 departments have default agents, so their visit-type columns are dead weight.

#### F-02 — `DepartmentAgent` is a prompt pointer, not an agent
Schema (`packages/database/src/prisma/db_main/department-agent.prisma:22-52`): `promptTemplateId`, `pinnedVersionNumber`, `dnaStylePolicy`, `harnessOverrides`, `goldenSetId`, `isDefault`, `templateLocked`. `harnessOverrides` is whitelisted to thresholds/pipeline knobs only (`departmentAgent/constants.ts:16-28`) — **no** `smrProvider`/`smrModel`, **no** tool configuration, **no** visit-type axis, **no** live-prompt binding. The requirements' notion of "agent" (prompt + tools + LLM) does not exist as a model.

#### F-03 — Pre-summary prompt text still carries department/visit-type (R-C3 ambiguity → OD-1)
Resolution conforms (no department axis, `smr-compat-template.service.ts:67-72` doesn't even pass department for pre-summary). But:
- System prompt: *"…producing clinically relevant, concise, **department-aware** pre-summaries…"* (`summary-prompt.builder.ts:198-199`).
- Body (`V1_PRE_SUMMARY_TEMPLATE`, `:211-212` + seeded `PRE_SUMMARY_CONTENT`, `07b-arcaai-clinical-content.ts:84`): `- **Department:** {current_department}`, `- **Visit Type:** {visit_type}`, `### PRIORITIZE: - Notes from {current_department}`, plus `(Latest Dept Note)` in three FORMAT section titles.
- Substitution defaults when absent: `current_department → 'General'`, `visit_type → 'Medical examination'` (`pre-summary-variables.ts:90-102`; blank counts as absent, `:81-83`). The LLM ALWAYS receives a department string.
- Same on native: `prompt-assembly.service.ts:628-641` re-injects the 9 variables; `resolveDepartmentName` degrades to `'General'` (`:689-700`).
- **Conflict**: stripping the placeholders breaks the TASK-634 byte-exact v1 fidelity checksum gate (`v1-clinical-prompt-fidelity.test.ts` locks `PRE_SUMMARY_CONTENT` sha256 `309a9cd1…`). v1 parity and dept-free pre-summary are mutually exclusive on the same template.

#### F-04 — The live loop has no agent (R-N1)
`LiveDocumentationService` (`packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts`, 2184 lines):
- System prompt hardcoded (`:1666-1675`: *"You are a clinical documentation assistant generating an in-progress, structured SOAP running note…"*; module constant `LIVE_SOAP_STABLE_SYSTEM_PREFIX` `:69-72`). Zero `department` hits in the file; constructor (`:334-367`) injects no `PromptResolutionService`/`PromptAssemblyService`/`DepartmentAgentRepository`.
- NER is a hardcoded orchestration step, not tool-calling: `:885` `await this.callNlp(nerSourceText, signal)` → direct `POST {NLP_URL}/api/v1/classify/tokens` (`:1710-1721`). The SMR payload (`:1666-1675`) has **no `tools`/`tool_choice` field**. The `TOOL_CALL` trajectory record (`:1063-1072`, `nlp.classify-tokens`) is bookkeeping of the hardcoded call, not a model-initiated tool call.
- Highlighting mechanism (works, keep): entities from the raw transcript delta (never the generated note — anti-laundering) are grounded to char offsets in the rendered note (`groundEntitiesToNote`); ungroundable entities are dropped. Published as `LiveSummaryEventDto` on Redis `consultation:live-summary:{id}`, relayed via SSE `GET /consultations/:id/live-summary/stream` (`consultation.controller.ts:509-521`).
- LLM selection IS tenant-configurable: `resolveSmrSelection(tenantId, 'live')` (`:1656-1657`) → `smr.live` AiTaskDefault. Env `LIVE_DOC_SMR_PROVIDER/MODEL` survives only as non-DI fallback (`:392-393`).
- Tenant-governed knobs are batching-only: `agentic.context.*` flush thresholds/delta caps (`:1593-1636`).

#### F-05 — Finalize does not "review" via the same agent (R-N2)
Live vs finalize are fully independent: prompts (hardcoded vs `PLATFORM_SYSTEM_PROMPT` + governed template), routing keys (`smr.live` vs `smr.finalize`), schemas (`LIVE_SOAP_RESPONSE_FORMAT` vs template `outputSchema`), agent identity (none vs DepartmentAgent tier). The only bridge — warm-start injection of the live SOAP snapshot as `preSummaryText` — is:
1. **Gated OFF by default**: `prompt-assembly.service.ts:534` checks `resolveWarmStartEnabled`; `HarnessPolicy.warmStartEnabled` defaults null (`harness.prisma:361`, `HarnessPolicyFactory.ts:41`) → env `HARNESS_WARM_START_ENABLED=false` in `.env.sample:284`/`.env.dev:269`/`.env.test:260`.
2. **Broken even when ON** in Vault-backed environments (B-02 below).
3. When working, it is a prompt append ("refine the STAGE 1 SCRATCHPAD…", `prompt-assembly.service.ts:540-550`), not a re-run of any live agent.

#### F-06 / F-07 — The test capability is half-built, split across two disconnected surfaces
- **Template test route**: `POST /api/v1/admin/prompt-templates/:id/test` (`prompt-management.controller.ts:268-306`, `@Authorize(['update','PromptTemplate'])` + `@RequiresIfMatch()`). DTO (`test-prompt-template.request.ts:12-30`): `variables?`, `sampleInput?`, `expectedVersion?` — **no provider/model**. Service `testPromptTemplate` (`prompt-management.service.ts:805-843`): `{{var}}` interpolation → `callSmrGenerate` (`:1003-1027`) which **hardwires** `resolveSmrSelection(this.tenantId)` with no task arg (silently `finalize`) and no caller override seam (`:1012-1021`) → heuristic `scoreOutput` (length/JSON-validity/variable-coverage; explicitly "not a semantic or clinical judgement"). It is an **OCC write** — persists `lastTestScore/lastTestOutput/lastTestAt`, bumps `_version` (`:820-830`). Tests the **mutable draft**, not a pinned `PromptVersion`. UI: `test` tab of the template drawer, `apps/admin-console/src/features/agents/components/test-run-panel.tsx:162-240` ("Sample input" textarea + Run test), reachable by tenant admins (`/agents` Templates tab is not elevated-gated; only Governance is, `agents-screen.tsx:257`).
- **Playground path**: `POST /api/v1/text/generate/assembled` (`smr-proxy.controller.ts:801-856`): accepts `provider`, `model`, `temperature`, `max_tokens`, `stream`; `applySmrModelSelection` (`:215-227`) forwards caller-supplied model untouched, else resolves policy fail-closed. Provider catalog: `GET /api/v1/text/providers` (`:1173-1225`) from ENABLED `AiModel` registry rows. But: template is a **raw-UUID text field** (`playground-llm/components/prompt-editor-card.tsx:249-257`), the route is constrained to `type: 'pre-summary' | 'summary'` with injected scaffolding (`validateAssembledRequest`, `:860-877`), and `debug` introspection gated to GLOBAL_ADMIN|TENANT_ADMIN (`:884-894`).
- **Predefined example data**: harness golden sets (`GoldenSet`/`GoldenCase`, `harness.prisma:43-119`, encrypted `transcript`+`referenceNote`, tenant-admin CRUD at `harness-admin.controller.ts:216-308`) are **judge-only**: `eval-run.service.ts:88-107` ships the stored reference note to be judged; `apps/harness/.../eval.py:15-18` is explicit — "Provenance, not generation." Judge model not per-run selectable. `DepartmentAgent.goldenSetId` (NOT `evalGoldenSetId`) is consumed only by the promotion gate (`eval-promotion-gate.service.ts:81`, `departmentAgent.service.ts:272`).
- Everything else checked and disqualified: `/prompt-studio` (redirect shim), `/ai-configuration` (read-only + BYOK), `/ai-services`, `/ai-operations/*` (telemetry), `agentic-admin` (read-only single route), deprecated `ui-playground` provider select.

### 2.3 Seed data audit — detailed

**Departments**: Global tenant 18 (`04-department.ts:16-343`), ArcaAI tenant 7 (`:362-479`; GEN, SURG, RHEUM, NEUR, ORTH, HEME, BREN; ids `00-constants.ts:228-234`), SYSTEM 18 golden clones (`07a:99-111`, prompt columns nulled).

**DepartmentAgent rows**: seeded ONLY in `07a-agent-golden-library.ts:334-346` — 18 SYSTEM golden (`isDefault:true`, unpinned, unlocked) + 18 Global clones (locked, `sourceAgentTemplateSlug`). **Zero for ArcaAI, deliberately** (TASK-592 Workstream D removal; retired id block `78000000-…-0001-…`).

**ArcaAI summary matrix — COMPLETE**: 7 departments × 2 visit types = 14 templates (`07b-arcaai-clinical-templates.ts:126-253`), wired via the legacy `Department.newPatientPromptId`/`revisitPromptId` columns (loose string refs, no FK — `department.prisma:21-23`). All `scope: DEPARTMENT_DEFAULT`, `category: SUMMARY`, `status: APPROVED`, **`approvedVersionNumber: 1` with byte-identical `PromptVersion` snapshots** (`07b:305-332`) — the ONLY seed set on the strict pinned-snapshot governance path. Global/SYSTEM template rows are APPROVED but unpinned (`approvedVersionNumber` never set in `07-prompt-template.ts`), so they resolve via the mutable-content legacy fallback in `resolveGovernedContent` (`prompt-resolution.service.ts:522-561` — degrades, never throws).

**ArcaAI pre-summary**: TENANT_DEFAULT row `71000000-0000-0000-0001-000000000024` (`07b:263-272`): `departmentId:null`, `scope:TENANT_DEFAULT`, tags incl. `pre-summary`, APPROVED, pinned v1, 9 declared variables (`07b:114-124`). Single candidate → deterministic. All 7 ArcaAI `preSummaryPromptId` columns null by design.

**Fidelity gate**: `v1-clinical-prompt-fidelity.test.ts` + `v1-clinical-prompt-checksums.fixture.ts` lock the 15 ArcaAI content constants byte-exact (sha256 per constant; exactly-15 guards; provenance = live v1 pod `apps-smr-84c9774997-zhp2l`, never a local checkout). NOT covered: Global templates, `…040`, SYSTEM golden, CATCHALL_SOAP, structure/wiring (that's `seed.test.ts:697-826` + `arcaai-clinical-templates-seed.test.ts`).

**Seed defects** → B-01, B-04, B-05, B-08 below. Coupling hazards documented in-file: `interpolateTemplate` is `{{var}}`-only and leaks literal braces on the `{single_brace}` pre-summary body (`07b-…-content.ts:30-33`); the five FORMAT titles are title-matched by `PRE_SUMMARY_DISPLAY_TITLES` in `summary-response.mapper.ts` — edit both sides or `structured_data.sections` comes back empty (`:35-37`); `PRE_SUMMARY_VARIABLES` duplicated into `packages/database` with a cross-package divergence guard test (`07b-…-templates.ts:105-113`).

### 2.4 Defect register (B-*) — bugs independent of new features

| ID | Severity | Defect | Evidence | Fix sketch |
|---|---|---|---|---|
| **B-01** | High | **Global-tenant pre-summary resolves the WRONG row.** Two Global rows satisfy the tag convention (`…026` PRE_SUMMARY_SYSTEM — a one-paragraph system-role stub — and `…040` the full body); multi-candidate branch (`prompt-resolution.service.ts:477-484`) picks first by `createdAt asc, id asc` → `…026` wins | `07-prompt-template.ts:1461-1473` vs `:1487-1610`; seed order | Retire `…026` from the convention (drop its `pre-summary` tag) or introduce the first-class pointer (OD-4); add a seed test asserting single-candidate per tenant |
| **B-02** | High | **Warm-start `preSummaryText` is empty in Vault-backed envs.** Plaintext `ContextItem.content` column was DROPPED (`consultation.prisma` ~:93-98); `findLatestPreSummary` (`ContextItemRepository.ts:106-121`) never decrypts (`decryptContentFromEntity` lives in `ContextItemRepository.encryption.ts:36-82`, not called); `summary.service.ts:395` reads `latestPreSummary?.content` → undefined. Same shape on harness: `harness-internal.service.ts:586` + `loadLiveSoapSnapshot` (`:1234-1239`) via non-decrypting `findPreSummaries` | as cited | Route the read through the decrypting accessor; add an integration test with encrypted fixture |
| **B-03** | Medium | **`smr.finalize.fallback` is configurable in the admin UI but INERT on native finalize.** `resolveSmrFallbackSelection` is called only from smr-compat (`smr-compat.controller.ts:429,481,569,612`); never from `summary.service.ts` or any processor | grep-verified | Add fallback retry to `SummaryService.callSmrService` mirroring compat's provider-failure swap |
| **B-04** | Medium | **Native `resolveSmrSelection()` trusts CLS with no fail-closed assertion.** All native call sites pass no tenantId (`summary.service.ts:1185`, `summary.processor.ts:286`, `pre-summary.processor.ts:257`, `comprehensive-summary.processor.ts:362`, `chain-summary.service.ts:607`); `harness-policy.service.ts:368` falls back to `callerTenantId`. A worker path with unpopulated CLS silently serves the SYSTEM default model instead of the tenant's | as cited | Assert tenant presence at the resolve site (compat's `requireTenantId()` pattern, `smr-compat.controller.ts:678-684`) |
| **B-05** | Medium | **Unguarded invariant: "ArcaAI has zero DepartmentAgent rows."** Nothing fails if one is added (resync sweep / provisioning), silently collapsing new-referral vs follow-up (F-01) | `07a:270-280` prose only | Seed test: `departmentAgent.count({tenantId: ARCAAI}) === 0`; plus longer-term OD-2 |
| **B-06** | Medium | **`findLatestPreSummary` is not `subType`-aware** on the `SummaryService` path — a case-notes PRE_SUMMARY created after the live snapshot shadows it. Only harness filters `subType === 'LIVE_SOAP_SNAPSHOT'` | `live-documentation.service.ts:1474-1476` (documented) | Add optional subType filter param; SummaryService passes it |
| **B-07** | Low | **Compat SDK dead call**: `useSMR.ts:311` calls `summary/async` — route exists only on native (`consultation.controller.ts:1062`), not on the compat controller | as cited | Decide: implement compat route or remove/deprecate the SDK method |
| **B-08** | Low | **Stale seed NOTE** (`07b-arcaai-clinical-templates.ts:288-295`) still claims the resolver lacks a tenant-default tier — the companion change landed in TASK-634 | as cited | Rewrite the NOTE to describe the shipped chain |
| **B-09** | Low | **Dead constant + cross-tenant pointer**: `ARCAAI_FALLBACK_TEMPLATE_IDS.SUMMARY` (`07b:297-302`) points at Global-owned CATCHALL_SOAP, referenced only by seeds/tests; resolver hardcodes the same id independently (`prompt-resolution.service.ts:171`) | grep-verified | Remove the constant or make it the single source the resolver imports |
| **B-10** | Low | **`…040` "SYSTEM default" pre-summary is owned by the GLOBAL customer tenant** and is a hand-maintained near-duplicate of the ArcaAI body — un-checksummed, free to drift; cross-tenant reachability from other tenants depends on repository scoping (unverified) | `07-prompt-template.ts:1487-1610` | Deduplicate into a shared constant; verify/lock cross-tenant read path; consider SYSTEM-tenant ownership |
| **B-11** | Low | `:id/test` persists `lastTest*` + bumps `_version` (a test run mutates the resource under OCC) and tests the mutable draft, not a pinned version | `prompt-management.service.ts:820-830` | Dry-run mode (Lane B) |
| **B-12** | Medium (latent) | **Discovered during A1/Task-3 (2026-08-08): the tier-2 pre-summary fallback (`SYSTEM_DEFAULTS.preSummaryPromptId` = `…040`) is unreachable cross-tenant.** `PromptTemplate` is in `TENANT_SCOPED_MODELS` (`tenant-scope.ts:96`) but NOT in `SYSTEM_SHARED_READ_MODELS` (`:262-359`); `mergeTenantIntoWhere` (`:573-585`) injects the caller's own tenantId, and `…040` is owned by the GLOBAL customer tenant — so any other tenant's lookup misses, `isApprovedTemplate` (`prompt-resolution.service.ts:627-639`) returns false, and tier-2 falls through to the 503 instead of the fallback. Latent today (ArcaAI has its own TENANT_DEFAULT row); breaks the first tenant provisioned without one. Only GLOBAL_ADMIN callers bypass (tenant-injection pass-through) | A1 agent evidence chain, 2026-08-08 | Re-own `…040` under the SYSTEM tenant (`00000000-…`) + add `PromptTemplate`/`PromptVersion` to `SYSTEM_SHARED_READ_MODELS` (read-widening only), + a resolution test from a fresh tenant. Fold into Lane C2's seed/migration work (same files) or a dedicated A-lane follow-up — owner's call at Wave-1 review |

### 2.5 Assets to build on (verified seams)

1. SMR accepts explicit per-request `provider`/`model` + BYOK `provider_overrides` (`apps/smr/src/smr/models/requests.py:30-49`).
2. `applySmrModelSelection` honors caller-supplied model untouched (`smr-proxy.controller.ts:215-227`).
3. Provider catalog endpoint powering a picker: `GET /text/providers` (`smr-proxy.controller.ts:1173-1225`) + UI wiring (`playground-llm/api/client.ts:11-13`).
4. Working test-service seam: `testPromptTemplate` interpolate→call→score (`prompt-management.service.ts:805-843`).
5. Server-side template assembly with tenant/owner guards incl. cross-tenant 404 (`smr-proxy.controller.ts:893-1066`).
6. Immutable `PromptVersion` snapshots (`prompt-template.prisma:110-140`).
7. Golden sets as a predefined-example corpus (`harness.prisma:43-119`).
8. Playground LLM screen already does pick-provider+run (`playground-llm-screen.tsx:259-289`), tenant-admin visible.
9. Task-keyed routing: `SmrRoutingTask` + AiTaskDefault (`harness-policy.service.ts:35-55`) — idiomatic place for a `'test'` tier.
10. Grounded-highlight pipeline (NLP entities → char offsets in note) and the SSE-over-Redis live transport — keep as-is under any live-agent redesign.

---

## 3. Open Decisions (OD-*) — REQUIRED before the affected lanes start

| ID | Decision | Options | Blocks |
|---|---|---|---|
| **OD-1** | R-C3 "no department/visit-type indicator": resolution-only (current state, done) or prompt-text-too? | (a) Accept current: fallback instruction is dept-agnostic in *selection*; the v1-parity body keeps its `{current_department}`/`{visit_type}` variables (checksum gate intact). (b) Strip indicators: fork a NEW dept-free pre-summary template (new id, new checksum entry or exclusion) so the v1-parity template survives; compat keeps v1 body, native/default uses the clean one. (c) Strip in the shared body and consciously break/re-baseline the TASK-634 fidelity gate | Lane D2 |
| **OD-2** | Should `DepartmentAgent` gain a **visit-type axis** (e.g. `newPatientTemplateId`/`revisitTemplateId` bindings or a per-visit-type agent row) so the agent tier stops collapsing new-referral vs follow-up? | (a) Yes — schema change + resolver update + migration of golden agents. (b) No — keep the invariant "dept×visit tenants must not use agents" and merely guard it (B-05 test only) | Lane C2, D1 |
| **OD-3** | Should the agent carry **LLM selection** (provider/model per agent), overriding tenant AiTaskDefault? | (a) No — agent = prompt+tools; LLM stays tenant-tier (matches R-C2's "default set by tenant admin"). (b) Yes, optional override with tenant default as fallback | Lane C2 |
| **OD-4** | Replace the pre-summary **tag convention** with a first-class pointer (settings descriptor or `Tenant`-level column)? The convention's weakness is already firing (B-01) | (a) Pointer via settings-registry descriptor (`prompts.preSummaryTemplateId`, db-config tier). (b) Keep convention + enforce single-candidate with tests/constraint | Lane A1 (fix shape) |
| **OD-5** | Live-agent tool-calling semantics: true model-initiated tool calls (requires SMR `tools` passthrough + loop) vs **agent-configured orchestration** (the agent's config declares which tools run — NER, vitals, future models — but the service orchestrates deterministically, as today)? | (a) Model-initiated (bigger: SMR contract change, latency risk in the live loop). (b) Config-driven orchestration now, tool-calling later (recommended for live-path latency: the ~5s flush budget tolerates 1 LLM call + 1 NLP call, not an open-ended tool loop) | Lane C1/C4 |
| **OD-6** | Design gate for UI work (rule 12): the test-bench UI changes (provider picker in test panel, golden-case picker, playground template picker) extend EXISTING approved surfaces — does the owner require new Figma frames, or accept as incremental changes to frames already shipped? | (a) Incremental, no new frames. (b) Frame updates + approval before B4 | Lane B4 |

### 3.1 Decisions recorded (owner, 2026-08-08) + best-practice refinements

**Chosen:** OD-1 **(b)** · OD-2 **(a)** · OD-3 **(b)** · OD-4 **(b)** · OD-5 **(b)** · OD-6 **(a)**.

The owner additionally confirmed the target use cases: compat pre-summary = ONE default fallback template (no department axis); compat summary = agent by dept×visit-type, single-shot, no agentic loop, no NER; native = SDK/API provide department + visit-type and the agentic loop/harness must pick the correct agent for **live-summarization, pre-summarization AND finalize** (pre-summary agent governance on native is a scope EXTENSION vs the original TASK-634 posture). The following refinements are binding on the lanes:

1. **RF-1 (amends D2 / OD-1b): the fork split is forced by the wire contract, not preference.** The compat mapper title-matches the five v1 section headings (`PRE_SUMMARY_DISPLAY_TITLES`, `summary-response.mapper.ts`), three of which contain "(Latest Dept Note)". Therefore compat MUST keep the v1-parity body (checksum gate intact); the dept-free fork is **native-only** and may rename its section headings freely (native does not use the compat mapper).
2. **RF-2 (amends A1 / OD-4b): tag-discriminated surfaces.** With two pre-summary templates per tenant possible, the single-candidate rule becomes per-surface: v1 row keeps tag `smr-v1` (already seeded), the fork carries a distinct tag (e.g. `dept-free`); `findTenantPreSummaryTemplateId` (and the native finder) filter by surface tag; seed tests enforce **exactly one candidate per (tenant, surface-tag)**. Without this the fork itself recreates B-01.
3. **RF-3 (amends D1/A6 / OD-2a): retire the zero-agent invariant instead of guarding it.** Seed ArcaAI `DepartmentAgent` rows with per-visit-type bindings pointing at the SAME 14 pinned templates as the legacy columns — behavior-identical by construction. A6's test morphs into: for all 7×2 cells, agent-tier resolution === legacy-column resolution (template id equality). Legacy `newPatientPromptId`/`revisitPromptId` columns demote to deprecated fallback (tier-1b retained, documented as legacy).
4. **RF-4 (amends C1/C2 / OD-2a+OD-3b): `DepartmentAgent` becomes a capability-keyed activation unit.** Optional bindings: `newPatientTemplateId`, `revisitTemplateId`, `preSummaryTemplateId`, `livePromptTemplateId` + `toolConfig`; per-task LLM override keyed `live` / `finalize` (NOT one global field — a low-latency live model must not silently drive finalize). Precedence per task: agent override (tenant-admin-owned) → tenant AiTaskDefault (`smr.live`/`smr.finalize`) → fail-closed. Capabilities are **per-path**: the compat path consults ONLY the summary bindings — `toolConfig`/live bindings never apply to compat.
5. **RF-5 (amends C1): the compat/native split falls out of existing call signatures — no new flag.** Compat pre-summary already calls `resolve({tenantId, promptType})` WITHOUT `departmentId` (`smr-compat-template.service.ts:67-72`), so the agent tier is naturally ineligible there; native passes `departmentId` → agent `preSummaryTemplateId` binding eligible, falling back tenant default → dept-free SYSTEM fork → 503.
6. **RF-6 (amends C1/C5): one agent identity per session, resolved once and frozen.** Resolve at recording start with the SDK-provided department; pin template version ids; stamp agent id + version through live flushes → `LIVE_SOAP_SNAPSHOT` metaData → finalize (`SummaryMeta` lineage). Mid-session approvals never mutate a running session; finalize and the harness draft path provably use the same agent via the shared resolver.

---

## 4. Implementation Plan

### 4.1 Lane map & dependency graph

```
Phase 0: OD-1..OD-6 resolved (owner) ──┐
                                       │
Phase 1 (parallel, no cross-deps):     │
  Lane A  Bug fixes (A1..A9)           │
  Lane B  Prompt Test Bench (B1..B6)   │  B4 gated on OD-6
                                       │
Phase 2:                               │
  Lane C  Live-Agent architecture      │  C1 (design) gated on OD-2/OD-3/OD-5
          C1 → C2 → {C3, C4} → C5      │
                                       │
Phase 3:                               │
  Lane D  Compat conformance closure   │  D1 on OD-2, D2 on OD-1; D3 free
```

Lanes A and B are fully parallelizable at task granularity. Lane C is sequential at the top (design first), then parallel. Lane D tasks are independent of each other.

### 4.2 Lane A — Defect fixes (Phase 1)

All tasks follow TDD (failing test first — see per-task test list) and the layer gates of `01-development-workflow.md`. Each task is self-contained for one agent.

| Task | Fixes | Instructions | Tests (write FIRST) | Tier | Effort |
|---|---|---|---|---|---|
| **A1** | B-01 (+OD-4 shape) | Per OD-4: (a) add `prompts.preSummaryTemplateId` settings descriptor (db-config tier, `editableBy` tenant) read first by `findTenantPreSummaryTemplateId`, convention as fallback; or (b) drop the `pre-summary` tag from `…026` in `07-prompt-template.ts:1461-1473` + seed assertion of single candidate per tenant. Either way: log-warn already exists; make multi-candidate a test failure in seeds | `prompt-resolution.service.test.ts`: Global-tenant pre-summary resolves `…040` (or pointer target); seed test: ≤1 convention-matching row per tenant | sonnet-5 | medium |
| **A2** | B-02 | In `SummaryService.generateSummary` (`summary.service.ts:374-395`) and `harness-internal.service.ts:586`/`loadLiveSoapSnapshot`, replace plain `findLatestPreSummary`/`findPreSummaries` reads with the decrypting accessor path (`ContextItemRepository.encryption.ts:36-82`), or add `findLatestPreSummaryDecrypted` to the repository extension (hand-written, OUTSIDE `generated/`, per rule 03). Do NOT touch the generated repository file's mapper guard | Repo test: encrypted fixture row → decrypted content returned; service test: `preSummaryText` populated when warm-start enabled | sonnet-5 | medium |
| **A3** | B-06 | Add optional `subType` filter to the pre-summary finder (hand-written extension); `SummaryService` passes `'LIVE_SOAP_SNAPSHOT'` when seeking the live note, keeps legacy behavior when seeking case-note pre-summaries | Repo test: newer case-note PRE_SUMMARY does not shadow the live snapshot | sonnet-5 | medium |
| **A4** | B-03 | Mirror compat's provider-failure fallback into `SummaryService.callSmrService`: on provider-side failure, `resolveSmrFallbackSelection(tenantId,'finalize')` → single retry with swapped selection; count in usage ledger under the actually-used provider | Service test: primary 502 → fallback invoked once with `smr.finalize.fallback` selection; no fallback configured → original error propagates | sonnet-5 | medium |
| **A5** | B-04 | Add fail-closed tenant assertion at every native `resolveSmrSelection()` call site (or centrally in `HarnessPolicyService.resolveScopedTenantId` when caller passed nothing AND CLS is empty → throw, never silently SYSTEM). Audit the 5 call sites listed in B-04 | Test: CLS empty + no explicit tenantId → throws (not SYSTEM default) | sonnet-5 | medium |
| **A6** | B-05 | Seed test asserting `DepartmentAgent` count for ArcaAI tenant === 0, with a comment linking F-01/OD-2; place next to `arcaai-clinical-templates-seed.test.ts` | The test IS the deliverable | haiku-4-5 | default |
| **A7** | B-08 | Rewrite the stale NOTE (`07b-arcaai-clinical-templates.ts:288-295`) to describe the shipped pre-summary chain (tenant tier → SYSTEM → 503). Prose-only change; keep byte-locked content files untouched | None (comment-only; fidelity suite must stay green) | haiku-4-5 | default |
| **A8** | B-09 | Either delete `ARCAAI_FALLBACK_TEMPLATE_IDS` (update `seed.test.ts:29`) or export the id from one shared module imported by both seed and `SYSTEM_DEFAULTS` (`prompt-resolution.service.ts:171`). Prefer share-if-cheap, delete otherwise — no new abstraction for one constant | Existing seed tests keep passing; if shared, a test that the two ids are identical | haiku-4-5 | default |
| **A9** | B-07, B-10 | (i) `useSMR.summarizeAsync`: mark `@deprecated` + throw a descriptive error (compat has no async route), or implement `summary/async` on the compat controller mirroring `summary/sync` + job polling — owner's call, default to deprecate. (ii) B-10: extract the `…040` body into a shared constant with the ArcaAI copy OR add it to the checksum fixture; verify cross-tenant reachability of `…040` from a non-Global tenant (write the failing test first to discover actual behavior) | SDK test for the deprecation path; fidelity fixture extended if dedup chosen | sonnet-5 | medium |

### 4.3 Lane B — Prompt Test Bench (Phase 1) — closes R-T1 + R-T2

Target: ONE coherent tenant-admin capability: pick a template (any category, any pinned version or draft) → pick example data (golden case OR pasted sample) → pick provider/model → run → see output + assembly introspection. Reuses seams §2.5.

| Task | Instructions | Tests (FIRST) | Tier | Effort |
|---|---|---|---|---|
| **B1** — provider/model on the test route | Add `provider?: string`, `model?: string`, `dryRun?: boolean`, `versionNumber?: number` to `TestPromptTemplateRequest` (class-validator + `@ApiPropertyOptional` on every field — global pipe forbids undeclared fields). Thread through `testPromptTemplate` → `callSmrGenerate`: caller-supplied pair forwarded untouched (mirror `applySmrModelSelection` semantics); absent → NEW `'test'` member in `SmrRoutingTask` (`harness-policy.service.ts:35`) + `smr.test` AiTaskDefault key + `models.smr.test` descriptor (follow `model-defaults.descriptors.ts:45-63` shape; tenant-editable; failMode closed) falling back to `smr.finalize` when unset. Validate the pair against ENABLED `AiModel` registry rows (same source as `GET /text/providers`) — reject unknown with 400 | Service tests: explicit pair forwarded verbatim; absent → `smr.test`→`smr.finalize` cascade; unknown provider → 400. Descriptor registered test | sonnet-5 | medium |
| **B2** — dry-run + version-addressable | `dryRun: true` (make it the UI default): skip the `lastTest*` persistence and the `_version` bump — route still requires If-Match for non-dry runs only (adjust guard accordingly: keep `@RequiresIfMatch` but bypass version write on dry-run; simplest compliant shape: dry-run ignores expectedVersion). `versionNumber` set → interpolate the immutable `PromptVersion.content` at that number instead of the mutable draft (fetch via existing version repo; 404 if missing). Note the `{{var}}` vs `{var}` trap: `interpolateTemplate` is `{{var}}`-only — when the template's declared variables match the 9 pre-summary names, ALSO run `substitutePreSummaryVariables` (shared module `pre-summary-variables.ts`) so single-brace bodies test correctly; do not leak literal braces | Tests: dry-run leaves `lastTest*`/`_version` untouched; versionNumber targets snapshot content; single-brace body interpolates via the shared substituter | sonnet-5 | medium |
| **B3** — predefined example data (golden cases) | Add `goldenCaseId?: string` to the DTO (mutually exclusive with `sampleInput`; 400 if both). Service loads the case via the eval/golden-set service WITH decryption (transcript as sample input), tenant-scoped 404-over-403 on cross-tenant ids. Do NOT persist the decrypted transcript anywhere; it exists only in the request lifetime | Tests: golden case feeds transcript into interpolation; cross-tenant caseId → 404; both-fields → 400 | sonnet-5 | medium |
| **B4** — UI (gated OD-6) | Extend `test-run-panel.tsx`: (1) provider/model `Select` pair fed by the existing providers hook (reuse `playground-llm/api` catalog wiring; default = tenant `smr.test`/effective default, labeled); (2) example-data source toggle: "Paste sample" (existing textarea) / "Golden case" (searchable select via golden-set list hooks); (3) dry-run switch, default ON; (4) version selector (Draft / v1..vN). Also: replace the playground's raw "Template ID" text field (`prompt-editor-card.tsx:249-257`) with a template picker (list endpoint exists in prompt-management). All shadcn primitives per rules 07/11; skeletons per rule 10; both themes; axe 0 violations | Vitest component tests colocated; axe scan; both themes verified | sonnet-5 | max |
| **B5** — E2E + cross-tenant | Playwright spec `apps/api/tests/e2e/`: tenant admin runs a dry-run test with explicit provider on a seeded template + golden case; asserts output shape, no `_version` drift, 404 on cross-tenant template AND cross-tenant golden case (extend the task-307 pattern) | The spec IS the deliverable | sonnet-5 | medium |
| **B6** — docs | Update this README §7 + `docs/traceability-matrix.md` row for the test capability | — | haiku-4-5 | default |

### 4.4 Lane C — Native Live-Agent architecture (Phase 2) — closes R-N1 + R-N2

The deep redesign. C1 produces the binding architecture; nothing else in Lane C starts before C1 is reviewed by the owner.

| Task | Instructions | Tier | Effort |
|---|---|---|---|
| **C1** — architecture design | Produce a design doc (append §C1 to this README) resolving: (1) the **LiveAgent binding** — recommended shape: extend `DepartmentAgent` (per OD-2/OD-3 outcomes) with `livePromptTemplateId?` (+ pinned version), `toolConfig` (JSON: which capabilities run in the live loop — NER on/off, vitals, future med-models — per OD-5 likely config-driven orchestration), optional LLM override per OD-3; alternatively a separate `LiveAgentProfile` model if DepartmentAgent semantics (approval gates, golden-set promotion) shouldn't govern live behavior. (2) **Resolution timing**: agent resolved ONCE at `LiveDocumentationService.start()` (consultation carries departmentId) and FROZEN for the session (mid-session template approval must not mutate a running session — snapshot semantics like the finalize path); stored on the in-memory `LiveSession` + Redis so crash-recovery re-resolves identically (pin the version id, not "latest"). (3) **Same-agent finalize**: thread the resolved agent id + version through the `LIVE_SOAP_SNAPSHOT` ContextItem `metaData` → `SummaryService.generateSummary` reads it and (a) records lineage in `SummaryMeta`, (b) prefers the SAME agent in resolution (making tier-1a deterministic wrt the live session even if defaults changed mid-visit), (c) always injects the live note as reviewed draft (warm-start becomes agent-lineage-gated rather than env-flag-gated — decide flag fate). (4) **Prompt governance**: live prompts become governed `PromptTemplate`s (`category: LIVE_SUMMARY` or tag), pinned-version served — the current hardcoded constants become the seeded SYSTEM default template (byte-identical, so behavior is unchanged until a tenant configures otherwise). (5) **Failure posture**: live loop must NEVER 503 a running consultation on resolution failure — fail-open to the SYSTEM live default (documented exception to failMode-closed, justified: patient-safety of the live view > selection strictness; finalize stays closed). (6) Latency budget analysis for OD-5. Deliverable includes the migration plan, rollout order, and the exact file/function touch list for C2-C5 | **fable-5** (or opus-5) | max |
| **C2** — schema + domain trio | Per C1: Prisma model change(s) under `packages/database/src/prisma/db_main/` (field template of rule 02; migration `task_635_*`); `pnpm gen:model`; **hand-author** entity/factory/mapper/repository deltas (NEVER `gen:mapper` — destructive; keep `FIELDS_NOT_WRITABLE=['version']`); barrels; `CoreDatabaseModule` registration; allow-lists (`TENANT_SCOPED_MODELS` etc.) if a new model; `ResourceType` parity in BOTH enums + `ADD VALUE` migration if sys-events emitted. Seed: SYSTEM live-default template with content == current hardcoded constants (checksummed), golden-agent live bindings | opus-4-8 | max |
| **C3** — LiveDocumentationService integration | Inject the resolver (via a narrow port — do NOT drag all of `PromptAssemblyService` into the live loop): at `start()`, resolve+freeze the live agent snapshot; `flush()` uses the governed system prompt (replacing `:69-72`/`:1668-1669` constants) and agent LLM selection (override → `smr.live` fallback per OD-3); tool execution driven by the agent's `toolConfig` (today's NER+vitals+grounding become the default config — behavior-identical when unconfigured); trajectory records carry the agent id. Preserve: delta/windowed modes, throttle, single-owner lock, grounding anti-laundering rule, SSE contract (additive-only DTO change: `agent: {id, name, versionId}` on `LiveSummaryEventDto.metadata`) | opus-4-8 | max |
| **C4** — tool layer | Per OD-5(b): a small `LiveToolRegistry` mapping tool keys → executors (`nlp.classify-tokens`, `vitals.extract`, future entries); agent `toolConfig` selects and parameterizes; executors keep current implementations. If OD-5(a) chosen instead: SMR `tools` passthrough contract + bounded tool-call loop in the flush (cap 1 round), with the latency analysis from C1 as gate | opus-4-8 | max |
| **C5** — finalize lineage | Implement C1's same-agent finalize: agent id/version in snapshot `metaData`; `SummaryService` prefers it, records `SummaryMeta` lineage; warm-start gating per C1 decision; fold in A2/A3 outcomes (decrypted, subType-filtered read). E2E: start→live flushes→stop→finalize uses the same agent id, evidence in SummaryMeta | opus-4-8 | max |
| **C6** — verification | Full-suite runs per layer gates; live e2e (recording start → SSE events with agent metadata → stop → finalize) against local stack; evidence pasted into §7 | sonnet-5 | medium |

### 4.5 Lane D — Compat conformance closure (Phase 3)

| Task | Depends | Instructions | Tier | Effort |
|---|---|---|---|---|
| **D1** — visit-type-safe agent tier | OD-2 | If OD-2(a): resolver reads the per-visit-type binding from the agent (fall back to its single template); migrate golden agents; delete the "must not use agents" invariant + A6 test morphs into "agent bindings respect visit type". If OD-2(b): document the invariant in rules + keep A6 as permanent guard; add a WARN log when tier-1a fires for a tenant that has visit-type columns populated (drift telemetry) | opus-4-8 | max |
| **D2** — pre-summary indicator | OD-1 | If OD-1(b): new dept-free pre-summary template (new id + seed + checksum handling), compat keeps v1 body for wire-parity clients, native/default switches; mapper section titles unchanged (title-match trap). If OD-1(a): no code change — record the accepted interpretation here and close R-C3 as conforming-by-interpretation | sonnet-5 | max |
| **D3** — conformance regression suite | — | Encode the §2.0 scorecard as executable checks where feasible: compat-has-no-live-route test; pre-summary-resolution-ignores-department test (exists in TASK-634 suites — verify + extend); tenant-LLM-honored tests for both surfaces (compat explicit-tenant + native post-A5 assertion) | sonnet-5 | medium |

### 4.6 Agent-team execution summary

| Wave | Tasks in parallel | Tiers |
|---|---|---|
| 0 | Owner resolves OD-1..OD-6 | human |
| 1 | A1–A9, B1–B3, B5 (B4 once OD-6 clears; B6 trails) | haiku-4-5 ×3 (A6,A7,A8,B6), sonnet-5 ×9 |
| 2 | C1 alone | fable-5/opus-5 ×1 |
| 3 | C2 → then C3 ∥ C4 → C5, C6 | opus-4-8 ×3, sonnet-5 ×1 |
| 4 | D1 ∥ D2 ∥ D3 | opus-4-8 ×1, sonnet-5 ×2 |

Coordination rules for the team: every task = failing test first; one task = one agent = one reviewable diff; no task touches the byte-locked 15 content constants except via the explicit checksum-handling steps (A9-ii, D2); Lane C tasks must not modify Lane A/B files without rebasing on their merged state; `pnpm verify` green per affected package before hand-back; violations in `packages/*` appear as warnings (only-warn) — treat as errors.

### 4.7 Out of scope (explicit)

- Admin UI for DepartmentAgent live bindings beyond what C2 seeds (future ticket, Figma-gated per rule 12).
- Eval-lane generation (making golden-set runs generate-then-judge) — noted as the natural follow-on to B3+C, not required by R-T1/R-T2.
- Any change to STT/transcription itself; the live transcript pipeline is untouched.
- TASK-634's remaining owner items (re-seed, live-pod verification) — tracked there.

---

## 5. Verification Criteria (Definition of Done, per lane)

- **Lane A**: all new tests red-then-green with output pasted; `pnpm --filter @arcaai/applications test`, `@arcaai/domains test`, `pnpm test:unit` green; fidelity suite untouched-and-green; no new lint findings.
- **Lane B**: unit + component + e2e green; axe 0 violations on changed screens, both themes; cross-tenant 404 posture proven in e2e; `smr.test` descriptor visible/editable on the tenant AI-configuration screen.
- **Lane C**: C1 design reviewed & approved by owner BEFORE C2; migration SQL reviewed; `gen:model`/`gen:entity`/`gen:factory` no-drift + coverage OK; behavior-identical default proven (seeded SYSTEM live template == old constants, byte compare test); live e2e evidence (SSE payloads showing agent metadata; SummaryMeta lineage row) pasted into §7; replay-/crash-recovery test for the frozen-agent snapshot.
- **Lane D**: conformance suite (D3) green; scorecard §2.0 re-run and updated in §7 with final verdicts.
- **Program**: `pnpm verify` green at each merge point; ticket README updated per phase; owner sign-off gates at Phase 0 (decisions), post-C1 (design), and closure.

---

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Live-loop latency regression from governed-prompt resolution | Resolve ONCE at `start()`, frozen snapshot; zero per-flush resolution I/O (C1 §2) |
| Checksum gate breakage by accidental edits to the 15 locked bodies | Coordination rule §4.6; only A9-ii/D2 may touch fixtures, with explicit re-baseline steps |
| `DepartmentAgent` semantic overload (approval/promotion gates now also govern live) | C1 explicitly weighs separate `LiveAgentProfile`; owner reviews before schema work |
| Warm-start enablement exposing B-02/B-06 in production before fixes | Lane A (A2/A3) lands in Wave 1, before any Lane C work turns lineage on |
| Test-bench provider selection abused to probe disabled providers | B1 validates against ENABLED `AiModel` registry rows; 400 otherwise |
| CLS-assertion (A5) breaking a legitimate SYSTEM-context worker path | A5 audits all 5 call sites first; any true SYSTEM-context caller passes an explicit tenant id instead of relying on fallback |

---

## 7. Implementation Summary

### Wave 1 — COMPLETE (2026-08-08): Lanes A + B, 7 parallel agents, all green

**Status**: Lane A (A1–A9) and Lane B (B1–B5) implemented and verified; B6 (docs) = this section. Nothing committed — working tree only, per owner's commit discipline.

| Task | Outcome | Evidence |
|---|---|---|
| A1 (B-01) | `pre-summary` tag removed from Global stub `…026`; new per-tenant uniqueness test (`seed/__tests__/pre-summary-candidate-uniqueness.test.ts`) proven RED (2 candidates) → GREEN | db suite 36 files / 976 tests green |
| B-10 partial | `…040` body extracted to byte-identical `SYSTEM_PRE_SUMMARY_DEFAULT_CONTENT` (sha256-verified refactor) + new checksum test (`system-pre-summary-default-checksum.test.ts`) | RED shown w/ wrong pin, GREEN w/ real hash |
| A1/Task-3 discovery | **New defect B-12 registered** (§2.4): tier-2 pre-summary fallback `…040` is unreachable cross-tenant (`PromptTemplate` tenant-scoped, not in `SYSTEM_SHARED_READ_MODELS`) — latent; fix folded toward Lane C2 | evidence chain in B-12 row |
| A2 (B-02) | `findLatestPreSummaryWithDecryptedContent(consultationId, secrets, {subType?})` added to `ContextItemRepository.encryption.ts`; both consumers switched (`summary.service.ts` warm-start read, `harness-internal.service.ts` `loadLiveSoapSnapshot`). Note: a generic decrypt-on-read wrapper (TASK-369 `phi-read-decrypt.ts`) already mitigated the literal defect when Vault mode is wired — the explicit accessor removes the dependency on ambient global state | 16/16 repo + 4/4 service + 2/2 harness tests, RED→GREEN each |
| A3 (B-06) | subType filter on the new accessor; `SummaryService.resolveWarmStartPreSummaryText()` prefers `LIVE_SOAP_SNAPSHOT`, legacy any-subtype fallback preserved | included above |
| A4 (B-03) | Native finalize now retries ONCE via `resolveSmrFallbackSelection(tenantId,'finalize')` on provider-side failure (connect-vs-response distinction mirrors compat); original error surfaces when unconfigured/fallback-fails | 6/6 tests RED→GREEN |
| A5 (B-04) | All 5 call sites pass explicit typed tenantIds (`callSmrService(tenantId: string)` on processors; `BadRequestException` pre-try/catch in services). Audit: none is a legit SYSTEM-context path; bug was structural (ambient CLS re-derivation), now closed by construction | 4/4 tests RED→GREEN |
| A6 | Interim guard `arcaai-zero-department-agents.test.ts` (RF-3 placeholder until C2) | db suite green |
| A7 | Stale NOTE rewritten to the shipped TASK-634 chain | comment-only, fidelity suite green |
| A8 | Dead `ARCAAI_FALLBACK_TEMPLATE_IDS` deleted; `seed.test.ts` adjusted; all 9 stale comment refs swept in consolidation (04-department.ts ×7, 07b ×1, prompt-resolution ×1) | grep clean |
| A9 (B-07) | `useSMR.summarizeAsync` deprecated: `@deprecated` JSDoc, throws descriptive error + `onError('ASYNC_SUMMARIZATION_ERROR')` before any fetch; signature preserved; zero real in-repo callers confirmed | vox: 252 files / 4107 tests, lint 0 errors, typecheck clean |
| B1 | `'test'` added to `SmrRoutingTask` + `smr.test` AiTaskDefault key + `models.smr.test` descriptor (tenant-writable, fail-closed); precedence caller-pair-verbatim (validated vs ENABLED `AiModel` rows, unknown → 400) → `smr.test` → `smr.finalize` | 312/312 scoped applications tests |
| B2 | `dryRun` (no `lastTest*` write, no `_version` bump; route keeps `@RequiresIfMatch`), `versionNumber` targets immutable `PromptVersion` (404 missing); `{{var}}`+`{var}` brace-trap handled via shared `substitutePreSummaryVariables` | included above |
| B3 | `goldenCaseId` (XOR `sampleInput` → 400; cross-tenant → 404; decrypted transcript never persisted/logged) via `GoldenCaseRepository` + `decryptFieldsFromEntity` | included above |
| B4 (UI) | Test panel: provider/model selects (shared `useTextProviders` hook in `src/shared/catalog/`), sample⇄golden-case XOR toggle (set→case combobox), dry-run switch default ON, version selector (Draft + every version via existing `:id/versions` route). Playground: raw Template-ID input → searchable server-side combobox w/ graceful fallback+toast | admin-console: lint 0 warnings, typecheck clean, 163 files / 1265 tests, `next build` all 68 routes, axe 0 violations |
| B5 (e2e) | `apps/api/tests/e2e/task-635-prompt-test-bench.spec.ts` — 11 scenarios (dry-run OCC-neutrality, version-bump proof, known/unknown pair, XOR 400, golden-case 404, 428, versionNumber 404/hit, cross-tenant 404 per task-307 pattern); SMR-dependent asserts gated. **NOT yet executed** — API was down; run: `pnpm test:up:api` then `pnpm test:e2e --grep task-635`. Golden-case happy path not e2e-able until a `GoldenCase` is seeded | tsc/eslint clean; every status assert traced to its code path |

**Consolidation verification (after all agents merged in the live tree)**: `pnpm --filter @arcaai/database test` → 36/976 green · `pnpm --filter @arcaai/applications build` clean · `pnpm --filter @arcaai/domains build` clean.

**Known pre-existing issues surfaced (NOT this ticket's regressions, confirmed independently by two agents via pristine-vs-fixed failure-list diffs):**
1. `.env.test` sets `SECRETS_PROVIDER=vault` while many applications-package test fixtures construct services with `secretsService: undefined`, tripping the TASK-369 fail-closed PHI guard → ~384 pre-existing failures unless `SECRETS_PROVIDER=env` is forced. Blocks a clean top-level `pnpm --filter @arcaai/applications test` today; needs its own fix (fixture or env), out of scope here.
2. 2 pre-existing live-Postgres integration failures in `@arcaai/domains` (unrelated).

**Owner tail for Wave 1**: run the B5 e2e against a live stack; decide B-12 fold-in (recommended: Lane C2); optionally seed a demo `GoldenCase` so the golden-case happy path is e2e-able; consider echoing the actually-used provider/model in the test response DTO (one-line enrichment; UI display point already identified).

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-07 | Ticket created. Full three-track review completed (flow conformance, seed audit, test-capability survey); findings F-01..F-07, defects B-01..B-11, decisions OD-1..OD-6, and the four-lane parallel implementation plan documented. Status: Pending (awaiting Phase-0 owner decisions). |
| 2026-08-08 | Phase 0 closed: owner selected OD-1(b), OD-2(a), OD-3(b), OD-4(b), OD-5(b), OD-6(a) and confirmed the compat/native use cases (native pre-summary agent governance = scope extension). Refinements RF-1..RF-6 recorded in §3.1, binding on lanes A1, A6, C1, C2, C5, D1, D2. Wave 1 (Lanes A + B) clear to dispatch. |
| 2026-08-08 | **Wave 1 COMPLETE** — 7 parallel agents (A1+B-10, A2–A5, A6–A8, A9, B1–B3, B4, B5) all delivered with RED→GREEN evidence; consolidation pass done (comment sweep, cross-agent seam verified, db 976 tests + both package builds green). New defect **B-12** discovered and registered (tier-2 pre-summary fallback unreachable cross-tenant). §7 carries the full evidence table + owner tail. Status → In Progress. Next: Wave 2 (C1 architecture design, fable-tier). |
