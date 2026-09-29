# TASK-1012 — Legacy residue sweep: nothing left of v1-compat / pre-agent selection

**Status:** In Progress (D-1..D-6 approved 2026-09-29; lanes W-1..W-5 running)
**Type:** refactor (+ one security-relevant fix, + one SDK bugfix)
**Branch:** `dev-2.2`
**Related:** TASK-1004 (v1-compat removal), TASK-1006 (pipeline removal, SDK 4.0.0), TASK-1010, TASK-1011

## Requirement Analysis

Owner (2026-09-29): *"v1-compat already deprecated, make sure nothing left, we are using agent/workflow
architecture!"* Goal: no v1-compat code, no pre-agent selection path (pipeline id, model/engine/provider
picked by a caller instead of an Agent / WorkflowDefinition) on any runtime surface, and no doc that
describes either as current. Removal gate tests (TASK-1004/1006 "assert absent") stay.

## Current State Evaluation — audit 2026-09-29 (read-only, both repos; key items re-verified by the orchestrator)

Clean: OpenAPI + `route-manifest.json` (738 routes) carry no `api/smr`, `api/stt`, `start_session`,
`audio/pipelines`, `stt-config`; env samples, `turbo.json`, CI yaml, compose, lockfiles clean. ~17 gate
test files + ~15 inline "absent" assertions pin the removals (keep). `apps/smr/` (59 ignored `.pyc`, no
source) deleted locally 2026-09-29.

### Live — fix first
| # | Where | Finding |
|---|---|---|
| L-1 | `apps/api/src/modules/speech/speech-proxy.controller.ts:36-66,128-147` | `applyAgentSpec` returns the body untouched when the resolver or tenant is missing, so caller-supplied `provider_overrides` / `resolved_spec` pass through to STT — a bypass of agent resolution. Strip both keys unconditionally. |
| L-2 | `packages/agentic-sdk-v2` `hooks/useArca.ts:954,1000`, `useArcaSummary.ts:85,117`, `core/KnowledgePipeline.ts:434`, `core/constants.ts:189-190` | **Verified:** SDK 4.0.0 `generateSummary` / `generatePreSummary` POST `/consultations/:id/summary` and `/summary/pre-summary`; the gateway only has `GET …/summary` and the `/async` variants → these hooks 404 in the published SDK. |
| L-3 | `apps/api/.../text-proxy.controller.ts:89-93,400,727,1172-1190` | `POST text-generations/generate[/assembled]` accepts caller `provider` + `model` (unvalidated interface); agent path only when `model` absent. Used by admin `playground-llm`. |
| L-4 | `apps/api/.../ai-inference/dto/extract-entities.request.ts:28-40` | `POST text-analyses/entities` accepts a `modelName` override. |
| L-5 | `packages/stt` `StreamingBackendSTTProvider.ts:38-41,364,383`, `STTProcessor.ts:57,571`, `types/index.ts:358` | **Verified:** `pipelineId` still an (deprecated) input and forwarded on session create; gateway 400s it. |
| L-6 | `packages/applications/.../update-user-preferences.request.ts:6-52,100` | `PATCH users/me/preferences` accepts `localConfig.{noiseCancellation,stt,vad,ner}.modelId` (client-AI model ids; no consumer). In OpenAPI. |
| L-7 | `transcription-job.controller.ts:511-541`, `create-job.request.ts:30-37,83,88-101,143,148-161` | Public DTOs accept client `agentVersionId` / `resolvedSpec` (never executed) and `codeSwitching` (ignored). |
| L-8 | `agent-draft-test.service.ts:195`, `prompt-management.service.ts:1699` | Return `streamUrl: text/tasks/…`, served only by a 308 shim. |
| L-9 (**false positive**) | deployment repo `base/stt.yaml:288-296,577,611`, `stt-worker.yaml:230-234,428,462` | **Verified:** STT `DATABASE_URL/POOL_SIZE/MAX_OVERFLOW` + 5432 egress still on `main`; the fix `b233fef` (+ docs `30ef262`) sits on unmerged `task-1006/docs-deploy`, which ALSO carries an old `promote(dev)` commit — cherry-pick the two, never merge the branch. |

### Dead code
Gateway: 10 `*-redirect.shim.controller.ts` marked "DELETE IN ALL-2.0.0", still mounted (after L-8);
`workflow-contract/agentic-contract.ts:423-425` `pipelineRef` validator; seed `11-global-setting.ts`
`default-stt-model` / `local-{asr,vad,noise-suppression}-models` (served by `GET tenants/me/config`, parsed
by SDK `parseTenantConfig`). SDK: `AgenticProvider` `remoteConfig.pipelineId/agentSlug` injection,
browser `ModelRegistry` + whisper/silero defaults + `selectModel`/`selectSttTask`/`localAsrModels`,
`NLP_ENDPOINTS`, `packages/utils/transformers-cache.ts`, vox-node empty `PREFIX_EXEMPT_PATHS`. Python:
`apps/stt/src/stt/pipeline/yaml_parser.py` (791 lines) + pipeline exceptions/constants (tests only);
`apps/text` `_HARDCODED_DEFAULT_PROVIDER`. Kept deliberately until drained: STT Dramatiq dead slots, harness
`smr_provider` Temporal alias. Console: `pipelineId` types, `workflowMode`/`transcriptionMode` vestiges,
`AsrPipeline` audit filter (probably keep for historical rows). `vitest.config.ts:116,118` coverage globs
for deleted packages. Deployment: `observability-config.yaml:115` `hope.pipeline_id` span allow-list.

