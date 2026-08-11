# BUG-018 — Prompt-template Test is a blocking 2–3½ minute request that 524s at the CDN, routes through harness policy it has no business consulting, and silently runs on the platform's LM Studio model with platform credentials

| Field | Value |
|---|---|
| **Status** | `In Progress` |
| **Type** | `bugfix` |
| **Branch** | `dev-2.1` |
| **Discovered** | 2026-08-11, testing template `71000000-0000-0000-0001-000000000024` on `https://admin-hope.taphuynh.dev` (deployed `hope-v2-dev`) |
| **Severity** | High — the Test tab is unusable on every deployed environment (100% 524), and when it does complete it bills the platform, not the tenant, on a model the tenant never chose |
| **Affected apps/packages** | `packages/applications` (`prompt-management`), `apps/api` (`prompt-management`, `streaming/smr-proxy`, `auth` stream tickets), `apps/admin-console` (`features/agents`), `packages/database` (seed `16-ai-task-default.ts`) |
| **Related tickets** | TASK-588 (tenant-configurable SMR selection — introduced `resolveSmrSelection`), TASK-643 (platform-default credential cascade / `funding`), TASK-615 (usage metering), TASK-654 + agent program (owns harness/agent routing — **explicitly out of scope here**) |

---

## Requirement Analysis

Testing a prompt template must be a **simple, self-contained thing**: interpolate the
template, run one text generation, score it, show the output. It is a prompt-authoring
tool, not a clinical pipeline.

Two requirements follow, and the current implementation violates both:

1. **It must stream.** A generation that produces 1000–1500 tokens cannot be delivered
   as one blocking HTTP response — no CDN in front of the gateway will hold the
   connection that long. It must return a job ack immediately and stream tokens over SSE.
2. **It must not be related to harness.** Harness policy governs the clinical
   documentation loop and belongs to the agent plane (in progress in a separate
   session). The Test button must not read, depend on, or be constrained by
   `HarnessPolicyService`.

---

## Current State Evaluation

### Evidence — the endpoint works, it is just far too slow

`hope-api-57cc9bf595-vw6j2`, namespace `hope-v2-dev`, same template id the user called:

```
POST /api/v1/admin/prompt-templates/71000000-…-024/test  durationMs:207475  201
POST /api/v1/admin/prompt-templates/71000000-…-024/test  durationMs:130244  201
POST /api/v1/admin/prompt-templates/71000000-…-024/test  durationMs:141300  201
```

`hope-smr-c94454fd-v855r`, the downstream call consuming essentially all of it:

```
provider: lm-studio  model: gemma-4-e2b-it-qat  tenant_id: null
prompt_tokens 1736 / completion_tokens 1559 → latency_ms 207446
prompt_tokens 1736 / completion_tokens 1061 → latency_ms 130198
prompt_tokens 1737 / completion_tokens 1110 → latency_ms 141261
```

~8 tokens/sec. Cloudflare's origin-response ceiling is 100s, so every one of these
reached the browser as **524**. One earlier attempt failed differently — LM Studio
briefly refused connections, `generation.retry` ×3 → 503 → the gateway surfaced it as a
`400 "Failed to call SMR service: AxiosError: 503"`.

### Defect 1 — blocking request, no streaming

[`prompt-management.service.ts:1191`](../../../packages/applications/src/services/prompt-management/prompt-management.service.ts) posts
`{ prompt, stream: false, provider, model }` and awaits the whole completion. The
controller returns only when generation finishes. There is no ack, no job id, no stream.

This is the direct cause of the 524. It is not fixable by raising a timeout: Cloudflare
caps at 100s on the current plan and 600s even on Enterprise, and a slower model or a
longer template would breach any ceiling.

### Defect 2 — the Test path is coupled to harness policy

[`resolveTestSmrTarget` (`prompt-management.service.ts:1128`)](../../../packages/applications/src/services/prompt-management/prompt-management.service.ts):

```ts
if (!this.harnessPolicyService) return {};
try   { return await this.harnessPolicyService.resolveSmrSelection(this.tenantId, 'test'); }
catch { return await this.harnessPolicyService.resolveSmrSelection(this.tenantId, 'finalize'); }
```

A prompt-authoring tool reaches into the harness policy service to decide which model to
run. That is the wrong seam: harness/agent routing is the agent plane's concern and is
being reworked in another session. Any change there silently changes what the Test button
does, and vice versa.

