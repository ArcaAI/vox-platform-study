# TASK-533 — Agentic-Loop Completion: Defect Closure, Live Control Plane, Learning Loop & Enablement

- **Status**: Pending
- **Type**: feature / bugfix (Phase 6 of the agentic platform program)
- **Program**: [2026-07-20 program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) §Phase 6 · [2026-07-20 findings review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) §3-E1, §7 GAP-A1…A9, D-22…D-28
- **Suggested number**: TASK-533 per the program plan's allocation (TASK-523…534); confirm at open time per the CLAUDE.md ticket workflow.
- **Size**: L · **Lanes**: E (harness/smr/stt-v2 Python) + B (applications/api TS) + C (admin-console)
- **Siblings** (cross-referenced, never edited by this ticket): [TASK-524](../TASK-524-Config-Plane-Core/README.md) · [TASK-525](../TASK-525-Service-Config-Adoption/README.md) · [TASK-526](../TASK-526-BYO-Cloud-Credentials/README.md) · [TASK-528](../TASK-528-Model-Discovery-Hub/README.md) · [TASK-529](../TASK-529-Model-Lifecycle-Retention/README.md) · [TASK-531](../TASK-531-Pipeline-Template-Governance/README.md) · [TASK-534](../TASK-534-E2E-Validation/README.md)

### Sub-scope dependency table

| Sub-scope | Contents | Start condition |
|---|---|---|
| **533-A** | Loop defect closure: D-22 (TranscriptSegment starvation), D-23 (warm-start dead knob), D-24 (MCP productionization), D-25 (finalize JSON-repair parity), D-26 (`smr.live` activation), D-27 (OTel dead flag), D-28 (claim-check prod guard) | **Independent** — may start alongside Phase 0 (after the owner commits the current tree, OD-7) |
| **533-B** | Live control plane + learning loop: `agentic.context.*` live lane + windowed transcript, token/$ budget (GAP-A4), evidence links to clinician (GAP-A2), gate-edit mining (GAP-A1) | **After TASK-524** lands the settings write-lane + effective-facade override lane (AD-1) |
| **533-C** | Enablement & eval hardening: eval-CI hard-fail flip (GAP-A6), golden-set SME kickoff, per-tier flag-enablement matrix | **Owner/hardware-gated** — anytime after 533-A; each flip individually gated |

---

## 1. Requirement Analysis

The 2026-07-20 review verified the harness agentic loop core as SOTA-shaped and wired (critique-fed regen ON, prefix-cache-stable prompts, optimistic delivery + retraction, HITL gate + edit-rerun caps, claim-check, trajectory metrics — findings §3-E1). What remains is **completion**, in three strata:

1. **Wrongly-wired defects (533-A)** — features that exist but do not function in production: the evidence-grounding pillar receives no segment data (D-22); a console toggle that changes nothing (D-23); MCP that cannot be enabled or authenticated (D-24); the higher-stakes finalize path more brittle than the live path (D-25); two-tier model routing built but inert (D-26); a dead observability flag (D-27); a documented-unsafe prod default with no guard (D-28).
2. **Control-plane-dependent features (533-B)** — the `agentic.context.*` knobs a global admin sees in the catalog must actually govern runtime (today: env-or-hardcoded, D-19/GAP-C7); per-run token/$ budgets must be enforced (usage is already captured per LLM call); the click-to-source evidence UI stranded in deprecated `ui-playground` must reach the production console; and the clinician approve-vs-edit signal — fully captured in WORM audit + edit-burden telemetry — must feed a learning loop (regression corpus + few-shot exemplars, explicitly NOT fine-tuning).
3. **Enablement (533-C)** — flipping the dormant accuracy flags per the 2026-07-18 review §7 hardware tiers, each with a measurement gate, and hardening the eval CI gate from diagnostic to blocking once its owner-side prerequisites (SME golden set, CI-reachable judge) exist.

Classification: `bugfix` for 533-A items D-22…D-28; `feature` for 533-B; `infrastructure`/owner-process for 533-C.

## 2. Current State Evaluation

All file:line references verified on the 2026-07-20 working tree (`fix/2605-review` + uncommitted wave). Items marked **[verified this ticket]** were re-checked during ticket authoring; the rest carry over from the program review's completed verification passes.

### 2.1 D-22 — TranscriptSegment pipeline starved (CONFIRMED, with precision corrections)

- Model fields: `idx`, `t0Ms`, `t1Ms`, `speaker`, `charStart`, `charEnd`; compound unique `(contextItemId, idx)`; **no consultationId column** — segments hang off `ContextItem`.
- **The TS ingest layer is correct.** The ONLY writer is `SttInternalService.persistTranscriptSegments` (`packages/applications/src/services/stt/internal/sttInternal.service.ts:75-106`), called on BOTH paths — batch `createTranscript` (:155) and streaming `createStreamingTranscript` (:220). The break is strictly UPSTREAM in the stt-v2 producers:
  - **Streaming sends no segments at all**: `apps/stt-v2/src/stt_v2/streaming/session_manager.py:2542-2548, 2725-2731` build the gateway payload without segments; the gateway client `apps/stt-v2/src/stt_v2/core/api_client/gateway.py:293-305` has no segments key.
  - **Batch sends the wrong shape**: `apps/stt-v2/src/stt_v2/transcription/dto.py:256-267` emits `metadata.segments` in snake_case / seconds / no-text form (`start_time`/`end_time`/`speaker_id`), which `computeSegmentOffsets` (`packages/applications/src/services/consultation/lib/transcript-segments.ts:73-97`) silently coerces to all-null except `idx`.
