# TASK-946 — Live-consultation trial fixes: ASR decode regression, durable routing, template freeze, terminal state

**Status:** In Progress
**Type:** bugfix
**Opened:** 2026-09-10
**Found by:** review of the three parallel service-account trials of 2026-09-10 (sessions `077eee2e`, `4c052799`, `52c28efc`; review artifact `https://claude.ai/code/artifact/6926f422-2cd1-423d-8f26-55fb064fbe03`)
**Branch:** target `dev-2.2`; one worktree per lane, branched from `dev-2.2` at the commit that carries this README
**Related:** TASK-934/935/937/938 (STT decode configuration), TASK-939/943 (live lane, trigger context), TASK-933 (H3-2, H3-6), TASK-864 (`core.condition`, run completion), TASK-932 (visit-type split)
**Rules:** `00`, `01`, `03`, `04`, `05`, `06`, `08`, `14`

## 1. Requirement Analysis

Three agents drove the owner's recording (`~/Downloads/consultation.mp3`, 797.9 s) through three
ArcaAI department workflows at the same time. Every case note came back empty. The review
re-derived every finding from the logs, the Temporal histories and two controlled experiments.

### 1.1 The transcript failure is a configuration regression

Commit `e3d61eefb` (2026-09-09 22:37, "the owner's ASR decode configuration") re-added the 20
`decoding.hotwords` to the whisper.cpp `initial_prompt` and switched both priming prompts on.
Offline A/B on the served f16 GGUF, 60–120 s of the recording, production 7 s spans, `language=en`:

| Arm | Letters | Latin |
|---|---|---|
| No prompt | 648 | 100 % |
| Agent `initialPrompt` only | 623 | 100 % |
| Single-language priming prompt only | 371 | 100 % (43 % of content lost, prompt echoed) |
| Priming + agent `initialPrompt` | 151 | 99 % |
| Hotwords only | 416 | 80 % ("carcinoid" ×30) |
| **Priming + agent + hotwords (production)** | 248 | **2 %** |
| Production + word timestamps | 248 | 2 % |

A single session on a quiet box (RTF 0.1) reproduced the production output. Contention slowed
decodes 5–30× but did not cause the script collapse. The carry-forward (`_previous_text`, 50
words, fed from partials) makes the collapse self-sustaining. TASK-935 removed this exact append for
this exact failure; `whisper_cpp_asr.py` still names it "the first knob to drop".

### 1.2 Defects that survive a perfect transcript

| # | Defect | Mechanism |
|---|---|---|
| D1 | Durable-lane visit routing never evaluates (`n_visit` → `else` in all 11 ArcaAI graphs) | Seeded CEL reads `trigger.context.visit_type`; the realtime lane publishes `{ trigger: { context } }` (TASK-943); the durable `_run_context` (`interpreter/workflow.py:853`) publishes the flattened context, and the dispatch subject + `resolveHandoffContext` carry only ids and `dna_style_*` |
| D2 | A revisit is documented with the new-visit note shape | `realtimeDocumentTemplateSlug` (`realtime-lane.ts:407`) is first-match; the freeze at session start never consults the visit branch though `session.visitType` and the lane's `branchGuards` are there |
| D3 | A failed finalization has no terminal state | degraded `n_finalize` → `ReviewGate` on `payload: {}` → 3,600 s timeout → `n_output` schema failure → Temporal FAILED; `WorkflowRunCompletionService.watch` is attached only by the workflows controller, never by `ConsultationWorkflowDispatchService`; no consultation transition exists for a failed run; the sweep closes it after 1,440 min |
| D4 | The live running-note prompt never resolves to the department agent's template | `promptBearingNodesForTask` requires `promptTemplateId` ON THE NODE; ArcaAI graphs are `core.agent` + `agentRef` (template on the agent) so tier 1a never matches; telemetry still says `selection_source: agent` |
| D5 | A context overflow is retried three times and reported as 502 | `generate.py:668`: every non-timeout exception is `provider_error`, which is in the default `retry_on` |
| D6 | Degrade reasons leak transport strings; a failed flush is not counted as failed | `degradeReason()` returns `error.name`; the stats line carries `turnDegraded` (contract fallback) but no failure field |
| D7 | `RealtimeSttSocket.stop()` says the session stays open; the gateway maps `stop` → STT `finalize`, which closes it | `stt-ws.gateway.ts:1178` |
| D8 | A service account cannot read back what it wrote | 20 consultation GET routes carry `svcScopes: []` |
| D9 | The ring-buffer overflow log reads as data loss | `Session.ring_buffer` is a write-only 30 s diagnostic window; nothing decodes from it |

