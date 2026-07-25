# TASK-533 — Agentic-Loop Completion: Defect Closure, Live Control Plane, Learning Loop & Enablement

- **Status**: Review — **533-A COMPLETE** (§9.1/§9.3) · **533-B COMPLETE** (B1–B6, §9.4) · 533-C owner/hardware-gated (C1/C2/C3 remain owner actions)
- **Type**: feature / bugfix (Phase 6 of the agentic platform program)
- **Program**: [2026-07-20 program plan](../SOTA-Track/2026-07-20-agentic-platform-program-plan.md) §Phase 6 · [2026-07-20 findings review](../SOTA-Track/2026-07-20-agentic-platform-review-findings.md) §3-E1, §7 GAP-A1…A9, D-22…D-28
- **Suggested number**: TASK-533 per the program plan's allocation (TASK-523…534); confirm at open time per the CLAUDE.md ticket workflow.
- **Size**: L · **Lanes**: E (harness/smr/stt Python) + B (applications/api TS) + C (admin-console)
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
- **The TS ingest layer is correct.** The ONLY writer is `SttInternalService.persistTranscriptSegments` (`packages/applications/src/services/stt/internal/sttInternal.service.ts:75-106`), called on BOTH paths — batch `createTranscript` (:155) and streaming `createStreamingTranscript` (:220). The break is strictly UPSTREAM in the stt producers:
  - **Streaming sends no segments at all**: `apps/stt/src/stt/streaming/session_manager.py:2542-2548, 2725-2731` build the gateway payload without segments; the gateway client `apps/stt/src/stt/core/api_client/gateway.py:293-305` has no segments key.
  - **Batch sends the wrong shape**: `apps/stt/src/stt/transcription/dto.py:256-267` emits `metadata.segments` in snake_case / seconds / no-text form (`start_time`/`end_time`/`speaker_id`), which `computeSegmentOffsets` (`packages/applications/src/services/consultation/lib/transcript-segments.ts:73-97`) silently coerces to all-null except `idx`.
- Harness consumers are wired and waiting: `workflows.py:660,892` → assemble → `loadSegmentCitations` (`packages/applications/src/services/consultation/harness/harness-internal.service.ts:358,990-997`); DTO `HarnessSegmentCitationRef {id,idx,speaker?,t0Ms?,t1Ms?}` (`packages/applications/src/services/consultation/harness/dto/harness-internal.dto.ts:164-170`).
- **Existing tests MASK the defect** by hand-feeding ideal camelCase shapes (`sttInternal.service.test.ts:357-447`); no Python test asserts the producer↔consumer contract. The TDD plan (§5) therefore mandates a cross-boundary contract test with a fixture derived from `TranscriptionResult.to_dict()` truth.

### 2.2 D-23 — `warmStartEnabled` dead knob shadowing a real switch (CONFIRMED, sharpened)

- `HarnessPolicy.warmStartEnabled` (`packages/database/src/prisma/db_main/harness.prisma:347`) is fully WRITE-plumbed: DTO `update-harness-policy.request.ts:136-139`, response `:101`, GLOBAL_ADMIN-gated (`harness-policy.service.ts:110`), parsed on the Python side (`apps/harness/src/harness/temporal/models.py:281,341`) — but **never read in `workflows.py`/`activities.py`**.
- The real switch is env `HARNESS_WARM_START_ENABLED`, read at `packages/applications/src/services/consultation/harness/harness-internal.service.ts:139-142` (consumed :316, :428 via `loadLiveSoapSnapshot` :897) and `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts:192` (**cached at :195** — construction-time; the STAGE 1 SCRATCHPAD → STAGE 2 FINAL refinement block is :261-274).
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
- **No harness manifest exists in `deployment/k3s/base/`** (directory listing verified: api/guardrail/nlp/smr/stt/tts/… but no harness.yaml — consistent with rule 09 "Harness + Temporal are not yet in the k3s base"). The guard must therefore be **boot-time in the service** (config validator + worker startup), plus a documented env line for whatever manifest eventually lands.

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

The workflow file already carries **8 `workflow.patched` eras** (findings §3-E1; count accurate as of this ticket — TASK-551 later added `task-551-redaction` + `task-551-redaction-audit`, making it **10**; see TASK-553 review). This ticket adds **zero** new eras by design: D-23/D-25/D-26 are TS-only; D-24 changes activity *internals* + policy payload fields (additive, `models.py` parsers already tolerate absence); token budget uses additive optional activity-result fields (§3.2); windowing is TS-side (§3.3); D-28 is config/boot. Rule: any change that would alter the command sequence is out of scope for this ticket and must be re-planned with `workflow.patched` + a captured replay fixture. Gate: `test_replay_compat` fixtures stay green in every 533 MR (`pnpm py:harness:test`). Harness CI stays hermetic (stubbed gateway/LLM, in-memory Qdrant, no live Temporal/DB/Redis).

## 4. Implementation Plan

Ordered within each sub-scope; layer order database → domains → applications → api → python → console where applicable.

### 4.1 Sub-scope 533-A (independent)