- Harness consumers are wired and waiting: `workflows.py:660,892` → assemble → `loadSegmentCitations` (`packages/applications/src/services/consultation/harness-internal.service.ts:358,990-997`); DTO `HarnessSegmentCitationRef {id,idx,speaker?,t0Ms?,t1Ms?}` (`packages/applications/src/services/consultation/harness/dto/harness-internal.dto.ts:164-170`).
- **Existing tests MASK the defect** by hand-feeding ideal camelCase shapes (`sttInternal.service.test.ts:357-447`); no Python test asserts the producer↔consumer contract. The TDD plan (§5) therefore mandates a cross-boundary contract test with a fixture derived from `TranscriptionResult.to_dict()` truth.

### 2.2 D-23 — `warmStartEnabled` dead knob shadowing a real switch (CONFIRMED, sharpened)

- `HarnessPolicy.warmStartEnabled` (`packages/database/src/prisma/db_main/harness.prisma:347`) is fully WRITE-plumbed: DTO `update-harness-policy.request.ts:136-139`, response `:101`, GLOBAL_ADMIN-gated (`harness-policy.service.ts:110`), parsed on the Python side (`apps/harness/src/harness/temporal/models.py:281,341`) — but **never read in `workflows.py`/`activities.py`**.
- The real switch is env `HARNESS_WARM_START_ENABLED`, read at `packages/applications/src/services/consultation/harness-internal.service.ts:139-142` (consumed :316, :428 via `loadLiveSoapSnapshot` :897) and `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts:192` (**cached at :195** — construction-time; the STAGE 1 SCRATCHPAD → STAGE 2 FINAL refinement block is :261-274).
- Fix shape: thread the effective policy value into those two TS services (env demoted to fallback); the :195 cache must become per-resolution (policy can change without redeploy).

### 2.3 D-24 — MCP unusable end-to-end (CONFIRMED, worse than "DTO missing")

- `mcpToolsEnabled` (`harness.prisma:357`) is absent from the update DTO AND from `HarnessPolicyKnobs` / `GLOBAL_ADMIN_ONLY_POLICY_KEYS` / `entityToKnobs` (`harness-policy.service.ts:74-144`; `mergeKnobs` iterates `KNOB_KEYS` :116, so the field **cannot be patched at all**) AND `getEffectivePolicy` never serializes `mcpToolsEnabled`/`mcpServers` into the `fetch_policy` response — Python `models.py:348-351` parses them but always receives None/[], so `workflows.py:417` is always False and `:418` `mcp_servers` always [].
- `_resolve_mcp_token` (`apps/harness/src/harness/temporal/activities.py:426-439`) is a hardcoded `return None`. Harness has **no Vault client** (hvac appears only in comments) — authenticated MCP servers can never be called.
- Design (frozen in §3.1): a gateway-resolved token via a new X-Service-Token internal route, NOT a harness-side Vault client. Flag stays default-OFF.

### 2.4 D-25 — Finalize path lacks the live path's JSON-repair fallback **[verified this ticket]**