Worse, the coupling is what produces the wrong model. `resolveSmrSelection`
([`harness-policy.service.ts:538`](../../../packages/applications/src/services/harness-policy/harness-policy.service.ts))
reads the `AiTaskDefault` row for the task key, cascading tenant → SYSTEM. The seed
([`16-ai-task-default.ts:86-97`](../../../packages/database/src/prisma/db_main/seed/16-ai-task-default.ts))
creates:

```ts
{ tenantId: SYSTEM_TENANT_ID, taskKey: 'smr.live',     modelSlug: 'lms-gemma-4-e2b-it-qat' },
{ tenantId: SYSTEM_TENANT_ID, taskKey: 'smr.finalize', modelSlug: 'lms-gemma-4-e2b-it-qat' },
```

**There is no `smr.test` row — for SYSTEM or for any tenant.** So `'test'` misses, the
bare `catch {}` swallows the miss, `'finalize'` resolves the SYSTEM row, and the run
lands on `lm-studio` / `gemma-4-e2b-it-qat`. The tenant had configured Azure OpenAI as
its default LLM provider; that setting is never consulted on this path.

The `catch {}` is itself a defect: it discards the distinction between "the tenant has
no `smr.test` key" (fall through, correct) and "the lookup failed" (should surface).

### Defect 3 — bypasses the proxy, so no tenant credentials and no metering

`callSmrGenerate` posts **directly** to `${SMR_URL}/api/v1/generate` with only
`Content-Type` and `X-Service-Token`. It never goes through
[`SmrProxyController`](../../../apps/api/src/modules/streaming/smr-proxy.controller.ts), so:

| Missing | Consequence |
|---|---|
| `applyTenantProviderOverrides` (`smr-proxy.controller.ts:264`) → `provider_overrides` | SMR falls back to its own env credentials. A tenant's `AiProviderConnection` is never used; `_is_tenant_funded` is false, so the run is **platform-funded** — the exact leak TASK-643 closed elsewhere |
| `X-Tenant-Id` | SMR logs `tenant_id: null`; guardrail tenant resolution is blind |
| `applySmrRuntimeProfile` | No hyperparameter profile applied |
| Usage-ledger emission | The run is **unmetered** — same class of hole as TASK-637 |

### Defect 4 — `dryRun: true` still runs a full generation

[`prompt-management.service.ts:887-905`](../../../packages/applications/src/services/prompt-management/prompt-management.service.ts)
generates and scores **first**, and only then checks `dto.dryRun` to decide whether to
persist. `dryRun` short-circuits the repository write, nothing else. The user's dry run
burned a real 141-second LLM call and (per Defect 3) platform credits.

---

## Implementation Plan

### Design — reuse the existing generation-job primitive, drop the harness dependency

The platform already has a text-generation job with SSE. It is not new machinery:

- SMR: `POST /api/v1/generate` with `stream: true` returns
  `{ task_id, stream_url }` ([`generate.py:383`](../../../apps/smr/src/smr/api/endpoints/generate.py)); chunks land in Redis Streams.
- Gateway: `GET text/tasks/:taskId/stream`
  ([`smr-proxy.controller.ts:663`](../../../apps/api/src/modules/streaming/smr-proxy.controller.ts))
  — SSE, `last-event-id` resume, `@StreamScope({ namespace: 'smr_task', param: 'taskId' })`,
  and usage-ledger emission on the terminal `usage` frame.
- Console: `use-event-stream.ts` (mints a single-use ticket via `POST /api/auth/stream-ticket`,
  opens `EventSource` directly against the gateway) and
  `features/playground-llm/api/use-task-stream.ts` as the working consumer to copy.

Model selection moves off harness entirely. `AiTaskDefault` is the model-registry control
plane in its own right; `HarnessPolicyService` merely wraps it. The Test path will read
`IAiTaskDefaultService.getEffective('smr.test', tenantId)` **directly** and drop the
`HarnessPolicyService` injection from `PromptManagementService`.

### Settled API contract

The `@RequiresIfMatch` question raised at ticket-open is resolved by **splitting the
call in two**: the ack performs no write, so it carries no OCC predicate; the write
happens in a second call that keeps the full OCC contract.

