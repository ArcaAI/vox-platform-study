# TASK-870 — Configuration Governance Program

| | |
|---|---|
| **Status** | In Progress |
| **Type** | refactor / feature (program) |
| **Branch** | `dev-2.2` (all lanes merge here) |
| **Base** | `c364bb8ec` |
| **Owner decisions** | 10 answers + 4 follow-up directions, recorded in the review artifact and restated below |
| **Review record** | https://claude.ai/code/artifact/d0acc802-b6da-47f2-b83f-0b4b3ff7e541 |

## Requirement Analysis

A two-day review of all 341 settings-registry descriptors, run after the audio-pipeline
retirement (TASK-861/865) and the AI-consolidation program (TASK-859..864), established for
every key whether it is read, whether changing it does anything, and — against the owner's
target model — where it belongs. The owner then answered every open decision. This program
executes the result.

**The target model, as decided (2026-09-05):**

1. BYO keys — a tenant admin provides them; each affects only that tenant.
2. Built-in providers (LM Studio, Ollama, NLP, TTS, vLLM) — the platform admin manages them.
3. Capabilities are agents and workflows, cloned from SYSTEM templates or any existing agent.
   Global (`50000000-…`) is the platform's build-and-test tenant; SYSTEM (`00000000-…`) is the
   template every customer tenant refers to and the tenant template for new tenants. A
   multi-tenant admin syncs among his own tenants; tenant admins import/export JSON.
4. Fallback is a platform HA capability: every agent falls back to the platform default
   provider on outage, by default, metered as platform-funded. The toggle is per agent node.
5. Guardrail is built-in and platform-only. It gates every text-generation request before send
   and every response after receive, for built-in and BYO providers alike. No tenant admin
   manages any guardrail setting.
6. Settings exist for platform admins to control platform behaviour. No tenant-managed
   conditions (department, visit type); developers branch in workflows; tenant admins align
   agents by key:value tags. Admins overwrite an agent's hyperparameters and instruction by
   injected context or hard-coded node values, not by settings.
7. Priorities: transcription, text generation, NLP, and safety against jailbreak/injection
   first; harness policy later. Redundant settings from the old architecture are removed
   completely, not dual-homed.

**Outcome the program lands:** 341 → 208 registry keys; tenant-scoped keys 59 → 6 (the five
clamped security floors plus the platform-written credential ceiling); the old text-selection,
ASR-pipeline, pipeline-policy and tenant-guardrail surfaces removed; nine capability gaps
closed. Per-key decisions, prerequisites and the removal list are in the review artifact.

## Current State Evaluation

Verified facts the lanes build on (file:line references point at `c364bb8ec`):

- `_apply_guardrail_gate` (`apps/text/src/text/api/endpoints/generate.py:149`) is the only
  moderation gate in `apps/text` and runs once, on the request (`:435`). Both `stream.py`
  routes are `GET` replay endpoints over a generation only `POST /generate` can start, so
  input is gated on every path and output on none.
- STT streaming attributed a whole session to ONE engine — and, as TASK-874 established, to
  whichever engine was loaded LAST (`_session_asr_formats`), not the primary as first recorded
  here. A BYO session that failed over billed every minute as platform `CLOUD`; one that switched
  back hid the platform's fallback minutes inside `BYOK`. Both directions mis-billed. Separately,
  `asr-agent-resolver.service.ts:169-178` resolved one `fundingTier` per session first-wins — a
  latent trap with no consumer yet. TASK-874 replaced both with per-engine usage segments
  anchored to the session totals (`Σ segments == audio_seconds`), additive on the wire and
  backward-compatible in both directions.
- `AiRoutingPolicyRepository.findCandidates` (`:93-100`) hard-filters `resourceStatus: ENABLED`
  + `enabled: true`; `resolveDefault` (`ai-routing-policy.service.ts:176-179`) widens to SYSTEM
  on an empty tenant tier. Guardrail (`tenant_config.py:198,517`) treats DISABLED as a veto.
