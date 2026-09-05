# TASK-876 — Agent-First Text Generation on Both Lanes, with Platform-Default Fallback

| | |
|---|---|
| **Status** | Review — implemented, gates green, awaiting the orchestrator's merge |
| **Type** | feature / refactor |
| **Program** | TASK-870 Configuration Governance — wave 2, lane A |
| **Branch** | `task-876-agent-first-text` (worktree `../hope-v2-task-876`) |
| **Base** | `030df76b5` (off `dev-2.2`) |
| **Merge target** | `dev-2.2` — merged by the orchestrator from the primary checkout |

## Requirement Analysis

The owner's model for this lane (TASK-870 decisions #3, #4, #6, #7): **capabilities are agents.** A
text-generation call is served by the tenant's assigned `TEXT_GENERATION` agent
(`AgentAssignment` cascade `department → tenant → SYSTEM`); fallback is a platform HA capability —
ON by default, to the platform default (the SYSTEM-assigned agent), metered as platform-funded —
and the on/off toggle is a per-agent-node parameter a tenant admin controls; admins overwrite an
agent's hyper-parameters and instruction by injected context or hard-coded node values, never by
settings; the redundant old-architecture selection paths are removed completely, not dual-homed.

Six deliverables: (1) the agent contract additions (TEXT_GENERATION `fallback` block with the
governance defaults DECLARED on the contract; SPEECH_TO_TEXT chunking / semantic-endpointing /
endpointing-model fields for TASK-877); (2) a TEXT_GENERATION resolver producing a resolved spec
analogous to the ASR spec; (3) the realtime `core.agent` resolves its `agentRef` and falls back;
(4) `resolveTextSelection` precedence collapses to the assigned agent; (5) the Temporal
`core.agent` falls back along the chain the resolve route now carries; (6) publish-time
capability clamp on `core.agent.overrides.generation`.

## Current State Evaluation

Verified at `030df76b5` (the brief's paths differ slightly from the tree — the Temporal nodes live
under `apps/harness/src/harness/temporal/interpreter/nodes/`, not `temporal/nodes/`):

- `AGENT_PARAMETER_SCHEMAS.TEXT_GENERATION` carried no `fallback` block; `SPEECH_TO_TEXT.fallback`
  declared no defaults, and the two governance literals lived in
  `build-resolved-asr-spec.ts:36` (`ASR_SPEC_FALLBACK_DEFAULTS`).
- `AgentModelFallback` rows were READ only by the ASR builder's `fallbackOf`; TEXT_GENERATION had
  no reader.
- **Realtime lane defect confirmed.** `realtime-node-registry.ts:457-469` (`CoreAgentHandler.run`)
  forwarded only `ctx.config`; `agentRef` was resolved nowhere in `packages/applications/src`.
  `callText` (`live-documentation.service.ts:3242-3250`) selected through `agent?.liveLlm` (always
  `null` — `live-agent-resolution.service.ts:100` hard-coded it) else
  `resolveTextSelection(tenantId, 'live', nodeBinding)`. A bound agent's model, instruction, prompt
  pin and parameters were ignored on the live lane.
- `resolveTextSelection` (`harness-policy.service.ts:630-655`) had three tiers: the node
  `llmBinding.modelSlug` (0), `AiTaskDefaultService.getEffective('text.live'|'text.finalize')` (1),
  `HarnessPolicy.textProvider/textModel` (2).
- Temporal lane: `nodes/core.py:711-755` resolved the agent via `GET /internal/agents/resolve`,
  enforced the version pin fail-closed, and `_run_text_generation` used the primary model only —
  with the RAW catalogue provider (`azure`), which apps/text does not register (it registers
  `azure-openai`; every TS caller applies the alias).
- Publish-time gap: `readGenerationBinding` (`node-generation-binding.ts:53-60`) read only
  `config.generation` + `config.providerConfigRef`; `hyperparameterCapabilityFindings` never saw
  `core.agent.overrides.generation`.