| Route | OCC | Returns |
|---|---|---|
| `POST admin/prompt-templates/:id/test` | none (no write) | `PromptTestAckResponse` — `{ mode: 'stream' \| 'dry-run', provider, model, assembledPrompt, taskId?, streamUrl? }` |
| `GET text/tasks/:taskId/stream` (existing) | n/a | SSE `chunk`/`reasoning`/`usage`/`done`/`error`, scope `smr_task:<taskId>` |
| `POST admin/prompt-templates/:id/test/finalize` | `@RequiresIfMatch` + `@ExpectedVersion` | `PromptTestResultResponse` (unchanged shape) |

**Finalize re-fetches the generated text server-side** from SMR `GET /api/v1/tasks/:taskId`
(the `content` field — `apps/smr/src/smr/models/responses.py:91`). The client never supplies
the output: accepting it from the body would let any caller forge `lastTestOutput`.

`smr.finalize` is **removed as a fallback**, not repointed. With a SYSTEM `smr.test` row
seeded, the tenant-row → SYSTEM-row cascade inside `AiTaskDefaultService.getEffective` is
the only fallback the Test path needs, and it never reads a harness key.

Credential/profile enrichment is **extracted, not duplicated**: `applyTenantProviderOverrides`
and `applySmrRuntimeProfile` move out of `SmrProxyController` into a shared applications-layer
service that both the proxy and prompt-management call, so one implementation exists.

### Test list (TDD — write these first, watch them fail)

**`packages/applications` — `prompt-management.service.test.ts`**
1. `testPromptTemplate` with `dryRun: true` returns the assembled prompt and **never**
   calls the SMR client (assert the http mock is not invoked).
2. Non-dry-run returns `{ taskId, streamUrl }` and does **not** await a completion.
3. Model selection reads `IAiTaskDefaultService.getEffective('smr.test', tenantId)`;
   assert `HarnessPolicyService` is not injected and not called.
4. An explicit `{ provider, model }` in the request wins over the resolved default
   (existing `assertKnownSmrModel` validation preserved).
5. `smr.test` unresolved for the tenant → falls through to the SYSTEM `smr.test` row;
   still unresolved → throws a `BadRequestException` naming the key (fail-closed, no
   silent platform model).
6. A lookup **error** (as distinct from a miss) propagates and is logged — no bare `catch {}`.

**`apps/api` — `prompt-management.controller.test.ts`**
7. `POST :id/test` responds in well under a second with the ack body.
8. A `smr_task:<taskId>` stream ticket can be minted for the returned task id.
9. Non-dry-run persistence of `lastTestScore/lastTestOutput/lastTestAt` happens on stream
   completion, under OCC, and a cross-tenant template id still 404s.

**`packages/database` — seed test (extend `ai-model-consolidation-seed.test.ts`)**
10. A SYSTEM `smr.test` `AiTaskDefault` row exists.

**`apps/admin-console` — `test-run-panel` tests**
11. Panel renders streaming tokens as they arrive.
12. Dry run renders the assembled prompt with no stream opened.
13. Stream error surfaces `toast.error` and leaves the panel recoverable.

### File order

| # | File | Change |
|---|---|---|
| 1 | `packages/database/src/prisma/db_main/seed/16-ai-task-default.ts` | Seed SYSTEM `smr.test` (CREATE-ONLY, mirroring the `smr.finalize` row) |
| 2 | `packages/applications/.../prompt-management/prompt-management.service.ts` | Drop `HarnessPolicyService`; inject `IAiTaskDefaultService`; rewrite `resolveTestSmrTarget` (miss vs error split); make `dryRun` skip generation; convert `callSmrGenerate` → ack-returning job submit routed through the proxy's selection/override chain |
| 3 | `packages/applications/.../prompt-management/prompt-management.service.module.ts` | Swap the module import |
| 4 | `packages/applications/.../prompt-management/dto/` | `PromptTestAckResponse { taskId, streamUrl }`; dry-run response carries `assembledPrompt` |
| 5 | `apps/api/src/modules/prompt-management/prompt-management.controller.ts` | Ack response; re-evaluate `@RequiresIfMatch` now that the POST no longer writes (the OCC write moves to stream completion) |
| 6 | `apps/api/src/modules/auth/auth.controller.ts` | Confirm `smr_task` ticket minting covers this task id (add to `NON_CONSULTATION_ID_SCOPES` handling if needed) |
| 7 | `apps/admin-console/src/features/agents/api/client.ts` + `hooks.ts` | `testTemplate` returns the ack; add a task-stream hook modelled on `playground-llm/api/use-task-stream.ts` |
| 8 | `apps/admin-console/src/features/agents/components/test-run-panel.tsx` | Live token rendering; `<Skeleton />` while queued; scoring on completion |