| # | Item | Files | Kind |
|---|---|---|---|
| A1 | **D-22 producer fix** — streaming: attach segment array (consumer shape `{idx,t0Ms,t1Ms,speaker,text}`) to the gateway payload; batch: emit the same shape (normalize snake_case/seconds at the producer); TS: `computeSegmentOffsets` accepts + normalizes both shapes, logs loudly (never silently nulls) on an unusable shape | `apps/stt/src/stt/streaming/session_manager.py` (:2542-2548, :2725-2731) · `apps/stt/src/stt/core/api_client/gateway.py` (:293-305) · `apps/stt/src/stt/transcription/dto.py` (:256-267) · `packages/applications/src/services/consultation/lib/transcript-segments.ts` (:73-97) | UPDATE |
| A2 | **D-22 contract lock** — Python truth-fixture + TS contract test (§5.1) | `apps/stt/tests/unit/test_transcript_segment_contract.py` · `tests/contracts/stt-transcript-segments/` (fixture + `*.contract.test.ts`) | NEW |
| A3 | **D-23** — effective `warmStartEnabled` threaded into the two TS consumers; env `HARNESS_WARM_START_ENABLED` demoted to fallback; drop the construction-time cache at `prompt-assembly.service.ts:195` in favor of per-resolution reads | `packages/applications/src/services/consultation/harness/harness-internal.service.ts` (:139-142,:316,:428,:897) · `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts` (:192,:195,:261-274) | UPDATE |
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
| `apps/stt/**` (lane D) | TASK-523 (0.4 `preprocessing.py`), TASK-525 (config paths), TASK-527 (loaders) | Disjoint files, same lane — A1/A2 sequenced by the lane-D lead; no shared file |
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
| `apps/stt/tests/unit/test_transcript_segment_contract.py` | The producer payload derived from `TranscriptionResult.to_dict()` matches the checked-in consumer-shape fixture (`{idx,t0Ms,t1Ms,speaker,text}`, ms ints); regenerates/compares the fixture so drift fails the Python side | D-22 |
| `tests/contracts/stt-transcript-segments/stt-transcript-segments.contract.test.ts` | `computeSegmentOffsets` + `persistTranscriptSegments` fed the SAME fixture produce non-null `t0Ms/t1Ms/speaker/charStart/charEnd` rows (the cross-boundary lock the current hand-fed tests at `sttInternal.service.test.ts:357-447` lack) | D-22 |
| `apps/stt/tests/unit/streaming/test_session_manager_segments.py` (path per stt top-level convention) | Streaming finalize payload carries the segments array on both emit sites | D-22 |
| `packages/applications/src/services/consultation/prompt/__tests__/prompt-assembly.service.test.ts` (extend) | Precedence: policy `warmStartEnabled=false` + env `HARNESS_WARM_START_ENABLED=true` → warm-start OFF (and the inverse); no construction-time staleness after a policy change | D-23 |
| `packages/applications/src/services/harness-policy/__tests__/harness-policy.service.test.ts` (extend) | `mcpToolsEnabled` DTO round-trip (patch → knobs → response); tenant PATCH carrying it → 403 (global-only); `getEffectivePolicy` serializes `mcpToolsEnabled` + `mcpServers` | D-24 |
| `apps/harness/src/harness/tests/unit/temporal/test_mcp_token_resolver.py` | `_resolve_mcp_token` returns the gateway-served secret (api_client stubbed); token absent from workflow-visible state; unknown `authRef` → None + logged | D-24 |
| api controller test for `GET internal/harness/mcp-token` | Service-token required; `authRef` allowlisted against registered `McpServer` rows; secret value never logged | D-24 |
| `packages/applications/src/services/consultation/summary/__tests__/summary.service.test.ts` (extend) | Malformed-JSON first response + structured request → exactly one corrective retry → repaired parse (mirror of the live-doc contract) | D-25 |
| `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.service.test.ts` (extend) | The flush resolves `resolveSmrSelection(tenantId, 'live')` (spy asserts the task arg) | D-26 |
| `apps/harness/src/harness/tests/unit/test_claim_check_guard.py` | `store="memory"` + production indicator → startup error; dev → warning only | D-28 |
| Replay gate (existing) | `test_replay_compat` — all 8 era fixtures green, unchanged | §3.6 |

### 5.2 533-B

| Test | Asserts |
|---|---|
| live-doc settings test (extend live-doc suite) | `agentic.context.*` change through the TASK-524 lane → next flush uses the new value, no redeploy; env now loses to DB |
| windowed equivalence test (live-doc suite) | Transcript shorter than the window → `windowed` prompt byte-identical to `whole` |
| `agent-trajectory` accumulation test | LLM_CALL steps accumulate per-run tokens; rollup exposes them; $-cost = tokens × `AiModel.metaData.pricing` |
| `apps/harness/src/harness/tests/unit/temporal/test_token_budget.py` (hermetic) | Budget exceeded via additive result field → regen loop stops gracefully, gate annotated "budget-stopped"; `perRun=0` → unbounded (old behavior byte-for-byte) |
| exemplar retrieval test (`gate-edit-mining` suite) | Retrieval is tenant+department-scoped (cross-tenant fixture → empty, 404-over-403 on admin routes); redaction failure → candidate dropped |
| console tests | Agentic-context tab write path (OCC 428/412), axe 0 violations, both themes, skeleton/empty/error states (rules 10/11) — same for the evidence-link view |

### 5.3 Gates

Per touched lane: `pnpm --filter @arcaai/applications build test` · `pnpm build:api` + `pnpm test:unit` · `pnpm py:stt:test|lint|typecheck` · `pnpm py:harness:test|lint|typecheck` · `pnpm --filter @arcaai/admin-console build lint test` · migration SQL reviewed (B6) · e2e specs authored here, executed in TASK-534.

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

### 9.1 Sub-scope 533-A — COMPLETE (D-22 … D-28)

All eight items implemented TDD (RED evidence captured per item, §9.3). Zero new
`workflow.patched` eras; `test_replay_compat` green throughout.