### Seed finding

`packages/database/src/prisma/db_main/seed/25-agents.ts:293-297` ships exactly ONE SYSTEM
TENANT-scope `TEXT_GENERATION` assignment: `platform-summarization` (model
`lms-gemma-4-e2b-it-qat`, the approved live SOAP template). **`AgentAssignment` has no role
dimension** — its key is `(scope, scopeId, task)` — so there is no separate "live" and "finalize"
assignment; the same assigned agent serves `text.live`, `text.finalize` and `text.test`. That is
the model the owner asked for (a workflow that wants a different model per node binds a
`core.agent` with an explicit `agentRef`), and it is why the deprecated routing-policy read does
NOT survive as a terminal fallback: a SYSTEM assignment exists, so "no agent anywhere" is a
configuration error and is reported as one. Seeds were not edited.

## Implementation Plan

TDD per deliverable, failing test first (evidence in Implementation Summary):

1. Schema — `agent-schemas.task876.test.ts` → `agent-schemas.ts`.
2. Resolver — `text-agent-resolver.service.test.ts` → `text-generation-spec.ts` +
   `text-agent-resolver.service.ts`, registered in `AgentServiceModule`.
3. Selection — `harness-policy.agent-first-text.task876.test.ts` → `harness-policy.service.ts`;
   the three retired-tier test files removed.
4. Realtime — `realtime-core-agent.task876.test.ts` + `live-documentation.core-agent.task876.test.ts`
   → `realtime-node-registry.ts`, `live-documentation.service.ts`, `live-agent.port.ts`.
5. Temporal + route — `test_core_agent_text_fallback_task876.py` + controller test →
   `_text_fallback.py`, `core.py`, `api_client.py`, the four node modules, `agent-internal.controller.ts`.
6. Clamp — `workflow-definition.core-agent-clamp.task876.test.ts` → `node-generation-binding.ts`,
   `workflow-definition.service.ts`.

## Implementation Summary

### Resolver design — `ResolvedTextGenerationSpec`

`packages/applications/src/services/agent/text-generation-spec.ts` (pure types + helpers) and
`text-agent-resolver.service.ts` (`TextAgentResolverService`, registered + exported by
`AgentServiceModule`), beside `AgentResolverService`:

```
resolve({ tenantId, agentSlug?, versionNumber?, departmentId? })
  → AgentResolverService.resolve(task = TEXT_GENERATION)            (:76)
  → version pin honoured FAIL-CLOSED (409 AGENT_VERSION_DRIFT)       (:84)
  → resolveFromAgent(agent, tenantId)                                (:94)
      primary   = the agent's primary model, provider aliased for the wire, sourceUri as model
      chain     = parameters.fallback.agentSlug → [fallback-agent]   (explicit wins)
                  else the agent's own AgentModelFallback chain → [fallback-model …]
                  then ALWAYS the SYSTEM-assigned agent → [platform-default]  (:139)
                  unless the primary already IS the platform default; never listed twice
      fallback  = { autoSwitch, switchAfterConsecutiveFailures } from readAgentFallbackGovernance
      funding   = per candidate, DERIVED from the row that serves it (:185):
                  cloud provider → ProviderCredentialResolver binding (tenant row = 'tenant',
                  SYSTEM row = 'platform'); self-hosted → the AGENT row's tenantId
                  (SYSTEM → 'platform', else 'tenant') — the same rule AiRoutingPolicyService.fundRow
                  applies to a routing row without a connection
```

A veto / entitlement refusal on the PRIMARY propagates (fail closed); on a FALLBACK the candidate
is left out of the chain (a tenant that vetoed one provider still generates on another); a cloud
fallback with no credential at either tier is dropped (it could only 503); a fallback agent that
does not resolve degrades to the next option. `autoSwitch` is CARRIED as the tenant's toggle —
the runtime lane decides whether to switch; the resolver never does.