### Explicitly out of scope

- **Harness / agent routing.** `HarnessPolicyService`, `smr.live`, `smr.finalize`, and the
  agent plane are owned by the in-progress agent work in another session. This ticket only
  **removes** the Test path's dependency on them; it changes no harness behavior and adds
  no harness key.
- CDN configuration. The ack makes the 524 structurally impossible; no Cloudflare timeout
  change is requested or needed.
- LM Studio throughput. Slow local inference is a real constraint but not this bug — once
  the tenant's Azure OpenAI selection is honored, the Test path stops touching LM Studio.

### Verification criteria

- [ ] `POST :id/test` returns in < 1s on `hope-v2-dev` through the CDN; no 524.
- [ ] SMR audit log for a test run shows the **tenant's** provider/model and a non-null
      `tenant_id`, with `funding: 'tenant'` where the tenant holds the connection.
- [ ] A usage-ledger row is written for the run.
- [ ] `dryRun: true` performs zero SMR generation (assert against the SMR access log).
- [ ] A tenant with no `smr.test` and no SYSTEM `smr.test` gets a clear 400, never a
      silent platform model.
- [ ] `pnpm --filter @arcaai/applications test`, `pnpm test:unit`, and
      `pnpm --filter @arcaai/admin-console build lint test` green (output pasted below).

---

## Implementation Summary

### Step 1 — SYSTEM `smr.test` seed (done)

`packages/database/src/prisma/db_main/seed/16-ai-task-default.ts` gains the tenth SYSTEM
row (`86000000-0000-0000-0000-000000000010`, `smr.test` → `lms-gemma-4-e2b-it-qat`),
CREATE-ONLY like its siblings and seeded at the same platform default so nothing changes
for tenants that never override it. Tests extended in
`seed/__tests__/ai-model-consolidation-seed.test.ts` (task-type map, count 9 → 10, slug
assertion, and the three count-coupled cases).

RED first — `expected 10 to be 9` — then green:

```
 Test Files  1 passed (1)
      Tests  45 passed (45)
   Duration  629ms
```

### Steps 2-6 — backend (done)