### Stale docs (describe removed things as current)
SDK docs (`Compat-API-Reference.md`, `Batch-Transcription-Reference.md`, `API-Reference.md`, READMEs),
vox-node README (49 vs 48 areas, `summarization.ts`), `.claude/rules/08-vox-sdk.md:214`,
`00-project-context.md:29`, `.cursor/rules/08,05`, `docs/development-guide.md:178` (`pnpm compat:dev`),
`docs/architecture/*` + `docs/traceability/*` (~15 spots), `apps/api/docs/*`, `infrastructure/docker/*STT-ORCHESTRA*`,
deployment-repo docs (`apps/smr` paths, `smr_*` metrics, compat-playground), ~15 code comments citing
`AiTaskDefault` / `text-compat` as current. Full path list: audit output, kept in the orchestrator session.

## Owner decisions (all APPROVED as recommended, 2026-09-29)
| # | Question | Recommendation |
|---|---|---|
| D-1 | L-3 raw `provider`/`model` on `text-generations/generate` | Business plane: `agentSlug` only. Raw pinning moves behind the admin plane (super-admin playground) or the playground uses a Global playground agent |
| D-2 | L-4 `modelName` on `text-analyses/entities` | Drop it; selection = NER agent / `nlp.ner` routing policy only |
| D-3 | Redirect shims (10) | Delete after L-8, once gateway logs show no hits for the shim prefixes in the last 7 days |
| D-4 | SDK: L-2 is a live bug; removing dead exports is semver-major | 4.0.1 patch now (summary hooks → `/async`, drop `pipelineId` forwarding which already 400s); mark dead exports `@deprecated`; remove them + `parseTenantConfig` legacy fields in 5.0.0 with the seed retirement |
| D-5 | `core.classify` names a registry `modelSlug`, not an agent | Keep for now (workflow node config, platform-owned); convert to an agent reference in its own ticket |
| D-6 | L-9 deployment change restarts STT pods on sync | Cherry-pick `b233fef` + `30ef262` onto deployment `main` now (dev only; STT no longer reads them) |

## Verification before the lanes (orchestrator, 2026-09-29)

- **L-9 is a false positive.** The audit read the deployment primary checkout's stale LOCAL `main`
  (`ada789e`). `b233fef` and `30ef262` are both ancestors of `origin/main` (`67e41e2`); a cherry-pick
  onto `origin/main` was empty. D-6 needs no change.
- **D-3 precondition met.** Loki, `{app="hope-api"}` "Request completed" lines, 28 × 6 h windows
  2026-09-22T13:22Z → 2026-09-29T13:22Z (30-day retention, no window failed): **0 hits** on every shim
  prefix (`usage`, `ai/`, `billing`, `tenant/me/context-schema`, `entitlements`, `rbac/check`, `text/`,
  `tenant`, `voice-profile`); a control query on `health/` matched, so the filter works. The 9 shims
  are deleted (W-1, as its own commit).

## Implementation Plan (lanes, 2026-09-29)

| Lane | Branch | Owns |
|---|---|---|
| W-1 (opus) | `task-1012/w1-gateway` | L-1, L-3 (D-1: business route refuses `provider`/`model` 400 `MODEL_PINNING_NOT_ALLOWED`; admin-plane playground route, super-admin + AUTH-NOTE; console playground-llm switched), L-4, L-6, L-7, L-8, shims (D-3), workflow-contract validator, stale comments in `apps/api` + `packages/applications`, five artifacts. Fields a published SDK may still send → accepted-and-ignored `@deprecated` until 5.0.0; fields that bypass agent resolution → refused/stripped |
| W-2 (opus) | `task-1012/w2-sdks` | L-2, L-5, SDK side of the W-1 contract, dead exports `@deprecated`, vox-node cleanups, SDK docs, a `patch` changeset (4.0.1). No publish — the local release is a separate owner-confirmed step |
| W-3 (sonnet) | `task-1012/w3-python` | stt YAML pipeline stack + tests, text hardcoded provider (fail closed if every caller supplies one), stale comments |
| W-4 (sonnet) | `task-1012/w4-docs` | rules (`.claude`, `.cursor`), docs, generator comments, seed comments, `vitest.config` globs, console vestiges |
| W-5 (sonnet) | deployment `task-1012/deploy-docs` (from `origin/main`) | deployment docs (`smr_*` → `text_*`, compat-playground, `pipelineId`), `hope.pipeline_id` span allow-list if nothing emits it |

### Original draft (superseded by the table above)
1. W-1 gateway + applications: L-1, L-3/L-4 per D-1/D-2, L-6, L-7, L-8, then shims (D-3), workflow-contract validator; regenerate the five API artifacts.
2. W-2 SDKs: L-2, L-5, dead-export deprecations, vox-node cleanups, SDK docs; local release per the runbook (owner rule).
3. W-3 Python: stt `yaml_parser` + exceptions/constants + their tests; text hardcoded provider.
4. W-4 docs/rules/console vestiges/`vitest.config` globs.
5. Orchestrator: deployment-repo cherry-pick (D-6) + deployment docs.
TDD: each removal of a live path gets an "absent/refused" test first (e.g. speech proxy strips caller `resolved_spec` even with no tenant).

## Implementation Summary
_Not started._

## Change History
- 2026-09-29 — D-1..D-6 approved; L-9 found to be a false positive; shim traffic check 0 hits / 7 d; lanes W-1..W-5 started from `df9eed44f` (deployment lane from `origin/main` `67e41e2`).
- 2026-09-29 — Ticket opened from the owner's "nothing left of v1-compat" directive; audit findings recorded; `apps/smr/` leftover (ignored `.pyc` only) deleted locally.