Environment (not code): `gemma-4-e2b-it-qat` loaded at 8,192 of 131,072 tokens while the seeded
ArcaAI prompts alone are 3.3–4.9k tokens plus 2–3k reserved; the judge lane's two permits turn
three concurrent consultations into a 503 cascade.

## 2. Current State Evaluation

- Every consultation stopped on 2026-09-10, including the six single-session TASK-939 replays, sits
  at `DRAINING` with its `WorkflowRun` row `RUNNING` and `failedNodeCount 0`; the interpreter
  workflows closed as FAILED exactly one hour after each stop.
- TASK-939 §6.4/6.6 and TASK-943 record "proven end to end" on this configuration; neither quotes
  a transcript. Their one extracted sentence ("complaint related to cancer") matches the hotword
  hallucination vocabulary.
- `stop()` in `LiveDocumentationService` already force-drains the flush loop, so TASK-933 H3-2 is
  mitigated on this branch; it is not in scope here.
- `ContextItem` bodies are encrypted at rest; the STT log is the only place a transcript can be read.

## 3. Decisions taken (owner may override)

The owner's "go ahead" came after the review, which recommended each of these. Every one is
reversible; an override is recorded in §6.

| OD | Decision taken | Why |
|---|---|---|
| OD-1 | Hotwords leave the whisper.cpp prompt: TASK-937 R-4 `decoding.hotwordsInPrompt`, per model, default **OFF** for whisper.cpp. The lexicon stage keeps the same terms. | The offline A/B: 100 % → 2 % Latin from this knob alone; TASK-935 measured the same. |
| OD-2 | `WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED = False`. The PAIR prompt stays ON pending its own measured A/B on `ml-en`. | On a pinned language the single prompt is redundant, echoes itself into the output and cost 43 % of the content in isolation. The pair prompt was not measured here. |
| OD-3 | `trigger.context.*` is the canonical namespace on BOTH lanes. The durable `_run_context` nests the merged context under `trigger.context` (identity keys stay reachable for the `run_identity` readers; `_prompt_scope`'s `context` alias resolves to that nested object so `{{context.dna_style_text}}` keeps rendering). The live handoff carries `visit_type`, `current_department`, `language` beside `dna_style_*`. | The seed, TASK-943 and 11 published graphs already say `trigger.context`; the durable lane is the side to move. |
| OD-4 | A governed consultation whose run ends FAILED or TIMED_OUT transitions `DRAINING → CLOSED_INCOMPLETE` with the terminal reason on the row, and a harness-progress `failed` event reaches the caller. A review gate is never opened on an empty payload: the interpreter skips it and the run fails within seconds. | A clinician cannot sign an empty note; `CLOSED_INCOMPLETE` is the honest state and `reopen` exists. The hour on the gate is pure loss. |
| OD-5 | Tier 1a of the live prompt resolver walks the governing graph's per-turn `core.agent` node to its agent's `instruction.promptTemplateId` (approved version, node pin honoured), the same path the realtime executor uses for the model binding. | The seed binds the department agent as the per-turn summarizer by design; the generic SYSTEM prompt running under the agent's name is the wrong-prompt class the resolver exists to prevent. |
| OD-6 | Environment, by the orchestrator before verification: reload `gemma-4-e2b-it-qat` at 32,768 tokens on dev; raise the judge lane's permits on dev through the control plane. Partial-summary turns keep blocking on the judge. | Both are one-line environment changes; the platform-side budget check is a follow-up (§7). |
| OD-7 | The consultation readback routes a machine caller needs get `svc:consultation:session:read` (context, case-notes, transcriptions, named-entities, timeline, workflow) or `svc:consultation:report:read` (summary list, document sections), matching their siblings. | TASK-933 declared the plane and missed these. |

## 4. Implementation Plan — six lanes, one worktree each

Partition is by file ownership; no two lanes write the same file. The orchestrator owns the
merges, this README, `pnpm install`, the DB and the running stack.

| Lane | Tier | Worktree / branch | Owns |
|---|---|---|---|
| **S** — STT decode configuration | opus | `../hope-v2-task-946-stt` / `task-946/stt` | `apps/stt/**`, `packages/types/src/asr-model-profile.ts`, `packages/types/src/asr-spec.ts`, `packages/applications/src/services/stt/**`, `packages/applications/src/services/ai-model/asr-profile.util.ts`, `tests/contracts/resolved-asr-spec*` |
| **H** — harness interpreter | opus | `../hope-v2-task-946-harness` / `task-946/harness` | `apps/harness/**` |
| **T** — live lane | opus | `../hope-v2-task-946-live` / `task-946/live` | `packages/applications/src/services/consultation/live-documentation/**`, `.../consultation/prompt/prompt-resolution.service.ts`, `.../consultation/summary/live-pre-summary.adapter.ts` |
| **D** — run lifecycle | opus | `../hope-v2-task-946-lifecycle` / `task-946/lifecycle` | `packages/applications/src/services/workflow-run/**`, `.../consultation/workflow-dispatch/**`, `.../consultation/harness/harness-internal.service.ts` (+ module), `apps/api/src/modules/workflows/**`, `apps/api/src/modules/consultation/harness-internal.controller.ts` |
| **X** — TEXT error classification | sonnet | `../hope-v2-task-946-text` / `task-946/text` | `apps/text/**` |
| **K** — SDK contract + service-account scopes | sonnet | `../hope-v2-task-946-sdk` / `task-946/sdk` | `packages/vox-node/**`, `apps/api/src/modules/consultation/consultation.controller.ts`, the five regenerated API artifacts |

Inline, by the orchestrator after the merges: `packages/py-env` service-registration guard,
TASK-939/943 records, OD-6 environment steps, the live re-run.

### Lane S — TDD list
1. `AiModelAsrProfileDecoding.hotwordsInPrompt?: boolean` parses (absent/true/false), rejected otherwise; wire field `AsrSpecDecoding.hotwordsInPrompt` folded agent → model → absent; parity fixture + `resolved-asr-spec-parity.contract.test.ts` updated; `spec.py` mirror.
2. `whisper_cpp_asr.py`: the hotword append runs only when the resolved switch is `true`; absent/false leaves the prompt untouched (`test_task934_hotwords_prompt.py` rewritten to assert OFF by default).
3. `language_modes.py`: `WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED = False`; the independence tests set both switches explicitly.
4. `inference.py`: `_previous_text` is taken from FINALS only, and cleared when a decode pinned to a Latin-script language yields a majority non-Latin text.
5. `session_manager.py` / publisher: on a final whose script contradicts the pinned language, publish `status: degraded` with reason `script_mismatch` once per session and count a metric; the ring-buffer overflow log drops to DEBUG with a comment naming the buffer as diagnostic-only.
6. Measurement: re-run the offline A/B script (`/private/tmp/claude-501/-Users-taphuynh-Desktop-igglo-ARCAAI-hope-v2/0f78b91c-7090-49e1-aecb-9f1920acbc31/scratchpad/ab-offline.py`) — the "production" arm must now match the "no prompt" arm within 5 % Latin.

### Lane H — TDD list
1. `_run_context()` publishes `trigger.context.*`; a seeded-shape `n_visit` (`trigger.context.visit_type == 'revisit'`) routes to `revisit` when the live handoff context carries `visit_type: 'revisit'`; identity readers and `{{context.dna_style_text}}` unchanged (existing tests stay green).
2. `_run_review`: when the bound payload is empty (no keys, or every value `None`/empty) the gate is NOT started; the node returns `DEGRADED` with reason `review_skipped_empty_payload` and the run proceeds to fail at `n_output`. `test_task932_h1_review_timeout.py` gains the case.
3. `test_replay_compat` green; interpreter fixtures updated if the shape change requires it, with the reason recorded.

### Lane T — TDD list
1. `realtimeDocumentTemplateSlug(lane, branchHandles)`: with the taken handle `revisit`, the node reachable through that guard supplies the slug; unguarded lanes keep first-match. `resolveBranchHandles` exported from `realtime-executor.ts` and reused by `ensureTemplateResolved` with `realtimeRunContext(session)`.
2. `resolveHandoffContext` returns `visit_type`, `current_department`, `language` (from `realtimeRunContext`'s builder) beside `dna_style_*`.
3. `prompt-resolution.service.ts` tier 1a resolves through the per-turn `core.agent` node's agent `instruction.promptTemplateId` (OD-5), approved version, node pin honoured; the BREN new-visit graph yields template `71000000-0000-0000-0001-000000000022` at tier `agent`.
4. `live-pre-summary.adapter.ts` `degradeReason()` returns codes only: `no_case_notes`, `context_overflow`, `text_unavailable`, `timeout`, `pre_summary_failed`.
5. Flush stats and the `section.patch` envelope carry `flushFailed: boolean` and `degradeReason`.

### Lane D — TDD list
1. `ConsultationWorkflowDispatchService` attaches the completion watcher after `startWorkflowRun` through an applications-side port (`IWorkflowRunCompletionPort`) implemented by `WorkflowRunCompletionService`; `recordRunFinished` resolves the `wf-<runId>` row (H3-5 fallback) so the row reaches FAILED/COMPLETED with `endedAt`.
2. On FAILED/TIMED_OUT for a governed consultation: `DRAINING → CLOSED_INCOMPLETE` through `transitionTo` (single writer), terminal reason stamped on `_metadata`, `HarnessProgressService.reportProgress` with the failed stage; idempotent on retry; a consultation already past DRAINING is untouched.
3. Node counts on the terminal write come from the `workflow.run.completed` payload when present.

### Lane X — TDD list
1. A provider 4xx (context overflow, invalid request) classifies as `error_type: "invalid_request"`, is never retried, and answers 422 with `code: PROVIDER_INVALID_REQUEST` (or `CONTEXT_WINDOW_EXCEEDED` when the provider message says so) — sync and streaming paths.
2. Existing `test_retry_and_timeout.py` cases stay green; timeouts and 5xx keep retrying.

### Lane K — TDD list
1. `RealtimeSttSocket.finalize()` documented as "finalize and close"; `stop()` kept as a deprecated alias with the corrected doc; unit test; README/JSDoc.
2. Scopes per OD-7 on `consultation.controller.ts`; the five artifacts regenerated; `task-776-route-authz-matrix` expectations follow the manifest.

### Gates (per lane, pasted in the lane report)
- S: `pnpm stt:test`, `stt:lint`, `stt:typecheck`, `stt:format:check`, `pnpm --filter @arcaai/types build test`, `pnpm --filter @arcaai/applications test -- stt`, contracts via `pnpm test:unit` filtered to `tests/contracts`.
- H: `pnpm harness:test`, `harness:lint`, `harness:typecheck`, `harness:format:check`.
- T, D: `pnpm --filter @arcaai/applications build test`, `pnpm lint` on the package; D also `pnpm api:build` + `pnpm test:unit` (api).
- X: `pnpm text:test`, `text:lint`, `text:typecheck`, `text:format:check`.
- K: `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:openapi:check && pnpm api:portal && pnpm api:portal:check && pnpm --filter @arcaai/vox-node gen:admin && pnpm --filter @arcaai/vox-node gen:admin:check`, `pnpm sdk-node:test`.

## 5. Implementation Summary

| Lane | Merge | What landed | Gates (re-run by the orchestrator in the worktree, then post-merge) |
|---|---|---|---|
| X — TEXT | `e8671f070` (lane commit `12a462e64`) | `retry_handler.py`: `provider_status_code_from` / `is_provider_invalid_request` / `provider_error_code_from`; a provider 4xx classifies as `invalid_request`, is never retried, answers **422** `{error, code}` with `PROVIDER_INVALID_REQUEST` or `CONTEXT_WINDOW_EXCEEDED` (message match: context size/length/window, maximum context, too many tokens, exceeds the model); same code on the terminal SSE `error` frame; `generation.failed` logs `error_type` + `code`. 4xx detection keys on `openai.APIStatusError.status_code` / `anthropic.APIStatusError.status_code` / `httpx.HTTPStatusError.response.status_code`; Bedrock's `ClientError` stays `provider_error`. Circuit-breaker still counts a 4xx as a failure (deliberately unchanged; owner's call). | `apps/text` 1669 passed / 4 env-skipped (0:03:38); ruff clean; mypy 81 files clean; post-merge `test_retry_and_timeout.py` + `test_task871_output_gate.py` 44 passed |
| S — STT decode configuration | `df3573171` (lane commits `c22007842`, `d138c2dec`) | OD-1: `decoding.hotwordsInPrompt` per model — `AiModelAsrProfileDecoding.hotwordsInPrompt?: boolean` (parsed, unknown-key-safe), wire `AsrSpecDecoding.hotwordsInPrompt?` folded agent → model → omitted (+ `sources.hotwordsInPrompt`), `spec.py`/`dto.py` mirror (`InferenceConfig.hotwords_in_prompt = False`), fixture `modelProfileDecodeKnobs` carries the ON case and `clinicalVocabularyCorrection` the absent case; `whisper_cpp_asr.py` appends hotwords to the prompt ONLY when the switch is `true` (the lexicon stage keeps the terms). OD-2: `WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED = False` (pair prompt unchanged). Carry-forward from FINALS only, cleared when a Latin-pinned session decodes majority non-Latin. Script tripwire: one `status: degraded, reason: script_mismatch` frame per session (the bridge already forwards `reason`/`utterance_index`), a per-occurrence metric and a WARNING without the text. Ring-buffer overflow logs demoted to DEBUG with the buffer documented as diagnostic-only. Adapter-level measurement from the worktree: 20 hotwords configured + switch absent + no prompt → 100 % Latin (byte-identical to no hotwords); old production shape → 7 %; new production shape (agent prompt only) → 100 %. NOT done (outside the lane): `AsrProfileDecodingRequest` + `SPEECH_TO_TEXT_PARAMETERS.decoding` do not accept the key yet, so the ON path is reachable only by a direct row write — §7. | `apps/stt` unit+integration 3321 passed, 1 pre-existing env failure (`test_minio_credentials_default_to_empty`, fails on `dev-2.2` too); ruff clean; mypy 141 files clean; types + applications(stt, ai-model) + contracts 1095 passed; post-merge in the primary: STT 3324 passed / same 1 failure, TS subset 920 passed after `pnpm --filter @arcaai/types build` (the primary's stale `dist` was the only post-merge red) |
| T — live lane | `efecad192` (lane commit `5e3218634`) | D2: `realtimeDocumentTemplateSlug(lane, branchHandles?)` picks the first template-bearing node REACHABLE through the evaluated guards; `resolveBranchHandles` exported; `ensureTemplateResolved` evaluates once with `realtimeRunContext(session)` (substrate now resolved before the template so `visitType` is frozen). OD-3: `resolveHandoffContext` always carries the clinical half (`visit_type: 'new-visit' | 'revisit'`, `current_department`, `language`, `language_name`, `safe_*`, `formatted_*`) beside the DNA half; `chief_complaint`/`formatted_vitals` deliberately not carried. OD-5: tier 1a of the live prompt chain also walks the graph's per-turn `core.agent` nodes (`execution.lane === 'realtime'`, cadence ≠ `onStart`) to the agent's APPROVED `instruction.promptTemplateId` (node pin wins; version = pin ?? agent pin ?? approved ?? latest), tier `agent`, `resolvedAgentId` = agent id. D6: one classifier (`degrade-codes.ts`: `context_overflow`, `no_case_notes`, `timeout`, `text_unavailable`, pass-through bare codes, fallback `pre_summary_failed` / `generation_failed`); `flushFailed` + `degradeReason` on the stats line, `LiveDocSessionStatsResponse`, `LiveSummaryEventDto`; `SectionPatchDto.degradeReason` is a code. | applications build clean; targeted suites 1160 passed; lint 182 warnings = baseline; post-merge full `packages/applications` 12733 passed, 0 failed |
| D — run lifecycle | `b2084238a` (lane commit `f59289a6a`) | `IWorkflowRunCompletionPort` (applications) provided by a new `@Global()` `WorkflowRunCompletionModule` (`useExisting: WorkflowRunCompletionService`); `ConsultationWorkflowDispatchService` calls `watch(tenantId, runId, consultationId)` after `startWorkflowRun`. `recordRunFinished` resolves `workflow-interpreter-<runId>` and `wf-<runId>`. `recordTerminal` (public seam) on FAILED/TIMED_OUT calls `HarnessInternalService.failGovernedRun` → `DRAINING → CLOSED_INCOMPLETE` (explicit status guard; DRAFT_PENDING_SENSORS and later states untouched), `_metadata.terminalReason = { runId, status, reason, at }`, sys-event `failGovernedRun`, harness-progress `failed` stage (the DTO has no `ok`). `HarnessInternalService` now extends `BaseService`. Node counts are NOT on the `workflow.run.completed` envelope (harness emits `{status}` only) — left untouched, pinned by a test. CANCELED leaves the consultation alone (OD-4 read literally). | targeted suites 481 passed; applications build; `pnpm api:build` 12/12; api lint 0 errors/65 pre-existing warnings; root `pnpm test:unit` 24596 passed in the lane; post-merge targeted 481 passed + api build 12/12 |
| Artifacts | `45dc1d625` | The five artifacts regenerated on the merged tree (Lane T's DTOs drifted `openapi.json`, both portal JSONs and `vox-node` `schemas.ts`); `api:openapi:check`, `api:portal:check`, `gen:admin:check` all "no drift" | vox-node 486 passed after regeneration |
| K — SDK + scopes | `72494cdd9` (lane commits `afe134193`, `0233b6517`) | `RealtimeSttSocket.finalize()` ("finalize the utterance AND end the session"), `stop()` kept as a deprecated alias, same wire frame, changeset `vox-node-realtime-stt-finalize` (patch, no version bump). OD-7 scopes on 11 consultation GET routes (`session:read`: context, case-notes, transcriptions, named-entities, timeline, workflow, chain; `report:read`: summary, documents/sections ×3). Five artifacts regenerated (`route-manifest.json`, `openapi.admin.json`, `openapi.business.json` changed on exactly those 11 paths; `openapi.json` and `vox-node` admin codegen zero diff). Two e2e specs that pinned `GET :id/workflow` as the "still 403" example now use `:id/context/shared`. | vox-node build/test 486 passed/lint/typecheck/check:exports; `pnpm api:build` 12/12; portal + admin-codegen "no drift"; api consultation module 248 passed; post-merge vox-node 486 + consultation 248 passed. e2e specs NOT run (need the live test gateway) — run `task-776-credential-classes`, `task-933-service-account-consultation` and the authz matrix in the verification phase |

## 6. Change History

| Date | Entry |
|---|---|
| 2026-09-10 | Ticket opened from the trial review; decisions OD-1…OD-7 taken as recommended; six worktree lanes spawned from `dev-2.2` at `eec2daa1f` (S/H/T/D at opus, X/K at sonnet). |
| 2026-09-10 | Inline (orchestrator, `dd1eb71e5`): `start_registration` returns `None` and schedules nothing for a degraded build-info (`service == "unknown"`), test-first (`packages/py-env` 114 passed, ruff/black/mypy clean); TASK-939 §8 and TASK-943 §7 corrected. OD-6 first half applied to the dev box: `gemma-4-e2b-it-qat` reloaded at 32,768 context (`lms load … -c 32768`). OD-6 second half (judge-lane permits) NOT applied: the budget is served per `(provider, lane)` runtime-profile row (`apps/text/src/text/core/effective_config.py:150-195`, `lane: 'judge'`, `maxConcurrent`), and the verification run is a single consultation, which two permits serve; left for the owner to size. |

## 7. Follow-ups (not in this ticket)
- Declare a context window on the LM Studio `AiModel` rows and wire `agentic.context.tokenBudget.perRun` into the live lane as a pre-dispatch check.
- Measured A/B of the PAIR priming prompt on unpinned `ml-en` sessions; re-baseline `mlen_scorecard_baseline.json` with the served configuration.
- A transcript-quality assertion (Latin ratio for `en`) in `task-939-note-accumulation-replay.spec.ts`.
- Admin model-form field for `decoding.hotwordsInPrompt` (console).