- `svc:admin:*` scopes are renamespaced from `apikey-scopes.registry.ts`; the seed test at
  `service-account-seed.test.ts:113` asserts `tenant-storage:manage → manage:Tenant` while
  30 routes across 8 controllers require a different subject.
- 46 descriptors are dead with no prerequisite (list: `REMOVE-DEAD`/`REMOVE-FALLBACK` rows with
  an empty `prerequisite` in the review's reconciled decisions). No seed writes any of them;
  no live DB row holds any of them.
- `apps/text` had the `pythonpath` half of the worktree guard but not the `conftest.py`
  `assert_source_tree` half (rule 14 §4); TASK-871 added it (and found two more packages —
  `hope_otel`, `hope_async_contract` — resolving from the primary checkout until it did).

### Corrections established during wave 1

- **`text.serviceToken` and `tts.serviceToken` are NOT dead.** The review traced only the
  Python side, where each service's `config.py` retired them; the gateway still fetches both
  through `SecretsService` (`TEXT_SERVICE_TOKEN` at `base-proxy.controller.ts:68` and as the
  fallback after `INTERNAL_ACCESS_TOKEN` in `text-proxy`/`text-compat`; `TTS_SERVICE_TOKEN`
  at four `apps/api` sites). `vault-seed-secrets.sh` derives its key list from the
  descriptors, so removing one silently breaks a Vault deployment. Both KEPT by TASK-872;
  retiring the gateway readers in favour of the shared `internal.accessToken` is `apps/api`
  work for a later wave. `nlp.serviceToken` was genuinely dead and is removed.
- **The three `stt.streaming.{batchWaitMs,embeddingDevice,multiGpuStrategy}` descriptors are
  removed, but their override branches at `apps/stt/src/stt/streaming/execution_profile.py:377-387`
  survive as dead code** (the fields can now only hold their code default). Behaviour is
  unchanged — those values never reached a consumer — but the branches belong to the wave-2
  ASR lane that owns `apps/stt/streaming`.
- **The five dead `models.*` task keys keep their `AI_TASK_KEYS` entries and seed rows**; only
  the descriptors went (via a documented `UNCATALOGUED_TASK_KEYS` list). They are an OpenAPI
  enum, a console catalogue, seed elections pinned by tests, and three recorded open owner
  decisions — retiring them is the `models.*` family retirement in wave 2, with the
  five-artifact regeneration.
- **A behaviour change on fresh local setups, correct per the 2026-08-22 owner decision:**
  removing `entitlements.enabledDefault` drops `ENTITLEMENTS_ENABLED_DEFAULT=false` from the
  generated `.env.sample`, which `pnpm setup:dev` copies into `.env.dev`. That committed sample
  had been forcing quota enforcement OFF on every new laptop against the decision that local
  dev runs ON. Existing `.env.dev` files are untouched.
- Registry size after wave 1 is **286**, not the 287 the plan implied: TASK-872 removed 55 —
  the 46 with no prerequisite, the five dead `models.*`, the three judge keys that went with
  `guardrail-policy.descriptors.ts`, and `nlp.serviceToken` — while keeping the two live
  service tokens.

## Implementation Plan

Waves. A wave's lanes run in parallel in separate worktrees with disjoint file ownership; the
next wave starts only after the previous one is merged into `dev-2.2` and its gates re-run.

### Wave 1 — safety gate, fast wins, dead removal, metering

| Lane | Ticket | Scope | Owns (exclusive) | Tier |
|---|---|---|---|---|
| A | TASK-871 | Post-receive guardrail gate | `apps/text/**` | fable |
| B | TASK-872 | Registry cleanup + routing-policy veto: flip `globalOnly` on 5 keys; align `resolveDefault` to the three-state rule; remove the 46 dead descriptors and the dead plumbing beside them; amend `forcePathStyle` `consumedBy`; re-anchor the tighten-only floor tests | `packages/applications/src/services/settings-registry/**`, `.../ai-routing-policy/**`, `.../effective-config/**`, `packages/domains/src/repositories/generated/core/AiRoutingPolicyRepository.ts`, `packages/database/src/prisma/db_main/seed/16-ai-routing-policy.ts`, `apps/guardrail/src/guardrail/core/effective_config.py`, `apps/{harness,tts}/**/test_effective_config_retention.py` | opus |
| C | TASK-873 | Service-account scope alignment (widen `implies`), delete the two orphaned admin-console feature folders, regenerate the five API artifacts | `packages/applications/src/services/apiKey/**`, `.../serviceAccount/**`, `packages/database/src/prisma/db_main/seed/__tests__/service-account-seed.test.ts`, `apps/admin-console/src/features/audio-pipelines/**`, `.../features/pipeline-policy/**` (+ referencing tests/nav lines), `apps/api/route-manifest.json`, `apps/api/openapi.json`, the `api:portal` output, `packages/vox-node/src/resources/admin/**` | opus |
| D | TASK-874 | STT fallback funding on engine switch | `packages/applications/src/services/stt/**`, `apps/stt/src/stt/streaming/**`, `apps/stt/src/stt/core/api_client/**`, their tests | opus |

Deliberately NOT in wave 1 (shared surfaces the orchestrator serialises, or wave-2 prerequisites):
Prisma schema changes (`AiTaskDefault` table drop, `TenantFrontendConfig` client-AI columns,
display-only `PlanEntitlement` columns); `nlp.logging.*` removal (needs the deployment repo
confirmed for stdout logging); `apps/stt/src/stt/pipeline/spec.py` (wave 2 ASR wiring).

### Wave 2 — agent-first text, ASR spec wiring, guardrail outbound (base: wave-1 close commit)

| Lane | Ticket | Scope | Owns (exclusive) | Tier |
|---|---|---|---|---|
| A | TASK-876 | Agent-first text on both lanes: TEXT_GENERATION `fallback` block and SPEECH_TO_TEXT `decoding.{chunkLengthSec,strideLengthSec}` in the agent schema; a runtime reader for `AgentModelFallback` on TEXT_GENERATION; realtime `CoreAgentHandler` resolves `agentRef`, else the assigned agent; `resolveTextSelection` precedence 1 → the assigned TEXT_GENERATION agent; both lanes fall back to the SYSTEM-assigned agent on primary failure, honouring the per-agent-node toggle, funding derived per row | `packages/workflow-contract/src/agent-schemas.ts`, `packages/applications/src/services/{agent,agent-assignment,harness-policy,consultation/live-documentation}/**`, `apps/harness/src/harness/temporal/nodes/**`, `apps/harness/src/harness/temporal/_llm_policy.py`, their tests | fable |
| B | TASK-877 | ASR spec wiring: map `streaming.{partialIntervalMs,endpointing,maxUtteranceSec}`, `decoding.vadFilter` and the two chunking fields (declared optional on the Python wire) in `pipeline_spec_from_resolved`; an end-of-utterance model role; `build-resolved-asr-spec.ts` maps the new agent parameters; then delete the eight platform duplicates (`stt.streaming.partialIntervalS`, `stt.semanticEndpoint.*`), the dead override branches at `execution_profile.py:377-387`, and turn the punctuation boot gate into a lazy per-spec load | `apps/stt/src/stt/{pipeline,streaming,punctuation}/**`, `apps/stt/src/stt/core/control_plane.py`, `apps/stt/tests/**`, `packages/types/src/asr-spec.ts`, `tests/contracts/resolved-asr-spec.fixture.json`, `packages/applications/src/services/stt/agent-resolver/**`, `packages/applications/src/services/settings-registry/descriptors/stt-runtime.descriptors.ts` + its test | opus |
| C | TASK-878 | Guardrail outbound gaps from TASK-871: `jailbreak_detection` in `OUTBOUND_TASKS`, `usage_detail` on `ScreenResponse`, the containment-echo nonce; judge `temperature`/`maxTokens` from `config.py:32-33` literals to `AiModel._metadata.policy` (seeded on the guardian rows, resolved via `policy.py`); a new `guardrail.judge.timeoutSeconds` descriptor on the pull route replacing `config.py:34` | `apps/guardrail/**`, `apps/text/src/text/services/{external_guardrail,output_gate}.py` + tests, a new `descriptors/guardrail-judge.descriptors.ts` + its `registry.ts` spread + test, `packages/database/src/prisma/db_main/seed/06-ai-models.ts` + seed tests | opus |

Orchestrator-owned in wave 2 (shared surfaces, serialised after the lanes): the Prisma drops
(`AiTaskDefault` table + trio + `CoreDatabaseModule` registration; the five `TenantFrontendConfig`
client-AI columns; the three display-only `PlanEntitlement` columns; the per-tenant guardrail
availability column) — the Prisma CLI refuses a Claude-invoked migration, so these go through
the `prisma-local` MCP or the owner; `nlp.logging.*` removal once the deployment repo confirms
stdout logging; post-merge artifact regeneration; the e2e matrix at close.

Disjointness: A owns the agent schema file and B only reads its shape (`build-resolved-asr-spec`
maps `parameters` it receives, testable with fixtures); B owns `stt-runtime.descriptors.ts`
and does not touch `registry.ts`, which C edits for one spread line; C's two `apps/text`
files are the guardrail client and the output gate, which A never touches. Every worktree is
pre-built by the orchestrator (`pnpm install`, `pnpm db:generate`, `turbo run build`) before
its agent starts — both C and D in wave 1 lost time discovering an empty `dist/`.

### Wave 3 — resolution capabilities and governance

Tag-based agent alignment; agent clone; TEXT_TO_SPEECH agent resolution on the speech path;
per-tenant guardrail availability; provider/routing/metadata moves (27 keys); promotion gate
relaxation; agent/workflow JSON import/export; `pipeline.*` repoints; harness moves; retention
consolidation.

### Rules every lane follows

- TDD: failing test first, evidence pasted (rule 01). Python lanes run under `arcaenv` from the
  worktree; lane A adds the `assert_source_tree` guard to `apps/text` conftest before trusting
  a result.
- No `git stash`, no `pnpm install`, no `db:*`, no Docker, no merges, no artifact regeneration
  except lane C (rule 14 §3). No touching files outside the lane's ownership column.
- Each lane keeps its own `docs/implementation/TASK-87N-*/README.md` through the lifecycle.
- Merge target is `dev-2.2`, merged by the orchestrator from the primary checkout, gates re-run
  after merge, worktree removed only after the merge commit exists (rule 14 §5).

## Implementation Summary

### Wave 1 (in progress)

| Lane | Ticket | Merge commit | Post-merge gates (primary checkout) | Worktree |
|---|---|---|---|---|
| A | TASK-871 — post-receive guardrail gate | `9a8e2af0b` | `pnpm text:test` 1614 passed / 4 skipped (1587 baseline + 27 new); `pnpm text:typecheck` clean | removed |
| C | TASK-873 — scope alignment, dead console folders, artifacts | `76686c60d` | applications 660 files / 11514 tests passed (a first run showed 13 files failing to load — a concurrent `api:build` rewriting `dist/`; clean re-run green); database 1767 passed; `api:build` clean; `api:openapi:check`, `api:portal:check`, `gen:admin:check` all no-drift; admin-console build + lint clean, 2269 tests; vox-node typecheck clean, 375 tests | removed |
| B | TASK-872 — registry cleanup (341 → 286) + six `globalOnly` flips + routing-policy veto | `94a311e4d` | applications 659 files / 11519 tests; domains 161 files / 1919; database 79 / 1767; api 280 / 4211; applications lint 0 errors; repo lint 39/39; all three drift checks no-drift; `stt:test` 1 failed / 3181 passed (the pre-existing MinIO env test); `tts:test` 459; `guardrail:test` 426; `harness:test` 6 failed / 2091 and `nlp:test` 2 failed / 583 — both sets pre-existing: the merged wave-1 diff under `apps/harness/` is `.env.sample` plus one retention test fixture, and touches nothing under `apps/nlp/`, `apps/harness/src/harness/temporal/` or the replay fixtures. First agent stalled on the harness watchdog after three commits; a continuation resumed on that tree and finished (ten commits total). | removed |
| D | TASK-874 — STT fallback funding per engine segment | `f8f7835a1` | `pnpm stt:test` 1 failed / 3193 passed / 210 errors — identical to the lane's baseline (the failure is the pre-existing `test_minio_credentials_default_to_empty`; the errors are integration tests with no test DB); `stt:lint` clean; `stt:typecheck` clean (140 files); applications 660 files / 11521 tests (+7 = the lane's new TS cases); api 280 files / 4211 tests; artifacts regenerated with zero diff (the usage callback is a doc-excluded internal route, so the DTO change never reached `openapi.json`); all three drift checks no-drift; vox-node typecheck clean, 375 tests | removed |