The internal route (`apps/api/src/modules/internal/agent-internal.controller.ts:74`) attaches
`textFallback: spec.fallback` to a TEXT_GENERATION answer from the SAME resolved agent
(`resolveFromAgent`, no second resolution). The route is `@ApiExcludeController()`, so no
`openapi.json` / portal / vox-node artifact changes; `route-manifest.json` is unaffected (same
route, same guards). **Resolve-endpoint DTO change: additive (`textFallback`) — no artifact drift
expected post-merge.**

### What survives of `resolveTextSelection`'s precedence, and why

| Tier | Before | After |
|---|---|---|
| 0 — node `llmBinding.modelSlug` | fail-closed override | **removed**: `node-llm-binding.ts` deleted, `resolveBoundNodeSelection` deleted, `getEffectivePolicy(opts.modelSlug)` accepted-but-inert (`@deprecated`; see "Left for others") |
| 1 — `AiTaskDefault` `text.live` / `text.finalize` / `text.test` | tenant → SYSTEM | **replaced** by the assigned TEXT_GENERATION agent through `TextAgentResolverService` (`harness-policy.service.ts:504`) |
| 2 — `HarnessPolicy.textProvider/textModel` | terminal cascade | **removed** from selection; the columns still pass through `getEffectivePolicy` without a `taskKey` (the Python `core.agent` reads only the PHI flags there) |
| `text.*.fallback` AiTaskDefault keys | per-tenant opt-in fallback | **replaced**: `resolveTextFallbackSelection` returns the FIRST candidate of the resolved chain, `null` when `autoSwitch` is off, the chain is empty, or the lookup faults (fail-OPEN by contract, unchanged) (`:553`) |

The `task` parameter (`'live' | 'finalize' | 'test'`) is kept as telemetry (`task_key` on the
generation stats) — it no longer selects. `getEffectivePolicy(tenantId, { taskKey })` overlays the
assigned agent's `{provider, model}` for the Python lane and **NULLS both fields when no agent is
assigned** (fail closed → `no_text_selection` at the node) instead of serving the legacy columns.

Every consumer keeps working unchanged: `summary.service.ts`, the pre-summary / comprehensive
processors, `chain-summary`, `dna-writing-style`, `text-proxy`, `text-compat` all call the
2-argument (or 0/1-argument) form. Behaviour change worth stating: `summary.service.ts` and
`text-compat` skip a fallback whose PROVIDER equals the primary's ("retrying the identical provider
cannot help"); with the platform default typically on the same self-hosted provider as a tenant's
primary, those two consumers will skip a same-provider model fallback. Not this lane's files —
recorded, not changed.

### Realtime lane (`packages/applications/src/services/consultation/live-documentation/`)

- `realtime-node-registry.ts:459-493`: `CoreAgentHandler.run` reads `agentRef` off its own config
  (`readAgentRef`; no slug ⇒ throws, the executor degrades the node with a named reason) and passes
  `{ slug, versionNumber? }` to `generateDocument` as `GenerateDocumentInput.agentRef` (`:126`).
- `live-documentation.service.ts:2322`: the host resolves it via `TextAgentResolverService`
  (`resolveRealtimeAgent`, `:3252`) — explicit slug + pin, FAIL CLOSED on drift or an unresolvable
  slug (no TEXT call, node degraded, nothing substituted). `callText` (`:3265`) walks
  `[primary, ...chain]` when `autoSwitch` is on; `callTextCandidate` (`:3360`) sends the candidate's
  provider / provider-native model, its resolved instruction interpolated with the agent's own
  variables + the node's `overrides.promptVariables` (node wins), its generation parameters with
  `overrides.generation` layered on top; the response format stays the session's compiled
  DOCUMENT schema (the agent writes the running note). Stats stamp `selection_source`
  (`agent` / `agent-fallback` / `task-default`), `agent_slug`, `funding_tier`
  (`dto/live-summary.dto.ts`). The legacy summary / grammar / findings nodes generate on the
  ASSIGNED agent through `resolveTextSelection(tenantId, 'live')`.