| File | Change |
|---|---|
| `packages/applications/.../smr-request/smr-request-enrichment.service.ts` (new) | `SmrRequestEnrichmentService` — the bodies of `applyTenantProviderOverrides` + `applySmrRuntimeProfile` MOVED VERBATIM out of `SmrProxyController`. Same fail-open semantics, same `assertProviderAvailable` outside the catch, same caller-wins profile merge. `applySmrModelSelection` deliberately NOT moved — model identity stays each caller's concern |
| `…/smr-request/smr-request.service.module.ts`, `index.ts` (new) + `services/index.ts` | Module + barrel exports |
| `apps/api/.../streaming/smr-proxy.controller.ts` | Both methods now delegate to the shared service (constructed in the constructor body from the controller's own already-injected deps, so every positional test fixture keeps its arity). Now-unused `isCloudByoProvider` / `assertProviderAvailable` / `ResolvedProviderOverrides` imports dropped |
| `…/prompt-management/dto/prompt-test-ack.response.ts` (new) | `PromptTestAckResponse { mode, provider, model, assembledPrompt, taskId?, streamUrl? }` |
| `…/prompt-management/dto/finalize-prompt-test.request.ts` (new) | `FinalizePromptTestRequest { taskId, expectedVersion? }` |
| `…/prompt-management/dto/test-prompt-template.request.ts` | Docblock rewritten (the `smr.test → smr.finalize` cascade and the blocking/OCC description were both wrong); `expectedVersion` marked deprecated on this route |
| `…/prompt-management/IPromptManagementService.ts` | `testPromptTemplate` → `startPromptTemplateTest` + `finalizePromptTemplateTest` |
| `…/prompt-management/prompt-management.service.ts` | `HarnessPolicyService` injection REMOVED (grep-clean); `IAiTaskDefaultService` injected in its slot; `SmrRequestEnrichmentService` appended. `resolveTestSmrTarget` reads `getEffective('smr.test', tenantId)` with `azure → azure-openai` mapping, **no** `smr.finalize` fallback, and a MISS (fail-closed `BadRequestException` naming the key) split from an ERROR (logged + rethrown). `callSmrGenerate` → `submitSmrGenerationJob` (`stream: true`, enriched body, `X-Tenant-Id`) + `fetchSmrTaskOutput` (`GET /api/v1/tasks/:id`, 404 → `NotFoundException`, non-terminal state → `BadRequestException` naming the state). `dryRun` short-circuits before any SMR call |
| `…/prompt-management/prompt-management.service.module.ts` | `HarnessPolicyServiceModule` → `AiTaskDefaultServiceModule` + `SmrRequestServiceModule` |
| `apps/api/.../prompt-management/prompt-management.controller.ts` | `POST :id/test` → `startPromptTemplateTest`, `@RequiresIfMatch()` REMOVED (it no longer writes); new `POST :id/test/finalize` → `finalizePromptTemplateTest` with `@RequiresIfMatch()` + `@ExpectedVersion()` (header wins). Both keep `@Authorize(['update','PromptTemplate'])` |

Tests: `__tests__/smr-test-routing.test.ts` rewritten (AiTaskDefault-only resolution,
azure mapping, miss-vs-error split, caller-pinned pair short-circuit, harness never
consulted); the ~15 `testPromptTemplate` cases in `prompt-management.service.test.ts`
converted to the two-call shape with every prior behaviour preserved, plus the new
BUG-018 cases (dry run makes zero SMR calls; the submit acks without fetching the
completion; the outgoing body is enriched and carries `X-Tenant-Id`; non-terminal and
unknown task ids; fail-closed miss; propagated lookup error). Controller tests split into
submit + finalize describes.

Evidence:

```
$ pnpm --filter @arcaai/applications test
 Test Files  452 passed | 1 skipped (453)
      Tests  8594 passed | 4 skipped (8598)

$ pnpm --filter @arcaai/applications build      # tsc, clean

$ pnpm test:unit          (root vitest, integration/e2e excluded)
 Test Files  956 passed | 2 skipped (958)
      Tests  16337 passed | 4 skipped | 9 todo (16350)
   Duration  264.95s
 + packages/ui, @arcaai/vox (255 files / 4131 tests), compat-playground (21/223),
   admin-console (172/1339) — all passed

$ pnpm api:lint
 ✖ 65 problems (0 errors, 65 warnings)   # pre-existing warnings only

$ grep -rn "HarnessPolicy" packages/applications/src/services/prompt-management/
 (no output)
```

Also updated: `apps/api/tests/e2e/task-635-prompt-test-bench.spec.ts` — the spec asserted
the old contract (`428` on a missing `If-Match` for `:id/test`, an output/score/version body,
and a `_version` bump on the submit). Rewritten to the two-call shape: the dry run is now a
HARD assertion (it makes no SMR call, so it is deterministic), the stream submit asserts
`{ taskId, streamUrl }` plus a `< 30s` latency bound and no `_version` change, and the
`428`/OCC gates moved onto `:id/test/finalize`.

### Steps 7-8 — admin console

Owned by a parallel session against the contract above.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-11 | **Pinned-snapshot scoring gap closed.** Splitting the call introduced a way to lose the tested identity: `finalize` originally carried only `taskId`, so a run started with `versionNumber` was scored against the MUTABLE draft (`variablesDeclared: 0` instead of `2` — caught by a new failing test). `FinalizePromptTestRequest` gains an optional `versionNumber`; `finalizePromptTemplateTest` resolves the same `PromptVersion` snapshot before scoring; the console captures the run's version in a ref (`runVersionRef`) and echoes it at finalize, since the version picker may move while the stream runs. |
| 2026-08-11 | Backend implemented (steps 2-6): shared `SmrRequestEnrichmentService` extracted from the SMR proxy, prompt-test split into submit (ack) + finalize (OCC write), harness policy removed from the prompt-management path, `dryRun` no longer generates. |
| 2026-08-11 | Ticket opened. Diagnosed from `hope-v2-dev` API/SMR pod logs plus code trace. Filed as BUG-018: the requested number BUG-017 is already taken by `BUG-017-STT-CUDA-Pywhispercpp-Shared-Library`. Four defects recorded; plan written; harness/agent coupling scoped out to the agent program. |