Lane A chose design (d): gate the assembled completion at end-of-stream for SSE (published tokens
cannot be recalled; buffering would kill time-to-first-token) and buffer-then-gate on the
non-streaming path; rejection is a terminal `error` frame every existing consumer discards on,
the task is `FAILED`, nothing persists. It also released the provider concurrency permit before
the gate (a guardrail outage would otherwise pin a slot per request). Guardrail's outbound screen
exists (`POST /api/v1/guardrail/screen/outbound`) but lacks `jailbreak_detection`, a
`usage_detail`, and a nonce — owed to a guardrail lane in wave 2.

Lane C evaluated per `(route, declared scope)` — `enforceServiceAccountScopes` is
`required.some(...)` — and found 31 mismatches over 9 controllers (one more than the audit's
union view). Two routes were narrowed rather than over-granting: `GlobalSettingController`
reveal/rotate now `@ForbidServiceAccount()` (they re-authenticate the caller's own password, so a
machine could never have executed them); `PromptManagementController.assignDepartment` narrowed
`manage:Department` → `update:Department`. A per-scope regression guard
(`svc-scope-route-ability-coverage.test.ts`, 436 cases) now walks the manifest. Both orphaned
console folders deleted (no live import). Lane C ran `pnpm db:generate` once in its worktree —
pure codegen, no DB contacted — and disclosed it.