| Item | Outcome | Key files |
|---|---|---|
| **A1/A2 · D-22** | **Closed both producer paths.** Streaming gained `StreamSession.build_transcript_segments()` — consumer-shaped `{idx,t0Ms,t1Ms,speaker,text,charStart,charEnd}` built from the SAME filter/strip/join rule as `build_transcript_text()`, so offsets are exact by construction (invariant `text[charStart:charEnd] == text` asserted). Attached at BOTH emit sites plus the outbox payload + re-drive (a queued transcript would otherwise land segment-less). Batch gained `TranscriptionResult.build_transcript_segments()`, joining `sentence_timestamps` (text+timing) to the VAD segments' diarization by **maximum temporal overlap**, sent on the TYPED `segments` field rather than smuggled through untyped `metadata`. Consumer `computeSegmentOffsets` now **normalizes** the legacy snake_case/seconds shape instead of nulling it, and reports genuinely-unusable segments through a new `onUnusable` callback that `persistTranscriptSegments` logs loudly. | `stt/streaming/session.py`, `session_manager.py`, `core/api_client/gateway.py`, `transcription/dto.py`, `workers/transcribe_file.py`, `consultation/lib/transcript-segments.ts`, `stt/internal/sttInternal.service.ts` |
| **A3 · D-23** | **Policy is now the authority.** Both consumers cached the env var at CONSTRUCTION; both now resolve `HarnessPolicy.warmStartEnabled` per call via `getEffectivePolicy`, with env demoted to the null-fallback (so an untouched deployment behaves byte-for-byte as before). `HarnessInternalService` threads its `tenantId` into `assemble()` so both gates agree. `HarnessPolicyServiceModule` added to `HarnessInternalServiceModule` (the only one of the four providing modules that lacked it). | `prompt/prompt-assembly.service.ts`, `harness/harness-internal.service.ts`, `harness-internal.service.module.ts` |
| **A4 · D-24** | **All three breaks closed.** (1) `mcpToolsEnabled` added to `HarnessPolicyKnobs`, `entityToKnobs` (the actual leak — `KNOB_KEYS` already carried it at runtime via `HARNESS_POLICY_DEFAULTS`), both DTOs, and `GLOBAL_ADMIN_ONLY_POLICY_KEYS`. (2) `getEffectivePolicy` overlays `mcpServers` from the SYSTEM-shared `McpServer` registry through the existing `McpServerDtoMapper`, which already emitted the exact camelCase shape `McpServerConfig.from_api` parses; degrades to `[]` on registry failure. (3) `_resolve_mcp_token` is now async and calls the NEW gateway route `GET /internal/harness/mcp-token` — **no harness Vault client**, per §3.1. `authRef` is allowlisted against registered ENABLED rows, so it is not an arbitrary secret-path read. Console knob added. Flag stays default-OFF. | `harness-policy.service.ts` + both DTOs, `harness/harness-internal.service.ts`, `api/.../harness-internal.controller.ts`, `harness/services/api_client.py`, `harness/temporal/activities.py`, `agentic-knobs.ts`, `agentic-policy/api/types.ts` |
| **A5 · D-25** | **Worse than the README recorded, and fixed accordingly.** The finalize path did not merely lack the repair retry — it never parsed JSON *at all*, so a malformed structured response was persisted VERBATIM as the clinical note the clinician signs. `callSmrService` now drives `generateJsonWithRepair` with a generic strict parse; storage semantics are byte-identical in every case except the malformed-JSON one. Cost fields (`inputTokens`/`outputTokens`/`processingTimeMs`) are summed across the ≤2 calls. New shared `parsesAsJsonObject` + `unfence` helper. | `summary/summary.service.ts`, `shared/bounded-json-repair.ts` |
| **A6 · D-26** | One argument at the live-flush call site. Note the existing test at `live-documentation.service.test.ts:550` **pinned the defect** (`toHaveBeenCalledWith(TENANT)`) and was corrected as the RED step. | `live-documentation/live-documentation.service.ts:1332` |
| **A7 · D-27** | **Deleted** (owner-approved; §9.2 DR-1). The 7 `otel_*` fields were not merely unread — they were **unreachable**: they required `HARNESS_OTEL_*` env vars, and the repo only ever defined bare `OTEL_*` (for stt/smr). Per Completion Doctrine rule 1 the 5 never-imported OTel packages were dropped from `apps/harness/pyproject.toml` (keeping `opentelemetry-api`, which the inert `_add_otel_context` needs) and `uv lock` re-run — delta confined to the harness block, other services unaffected. | `harness/core/config.py`, `harness/pyproject.toml`, `uv.lock` |
| **A8 · D-28** | **Guard added; defaults unchanged.** The harness had **no production indicator at all** — `debug` could not be inverted, since its `False` default cannot distinguish a deploy from unconfigured local dev. Added explicit `HARNESS_ENVIRONMENT` (default `development`) + a `@model_validator(mode="after")` on `Settings` (the file's first) that hard-errors on `production|prod|staging` + offload enabled + `store=memory`, plus an independent fail-fast check in `temporal/worker.py` before the Temporal connect, which warns in dev (where a second worker silently breaks cross-worker retries). Pre-existing `test_claim_check_config.py:40` (asserting the `memory` default) stays green — this is a guard, not a default change. | `harness/core/config.py`, `harness/temporal/worker.py`, `.env.example`, `apps/harness/.env.example`, `turbo.json` |

### 9.2 Decision rows (deviations from §4 — recorded per §2.5 plan-conformance)

| # | Decision |
|---|---|
| **DR-1** | **D-27 = delete** (§3.5 offered delete vs implement-minimal, "choose in-ticket with the owner"). Owner approved delete. Evidence hardening the choice beyond §2.6: the fields were unreachable by any env var in the repo, and 5 of the 6 installed OTel packages were never imported. Scope extended to those dependencies per Completion Doctrine rule 1. |
| **DR-2** | **D-25's fix is larger than §4.1 A5 describes.** A5 said "mirror `generateJsonWithRepair`"; the finalize path had no JSON parse at all, so a strict parse + tolerant fallback had to be introduced alongside the retry. Shared helper `parsesAsJsonObject` added rather than duplicating a parse in the service. |
| **DR-3** | **D-22 `charStart`/`charEnd` are producer-computed on the streaming path only.** §4.1 A1 specified shape `{idx,t0Ms,t1Ms,speaker,text}`; streaming additionally emits exact char offsets because that method owns the join rule, which removes ambiguity when an utterance repeats verbatim. Batch deliberately omits them (the ASR engine assembles that text, so guessing risks misattribution) and relies on the consumer's designed text-search path. |
| **DR-4** | **D-24 policy plumbing needed `McpServerRepository` in two services, not one.** §4.1 A4 listed only the policy service; `resolveMcpToken` needs the same registry as its authRef allowlist, so `HarnessInternalService` takes it too. Both resolve from the already-imported `CoreDatabaseModule` — no module change required. |
| **DR-5** | **Python test path deviation.** §5.1 named `test_mcp_token_resolver.py` directly under `apps/harness/src/harness/tests/`; placed at `tests/unit/temporal/test_mcp_token_resolver.py` to match the existing layout (all temporal-activity tests live there). |
| **DR-6** | **`_resolve_mcp_token` became async**, which broke 7 pre-existing tests in `test_mcp_tool_activity.py` that monkeypatched it with a sync lambda. Those stubs were updated to awaitables — orphans created by this change, per the surgical-change rule. |

### 9.3 Gate evidence (all captured on the working tree)

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/applications build` | ✅ clean `tsc` |
| `pnpm --filter @arcaai/applications test` | ✅ **6611 passed**, 4 skipped (324 files) — up from 6575 pre-ticket |
| `pnpm build:api` | ✅ 8/8 tasks successful |
| `npx vitest run tests/contracts/` | ✅ **71 passed** (5 files, incl. the new `stt-transcript-segments` lock) |
| harness `pytest src/harness/tests/` | ✅ **935 passed** (incl. `test_replay_compat` — all era fixtures green) |
| stt `pytest tests/unit` | ✅ **2455 passed**, 1 skipped (pyannote absent) |
| `pnpm py:harness:typecheck` (mypy) | ✅ no issues in 91 source files |
| harness / stt `ruff check` | ✅ All checks passed (both) |
| `pnpm --filter @arcaai/admin-console test` | ✅ **1081 passed** (140 files) |
| `pnpm --filter @arcaai/admin-console build lint` | ✅ build OK; eslint `--max-warnings 0` clean |
| `pnpm turbo lint` (applications, api) | ✅ api 0 errors; applications **156 warnings = the pre-existing baseline**. TASK-533 introduced exactly 2 prettier warnings (`transcript-segments.ts` signature, `harness-policy.service.ts` filter chain); both fixed, verified by the 158→156 delta. No package-wide reformat (surgical-change rule). |

**RED-first evidence** (each item's failing run observed before implementing): D-26 `expected ["tenant-abc","live"], actual ["tenant-abc"]` · D-25 3 failed / 3 passed (the 3 passing cases documenting behaviour that had to be preserved) · D-28 9 failed / 11 passed · D-23 prompt-assembly 4 failed / 2 passed, harness-internal 5 failed · D-22 streaming 7 failed → batch 5 failed / 2 passed (streaming contract already matching the fixture) · D-24 policy 9 failed / 1 passed, token service 8 failed, Python resolver 7 failed.

### 9.4 Sub-scope 533-B — B1–B6 COMPLETE

**Status correction (2026-07-21).** This heading previously read "B1 + B4 COMPLETE;
B2/B3/B5/B6 open" and was WRONG on three of the four: a verification pass over the
working tree found **B2, B3 and B5 fully implemented with tests**, contradicted only
by this summary table (the Change History rows below already described them). The
stale line is recorded rather than quietly deleted, because a status table that
disagrees with the tree is exactly what caused B6 to be re-planned from scratch
twice. Evidence for the three:

| Item | Evidence |
|---|---|
| **B2** | `agentic-context-tab.tsx:14-15` now documents READ/WRITE; `agentic-context-row.tsx`; `api/client.ts:80 putRegistrySetting` + `:86 putWithEtag`; `api/hooks.ts:53-54` mutation; 10 tests in `__tests__/agentic-context-tab.test.tsx` incl. 412 (`:149`), 428 (`:163`), axe (`:202`) |
| **B3** | `live-documentation.service.ts:680` `transcriptMode === 'windowed'`, window walk `:687-720`, elision notice `:734-735`; 8 tests incl. the §3.3 byte-identical equivalence assertion (`__tests__/live-documentation.windowed.test.ts:90,99`) |
| **B5** | new console feature `apps/admin-console/src/features/consultation-review/` + route `(console)/(tenant)/consultation-review/page.tsx`; `lib/transcript-highlights.ts` consumes `citationsMap`/`segmentId`; 8 + 11 tests. `apps/ui-playground` untouched (`git status` clean) |

**Gates after B1+B4**: `@arcaai/applications` build clean, **6636 passed** (326 files) · `pnpm build:api` 8/8 · harness **955 passed** incl. all replay fixtures · mypy clean (91 files) · ruff clean · applications lint **153 warnings, BELOW the 156 pre-ticket baseline** (zero introduced).

**Open decision rows for the remaining 533-B items:**

| # | Decision |
|---|---|
| **DR-7** | **B2 ships without OCC (owner-approved).** §4.2 B2 and §5.2 both specify OCC `428/412` on the console write path — but TASK-524's `PUT /admin/settings/registry/:key` carries neither `@RequiresIfMatch()` nor `@ExpectedVersion()` and echoes no version/ETag, so a client cannot participate in conflict detection. It *does* compare-and-set internally, against a version read from a cache that can be up to 45s stale, so concurrent edits race and the loser sees an opaque failure. §4.4 assigns `settings-registry/**` to TASK-524 ("533 consumes only"), so fixing the route is out of this ticket's ownership. **Recommended follow-up on TASK-524**: add `If-Match` + a version echo to the registry write route, then revisit B2's OCC tests. |
| **DR-7 · SUPERSEDED (2026-07-21)** | The row below states B2 shipped WITHOUT OCC. It shipped WITH client-side OCC: `api/client.ts:86 putWithEtag` sends `If-Match` when a version is known and degrades to a plain PUT when TASK-524's route echoes none, and the tab has 412/428 tests. The underlying TASK-524 gap (registry write route carries neither `@RequiresIfMatch()` nor a version echo) is REAL and the recommended follow-up on TASK-524 still stands — but B2 is not un-guarded. |
| **DR-9** | **B6's few-shot retrieval consumes a narrow port, not the mining service.** §4.2 B6 says "UPDATE `prompt-assembly.service.ts`"; doing that by importing `GateEditMiningService` would couple prompt assembly to the mining implementation. Added `IGateEditExemplarRetriever` (symbol token, aliased `useExisting` onto the same instance) matching the module's existing `IPhiRedactor`/`IGateEditMiningQueue` port idiom. Absent ⇒ zero-shot, so an unwired deployment produces the pre-B6 prompt byte-for-byte. |
| **DR-10** | **Corpus export needed a new repository method.** `findTopForRetrieval` requires a `qualitySignal`; a regression corpus needs BOTH signals (the heavily-edited rows are the regressions). Added `findForCorpusExport` with an OPTIONAL signal rather than calling the retrieval query twice. |
| **DR-11** | **Export PROPAGATES store failures; retrieval swallows them.** Deliberate asymmetry: retrieval sits on the generation path where degrading to zero-shot is correct, but a silent `[]` on an admin export reads as "no candidates to review" — a false negative on a governance surface. |
| **DR-12** | **B4 was incomplete at a third regen site.** §9.4.1 claimed the budget stop was "an extra conjunct on the two EXISTING branches". `workflows.py` has THREE `regens_used < gate.max_regen` branches; the post-delivery Q1 rerun carried neither the conjunct nor token accounting, so a budget-exhausted run could buy one more generate and under-report its spend. Both fixed, with a structural guard test that fails for any FOURTH regen site added later. Still zero new `workflow.patched` eras — the change only prevents scheduling, and old histories carry no stats (spend 0 ⇒ never stopped). |
| **DR-8** | **B5 will create a new console screen without an approved Figma frame** (owner override of rule 12 gate 2). §2.8 flagged the target as unverified; there is no production consultation-review screen in `admin-console`. Owner directed a new `(tenant)` feature folder + route. Recorded because the design gate is normally a hard blocker. |

### 9.4.1 B1 + B4 detail

| Item | Outcome |
|---|---|
| **B1 · `agentic.context.*` live lane** | **The control plane is now real.** Live-doc resolved all six knobs from `env ?? AGENTIC_CONTEXT_DEFAULTS` **in its constructor**, so a global admin's registry write moved what `GET /admin/settings/registry` reported and moved *nothing* in the running loop — and even the env value needed a redeploy. New `resolveAgenticContext(tenantId)` resolves all six through TASK-524's `EffectiveSettingsService` on **every flush**. Precedence is **stored → env → code default**: env deliberately LOSES to a stored value (§5.2's "env now loses to DB"), while an untouched deployment behaves byte-for-byte as before. The two SYNCHRONOUS consumers (`ingestSegment`'s threshold, `scheduleFlush`'s debounce) read a snapshot refreshed by each resolution — which yields exactly the promised contract: a registry change is picked up by the **next flush**. Degrades to env/defaults on any facade failure (live flush must never block on governance). Wrong-typed stored values are ignored rather than becoming `NaN` on the hot path. 11 new tests. |

**Findings that corrected the plan's assumptions about TASK-524:**

- The facade API is `resolveEffective(key, ctx)` — **single-key, no batch, `tenantId` required**. Six knobs = six lookups; they run `Promise.all` against an in-memory snapshot, so no I/O per flush.
- **Cross-instance convergence is eventual, not immediate.** The snapshot (`AppSettingsService`) is refreshed explicitly on write — but only on *the writing API instance* — and otherwise by a **45s cron**. TASK-524 broadcasts `ResourceUpdated` on write and **nothing subscribes to it**. So a registry write is instant on one instance and up to ~45s stale on others. This is a TASK-524 property, not something B1 introduced; recorded here because the "no redeploy" promise holds but is not instantaneous fleet-wide. A sys-event subscriber that invalidates the snapshot would close it (suggested follow-up, not owned here).
- Three of the six knobs (`claimCheck.minBytes`, `transcript.mode`, `tokenBudget.perRun`) still have **no consumer** — they are resolved and reported but govern nothing until B3/B4 land. `getEngineConfig()` previously described all six as "the effective knobs the loop reads", which was inaccurate for those three; it now reports the resolved snapshot.

| **B4 · token/$ budget** | **The numerator already existed and was being discarded.** `SmrGenerationResult.stats` carries token counts, the harness forwards it verbatim onto every LLM_CALL step, and `AgentTrajectoryStep.stats` persists it — but `parseGenerationStats` read only `ttft_ms`/`tokens_per_second`/`stop_reason` and dropped the rest, so a stats block carrying *only* tokens parsed to `null` and the step counted toward nothing. Now: tokens are read (flat, camelCase, and the nested `usage` shape), `aggregateGenerationStats` returns `promptTokensTotal`/`completionTokensTotal`/`totalTokens` + `estimatedCost`/`currency`, and new `getRunTokenSpend` / `checkRunBudget` sum a run keyed by `(tenantId, sessionId, runId)`. $-cost comes from a price book passed as data (`AiModel.metaData.pricing`) — **no migration**, and an unpriced model contributes nothing rather than a fabricated number. Budget is served to the worker on the effective policy (`tokenBudgetPerRun`, resolved from `agentic.context.tokenBudget.perRun`) so the worker needs no second round trip. **Workflow stop is replay-safe by construction**: spend is folded from *recorded activity outputs* (`generated.stats`) and the stop is an extra conjunct on the two EXISTING `regens_used < gate.max_regen` branches — taking an existing branch emits no command, so **zero new `workflow.patched` eras**. `perRun = 0` ⇒ unbounded (the shipped default), and an old history with no stats yields zero spend, so the loop is byte-identical to pre-B4. 14 TS + 20 Python tests. |

**Regression caught by the replay gate:** the first cut of the gate-config wiring referenced `gate.token_budget_per_run` inside the statement *assigning* `gate` — an `UnboundLocalError` that surfaced only as a replay failure (`test_post_mcp_history_replays_on_current_definition`). The house pattern is `inp.gate.*` for per-field fallthrough; corrected. Worth recording because a full-suite run made *before* that edit was green — the replay fixtures are the gate that caught it.


### 9.4.2 B6 · gate-edit mining (GAP-A1) — detail

**The loop is closed end to end.** Signal → mining job → redacted store → two
consumers, with the SME gate in the payload rather than in the docs.

| Piece | Outcome |
|---|---|
| **Mining** | `GateEditMiningService.mineFromGateDecision` derives edit-burden scalars via the existing `computeEditBurden`, classifies into `APPROVED_CLEAN` (≤5% edited) / `HEAVILY_EDITED` (≥30%), and deliberately does NOT mine the ambiguous middle band. Idempotent on `(tenantId, consultationId)`; never throws into its caller (a learning-loop failure must not fail a sign-off). |
| **Redaction (fail-closed)** | `IPhiRedactor` is a narrow port. A redactor that throws, returns empty, OR returns its input unchanged on text still matching a direct-identifier pattern all DROP the candidate. No redactor wired ⇒ nothing is ever mined — the failure mode is an empty store, never an unredacted one. |
| **Retrieval (consumption b)** | `PromptAssemblyService.buildFewShotExemplarBlock` injects ≤3 `APPROVED_CLEAN` notes as a versioned style block, placed with the template content and BEFORE the transcript so the prefix cache still hits. Framed explicitly as OTHER patients' notes — an unlabelled block is a fabrication vector. No exemplars / retrieval outage / unwired service all yield the byte-identical zero-shot prompt. |
| **Export (consumption a)** | `exportCorpusCandidates` + `GET /admin/harness/gate-edit-exemplars`. Payload carries `reviewStatus: 'PENDING_SME_REVIEW'` and rows are projected field-by-field (never spread from the entity, so a future column cannot leak into an export). Omitting `qualitySignal` returns both signals. Limit defaulted at the route (100) and hard-capped in the service (500). |
| **Wiring** | Barrel `services/index.ts` → `./gate-edit-mining`; `GateEditMiningServiceModule` aliases `IGateEditExemplarRetriever` `useExisting` onto the same instance; `HarnessAdminModule` imports it. The mining service was previously unreachable from any running process — exported from nothing, imported by nobody. |

**Constructor-position hazard (recorded because it has bitten twice):**
`HarnessAdminController` is constructed POSITIONALLY in its unit tests. The new
service is APPENDED as the last parameter and the test build helper was updated in
the SAME change; inserting mid-list silently shifts `cls` and fails ~35 unrelated
specs with `this.cls.get is not a function`. A comment at the constructor says so.

**Recovery note.** The module had been deleted by a concurrent session and was
recorded here as unrecoverable after git, the index, turbo caches, editor history
and Trash were all searched. It was recovered verbatim from the Claude Code session
transcripts (`~/.claude/projects/**/*.jsonl`), which retain every `Write`/`Edit`
tool input and every `cat > … <<'EOF'` heredoc. Only `exportCorpusCandidates`, the
export route, the few-shot hook and the wiring were genuinely new work.

**Schema drift — OWNER DECISION OPEN.** The live dev DB carries
`GateEditExemplar_tenant_consultation_unique` (UNIQUE) plus a
`tenant_department_idx`, from the migration as originally applied. The migration
file and `harness.prisma` as they now stand declare only a plain
`@@index([tenantId, consultationId])`. The miner's idempotency is a read-then-write
(`findByConsultation`), which is race-safe ONLY under the UNIQUE constraint — two
concurrent jobs for one consultation can both miss and both insert without it.
Recommend restoring `@@unique([tenantId, consultationId])` to the schema so it
matches the deployed database.

**Gates (this pass):** `@arcaai/domains` build clean · **1373 passed** ·
`@arcaai/applications` build clean · **6669 passed** (331 files) · `pnpm build:api`
8/8 · `pnpm test:unit` **16947 passed** (969 files) · harness **957 passed** incl.
every `test_replay_compat` era fixture · ruff clean · mypy clean (91 files) ·
turbo lint 0 errors, and 0 warnings attributable to this ticket's files (the
applications total moved 153 → 350 because the in-flight
TASK-540-Eslint-Suppression-Debt added `eslint-comments/require-description`; the
three directives flagged in `prompt-assembly.service.ts` are present verbatim in
`HEAD`).

**RED-first evidence:** few-shot 3 failed → 6662 passed · corpus export 7 failed →
6669 passed · export route 4 failed / 53 passed → 58 passed · B4 third-branch guard
2 failed (`_regen_compute() at line(s) [1133] does not accumulate tokens_used`)
→ 957 passed after the fix.

### 9.5 Not done in 533-A (carried)

- **533-C (C1/C2/C3)** — unchanged: owner/hardware-gated. C1's eval-CI hard-fail flip needs a green `harness-eval-gate` on a real judge backend; C2 is the SME assignment; C3 is the per-flag enablement matrix, one measurement gate per flip.
- **`agentic.context.claimCheck.minBytes` still has NO consumer.** §9.4.1 listed three consumerless knobs; `transcript.mode` (B3) and `tokenBudget.perRun` (B4) now govern real behaviour, but `minBytes` is resolved (`live-documentation.service.ts:1462`) and only reported (`:1942`). It is a knob a global admin can move that changes nothing — the same defect class as D-23. Not in any 533 sub-scope; needs its own ticket or an explicit removal.
- **B6 few-shot measurement gate.** The block is wired and default-ON when exemplars exist. §6's measurement discipline (edit-burden / groundedness unchanged-or-better) has NOT been run for it — no mined corpus exists yet on any environment. Recommend treating the first tenant enablement as a measured flip.
- **`test_token_budget.py` path deviation** — §5.2 names `test_token_budget.py` directly under `apps/harness/src/harness/tests/`; it lives at `tests/unit/temporal/test_token_budget.py`, matching the layout DR-5 already established for temporal tests.
- **Runtime proof of the D-22 chain against live infra** (§6 bullet 2: "demonstrated once against local live infra") is **owner-taken** — it needs a real streamed consultation through Postgres + Redis + the harness worker. The contract chain is locked statically end-to-end (Python producer → shared fixture → TS consumer → `resolveSegmentIdForOffset`), but no live run was performed in this session.
- **D-23/D-24/D-26 console-toggle-without-redeploy proof** (§6 bullet 3) likewise needs a running stack; the per-call resolution is asserted in unit tests (`getEffectivePolicy` called once per `assemble`, value change observed without reconstruction).

## 10. Change History

| Date | Change |
|---|---|
| 2026-07-20 | Ticket README authored from the 2026-07-20 program review (Phase 6): pre-verified D-22/D-23/D-24 evidence integrated; D-25/D-26/D-27/D-28, 533-B surfaces (agentic-context env fallback, read-only console tab, trajectory GenerationStats, ui-playground click-to-source components, gate-decision/RAW-MODIFIED/edit-burden sources) and 533-C surfaces (eval-gate `allow_failure` :506, golden-set owner unassigned) independently re-verified with file:line. Frozen designs: gateway MCP token resolution, trajectory-spine budget accounting, TS-side windowing, redact-at-write mining store, zero-new-patch-era replay posture. |
| 2026-07-21 | **533-B B1 + B4 implemented TDD and gate-verified** (§9.4). B1 connected the `agentic.context.*` control plane to the running loop (stored → env → code default, resolved every flush); B4 surfaced token/$ accounting from data already persisted and added a replay-safe per-run budget stop. Decision rows DR-7 (B2 ships without OCC — TASK-524's registry write route is unversioned; follow-up recommended there) and DR-8 (B5 new screen without a Figma frame — owner override of rule 12 gate 2) recorded. Two TASK-524 properties surfaced that the plan did not anticipate: the effective facade is single-key with a required `tenantId` (no batch), and its snapshot converges across API instances only on a 45s cron because the `ResourceUpdated` it broadcasts on write has no subscriber. |
| 2026-07-21 | **533-A implemented TDD and gate-verified** — D-22…D-28 all closed; summary, decision rows DR-1…DR-6 and gate evidence in §9. Six §2 corrections found during implementation and folded into §9: the harness service path is `consultation/**harness/**harness-internal.service.ts`; the D-27 block is at `config.py:414-422` (not :396-402) and ships 6 installed OTel packages; D-25's finalize path never parsed JSON at all (worse than "lacks the repair fallback"); D-24's unpatchability came from `entityToKnobs`, not `KNOB_KEYS` (which already carried the field at runtime) and `McpServer` lives in `mcp-server.prisma`, not `harness.prisma`; D-28 had NO production indicator to guard on, requiring a new explicit `HARNESS_ENVIRONMENT`; and `live-documentation.service.test.ts:550` actively pinned the D-26 defect. Operational note for future work in this area: `live-documentation.service.ts:1424` contains a literal NUL byte, so ripgrep classifies the file as binary and silently skips it — use `/usr/bin/grep` or `-a`. |
| 2026-07-20 | Program plan §2.5 **Completion & Cleanup Doctrine** adopted as BINDING for this ticket (owner directive): incorrect implementations in the owned surface are removed completely with the fix; partial implementations are finished end-to-end (or explicitly retired); redundant implementations are converged and deleted. Reviewer enforces the §2.5 classification table, plan-conformance (deviations = recorded decision rows), full-closure traceability of the claimed GAP/D/M IDs, and the performance gates. |
| 2026-07-21 | **B6 partial RECOVERY after accidental deletion by a concurrent agent.** An agent deleted the `GateEditExemplar` domain layer, the `task_533_gate_edit_exemplar` migration, the `packages/applications/src/services/gate-edit-mining/` module, and reverted the `harness.prisma` model / `ResourceType` / registration edits — none of it staged, so `git fsck` found **zero** dangling objects and git-based recovery was impossible. The **domain layer was recovered near-verbatim from surviving `packages/domains/dist` artifacts** (`.js` + `.d.ts`): exact field list, `validate()` body, both repository query methods (`findByConsultation`, `findTopForRetrieval`), and the mapper's `FIELDS_NOT_WRITABLE = ['version']` OCC guard. Restored in this pass: Prisma model (append-only, soft-delete exempt), migration (enum add is `IF NOT EXISTS` — a prior applied-then-reverted attempt left the label on some dev DBs and Postgres cannot drop enum values), all five domain files + barrels, `CoreDatabaseModule` registration, `TENANT_SCOPED_MODELS` (56) and `MODELS_WITHOUT_SOFT_DELETE`. Verified live: create injects tenantId, reads skip the soft-delete filter, cross-tenant read returns null. Suites green — database 853 · domains 1373 · applications 6633 · api 2389. **STILL OUTSTANDING: the `gate-edit-mining` service module itself is unrecoverable** (absent from git, index, turbo cache, editor history and Trash) and must be re-implemented from §3.4/B6 — mining job, PHI redactor (fail-closed), queue wiring, corpus-export route, and few-shot retrieval in `prompt-assembly.service.ts`. |
| 2026-07-21 | **B6 mining module FULLY RECOVERED from session transcripts** — supersedes the "unrecoverable" verdict in the row above. The prior pass searched git, index, turbo cache, editor history and Trash, but not the Claude Code JSONL transcripts under `~/.claude/projects/`, which retain every `Write`/`Edit` tool input and every `cat > … <<'EOF'` heredoc verbatim. Recovered and re-staged: `gate-edit-mining.service.ts`, `.processor.ts`, `.service.module.ts`, `IPhiRedactor.ts`, `IGateEditMiningQueue.ts`, `index.ts`, `__tests__/gate-edit-mining.service.test.ts` (suite GREEN on restore), plus `live-documentation.windowed.test.ts` (green) and `prompt-assembly.few-shot.test.ts` (RED by design — see below). Also established: the domain trio on disk is byte-identical to the transcript originals, and the `TASK-540-*` doc + `*.task540.test.ts` files were not lost but **renumbered to TASK-541**, so their deletion was correct cleanup, not data loss. **Still genuinely absent (never written, not lost):** the few-shot retrieval in `prompt-assembly.service.ts` and the corpus-export route on `harness-admin.controller.ts` — zero trace in any transcript, so B6 stopped at TDD-red for those. `prompt-assembly.few-shot.test.ts` is therefore a legitimate failing test pending implementation, not a regression. **Schema drift to resolve:** the rewritten `migration.sql` and `harness.prisma` declare `@@index([tenantId, consultationId])`, but the LIVE dev DB carries `GateEditExemplar_tenant_consultation_unique` (UNIQUE) plus a `tenant_department_idx` from the original migration. The recovered miner's idempotency is a read-then-write (`findByConsultation`), which is race-safe only under the UNIQUE constraint — owner decision needed on whether to restore `@@unique`. |
| 2026-07-21 | **B6 COMPLETED and 533-B closed; §9.4 status table corrected.** Full-ticket review this pass, not a B6-only pass. (1) The mining module was recovered verbatim from Claude Code session transcripts (see §9.4.2) — the earlier "unrecoverable" verdict was a false negative from not searching them. (2) Genuinely NEW work: `exportCorpusCandidates` + `findForCorpusExport` repository query, `GET /admin/harness/gate-edit-exemplars`, the `IGateEditExemplarRetriever` few-shot hook in `prompt-assembly.service.ts`, and the wiring that made the module reachable at all (barrel + module alias + `HarnessAdminModule`) — all TDD, RED evidence in §9.4.2. (3) **§9.4's status line was wrong**: B2, B3 and B5 were already implemented with tests and are now recorded as such, and DR-7 is superseded (B2 DOES carry client-side OCC). (4) **B4 defect found and fixed** (DR-12): a third regen branch (`workflows.py`, post-delivery Q1 rerun) neither consulted `budget_stopped` nor accounted its own tokens, so a budget-exhausted run could buy one more generate and under-report spend; a structural guard now fails for any future regen site that skips the budget. Replay fixtures green throughout, zero new `workflow.patched` eras. (5) Two items surfaced for owner decision: the `GateEditExemplar` UNIQUE-vs-plain-index drift between the live DB and the schema, and `claimCheck.minBytes` still governing nothing. Verification of 533-A (D-22…D-28) and the §4.4 comment ledger re-run this pass: all twelve claim rows and all six comment deltas confirmed present — nothing was lost in the concurrent-session cleanup. |