- The shared helper `generateJsonWithRepair` lives at `packages/applications/src/services/consultation/shared/bounded-json-repair.ts` (single bounded corrective retry, `CORRECTIVE_RETRY_INSTRUCTION` mirrored byte-for-byte from the seeded template; tolerant parser always the final fallback).
- Wired into the live path: `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts:27` (import) and `:680` (the `generateJsonWithRepair` call in the flush, with `shouldRepair: structured && looksLikeJsonObject`).
- **Absent from the finalize path**: `packages/applications/src/services/consultation/summary/summary.service.ts` — imports at :1-45 contain zero repair references (re-verified by grep across the file); the durable end-of-visit summary has no corrective retry. (The harness's own generate loop is separately protected by the `schema_validity` sensor + REGEN — fine; this defect is the non-harness summary path.)

### 2.5 D-26 — `smr.live` routing key inert **[verified this ticket]**

- `resolveSmrSelection(tenantId?, task: SmrRoutingTask = 'finalize')` (`packages/applications/src/services/harness-policy/harness-policy.service.ts:325`) implements the two-tier routing correctly (AiTaskDefault `SMR_TASK_KEY[task]` first, legacy HarnessPolicy cascade fallback).
- **Every production caller uses the default `'finalize'`** — no call site anywhere passes `'live'`: `dna-writing-style.processor.ts:330`, `pre-summary.processor.ts:228`, `summary.processor.ts:269`, `comprehensive-summary.processor.ts:329`, `chain-summary.service.ts:541`, `summary.service.ts:913`, `prompt-management.service.ts:968`, `smr-proxy.controller.ts:175` (via `applySmrModelSelection` :161-175, the playground/SDK omitted-model path) and `:944` (providers default marking).
- The live-tier call site is `live-documentation.service.ts:1332` — `callSmr` (:1319) resolves `resolveSmrSelection(tenantId)` with **no task argument**, so the live flush loads the finalize-tier model. The fix is one argument at :1332 (`, 'live'`); all finalize-path callers are already correct.

### 2.6 D-27 — OTel dead flag **[verified this ticket]**

- `otel_enabled: bool = False` plus 6 companion fields (`otel_exporter_endpoint`, `otel_service_name`, `otel_service_namespace`, `otel_deployment_environment`, `otel_insecure`, `otel_logs_enabled`) at `apps/harness/src/harness/core/config.py:396-402`.
- `otel_enabled` has **zero consumers** in `apps/harness/src/` (grep: only the definition). `core/logging.py:18-34` (`_add_otel_context`) does ambient span-id stamping that only activates if some other code configures a TracerProvider — nothing does. No exporter/provider exists anywhere in the service.
- Options sized in §3.5; recommendation: **delete the flag block now** (S), keep `_add_otel_context` (harmless, future-proof), file OTel as future enablement.

### 2.7 D-28 — Claim-check prod default unsafe, no deploy guard **[verified this ticket]**

- `apps/harness/src/harness/core/config.py` (`HARNESS_CLAIM_CHECK_` settings, ~:185-205): `enabled: bool = True`, `store: str = "memory"`, `min_bytes: int = 65_536`. The class docstring itself states: "a MULTI-worker deploy MUST set `store=s3` … because a cross-worker activity retry against the in-memory fake fails LOUD (`ClaimCheckNotFound`)". Documented-unsafe, unguarded.
- **No harness manifest exists in `deployment/k3s/base/`** (directory listing verified: api/guardrail/nlp/smr/stt-v2/tts-v2/… but no harness.yaml — consistent with rule 09 "Harness + Temporal are not yet in the k3s base"). The guard must therefore be **boot-time in the service** (config validator + worker startup), plus a documented env line for whatever manifest eventually lands.

### 2.8 533-B surfaces **[verified this ticket]**

- **`agentic.context.*` env fallback**: `live-documentation.service.ts:287-320` — constructor-time reads `configService.get('LIVE_DOC_SEGMENT_THRESHOLD'|'LIVE_DOC_DEBOUNCE_MS'|'AGENTIC_CONTEXT_LIVE_DELTA_MAX_CHARS'|'AGENTIC_CONTEXT_CLAIM_CHECK_MIN_BYTES'|'AGENTIC_CONTEXT_TRANSCRIPT_MODE'|'AGENTIC_CONTEXT_TOKEN_BUDGET_PER_RUN') ?? AGENTIC_CONTEXT_DEFAULTS[…]` — env-or-hardcoded, never a DB read. Descriptors: `packages/applications/src/services/settings-registry/descriptors/agentic-context.descriptors.ts` — `'transcript.mode': 'whole'` ("windowed lands in a later phase", :14,:32-33,:61-64) and `'tokenBudget.perRun': 0` ("0 = unbounded, enforced once tokenizers land", :34-35,:66-69).
- **Console tab is read-only by design**: `apps/admin-console/src/features/agentic-policy/components/agentic-context-tab.tsx` — self-documented "Read-only inventory of the `agentic.*` settings registry … METADATA only — never a value"; renders a catalog table via `useSettingsCatalog(true)`, zero mutations/inputs.
- **Token accounting substrate exists**: AD-1 `GenerationStats` ride on LLM_CALL trajectory steps — `packages/applications/src/services/agent-trajectory/dto/create-agent-trajectory-step.input.ts:32` ("AD-1 GenerationStats on LLM_CALL steps; null otherwise"); server-side rollup `aggregateGenerationStats` (`agent-trajectory.service.ts:214-221`, filters `stepType: AgentStepType.LLM_CALL`) feeds `GET admin/agent-trajectory/metrics/generation` (`dto/generation-metrics.response.ts`). Per-run accumulation and budget enforcement do not exist.
- **Click-to-source reference UI found** (GAP-A2): `apps/ui-playground/src/features/clinical-workspace/components/review/` — `review-screen.tsx` (consumes `data.citationsMap.claims`, builds `buildTranscriptHighlights(transcript.text, spans)`), plus `transcript-pane.tsx`, `claim-line.tsx`, `claim-status-badge.tsx`, `confidence-indicator.tsx`, `needs-attention-list.tsx`. This is the port source. Target console feature folder to be confirmed at implementation (no production consultation-review screen exists yet in `apps/admin-console` — **unverified**, confirm during Phase-3 planning of this ticket).
- **Gate-edit mining source data** (GAP-A1): gate decisions live in the WORM `HarnessAuditEvent` (`harness.prisma:213`; event type `GATE_DECISION` :22; `gateDecision String?` :259; hash-chained, UPDATE/DELETE revoked, Phase-3D ciphertext columns); approved-vs-delivered content versions are `RAW_SUMMARY`/`MODIFIED_SUMMARY` (`enums.prisma:228-229`) with diffs computed by `diffContent` (`summary.service.ts:460` edit delta, `:622` sign delta; util `summary/content-diff.util.ts`); derived edit-burden telemetry (Levenshtein/deferral/time-to-sign) at `packages/applications/src/services/harness-observability/edit-burden.ts`, surfaced via `GET admin/harness/edit-burden` (`apps/api/src/modules/harness-admin/harness-admin.controller.ts:304-315`). The signal is fully captured and consumed by nothing downstream.

### 2.9 533-C surfaces **[verified this ticket]**

- **Eval CI gate**: `.gitlab/ci/test.yml` — `harness-eval-gate:` at :502, `allow_failure: true` at :506; the comment block (:496-501) states it becomes hard-blocking "once the clinician golden-set program delivers a real clinician-rated golden set AND a CI-reachable judge backend". Script runs real PDSQI-9/faithfulness/ICC (`harness.eval.ci` on `curated_v1.json`) + promptfoo output-contract gate.
- **Golden-set spec**: `apps/harness/src/harness/eval/golden/clinical_v1_spec.md` — clinical-content owner "_unassigned — requires a clinical SME lead (see §11)_" (:6); Phase-0 exit gate **N ≥ 132** cases (:70, derivation :82-99); integrity boundary explicit (no real cases shipped).
- **Enablement matrix source**: [2026-07-18 gap review](../SOTA-Track/2026-07-18-external-sota-report-gap-review.md) — dormant default-OFF flags enumerated (:75: groundedness gate, atomic-fact, warm-start + NER priors, optimistic delivery, retrieval, claim-check S3, Sortformer, Parakeet), per-tier enablement with a measurement gate per flip recommended against the §7 hardware tiers (workstation tier referenced at :107).

## 3. Architecture, Patterns & Best Practices

### 3.1 MCP token gateway-resolution (D-24) — frozen design

Harness gets **no Vault client**. Token resolution follows the platform's existing internal-route pattern:

- NEW route `GET /api/v1/internal/harness/mcp-token?authRef=<ref>` on `apps/api/src/modules/consultation/harness-internal.controller.ts` under the existing `HarnessServiceTokenGuard` (X-Service-Token), backed by `SecretsService.getSecret` (`packages/applications/src/services/baseServices/_meta/secrets/SecretsService.ts:51-99`), which is already DI'd into `harness-internal.service.ts` (:121). `authRef` is validated against the registered `McpServer.authRef` values (no arbitrary secret-path reads).
- Harness client `apps/harness/src/harness/services/api_client.py` (internal prefix `/internal/harness`, :254) gains `resolve_mcp_token(auth_ref)`. `_resolve_mcp_token` (`activities.py:426-439`) calls it **inside the activity that performs the MCP call**; the token is used and discarded — **never persisted in workflow state, activity inputs, or heartbeats** (Temporal history is durable; a token in an input is a token on disk).
- Policy plumbing: `mcpToolsEnabled` joins `HarnessPolicyKnobs`/`KNOB_KEYS`/`entityToKnobs` AND `GLOBAL_ADMIN_ONLY_POLICY_KEYS` (MCP is global-admin governance); `getEffectivePolicy` serializes `mcpToolsEnabled` + `mcpServers` into the `fetch_policy` response so `workflows.py:417-418` finally receive real values. Console: field in `apps/admin-console/src/features/agentic-policy/components/agentic-knobs.ts` + form. Flag default-OFF, allowlist + PHI-egress guard asserted by tests. This supersedes the prior AD-5 "Vault seam stub" posture (see §8).

### 3.2 Token-budget accounting placement (GAP-A4)

- **Accumulate in the TS trajectory spine** — the data already lands there (`GenerationStats` on every LLM_CALL step). Add a per-run rollup (sum of prompt/completion tokens keyed by `runId`) computed at step-append time in `agent-trajectory.service.ts` (cheap incremental counter; no schema change required if kept in the run row's metadata, else one additive column).
- **Enforce at the activity boundary, replay-safely**: the harness workflow learns budget state from **additive fields on existing activity results** (`assemble`/`generate` responses gain optional `budget: {usedTokens, perRunBudget, exceeded}`). Optional-with-default fields on activity results are command-neutral: old histories simply lack them. On `exceeded`, the workflow stops the regen loop gracefully (no further generate commands are *scheduled* — a data-dependent branch, no `workflow.patched` needed because behavior only changes when the new field is present) and annotates the gate payload ("budget-stopped") so the clinician sees why. `0 = unbounded` preserved.
- Live-doc path enforces TS-side directly (session accumulator in the existing Redis stats snapshot).
- **$-cost**: price table as data in `AiModel.metaData` (e.g. `pricing: {inputPer1k, outputPer1k, currency}` — no migration); `aggregateGenerationStats` multiplies at rollup time; surfaced on the AI-Ops Metrics screen. No PHI in any of this (stats-first precedent).

### 3.3 Windowed-transcript strategy (`transcript.mode='windowed'`)

- Windowing happens **in TS prompt assembly** (live-doc + harness assemble service), never in workflow code — zero replay surface. Prompt shape: `[static system] + [carry-forward summary of pre-window transcript] + [recent window verbatim] + [note-so-far] + [delta instruction]` — the carry-forward summary is refreshed only when the window slides past a threshold, so the prefix stays cache-stable between flushes (preserving the Phase-4D discipline).
- **Equivalence invariant**: when the transcript fits inside the window, `windowed` mode produces byte-identical prompts to `whole` mode (tested — §5). The flip is measurement-gated (edit-burden + groundedness unchanged-or-better on the eval set before default change); `whole` remains the default.

### 3.4 Gate-edit mining privacy design (GAP-A1)

- **Sources (read-only)**: `HarnessAuditEvent` GATE_DECISION rows (WORM — never touched), `RAW_SUMMARY`/`MODIFIED_SUMMARY` versions + `diffContent` deltas, edit-burden telemetry (§2.8).
- **Storage decision — new table over claim-check refs**: a NEW tenant-scoped, append-only `GateEditExemplar` table (house field template; department, visit-type, diff stats, PHI-**redacted** before/after snippets, quality signal approved-clean vs heavily-edited). Rationale: exemplars must be queryable by department for retrieval (claim-check blobs are opaque); redaction-at-write keeps PHI out of the mining store entirely (ops-table PHI posture); the WORM source remains the audit truth.
- **Population**: async job (BullMQ, sys-event-driven off gate-decision events), never inline in the sign path. Redaction reuses the existing PHI machinery (`encryptPhiFields`/guardrail redaction contract) — redaction failures drop the candidate, fail-closed.
- **Consumption**: (a) append-only **eval regression-corpus export**, released only through golden-set-program review (SME gate — candidates are proposals, not corpus rows); (b) **per-department few-shot exemplar retrieval** in `prompt-assembly.service.ts` — top-K by recency/quality, tenant+department-scoped, injected as a versioned few-shot block inside the stable prefix region (exemplar-set version changes are infrequent → prefix cache preserved). Explicitly NOT fine-tuning.

### 3.5 D-27 decision framing

- **Delete (recommended, S ≈ ½d)**: remove `config.py:396-402`; keep `_add_otel_context` (inert, future-proof). Rationale: no collector in any deployment artifact, Prometheus metrics + the trajectory spine + Grafana already cover the observability need; a half-implemented TracerProvider is Karpathy-anti-pattern speculative code.
- **Implement-minimal (M ≈ 2d)**: TracerProvider + OTLP exporter in `lifespan` behind the flag, spans on activity boundaries; adds `opentelemetry-sdk`/`-exporter-otlp` deps (`uv lock`), hermetic tests with provider stubbed, compose collector optional. Choose in-ticket with the owner; the plan default is delete.

### 3.6 Replay-safety playbook (binding for every 533 change)

The workflow file already carries **8 `workflow.patched` eras** (findings §3-E1). This ticket adds **zero** new eras by design: D-23/D-25/D-26 are TS-only; D-24 changes activity *internals* + policy payload fields (additive, `models.py` parsers already tolerate absence); token budget uses additive optional activity-result fields (§3.2); windowing is TS-side (§3.3); D-28 is config/boot. Rule: any change that would alter the command sequence is out of scope for this ticket and must be re-planned with `workflow.patched` + a captured replay fixture. Gate: `test_replay_compat` fixtures stay green in every 533 MR (`pnpm py:harness:test`). Harness CI stays hermetic (stubbed gateway/LLM, in-memory Qdrant, no live Temporal/DB/Redis).

## 4. Implementation Plan

Ordered within each sub-scope; layer order database → domains → applications → api → python → console where applicable.

### 4.1 Sub-scope 533-A (independent)

| # | Item | Files | Kind |
|---|---|---|---|
| A1 | **D-22 producer fix** — streaming: attach segment array (consumer shape `{idx,t0Ms,t1Ms,speaker,text}`) to the gateway payload; batch: emit the same shape (normalize snake_case/seconds at the producer); TS: `computeSegmentOffsets` accepts + normalizes both shapes, logs loudly (never silently nulls) on an unusable shape | `apps/stt-v2/src/stt_v2/streaming/session_manager.py` (:2542-2548, :2725-2731) · `apps/stt-v2/src/stt_v2/core/api_client/gateway.py` (:293-305) · `apps/stt-v2/src/stt_v2/transcription/dto.py` (:256-267) · `packages/applications/src/services/consultation/lib/transcript-segments.ts` (:73-97) | UPDATE |
| A2 | **D-22 contract lock** — Python truth-fixture + TS contract test (§5.1) | `apps/stt-v2/tests/unit/test_transcript_segment_contract.py` · `tests/contracts/stt-transcript-segments/` (fixture + `*.contract.test.ts`) | NEW |
| A3 | **D-23** — effective `warmStartEnabled` threaded into the two TS consumers; env `HARNESS_WARM_START_ENABLED` demoted to fallback; drop the construction-time cache at `prompt-assembly.service.ts:195` in favor of per-resolution reads | `packages/applications/src/services/consultation/harness-internal.service.ts` (:139-142,:316,:428,:897) · `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts` (:192,:195,:261-274) | UPDATE |
| A4 | **D-24** — DTO + knobs + global-only key + effective-policy serialization; gateway mcp-token route; harness client + `_resolve_mcp_token`; console form field | `packages/applications/src/services/harness-policy/dto/update-harness-policy.request.ts` · `harness-policy.service.ts` (:74-144, effective serialization) · `apps/api/src/modules/consultation/harness-internal.controller.ts` (route) · `harness-internal.service.ts` (token lookup via `SecretsService`) · `apps/harness/src/harness/services/api_client.py` (:254) · `apps/harness/src/harness/temporal/activities.py` (:426-439) · `apps/admin-console/src/features/agentic-policy/components/agentic-knobs.ts` + form component | UPDATE |
| A5 | **D-25** — mirror `generateJsonWithRepair` into the finalize summary call (same one-corrective-retry contract as live-doc :680) | `packages/applications/src/services/consultation/summary/summary.service.ts` | UPDATE |
| A6 | **D-26** — `resolveSmrSelection(tenantId, 'live')` at the live flush call site; before/after live-tier latency measurement note in this README | `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts:1332` | UPDATE |
| A7 | **D-27** — delete `otel_*` config block (or implement-minimal per in-ticket decision, §3.5) | `apps/harness/src/harness/core/config.py:396-402` (+ `.env.example` mention if any exists) | UPDATE |
| A8 | **D-28** — pydantic validator + worker-boot check: `store="memory"` + production/multi-worker indicators → hard error (warning in dev); env line documented for the future k3s manifest + runbook note | `apps/harness/src/harness/core/config.py` (~:185-205) · `apps/harness/src/harness/temporal/worker.py` · docs/runbook touchpoint | UPDATE |

### 4.2 Sub-scope 533-B (after TASK-524)

| # | Item | Files | Kind |
|---|---|---|---|
| B1 | **`agentic.context.*` live lane** — live-doc reads effective values via TASK-524's facade (refresh-aware, not constructor-frozen); descriptors' "later phase"/"lands later" comments updated | `live-documentation.service.ts` (:287-320) · `settings-registry/descriptors/agentic-context.descriptors.ts` (comments) | UPDATE |
| B2 | **Console Agentic Context tab → read-write** (global-admin, OCC via the TASK-524 write route) | `apps/admin-console/src/features/agentic-policy/components/agentic-context-tab.tsx` + feature api hooks | UPDATE |
| B3 | **Windowed transcript** — §3.3 strategy in live-doc (+ harness assemble if shared), equivalence-tested, measurement-gated default-off | `live-documentation.service.ts` prompt build · possibly `prompt-assembly.service.ts` | UPDATE |
| B4 | **Token/$ budget** — per-run accumulation + additive activity-result budget fields + graceful stop + gate annotation (§3.2); price table consumption in the rollup; AI-Ops Metrics $ column | `agent-trajectory/agent-trajectory.service.ts` · `harness-internal.service.ts` (assemble/generate responses) · `apps/harness/src/harness/temporal/workflows.py` (data-dependent stop — no new commands) + `models.py` · `agent-trajectory/dto/generation-metrics.response.ts` · AI-Ops Metrics screen files | UPDATE |
| B5 | **Evidence links** — port `ui-playground` review components (§2.8) into the console consuming `citationsMap.segmentId`; depends on A1/A2 (D-22 fixed) | NEW console feature folder (target to confirm); source: `apps/ui-playground/src/features/clinical-workspace/components/review/*` (read-only reference — deprecated app untouched) | NEW |
| B6 | **Gate-edit mining** — §3.4: `GateEditExemplar` table (migration `task_533_gate_edit_exemplar`) + hand-authored domain trio + mining job + redaction + corpus-export endpoint + exemplar retrieval in prompt assembly | NEW prisma model (in `harness.prisma`) · NEW `packages/domains` trio · NEW `packages/applications/src/services/gate-edit-mining/` · UPDATE `prompt-assembly.service.ts` · NEW export route on `harness-admin.controller.ts` | NEW+UPDATE |

### 4.3 Sub-scope 533-C (owner/hardware-gated)

| # | Item | Files | Gate |
|---|---|---|---|
| C1 | Eval-CI hard-fail flip: `allow_failure: true` → removed at `.gitlab/ci/test.yml:506` | `.gitlab/ci/test.yml` | Judge backend CI-reachable AND golden set ≥ owner-approved threshold |
| C2 | Golden-set SME kickoff — owner action (assign the clinical SME lead named "unassigned" at `clinical_v1_spec.md:6`); engineering side: liaison only | none (process) | Owner assignment |
| C3 | Enablement matrix — per 2026-07-18 §7 tiers, flip each dormant flag (`retrieval`, `atomic_fact`, `optimistic_delivery`, `ner_priors`, groundedness gates, claim-check→S3, Sortformer, Parakeet) via HarnessPolicy/settings; one flip = one measurement gate = one evidence entry in this README | per-flag (policy/settings values, not code) | Per-flip measurement gate (§6) |

### 4.4 Ownership manifest & sequencing (file overlaps with sibling tickets)

| Shared surface | Also touched by | Sequencing rule |
|---|---|---|
| `harness-policy.service.ts` | TASK-532 (AD-7 adds E3 locks to `GLOBAL_ADMIN_ONLY_POLICY_KEYS`) | **533-A A4 lands before 532** (both edit the key list/knobs); coordinate via lane B lead |
| `apps/admin-console/src/features/agentic-policy/**` | TASK-532 (M-02 makes `/agentic-policy` the single editor) | 533-A A4 + 533-B B2 land before 532's screen consolidation, or rebase onto it — decide at 532 open |
| `apps/stt-v2/**` (lane D) | TASK-523 (0.4 `preprocessing.py`), TASK-525 (config paths), TASK-527 (loaders) | Disjoint files, same lane — A1/A2 sequenced by the lane-D lead; no shared file |
| `settings-registry/**` | TASK-524 (owns the write-lane + facade) | 533-B **consumes only**; the sole 533 edit is descriptor comments (B1) — after 524 merges |
| `.gitlab/ci/test.yml` | TASK-534 (P7 evidence run) | C1 is a one-line flip; land after 534's suite is green |
| `.env.example` | TASK-523 (D-15 hygiene, lane F) | Any 533 line (A7/A8) lands after 523 |
| `apps/ui-playground/**` | nobody (deprecated) | Read-only port source — 533 never edits it |

**Comment deltas (DoD-binding)**: `agentic-context.descriptors.ts` "later phase"/"enforced once tokenizers land" notes (B1/B4 make them true — rewrite); `agentic-context-tab.tsx` "read-only inventory" docblock (B2); `bounded-json-repair.ts` header "both the live-doc flush and the durable summary path can drive it" (A5 makes the second half true — note it); `activities.py:426-439` "Vault seam stub" docstring (A4); claim-check config docstring gains the guard note (A8); `models.py` mcp fields "always None today" style comments if present (A4).

**Out of scope**: golden-set case authoring (owner/SME); GPU staging + weight mirroring (ops); the TASK-524 write-lane itself; TASK-532's screen consolidation; any `workflow.patched` era (none needed — §3.6); fine-tuning of any kind.

## 5. TDD Plan (RED first — paste failing output before implementing)

### 5.1 533-A

| Test (exact path) | Asserts | Closes |
|---|---|---|
| `apps/stt-v2/tests/unit/test_transcript_segment_contract.py` | The producer payload derived from `TranscriptionResult.to_dict()` matches the checked-in consumer-shape fixture (`{idx,t0Ms,t1Ms,speaker,text}`, ms ints); regenerates/compares the fixture so drift fails the Python side | D-22 |
| `tests/contracts/stt-transcript-segments/stt-transcript-segments.contract.test.ts` | `computeSegmentOffsets` + `persistTranscriptSegments` fed the SAME fixture produce non-null `t0Ms/t1Ms/speaker/charStart/charEnd` rows (the cross-boundary lock the current hand-fed tests at `sttInternal.service.test.ts:357-447` lack) | D-22 |
| `apps/stt-v2/tests/unit/streaming/test_session_manager_segments.py` (path per stt-v2 top-level convention) | Streaming finalize payload carries the segments array on both emit sites | D-22 |
| `packages/applications/src/services/consultation/prompt/__tests__/prompt-assembly.service.test.ts` (extend) | Precedence: policy `warmStartEnabled=false` + env `HARNESS_WARM_START_ENABLED=true` → warm-start OFF (and the inverse); no construction-time staleness after a policy change | D-23 |
| `packages/applications/src/services/harness-policy/__tests__/harness-policy.service.test.ts` (extend) | `mcpToolsEnabled` DTO round-trip (patch → knobs → response); tenant PATCH carrying it → 403 (global-only); `getEffectivePolicy` serializes `mcpToolsEnabled` + `mcpServers` | D-24 |
| `apps/harness/src/harness/tests/test_mcp_token_resolver.py` | `_resolve_mcp_token` returns the gateway-served secret (api_client stubbed); token absent from workflow-visible state; unknown `authRef` → None + logged | D-24 |
| api controller test for `GET internal/harness/mcp-token` | Service-token required; `authRef` allowlisted against registered `McpServer` rows; secret value never logged | D-24 |
| `packages/applications/src/services/consultation/summary/__tests__/summary.service.test.ts` (extend) | Malformed-JSON first response + structured request → exactly one corrective retry → repaired parse (mirror of the live-doc contract) | D-25 |
| `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.service.test.ts` (extend) | The flush resolves `resolveSmrSelection(tenantId, 'live')` (spy asserts the task arg) | D-26 |
| `apps/harness/src/harness/tests/test_claim_check_guard.py` | `store="memory"` + production indicator → startup error; dev → warning only | D-28 |
| Replay gate (existing) | `test_replay_compat` — all 8 era fixtures green, unchanged | §3.6 |

### 5.2 533-B

| Test | Asserts |
|---|---|
| live-doc settings test (extend live-doc suite) | `agentic.context.*` change through the TASK-524 lane → next flush uses the new value, no redeploy; env now loses to DB |
| windowed equivalence test (live-doc suite) | Transcript shorter than the window → `windowed` prompt byte-identical to `whole` |
| `agent-trajectory` accumulation test | LLM_CALL steps accumulate per-run tokens; rollup exposes them; $-cost = tokens × `AiModel.metaData.pricing` |
| `apps/harness/src/harness/tests/test_token_budget.py` (hermetic) | Budget exceeded via additive result field → regen loop stops gracefully, gate annotated "budget-stopped"; `perRun=0` → unbounded (old behavior byte-for-byte) |
| exemplar retrieval test (`gate-edit-mining` suite) | Retrieval is tenant+department-scoped (cross-tenant fixture → empty, 404-over-403 on admin routes); redaction failure → candidate dropped |
| console tests | Agentic-context tab write path (OCC 428/412), axe 0 violations, both themes, skeleton/empty/error states (rules 10/11) — same for the evidence-link view |

### 5.3 Gates

Per touched lane: `pnpm --filter @arcaai/applications build test` · `pnpm build:api` + `pnpm test:unit` · `pnpm py:stt-v2:test|lint|typecheck` · `pnpm py:harness:test|lint|typecheck` · `pnpm --filter @arcaai/admin-console build lint test` · migration SQL reviewed (B6) · e2e specs authored here, executed in TASK-534.

## 6. Acceptance & DoD

- [ ] All §5 RED runs pasted, then GREEN; all lane gates green with output pasted.
- [ ] **D-22 proof**: a streamed consultation fixture yields non-empty `segment_citations` at both generate sites (`workflows.py:660,892`) — asserted by the contract chain, demonstrated once against local live infra (evidence pasted).
- [ ] **D-23/D-24/D-26 proof**: console toggle flips observable behavior without redeploy; `smr.live` AiTaskDefault row demonstrably routes the live flush.
- [ ] Replay fixtures unchanged and green; zero new `workflow.patched` eras.
- [ ] No PHI in trajectory rollups, budget metrics, or the mining store (redaction test + review); no token/secret in any response body, log line, or workflow history.
- [ ] Comment-delta ledger (§4.4) executed; sibling READMEs referenced, not edited.
- [ ] **533-C per-flip measurement gates**: each flag flip records — before/after on the harness eval set (PDSQI/faithfulness where applicable), edit-burden trend, latency budget for the affected path, and rollback-by-flag confirmation — as an evidence row in §9 before the next flip. C1 flips only with a green `harness-eval-gate` run on a real judge backend attached as evidence.
- [ ] This README's Implementation Summary + Change History updated; status → Review.

## 7. Risks & Rollback

| Risk | Mitigation / rollback |
|---|---|
| D-22 shape change breaks other `metadata.segments` consumers | Producer adds the consumer-shape array additively; `computeSegmentOffsets` keeps accepting the legacy shape (normalization, not replacement). Rollback: revert producer commits — TS side is tolerant of absence (today's behavior) |
| D-23 flips warm-start ON for tenants whose policy row defaults true | Effective default reproduces today's env-driven behavior byte-for-byte (program risk rule); deviation would be its own decision row |
| MCP token leakage | Token only inside activity locals; tests assert absence from history/logs; route allowlists `authRef`; flag default-OFF |
| Budget stop truncates a clinically-needed regen | Graceful stop still delivers the best draft + gate annotation (clinician sees why); `perRun=0` remains the shipped default |
| Windowed mode degrades notes | Default stays `whole`; flip is measurement-gated; equivalence test bounds the short-transcript case |
| Mining store accumulates PHI via redaction misses | Fail-closed drop on redaction failure; append-only table is deletable wholesale (no WORM constraint on the derived store); SME review gates corpus export |
| Eval-CI hard-fail blocks unrelated MRs after C1 | Flip is one line; revert restores `allow_failure: true` instantly |
| Sibling-ticket file collisions (§4.4) | Sequencing rules enforced by lane leads; barrels append-only one line per ticket |

## 8. References

- [2026-07-20 findings review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) — §3-E1 (loop verdict + D-22…D-28 table), §7 GAP-A1…A9, §4 defect register.
- [2026-07-20 program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) — Phase 6 definition, §2 delivery discipline, §3 AD-1 (settings write-lane this ticket's 533-B consumes), OD-7 (commit checkpoint precondition).
- [2026-07-18 external SOTA gap review](../SOTA-Track/2026-07-18-external-sota-report-gap-review.md) — §7 hardware tiers + the dormant-flag inventory (:75) driving 533-C.
- Prior MCP posture: `git show HEAD:docs/implementation/TASK-508-Agentic-SOTA-Program/README.md` — AD-5 shipped the MCP registry flag-OFF with `_resolve_mcp_token` as a deliberate Vault seam stub; §3.1 here supersedes it with gateway-resolved tokens (no harness Vault client).
- Sibling tickets: TASK-524/525/526/528/529/531/534 READMEs (header links).
- Golden-set spec: `apps/harness/src/harness/eval/golden/clinical_v1_spec.md` (N ≥ 132, SME owner unassigned).

## 9. Implementation Summary

_Pending_

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket README authored from the 2026-07-20 program review (Phase 6): pre-verified D-22/D-23/D-24 evidence integrated; D-25/D-26/D-27/D-28, 533-B surfaces (agentic-context env fallback, read-only console tab, trajectory GenerationStats, ui-playground click-to-source components, gate-decision/RAW-MODIFIED/edit-burden sources) and 533-C surfaces (eval-gate `allow_failure` :506, golden-set owner unassigned) independently re-verified with file:line. Frozen designs: gateway MCP token resolution, trajectory-spine budget accounting, TS-side windowing, redact-at-write mining store, zero-new-patch-era replay posture. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
