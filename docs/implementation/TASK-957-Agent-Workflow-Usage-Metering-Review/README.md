# TASK-957 — Agent & Workflow Usage Metering Review (billing + invoicing)

| Field | Value |
|---|---|
| Status | Pending |
| Type | `review` → `bugfix` (owner decisions gate two of the fixes) |
| Branch | `dev-2.2` |
| Requested | 2026-09-12 — "review the implementation of agents and workflows, ensure the usage counter is implemented properly for billing and invoicing" |
| Scope | The two tenant-facing inference planes shipped by TASK-930/931 — `POST /agents/:slug/{invocations,speech,transcriptions}` and `POST /workflows/:slug/runs` (durable + sandbox + consultation-bound) — traced from the gateway through `apps/text` / `apps/nlp` / `apps/tts` / `apps/stt` / `apps/harness` to the usage ledger (`AiUsageEvent`), the meters (`TenantUsageMeter`) and the invoice engine (`BillingInvoice`). |
| Verdict | **The metering plane itself is sound** (outbox → ledger → rollups → invoice, intent-derived idempotency, supersede-only price book, D16/OQ1 compensation). **The agent plane records what it spends. The workflow plane records what it spends under an operation the invoice engine and the LLM meter are built to EXCLUDE**, so a tenant's own workflow runs are metered but never invoiced and never consume its LLM allowance — and the one hop that delivers those rows to the gateway has no retry. Nine further defects, none of them platform-wide, are listed below with severity. |

## 1. Requirement Analysis

The owner asked for assurance, not a feature: are agent invocations and workflow runs counted correctly for billing and invoicing? "Correctly" decomposes into six questions, each answered in §2:

1. Is every inference the two planes cause recorded on the ledger at all? (coverage)
2. With the right quantity and units — input, output, cache, reasoning tokens; audio seconds; characters; text units? (accuracy)
3. Under an idempotency key that survives retries without double-billing? (integrity)
4. With the right economics — `deployment` (self-hosted / cloud / BYOK) and `costBasis` derived, never stamped? (funding)
5. Does the recorded usage reach the tenant's meter (quota) and the tenant's invoice (revenue)? (billing)
6. Is a lost or duplicated emission detectable? (observability)

## 2. Current State Evaluation

### 2.1 What is right (and should not be re-litigated)