- `liveLlm` deleted from `FrozenLiveAgentSnapshot` / `PersistedLiveAgentLineage`
  (`live-agent.port.ts`), from `callText`, `codeDefaultAgentSnapshot`, `agentLineage`, and from
  the three sites in `consultation/prompt/live-agent-resolution.service.ts` (outside the ownership
  column; named by deliverable 3 — three property lines removed, nothing else).
- `switchAfterConsecutiveFailures` is carried on the spec but the per-call lanes (live flush,
  Temporal activity) switch on the FIRST failure of a call — the threshold is a session-scoped
  runtime's semantics (the ASR session manager). Recorded as a deliberate simplification.

### Temporal lane (`apps/harness/src/harness/temporal/interpreter/nodes/`)

- `_text_fallback.py` (new): reads `textFallback` off the raw resolve answer with the contract
  defaults (`read_text_fallback`, `:87`), projects a candidate onto the `ResolvedAgent` shape
  (`candidate_as_resolved_agent`, `:117`) so ONE generation path serves primary and fallbacks
  alike, and `wire_provider` (`:42`, `azure → azure-openai`).
- `core.py:451-597`: `_run_text_generation(payload, resolved, started, fallback=…)` builds the
  candidate list (`:513`) and switches on `TextServiceError` while `autoSwitch` is on; the output
  names the serving row (`agent`, `selectionSource`, `fundingTier`); `interpreter_core_agent`
  passes `read_text_fallback(raw)` (`:797`). Activity-level only — the workflow stays
  deterministic and sees one activity result. The primary's provider now goes on the wire as
  apps/text registers it (`azure-openai`), fixing the pre-existing raw-provider mismatch. The
  PHI egress guard is default-deny (anything outside `HARNESS_PHI_LOCAL_PROVIDERS` is cloud), so
  the alias keeps the cloud posture.
- `api_client.py`: `resolve_agent` docstring documents `textFallback`; `get_policy` drops the
  retired `model_slug` parameter. `_shared.read_model_slug` deleted; `_llm_policy.resolve_text_selection`,
  `text_generate.py`, `guards.py`, `agent_catalogue.py`, `consultation_realtime.py` no longer thread
  a model slug. `test_llm_binding_task816.py` (19 tests) replaced by
  `test_core_agent_text_fallback_task876.py` (12).
- Replay-compat: `workflows.py` untouched; the six pre-existing failures are unchanged (below).

### Publish-time clamp (`packages/applications/src/services/workflow-definition/`)

`node-generation-binding.ts:61`: `readGenerationBinding` also yields a binding for a `core.agent`
node with `overrides.generation` + `agentRef` (`path: '/config/overrides/generation'`); the legacy
shape reads exactly as before. `workflow-definition.service.ts:1103`
(`generationCapabilitiesFor`): an `agentRef` binding resolves the bound agent (ACTIVE published,
`[tenant, SYSTEM]`) to its model row and reads `_metadata.capabilities.supportedGenerationParams`
— the same read `AgentService.capabilitiesOf` makes when the agent itself is published, so the two
gates cannot disagree; the routing plane is never consulted for an agent-bound node. Severity split
preserved: declared-and-absent → ERROR (publish refused), absent set / unresolvable agent → WARNING
(the runtime fails closed on it anyway). Two optional trailing constructor deps (`AgentRepository`,
`AiModelRepository`, both from the already-imported `CoreDatabaseModule`).

### Schema (`packages/workflow-contract/src/agent-schemas.ts`)

- `AGENT_FALLBACK_DEFAULTS` (`:152`) and `readAgentFallbackGovernance` (`:166`) declare the
  governance defaults ONCE; `fallbackProperty(task)` (`:179`) gives TEXT_GENERATION and
  SPEECH_TO_TEXT the same closed block with `default:` on both knobs and a slug-patterned
  `agentSlug`. `build-resolved-asr-spec.ts:36` still carries its own literal — left to TASK-877
  (that file is theirs); it should read `AGENT_FALLBACK_DEFAULTS`.