**Wave-1 close-out — e2e route-authz matrix: GREEN.** `task-776-route-authz-matrix.spec.ts`
ran against `dev-2.2` at `6123ffbb1` (all four lanes plus the owner's TASK-869 merge) on the
existing seeded test DB with `RESET_DB=false` — no wave-1 lane changed a seed file, and the
Prisma CLI refuses a Claude-invoked `db push --force-reset` by design — after the owner stopped
the TASK-869 watch-mode API that held 8968: **7 passed (2.1 s)**, API healthy after 90 s.
Containers left up.

**TASK-869 merge verified non-reverting.** Of the 129 files wave 1 changed, 869's merge later
touched three: `.env.sample` and `turbo.json` (both additive — two new `SEED_*` variables) and
this README (no change on 869's side; the overlap was this file's own later commit). All six
paths wave 1 deleted remain absent; the veto (`task-selection-veto`), the output gate
(`screen_output`), the usage segments (`usage_segments`) and the scope guard test are present
at HEAD.

**Wave 1 status: COMPLETE.** Registry 341 → 286 (executed). Four lanes merged, gated post-merge
in the primary checkout, worktrees removed, branches deleted.

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Program opened; wave 1 partitioned into TASK-871..874 off `c364bb8ec`. |
| 2026-09-05 | Lane A (TASK-871) merged at `9a8e2af0b`; lane C (TASK-873) merged at `76686c60d`; both post-merge gates green; worktrees removed. E2E authz matrix deferred to close-out. |
| 2026-09-05 | Lane D (TASK-874) merged at `f8f7835a1`; STT billing defect direction corrected (last-loaded engine, both directions wrong). Lane B (TASK-872) merged at `94a311e4d` after a watchdog stall and continuation; registry 341 → 286; two service tokens kept (gateway still reads them). |
| 2026-09-05 | Owner merged TASK-869 (`6123ffbb1`) on top; verified non-reverting. E2E route-authz matrix green (7 passed) on the merged tree. **Wave 1 complete.** |