| Property | Evidence |
|---|---|
| One frozen emission port: `recordUsage` writes an outbox row, the BullMQ drainer rates it against the COST plane and appends the ledger row + both rollups in ONE transaction; redelivery converges on the unique `idempotencyKey` | `usageLedger/IUsageLedgerService.ts`, `usage-outbox.drainer.ts` (header + `drainBatch`), `usage-ledger.service.module.ts:38-45` registers queue + processor; `app.module.ts:404` imports it |
| Ten closed operations, shaped providers, PHI-safe `attributesJson` allow-list with the `trigger` dimension (`AGENT_INVOCATION / AGENT_TEST / PROMPT_TEST / WORKFLOW_RUN / CONSULTATION`) | `usageLedger/vocabulary.ts`, `usage-attributes.ts:48-96` |
| Streaming agent invocation tees the SSE through the ONE shared collector, bills from TEXT's terminal `usage` frame, keys on TEXT's `task_id`, emits once across `end`/`error`/`close`, marks `interrupted` on the abort paths | `agent.controller.ts:300-336`, `usageLedger/llm-stream-usage.ts`, `text-usage.ts:172` |
| Blocking, stream, NER and TTS agent routes are quota-prechecked BEFORE the upstream call (`monthlyLlmTokens` / `monthlyNlpTextUnits` / `monthlyTtsCharacters` with the character count) and stamp `trigger: AGENT_INVOCATION` (+ `guardrail` disposition on generation rows) | `agent.controller.ts:277, 385, 462, 312-332, 627-648` |
| Funding is derived: blocking uses `resolved.fundingTier === 'tenant'` → `classifyLlmDeployment` + explicit `BYOK_NOTIONAL`; stream uses TEXT's wire `byok`; harness steps use `funding_tier` from the interpreter; the ledger service warns when `deployment` and `costBasis` disagree | `agent.controller.ts:623-647`, `text-usage.ts:178-181`, `harness-usage.mapper.ts:141, 203-208`, `usage-ledger.service.ts:118-140` |
| Workflow steps are keyed on the trajectory tuple `harness:step:<sessionId>:<runId>:<seq>`, so a Temporal activity retry converges on one ledger row; the emitter runs for EVERY posted step, not only inserted ones, so a first-attempt outbox failure gets a second chance | `agent-trajectory.service.ts:358-392`, `harness-usage.mapper.ts:184-190` |
| Workflow-lane keys are safe under retry: `seq` is allocated by the replay-deterministic workflow body (`interpreter/workflow.py:92-97, 329-333`) and passed as activity input, so a Temporal retry reuses the same `(sessionId, runId, seq)`; the gateway's `Idempotency-Key` header is inert by design (the composite unique is the dedup). One accepted residual sits a layer up: a TEXT 5xx after the model ran but before the response was cached is retried by the governor as a genuinely second generation (`activities.py:1650-1662`) — two generations, two rows, correct | `harness-usage.mapper.ts:81-93`, `agent-trajectory.service.ts:358-374`, `harness-usage.mapper.test.ts:80-95` |
| STT batch (agent transcriptions) is keyed on the job id and emitted from the worker's completion callback; `doctorId` is stamped on agent generation rows for service-account callers (TASK-950 decision 3) | `sttInternal.service.ts:556-563`, `agent.controller.ts:292, 641` |
| Invoice math: rollups only, half-up at line level, prorated plan-fee segments, `harness.step`/`guardrail.validate` subtracted per (day, unit, provider, deployment), BYOK units counted for overage but notional cost excluded, a period invoiced once per tenant | `billing.service.ts:397-500`, `billable-usage.ts`, `billing.prisma` |
| e2e proof exists for the agent plane: `task-890-metering.spec.ts` (blocking `generate` + stream `generate.stream` with `AGENT_INVOCATION`; 429 with an allowance of 1 and no TEXT call; `PROMPT_TEST`) | `apps/api/tests/e2e/task-890-metering.spec.ts:143-317` |

### 2.2 Findings

Severity: **BLOCKER** = money is wrong on the invoice; **HIGH** = money is wrong on the meter or COGS; **MEDIUM** = correctness under failure / accuracy loss; **LOW** = attribution / hygiene.

#### F-1 — BLOCKER (owner decision D-1) · Workflow-run LLM usage is recorded as `harness.step`, which the invoice engine and the LLM meter are built to exclude