- SPEECH_TO_TEXT: `decoding.chunkLengthSec` (1–60) / `strideLengthSec` (0–30) (`:286`), a closed
  `streaming.semantic` block `{ modelSlug, minSilenceMs, maxSilenceMs, confidenceThreshold, minWords }`
  (`:324`) and `ASR_ENDPOINTING_MODEL_SLUG_PATH` (`:371`). Materialising the `endpointing` role in
  `AgentResolverService` needs `ResolvedAgentModelRole` (`packages/types/src/agent.ts:19`, not this
  lane's file) widened by one member — recorded under "Left for others".
- `packages/workflow-contract/src/index.ts`: four export lines added (the barrel uses an explicit
  export list, so the new symbols could not reach `dist` otherwise).

### Left for others / not done

| Item | Where | Why |
|---|---|---|
| `withLlmBinding()` + the `taskKey` nodes' `llmBinding` schema property | `packages/workflow-contract/src/node-config-schemas.ts:2181-2185, 2256` | not this lane's file; the property is now inert (no reader on either runtime) |
| `modelSlug` query parameter on `GET /internal/harness/policy` | `apps/api/src/modules/consultation/harness-internal.controller.ts:384-409` (+ the applications `consultation/harness/**` pass-through) | not this lane's files; `getEffectivePolicy` accepts it as `@deprecated` and consults nothing |
| `ResolvedAgentModelRole` + `'endpointing'` | `packages/types/src/agent.ts:19` | not this lane's file (TASK-877 / orchestrator) |
| `ASR_SPEC_FALLBACK_DEFAULTS` → `AGENT_FALLBACK_DEFAULTS` | `packages/applications/src/services/stt/agent-resolver/build-resolved-asr-spec.ts:36` | TASK-877's file |
| `text.live.fallback` / `text.finalize.fallback` descriptors + `AI_TASK_KEYS` entries | `settings-registry/descriptors/model-defaults.descriptors.ts:116`, `ai-task-default/constants.ts` | not this lane's files; no reader remains after this lane (the `AiTaskDefault` table drop is orchestrator-owned) |
| `HarnessPolicy.textProvider/textModel` columns and DTO fields | Prisma + `harness-policy/dto` | Prisma is orchestrator-owned; the columns are no longer a selection source |
| Same-provider fallback skip in `summary.service.ts` / `text-compat` | those consumers | recorded above; not this lane's files |
| An invalidation channel for agent publish / `AgentAssignment` writes | `AgentService.publish`, the assignment writer | `TextAgentResolverService`'s spec cache (review item 6) is TTL-ONLY because none exists: `app-settings:invalidate` carries `GlobalSetting` writes and `arca:secrets:invalidate` secret rotations, and neither is published by those writers. The 15 s TTL is therefore the whole propagation bound, for a rotated cloud credential too |
| `departmentId` on the remaining text call sites | `text-proxy.controller.ts`, `text-compat.controller.ts`, `dna-writing-style.processor.ts`, the live legacy flush, `getEffectivePolicy`'s overlay | the seam now takes a department (review item 4) and `SummaryService` passes the consultation's. The rest hold NO consultation, and `getEffectivePolicy` is reached with a consultation ID but no repository to turn it into a department — they pass null, which starts the cascade at the tenant tier. Threading it needs a consultation read those call sites do not have |
| The three inert `GET /internal/harness/policy` query parameters | `apps/api/src/modules/consultation/harness-internal.controller.ts` | `consultationId`, `taskKey` and `modelSlug` are now ALL inert (`_opts` in `getEffectivePolicy`); removing the wire parameters belongs to that module's owner |
| `text.test` `AiTaskDefault` key + `models.text.test` descriptor | `ai-task-default/constants.ts`, `settings-registry/descriptors/model-defaults.descriptors.ts` | no reader remains after review item 5; the row/descriptor retirement is orchestrator-owned |

### Gates

Filled from the actual runs (see Change History for the commands):

Run by the orchestrator in this worktree AFTER rebasing the branch onto `dev-2.2` at `094d639f4`
(the wave-2 base plus TASK-869, lane C/TASK-878, and the two owner env-surface commits — the rebase
applied all seven commits cleanly). The lane's original agent stalled on the 600 s watchdog while
these suites ran, so the numbers below are the orchestrator's re-run, not the agent's.

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/workflow-contract build` / `test` | build clean; 35 files / 1491 tests passed |
| `pnpm --filter @arcaai/applications build` / `test` / `lint` | build clean; 661 files / 11527 tests passed (1 file, 4 tests skipped); 0 errors / 213 pre-existing warnings |
| `pnpm --filter @arcaai/api typecheck` / `test` | clean; 280 files / 4213 tests passed (2 files, 4 tests skipped) |
| `pnpm harness:test` (provenance-guarded, from this tree) | 6 failed / 2084 passed — the six are the pre-existing `[TMPRL1100] NondeterminismError` replay failures on the task-355 fixtures (`test_gating_consolidation_replay` ×2, `test_replay_compat` ×4), byte-identical to the wave-1 baseline set; the drop from 2091 passed reconciles exactly: `test_llm_binding_task816.py` (19 collected cases) deleted, `test_core_agent_text_fallback_task876.py` (12) added, `test_core_agent_resolution.py` unchanged at 9 → net −7 |

Re-run after the review round (2026-09-05):

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/workflow-contract test` | 35 files / 1492 tests passed |
| `pnpm --filter @arcaai/applications test` | 661 files / 11559 tests passed (1 file, 4 tests skipped) |
| `pnpm --filter @arcaai/applications lint` | 0 errors, 213 warnings (the pre-existing prettier/only-warn set — unchanged count) |
| `pnpm --filter @arcaai/api typecheck` / `test` | clean; 280 files / 4219 tests passed (2 files, 4 tests skipped) |
| `pnpm harness:test` | 6 failed / 2099 passed — the SAME six pre-existing replay failures. +15 on the baseline 2084: `test_core_agent_text_fallback_task876.py` 12 → 17 (the derived-tier attribution case, the `read_text_primary` tolerance case, and `TestActivityBudget` ×3) and the new `test_generate_text_fallback_task876.py` (10). No test removed. |
| `pnpm harness:lint` / `pnpm harness:typecheck` | ruff clean; mypy "no issues found in 148 source files" |

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | `e72dc1d8c` schema: TEXT_GENERATION `fallback`, declared defaults, SPEECH_TO_TEXT chunking / semantic / endpointing reference (+ barrel exports). |
| 2026-09-05 | `e034a88e2` `TextAgentResolverService` + `text-generation-spec.ts`. |
| 2026-09-05 | `9661284a7` agent-first `resolveTextSelection` / `resolveTextFallbackSelection` / `getEffectivePolicy` overlay; realtime `core.agent` resolves `agentRef` and falls back; `llmBinding`, `text.*` keys, policy columns, `liveLlm` retired. |
| 2026-09-05 | `e393e556d` Temporal `core.agent` fallback chain; `textFallback` on the internal resolve route; `model_slug` retired from the Python lane. |
| 2026-09-05 | `5865e7b06` publish-time capability clamp on `core.agent.overrides.generation`. |
| 2026-09-05 | `d79e02c6a` reverted two prettier-only touches outside the change. |
| 2026-09-05 | `d59ae8a13` loosened the internal-controller mock typing so `apps/api` typecheck stays clean. |
| 2026-09-05 | Orchestrator: branch rebased onto `dev-2.2` `094d639f4` (clean, 7/7); hashes above remapped; gate evidence filled from the re-run on the rebased tree. |

### Review round (2026-09-05) — thirteen findings closed on the branch

| Date | Change |
|---|---|
| 2026-09-05 | `50c3454d2` **(1a, BLOCKER)** the assigned-agent overlay on `getEffectivePolicy` is UNCONDITIONAL. The `opts.taskKey` gate was a live selection hole: `AgentAssignment` has no role dimension, and the DURABLE lane (`fetch_policy` → `workflows.py`) sends no task key — so it kept reading the retired `HarnessPolicy.textProvider/textModel` columns into `GenerateInput`. No agent at any tier now NULLS both fields and logs a configuration error. |
| 2026-09-05 | `1c315a6fb` **(11)** the resolver cascade test calls from a plain customer tenant, not the reserved `50000000-…` playground id. |
| 2026-09-05 | `92e26168a` **(2, BLOCKER)** the fallback toggle is FUNDING-GATED at the resolver chokepoint: `ResolvedTextFallback.autoSwitch` is the EFFECTIVE value (`effectiveAutoSwitch`), so a tenant may disable platform HA only for a primary it funds. Consumers read it verbatim. |
| 2026-09-05 | `a9a443e61` **(3, MAJOR)** `/internal/agents/resolve` ships `textPrimary` beside `textFallback`; `core.py` attributes the primary attempt from its DERIVED tier. `ResolvedAgent.fundingTier` is set only for a cloud BYO override, so a self-hosted platform primary metered `null` while its own fallback metered `platform`. |
| 2026-09-05 | `327a7413a` **(8)** the chain walk respects the ACTIVITY BUDGET: `_text_fallback` gains `chain_candidates` + `ActivityBudget`, and `core.agent` returns DEGRADED (`text_budget_exhausted`) rather than raising — a raise is what makes Temporal re-run from the primary and re-bill. |
| 2026-09-05 | `8bfc8bb69` **(1b, BLOCKER)** the DURABLE workflow falls back along the resolved chain: the worker policy route composes `textFallback`, `HarnessPolicy.text_fallback` carries it raw, the workflow snapshots it into `GenerateInput.text_fallback` (defaulted ⇒ replay-safe), and `generate` walks it with the SAME walker. PHI egress is re-screened per candidate; a fallback takes its own idempotency-key suffix; an exhausted budget fails NON-retryably. |
| 2026-09-05 | `7f1ad7974` **(4, MAJOR)** the DEPARTMENT tier is reachable: the three seam methods take `departmentId`, and `SummaryService` passes the consultation's on both finalize paths. |
| 2026-09-05 | `fd8206d53` **(6, MAJOR)** a 15 s, `tenantId`-leading spec cache with single-flight on `TextAgentResolverService.resolve` (the live lane resolved ~10 round trips per flush, at four call sites). TTL-only — see "Left for others". |
| 2026-09-05 | `e0c1ad100` **(5, MAJOR)** the prompt test bench resolves through the assigned agent instead of the retired `text.test` `AiTaskDefault` key; the now-dead `IAiTaskDefaultService` injection goes with it. |
| 2026-09-05 | `a79e60576` **(10)** chain identity is the ENDPOINT (provider + model + the credential that reaches it), not the agent row — a twin agent no longer retries the dead endpoint. |
| 2026-09-05 | `c270ef2dc` **(7)** `switchAfterConsecutiveFailures` removed from the TEXT_GENERATION block (schema, spec type, Python model, tests). Both text lanes are per-call; it stays on SPEECH_TO_TEXT, whose session manager counts. |
| 2026-09-05 | `49d921837` **(12, 13)** the resolved candidate's own `providerOverride` is authoritative for its request (the shared enrichment no longer recomputes it from the CLS tenant and re-funds a platform-served call as BYOK); `selection_source: 'task-default'` → `'assigned-agent'`. |
| 2026-09-05 | `42385cb21` **(9)** the publish clamp honours a pinned `agentRef.versionNumber` via `AgentRepository.findPublishedVisibleBySlugVersion`, and labels the finding with it. |