- **What happens.** Every durable `core.agent` step of a tenant workflow run reaches the ledger as `operation: 'harness.step'` with `trigger: WORKFLOW_RUN` (`harness-usage.mapper.ts:198`; proven end-to-end in TASK-890's black-box phase, README §2111: "two `AiUsageEvent` rows with `trigger: WORKFLOW_RUN … operation: harness.step`").
- **Why that is wrong now.** D16 (TASK-615) classified `harness.step` as *"internal agentic COGS — neither ever quota-blocked or invoiced"*. That was true when the harness was the platform's clinical-documentation loop. TASK-930 made published workflows a tenant product — invoked with a tenant API key or service account (`svc:workflow:run:write`), authored by the tenant, running the tenant's agents. The same operation string now labels tenant-consumed inference as platform COGS. Three consequences:
  1. **Never invoiced.** `billable-usage.ts:66` `NON_BILLABLE_LLM_OPERATIONS = ['guardrail.validate', 'harness.step']`; `billing.service.ts:466-471` subtracts those sums from the LLM pool before overage is computed.
  2. **Never counts against the LLM allowance.** `metering.service.ts:28-36` excludes the same operations from `LLM_TOKENS`, so a tenant can run unlimited workflow generations without `monthlyLlmTokens` moving.
  3. **The precheck on the harness-facing resolve route is toothless.** `apps/api/src/modules/internal/agent-internal.controller.ts:90` calls `assertMeterQuota(tenantId, 'monthlyLlmTokens')` on every workflow step — a meter that workflow usage never feeds. A workflow-only tenant can never trip it.
- **Related.** `monthlyWorkflowInvocations` IS gated at run start (`workflow-exposure.service.ts:260-262`, 429 when over) but is a quota only: no `AiCapability`, no allowance column in `allowances.ts`, no SELL row in `seed/20-ai-price-book.ts` (grep `workflow`: zero hits), no overage line. A run over allowance is blocked; a run under it is free. `WorkflowRun` carries no usage/cost columns either (`workflow-run.prisma`).
- **Owner decision D-1** (see §5). Recommended: **(a)** introduce the eleventh operation `workflow.step` for `LLM_CALL` steps whose `stats.trigger === 'WORKFLOW_RUN'`, keep `harness.step` for the consultation lane, and leave the billing/meter exclusion lists untouched so `workflow.step` is billable by construction. Rollups carry `operation` but not `trigger`, so billing on `trigger` instead would need raw-ledger scans that D5/D13 forbid. **(b)** decide whether `monthlyWorkflowInvocations` stays quota-only or gains a SELL row (`REQUEST` unit, per-run price) — today it is quota-only by construction.

#### F-2 — HIGH · The blocking agent invocation bills from the deprecated flat `usage` block and discards `usage_detail`

- `apps/text` returns `usage_detail` (cache read/write, reasoning, `byok`, `task_id`, `request_id`, `occurred_at`, `endpoint_kind`, `service_tier`) on the blocking `/generate` response (`apps/text/src/text/models/responses.py:60-65`) — the same block the stream terminal frame carries and `text-usage.ts` parses.
- `agent-invocation.service.ts:324-334` types the response as `usage?: { prompt_tokens, completion_tokens }` and drops everything else; `agent.controller.ts:611-648` then builds the row with `buildLlmUsageInputFromTokenCounts` (its own comment: *"the blocking invocation result carries only `{promptTokens, completionTokens}`"* — true only because the service narrowed it).
- **Effect.** On a cloud or BYOK model: cache-read/write and reasoning tokens are not recorded (under-billing, under-COGS); `cacheTtl`, `serviceTier`, `endpointKind` are absent so the rater cannot select the cache-TTL / context-band rows the price book already carries (`price-book.resolution.ts:22, 98-100`); `occurredAt` is the gateway clock, not TEXT's; and `requestId` is a fresh `generateId()` (`agent.controller.ts:627-629`) instead of TEXT's `task_id`, which (i) violates the intent-derived-key rule in `idempotency-keys.ts:1-26`, and (ii) breaks the only join between a ledger row and TEXT's persisted task log — the reconciliation path a disputed invoice needs. The stream path of the SAME agent does all of this correctly.
- **Fix.** Parse `data.usage_detail` with `parseTextUsageDetail` and build with `buildLlmUsageInput`; fall back to the counts-only builder only when `usage_detail` is absent. Same shape for `AgentDraftTestService` if it still reads the flat block.

#### F-3 — HIGH (COGS, not tenant revenue) · Guardrail LLM usage is dropped on the agent plane and absent from every stream

- Blocking `/generate` returns `guardrail_usage` (`responses.py:69`); only the consultation summary paths record it (`summary.service.ts:829-839`, `comprehensive-summary.processor.ts:484-535`). The agent invocation path never reads it (`agent-invocation.service.ts:324-334`), so the `GUARDRAIL_CALLS` meter and guardrail COGS undercount every agent-plane call.
- The streaming terminal frame carries `usage` only — no `guardrail_usage` at all (`apps/text/src/text/routing/streaming.py:396-397`) — so no stream consumer (agent, playground proxy, summary stream) can record it.
- **Fix.** Blocking agent path: `buildGuardrailUsageInput` beside the generation row (the summary precedent). TEXT: add `guardrail_usage` to the terminal frame; `LlmStreamUsageCollector` picks it up.

#### F-4 — HIGH · The tenant spend ceiling (D12) is enforced on consultation summaries only

- `BillingService.assertSpendLimit` (`billing.service.ts:338-356`) has two callers, both in `summary.service.ts:397, 618`. Agent invocations (all four task kinds) and workflow runs never check `monthlySpendLimitMicros`. A tenant that set a ceiling to bound its API-plane spend is not bounded on the two planes that can spend fastest.
- **Fix.** `await this.billing?.assertSpendLimit(tenantId)` beside each `assertMeterQuota` in `agent.controller.ts` (invocations, speech, transcriptions) and in `workflow-exposure.service.ts` at run start; `SpendLimitExceededException` already maps to a gateway status.

#### F-5 — HIGH (workflow lane) / MEDIUM (agent plane) · Emission is fire-and-forget, and on the workflow lane the loss window is the whole harness → gateway hop

- **Workflow lane.** The ONLY billing path for a workflow step is the interpreter's trajectory POST to `POST /internal/harness/trajectory`. `_TrajectoryBatch.flush()` (`apps/harness/src/harness/temporal/activities.py:505-519`) catches every exception, logs `harness.report_trajectory.failed`, and clears `self._steps` in `finally` — no retry, no local spool, no Temporal-side outbox. Two tests pin that a raising callback never fails the workflow (`tests/unit/temporal/test_trajectory.py:574-605`, `tests/unit/temporal/interpreter/test_trajectory.py:105`). A gateway restart, a 503 from the internal guard, or a network blip during a run therefore drops those steps AND every ledger row they would have produced, permanently; the gateway outbox/drainer's retries only protect the leg after the POST landed. The run still completes and its output is delivered. (The seq-keyed idempotency means a *successful* retry would be safe — the retry simply does not exist.)
- **Agent plane.** `agent.controller.ts:663` (`void … recordUsage(...).catch(warn)`), `sttInternal.service.ts:582`; on the gateway side of the workflow lane `agent-trajectory.service.ts:389-399` warns and swallows, and the step emit is NOT in the `createMany` transaction (documented at lines 375-380). The contract's `tx` join cannot apply on the invocation plane (no business row), so a Postgres blip between "TEXT answered" and "outbox row written" is unbilled revenue that surfaces only as a `warn` line.
- No Prometheus counter exists for either (grep `usage_emit|usage_ledger_` over metrics: none).
- **Fix.** (1) Harness: retry the trajectory POST with bounded backoff inside the activity, and spool undeliverable batches to Redis (the harness already has a Redis client) for a re-drain on the next activity — the step `seq` key makes redelivery safe. (2) Gateway: a bounded in-process retry (3× jittered) around the outbox write on the invocation plane. (3) `hope_usage_emission_failed_total{operation,trigger}` on both sides + an alert. (4) The durable answer for the agent plane: TEXT already persists `usage_detail` per task (`task.py:60`, read back by `GET /tasks/{id}`) — a nightly reconciler comparing TEXT task ids against ledger `requestId` for `llm:*` keys closes the gap for good. It needs F-2 first (the ledger `requestId` must BE the task id).

#### F-6 — MEDIUM · Workflow-step rows record input + output tokens only; reasoning tokens are structurally unbillable

- `harness-usage.mapper.ts:171-180` sets cache-read/write and reasoning to `0` because `GenerationStats` (`apps/text/src/text/models/stats.py:118-128`) surfaces `prompt_tokens` / `predicted_tokens` / `total_tokens` plus an `engine_native` blob only. The interpreter copies TEXT's stats verbatim into the step (`nodes/core.py:831`, "whatever cache/engine-native counters it reports reach the rollups untouched") — so the raw cache counters DO reach the gateway inside `engine_native`; the mapper never reads them, and TEXT's normalized `usage_detail` (with the split) is on the same response the interpreter reads.
- The consultation-lane `generate` activity records reasoning on a SEPARATE `THINKING` step (`activities.py:1707-1716`), and the mapper bills `LLM_CALL` only (`harness-usage.mapper.ts:159`; its own header at lines 30-36 admits "this lane does NOT bill" it). The interpreter's `core.agent` emits no `THINKING` step at all. Reasoning-model spend is visible in trajectory UIs and absent from the ledger on both lanes.
- Under-metering for cloud/BYOK models inside workflows; irrelevant for LM Studio today, wrong the day a tenant binds an Anthropic or OpenAI reasoning model to a workflow agent.
- **Fix.** The interpreter stamps `usage_detail`'s five counts into the `LLM_CALL` step `stats` (already an open blob on the wire), the mapper maps them through the existing `toUsageUnitQuantities`; retire the separate `THINKING` accounting for billing purposes.

#### F-7 — MEDIUM · Sibling gaps on the same routes' playground twins

- `POST /text-generations/generate` (sync) emits nothing — `text-proxy.controller.ts` has ONE `recordUsage` (line 797, the streaming task route only). `POST /text-analyses/{diagnosis,topic,intent}` emit nothing; only `/entities` does (`ai-inference.controller.ts:110-190, 200-258`). These are admin-plane benches, but OD-E ("every inference activity counts") applies and they burn the same platform keys.

#### F-8 — LOW · Attribution holes that make "spend by activity" and dispute answers incomplete

- `transcribe.batch` from the agent transcriptions route carries no `trigger` and never reads `job.agentVersionId` (`sttInternal.service.ts:549-574` types `job` as `{tenantId, consultationId, pipelineId, completedAt}`); `transcribe.stream` and consultation `ner.extract` carry no `trigger` either (TASK-890 L11 wave-2 scoped these out).
- On the workflow lane, `doctorId` / `departmentId` cannot be stamped: the trajectory wire DTO (`HarnessTrajectoryStepInput`, `harness-internal.controller.ts:161-240`; `TrajectoryStepInput`, `apps/harness/.../services/api_client.py:182-232`) carries neither, and the interpreter's `RunSubject.userId` (`interpreter/models.py:176`) is never threaded into `TrajectoryContext`. TASK-951 §6 already lists "doctorId on the agent-plane row" as an owner fast-win.
- Node identity is computed and then dropped: `TrajectoryContext` carries `workflow_version_id`, `stage_id`, `node_id`, `node_type` (`interpreter/workflow.py:813-820`) but `_TrajectoryBatch.record()` (`activities.py:483-503`) never serialises them, the DTOs forbid extra keys, and `usage-attributes.ts` has no `workflowRunId` / `definitionSlug` / `nodeId` key. "Which node of which definition version spent this" is unanswerable from the ledger; `requestId = runId` is the closest proxy.
- Agent identity (`agentSlug` / `agentVersionId`) is deliberately not a ledger dimension (`usage-attributes.ts`; `agent.controller.ts:516-517` puts it on response headers). Billing does not need it; a tenant asking "which agent spent this" cannot be answered from the ledger. Workflow rows DO carry `requestId = runId` and `sessionId`, so per-run cost is queryable; per-agent cost is not.
- `usageAnalytics` exposes no `operation`/`trigger` breakdown (grep: none), and cost-per-encounter is consultation-keyed, so standalone workflow runs are invisible on the consumption screens.

#### F-9 — LOW · Three restatements of the self-hosted provider set

- `vocabulary.ts:118` (`SELF_HOSTED_PROVIDER_IDS`), `text-usage.ts:74`, `harness-usage.mapper.ts:69` — identical today (`ollama, lm-studio, vllm, llama-cpp, built-in`). The blocking and streaming paths of the same agent classify `deployment` through different functions with different `byok` sources (agent funding tier vs TEXT's wire flag). TASK-952/E just added `tei-embed` as a provider id; it is in none of the three sets and not in `KNOWN_PROVIDERS` (the embed emitter hardcodes `SELF_HOSTED`, so nothing is wrong yet — the next self-hosted id added to one list and not the others forks the classification). `vocabulary.ts:110-116` already asks for convergence.

#### F-10 — LOW · TTS fallback classification

- `agent.controller.ts:494-512`: a missing `x-tts-provider` header yields `provider: 'none'`, `deployment: SELF_HOSTED`. Rated at zero COGS and allowance-consumed first (tenant-favourable). Should be `'none'` → skip emission with a warn, or fail the header contract in `apps/tts`.

#### F-11 — TEST GAP · Nothing pins the workflow lane

- No spec under `apps/api/tests/e2e` asserts a `WORKFLOW_RUN` or `harness.step` ledger row (grep: only `task-615-usage-ledger.spec.ts`, `task-890-guardrail-optout.spec.ts`, `task-890-metering.spec.ts` mention `recordUsage`/outbox, none the workflow lane). The 2026-09-07 proof was manual. No unit test pins whether a `WORKFLOW_RUN` row is billable or excluded — whichever way D-1 is decided, `billable-usage.test.ts` and `metering.service.test.ts` must pin it.

### 2.3 Path-by-path summary

| Path | Precheck | Row(s) | Key | Units | Trigger | Funding | Invoiced? |
|---|---|---|---|---|---|---|---|
| `POST /agents/:slug/invocations` blocking (TEXT_GENERATION) | `monthlyLlmTokens` | `generate` | `llm:<random>` ✗ (F-2) | in+out only ✗ (F-2) | ✓ | derived (fundingTier) | ✓ |
| same, `?mode=stream` | `monthlyLlmTokens` | `generate.stream` | `llm:<text task_id>` ✓ | in/out/cache/reasoning ✓ | ✓ | derived (wire byok) | ✓ |
| same, agent task NER | `monthlyNlpTextUnits` | `ner.extract` | `nlp:<random>` | TEXT_UNIT ✓ | ✓ | SELF_HOSTED literal | ✓ |
| `POST /agents/:slug/speech` | `monthlyTtsCharacters` (+count) | `tts.synthesize` | `tts:<random>` | CHARACTER ✓ | ✓ | `classifyTtsProvider` | ✓ |
| `POST /agents/:slug/transcriptions` | `monthlyTranscriptionMinutes` at job create | `transcribe.batch` on worker completion | `stt:job:<jobId>` ✓ | AUDIO_SECOND ✓ | ✗ (F-8) | worker callback | ✓ |
| `POST /workflows/:slug/runs` → durable `core.agent` step | `monthlyWorkflowInvocations` at start; `monthlyLlmTokens` at resolve (toothless, F-1) | `harness.step` (delivered by a no-retry POST, F-5) | `harness:step:<session>:<run>:<seq>` ✓ | in+out only ✗ (F-6) | ✓ `WORKFLOW_RUN` | derived (`funding_tier`) | **✗ excluded (F-1)** |
| Guardrail call triggered by any agent generation | — (never gated, D16) | `guardrail.validate` | `guardrail:<req>` | — | — | — | ✗ not recorded on the agent plane (F-3) |
| Spend ceiling `monthlySpendLimitMicros` | consultation summaries only (F-4) | | | | | | |

## 3. Implementation Plan (Pending — gated on §5)

Ordered so that each step is independently mergeable and the BLOCKER lands first.

| # | Change | Files | Gate |
|---|---|---|---|
| 1 | **D-1(a)** add `workflow.step` to `USAGE_OPERATIONS`; `buildHarnessUsageEvent` selects it when `pickTrigger(stats) === 'WORKFLOW_RUN'`; pin in `vocabulary.test.ts`, `harness-usage.mapper.test.ts`, `billable-usage.test.ts` (a `workflow.step` row IS billable), `metering.service.test.ts` (it counts toward `LLM_TOKENS`) | `usageLedger/vocabulary.ts`, `agent-trajectory/harness-usage.mapper.ts`, tests, `docs/architecture/data-and-domain-model.md:176-181` | `pnpm --filter @arcaai/applications test` |
| 2 | **F-2** blocking invocation reads `usage_detail` (+ `guardrail_usage`, F-3) and bills through `buildLlmUsageInput` / `buildGuardrailUsageInput`; `requestId` = TEXT `task_id`; controller test asserts cache/reasoning rows and the key shape | `agent/agent-invocation.service.ts`, `apps/api/src/modules/agent/agent.controller.ts`, tests | `pnpm test:unit` (api), applications tests |
| 3 | **F-4** `assertSpendLimit` on the three agent routes and at workflow-run start; unit tests for the 402/429 mapping | `agent.controller.ts`, `workflow-exposure.service.ts` | same |
| 4 | **F-5** harness: bounded retry + Redis spool for the trajectory POST (re-drained on the next activity; seq-keyed, so safe); gateway: bounded retry on the invocation-plane outbox write; `hope_usage_emission_failed_total` on both sides; alert rule in the deployment repo | `apps/harness/.../temporal/activities.py`, `agent.controller.ts`, `agent-trajectory.service.ts`, metrics | `pnpm harness:test`, api unit |
| 5 | **F-3** TEXT adds `guardrail_usage` to the terminal frame; collector reads it | `apps/text/src/text/routing/streaming.py`, `usageLedger/llm-stream-usage.ts` | `pnpm text:test`, applications tests |
| 6 | **F-6** interpreter stamps the five `usage_detail` counts into the `LLM_CALL` step `stats`; mapper maps them (reasoning no longer rides an unbilled `THINKING` step) | `apps/harness/.../interpreter/nodes/core.py`, `harness-usage.mapper.ts` | `pnpm harness:test`, applications tests |
| 7 | **F-11** e2e: `task-957-workflow-metering.spec.ts` — an API-triggered run writes `workflow.step` rows with `WORKFLOW_RUN`; with enforcement ON and `monthlyLlmTokens = 1`, the second run's step degrades with `quota_exceeded` | `apps/api/tests/e2e/` | `npx dotenv -e .env.test -- npx playwright test task-957` |
| 8 | **F-7/F-8/F-9/F-10** hygiene: playground sync routes emit; `transcribe.batch` threads `trigger` via job `metaData`; converge the three self-hosted sets on `SELF_HOSTED_PROVIDER_IDS`; TTS `'none'` provider skips with a warn | as named | lint + unit |
| 9 | **D-1(b)** if a per-run SELL price is wanted: `REQUEST`-unit SELL row for a new `WORKFLOW` capability or a `monthlyWorkflowInvocations` overage line — schema + `allowances.ts` + `billable-usage.ts` | `enums.prisma`, `usage-ledger.prisma`, billing | migration + billing tests |

## 4. Implementation Summary

Not started — review only. No code was changed by this ticket.

## 5. Owner decisions required

| Id | Question | Recommendation |
|---|---|---|
| D-1 | Is a tenant's workflow-run generation tenant-billable inference (like an agent invocation) or platform COGS (like the clinical harness)? | Billable. Split the operation (`workflow.step`), keep D16 for the consultation lane. |
| D-2 | Should `monthlyWorkflowInvocations` stay a pure quota, or gain a per-run SELL price / overage line? | Keep quota-only for R1; the tokens inside runs become billable under D-1, which is where the cost is. Revisit with a price book row when a run-count SKU is wanted. |
| D-3 | Does the tenant spend ceiling (D12) apply to the agent and workflow planes? | Yes — it is the only bound a tenant can set on API-plane spend. |
| D-4 | Should agent identity (`agentSlug`) become an allow-listed ledger dimension for per-agent cost reporting? | Not for billing. Add only if the console needs "spend by agent"; it is an opaque id and passes the allow-list rules. |

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-12 | Review performed on `dev-2.2` @ `47b568beb` (+ uncommitted TASK-955/956 console work, unrelated). Findings F-1..F-11, decisions D-1..D-4. Status `Pending`. |
