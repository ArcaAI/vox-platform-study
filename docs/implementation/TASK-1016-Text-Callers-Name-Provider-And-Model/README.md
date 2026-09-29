# TASK-1016 — Peer callers of `apps/text` name a provider and a model

| Field | Value |
|---|---|
| Status | **Review** — OD-1 (a) implemented, OD-2 split to TASK-1017; merged into `dev-2.2`; **live-proven on the dev stack 2026-09-29** (two further defects found and fixed by the live run) |
| Type | bugfix |
| Branch | `agent/eloquent-boyd-928da8`, based on `dev-2.2` @ `d211119f6` (TASK-1012 W-3 merge) |
| Services | `apps/nlp`, `apps/harness`, `apps/api` (gateway), `packages/applications`, `packages/database` (seed) |
| Related | TASK-1017 (vision extraction — OD-2), TASK-1012 (text `provider` required), TASK-863/876 (agent resolution, `textPrimary`), TASK-957 F-7b, TASK-664 (reasoning lane), TASK-882/890 (loop config) |

## Requirement Analysis

`apps/text` `POST /generate` has no default model: a missing or blank `model` gets a 422
(`apps/text/src/text/api/endpoints/generate.py`). Since TASK-1012, `GenerateRequest.provider` is
required too (`apps/text/src/text/models/requests.py`). Four callers sent neither, so every call
they made was refused:

| Caller | What it sent |
|---|---|
| `apps/nlp/src/nlp/services/external_text_client.py` (`/classify/topic`, `/classify/intent`) | `{prompt, stream, system_prompt}` |
| `apps/harness/.../temporal/activities.py` `plan_reasoning` | `prompt`, `system_prompt`, `context` — no provider/model |
| `apps/harness/.../temporal/activities.py` `run_specialist` | same |
| `apps/harness/.../temporal/activities.py` `vision_extract_text` | same, and **no image** (only the item's text) |

The job: find where each caller's model should come from under the agent/workflow architecture (no
hardcoded model, no env default, rule 09), fail closed with a named reason when nothing resolves,
and keep Temporal replay compatibility.

## Current State Evaluation (verified 2026-09-29 against `dev-2.2` @ `d211119f6`)

### NLP: topic/intent have no selection plane at all

The brief assumed that `apps/nlp` already resolves an `nlp.*` `AiRoutingPolicy` key. It doesn't.
`apps/nlp` resolves no config of its own. The **gateway** resolves the SYSTEM routing election and
injects the result: `model_name` for `nlp.ner` / `nlp.diagnosis` / the `/classify/text` keys
(`apps/api/src/modules/ai-inference/ai-inference.controller.ts`, `resolveDefaultModelSelection`).
For `/classify/topic` and `/classify/intent` the gateway injects only `instructions` and
`tenant_id`, with no model. `packages/applications/src/services/ai-routing-policy/constants.ts`
names this outright: `nlp.topic` / `nlp.intent` model selection is "a pre-existing governance gap
`assertKnownTaskKey` still rejects". Those two keys are also classified `TEXT_CLASSIFICATION`,
which is an encoder kind, but the route actually delegates to an LLM. The effect today: text
answers 422, `ExternalTextClient` retries it as if it were an outage, and the caller gets a
generic 503 "Topic classification is not available".

### Harness: planner and specialist are replay-only; vision is live

- `LoopConfigService` (`packages/applications/src/services/consultation/loop/loop-config.service.ts`)
  always answers `reasoningEnabled: false, agents: []`, because the deliberative lane retired with
  `DepartmentAgentRole`. `_maybe_plan` therefore never schedules `plan_reasoning`, and no
  specialist is ever planned. Both activities survive only for replay of recorded histories
  (`consultation_loop_task664_reasoning_history`). They are not a live 422 source today.
- `vision_extract_text` **is** live. `PRIMITIVE_DEFAULT_ACTIONS.IMAGE = ['vision.extract_text', …]`,
  so every IMAGE context item dispatches it, and every dispatch was a 422 that got swallowed as
  `derived=False`. No selection plane exists for it either. `AgentTask` has no vision member
  (`SPEECH_TO_TEXT | TEXT_GENERATION | TEXT_TO_SPEECH | NAMED_ENTITY_RECOGNITION`). The
  `vlm.extract` routing key exists, but it has no harness-reachable resolve, no runtime consumer,
  and deliberately no SYSTEM default (seed `16-ai-routing-policy.ts`). The activity also never
  sent the image: text accepts one only as `content_parts`.
- Once the loop activities get a real (possibly cloud) provider, they would send consultation
  context past the PHI egress guard that `generate` and `core.agent` apply. The fix has to add
  that guard.

## Implementation Plan

### Decisions taken (owner may override)

| # | Decision | Why |
|---|---|---|
| D-1 | **nlp:** the selection is **gateway-injected** as `text_provider` + `text_model` on the topic/intent request body. `ExternalTextClient` requires both (keyword-only) and puts them on the `/generate` body. If either is absent, the route answers a **named 503** (`"<Task> classification model not selected for this tenant"`, log `nlp.<task>.text_model_unselected`) **before** calling text. | Same shape as `model_name` on `/classify/text`: `apps/nlp` stays stateless. Checking before the call names the real cause and stops wasted retries of a request text can only refuse. The gateway half is OD-1. |
| D-2 | **planner:** runs on the consultation's **PRIMARY agent**. The workflow passes `planner_agent_slug=primary.slug` (new additive-optional `PlanLoopInput` field). The activity resolves it through `GET /internal/agents/resolve` → `textPrimary` (provider via `wire_provider`, provider-native model, one-hop `providerOverride`). | The planner prompt is literally "you are the primary clinical documentation agent". Using the resolution `core.agent` uses means no second resolver. |
| D-3 | **specialist:** runs on its **own** agent (`SpecialistAnalysisInput.agent_slug`, already on the input), same resolution. | A specialist is an agent. It needs no workflow change. |
| D-4 | **Fail-closed reasons:** planner → degraded `PlanDecision`, rationale `planner_agent_unresolved: …`, dispatches nothing. Specialist → non-retryable `ApplicationError(type="specialist_agent_unresolved")`, which the parent already turns into `degraded`. Vision → `DeriveContextResult(derived=False, reason="vision_model_unselected")` (new additive-optional field), with **no call to text**. | Matches each activity's existing failure posture (planner degrades, specialist fails alone, deriver ends its branch). A retry would ask the same resolver the same question, so unresolved is non-retryable. |
| D-5 | Planner and specialist apply the **same fail-closed PHI egress guard** as `generate`, using the tenant's effective policy (`get_policy`). A block degrades the planner and fails the specialist. | Without it this fix would open a PHI-to-cloud path. |

### Owner decisions

- **OD-1: gateway selection for `nlp.topic` / `nlp.intent`. DECIDED 2026-09-29: (a).** Before the
  decision both routes
  answer the named 503 from D-1. Before this change they answered an opaque 503 after retries,
  so user-visible behaviour does not regress.
  - **(a) — recommended.** Register `nlp.topic` / `nlp.intent` as `AiRoutingPolicy` task keys of
    kind **TEXT_GENERATION**, seed SYSTEM defaults, and have `AiInferenceController` inject
    `text_provider` + `text_model` the way it injects `model_name`. This follows rule 06 / 09
    ("AiRoutingPolicy for … NLP") and closes the governance gap the code already names. It
    widens `AI_TASK_KEYS`, which the code comment calls an owner-facing decision.
  - **(b)** Resolve the tenant's assigned TEXT_GENERATION **agent** (`department → tenant`) and
    inject its `textPrimary`. This reuses a clinical agent's model for a classification task,
    and its prompt/parameters would be ignored.
- **OD-2: vision extraction.** A real fix needs two things: (i) a selection plane, most likely
  `vlm.extract` resolved gateway-side and handed to the loop (a new internal resolve or a field on
  the pinned loop config), and (ii) the image delivered as text's `content_parts`. It fits better
  as its own ticket. Until then the activity fails closed as in D-4. **DECIDED 2026-09-29: separate
  ticket → TASK-1017.**
- **OD-3: the retired deliberative lane.** `plan_reasoning` / `run_specialist` are unreachable
  live. They are fixed here so a replayed or re-enabled lane cannot 422. Once no
  pre-retirement histories remain, the owner may prefer to retire them through the deprecation
  register. That needs its own drain, per rule 06's vocabulary note.

### TDD test list

| Test | Asserts |
|---|---|
| `apps/nlp/tests/test_task1016_topic_intent_text_selection.py` (12 cases) | the client puts provider + model on the body; a blank selection raises before any HTTP call; both routes forward the injected pair; a missing or blank pair is a named 503 with text never called |
| `apps/harness/.../temporal/test_task1016_loop_text_selection.py` (7 cases) | planner uses the primary agent's provider/model; no slug or an unresolvable slug degrades with `planner_agent_unresolved` and no text call; a cloud planner is blocked by the PHI guard; the specialist uses its own agent's provider/model/`providerOverride`; a specialist with no agent raises a non-retryable `specialist_agent_unresolved`; vision never calls text and returns `vision_model_unselected` |
| `test_reasoning_loop_workflow.py::…::test_the_planner_is_handed_the_primary_agents_slug` | the workflow threads `primary.slug` into `PlanLoopInput` |

## Implementation Summary

### Files changed

| File | Change |
|---|---|
| `apps/nlp/src/nlp/schemas/classification.py` | `text_provider` / `text_model` (gateway-injected) on `TopicClassificationRequest` and `IntentClassificationRequest` |
| `apps/nlp/src/nlp/services/external_text_client.py` | `generate_label[_with_usage]` require keyword-only `provider` + `model`, raise `ValueError` on a blank one, and send both |
| `apps/nlp/src/nlp/api/v1/rest/classify.py` | `_require_text_selection` → named 503 before the peer call; forwards the pair |
| `apps/harness/src/harness/temporal/models.py` | `PlanLoopInput.planner_agent_slug`, `DeriveContextResult.reason` (both additive-optional) |
| `apps/harness/src/harness/temporal/workflows.py` | passes `planner_agent_slug=primary.slug`. Input only: no new command. |
| `apps/harness/src/harness/temporal/activities.py` | `_resolve_loop_text_selection` (agent resolve → `textPrimary` + effective policy), `_loop_egress_safe`; `plan_reasoning` / `run_specialist` name provider + model + override; `vision_extract_text` fails closed |
| Tests | 2 new files; fixtures updated in `test_external_text_client.py`, `test_classify_topic_intent.py`, `test_task957_llm_usage_passthrough.py` (their calls and bodies now carry the required selection); 1 test added to `test_reasoning_loop_workflow.py` |

**OD-1 (a), gateway half:**

| File | Change |
|---|---|
| `packages/applications/src/services/ai-routing-policy/constants.ts` | `nlp.topic` / `nlp.intent` join `AI_TASK_KEYS`, kind **TEXT_GENERATION**, model task type `TEXT_GENERATION`; the `AI_TASK_KIND_BY_UNREGISTERED_TASK_KEY` side table is gone. Both stay under the platform-only `nlp.` prefix (SUPER_ADMIN writes, SYSTEM-tier read), like every other `nlp.*` key. |
| `packages/database/src/prisma/db_main/seed/16-ai-routing-policy.ts` | kind mirror → TEXT_GENERATION; two SYSTEM elections `89000000-…-000000000013` (`nlp.topic`) / `…014` (`nlp.intent`) → `lms-gemma-4-e2b-it-qat` (owner directive 2026-09-03, same model as `harness.judge`). CREATE-ONLY like the rest. |
| `apps/api/src/modules/ai-inference/ai-inference.controller.ts` | `resolveTextSelection(taskKey)`: the SYSTEM election → `text_provider` (`textWireProvider`, so `azure` → `azure-openai`) + `text_model` (the model's **wire** id, the same projection `toTextCandidate` uses). Missing election / provider / wire id ⇒ 503, NLP never called. |
| `apps/api/openapi.json`, `apps/admin-console/src/server/api-docs/openapi.admin.json` | regenerated: `nlp.topic`, `nlp.intent` added to the two `taskKey` query enums of `admin/ai-routing-policies` (+4 lines each, nothing else). `route-manifest.json`, `openapi.business.json` and `packages/vox-node/src/resources/admin/**` regenerated with **no drift**. |
| `apps/nlp/README.md` | documents the injected selection. |
| Tests | new `ai-inference.topic-intent-selection.task1016.test.ts`; vocabulary / taxonomy / seed tests updated. `ai-task-kind.test.ts` names the reclassification explicitly (`RECLASSIFIED_SINCE_SQL`): the task_843 backfill recorded TEXT_CLASSIFICATION for the two keys while they were unregistered. |

**No data migration.** No `AiRoutingPolicy` row can carry either key: `assertKnownTaskKey` refused
them until now, no seed ever elected one (git history of `seed/16-*` carries only the kind
mirror), and the dev DB holds only `nlp.ner` / `nlp.diagnosis` rows for `nlp.*` (queried
2026-09-29). A cold seed or `hope-reset` elects the two new defaults. **An already-seeded
database gets them only when the seed runs again** (CREATE-ONLY adds missing keys, it never
overwrites), or when a super admin elects them through `admin/ai-routing-policies`. Until then
topic/intent answer the gateway's 503.

**Side effect checked:** `EffectiveConfigService.resolveModelWeights('nlp')` now also lists the gemma
slug. `apps/nlp` reads no `modelWeights` at all, so it has no effect. `harness.judge` (also
TEXT_GENERATION) already rides the same path.

### Evidence

All runs used the `arcaenv` interpreter from the worktree root. Each service's conftest
worktree guard ran. The RED→GREEN flip came from editing only worktree files, so the tests ran
against in-tree source.

**RED (before the fix):**

```
apps/nlp/tests/test_task1016_topic_intent_text_selection.py — 12 failed
  TypeError: ExternalTextClient.generate_label_with_usage() got an unexpected keyword argument 'provider'   (x4)
  assert 500 == 200 (x2) / assert 500 == 503 (x6)   # routes never forwarded or checked a selection

test_task1016_loop_text_selection.py + TestPlannerIsAnActivity — 8 failed, 2 passed
  ValidationError: PlanLoopInput extra_forbidden (planner_agent_slug)            (x4)
  run_specialist: assert [] == ['cardiology']        # never resolved an agent
  run_specialist: DID NOT RAISE ApplicationError
  vision_extract_text: assert [{'tenant_id'…, 'prompt'…, 'context'…}] == []   # text called with NO provider/model
  AttributeError: 'PlanLoopInput' object has no attribute 'planner_agent_slug'
```

**GREEN:**

```
harness: test_task1016_loop_text_selection.py + test_reasoning_loop_workflow.py + test_replay_compat.py
  67 passed in 4.92s
  incl. TestConsultationLoopReplayCompatibility::test_reasoning_history_replays_on_current_definition PASSED
        (the frozen task664 history that schedules plan_reasoning)
  test_replay_compat.py alone: 23 passed

nlp: test_task1016_topic_intent_text_selection.py test_external_text_client.py test_classify_topic_intent.py
     test_task957_llm_usage_passthrough.py test_task799_peer_token_and_tenant.py
     test_task799_byok_credentials.py test_peer_call_semaphore.py
  76 passed in 4.21s

ruff check apps/nlp/src/ apps/nlp/tests/   → All checks passed!   (= pnpm nlp:lint)
ruff check apps/harness/src/               → All checks passed!   (= pnpm harness:lint)
black --check -l 100 on every touched file → clean
```

**Not run** (out of the brief's scope): full service suites, mypy, the gateway, e2e. `pnpm
<svc>:*` could not be used as-is, because the sandbox shell's `conda` function fails
(`__conda_exe: permission denied`). The same commands were run with
`~/miniconda3/envs/arcaenv/bin/{python -m pytest,ruff,black}`.

**OD-1 (a) — RED (before the gateway change), 14 failed:**

```
ai-inference.topic-intent-selection.task1016.test.ts   8 × (client called without text_provider/text_model; 503 never raised)
ai-task-kind.test.ts                                    2 × (nlp.topic not in AI_TASK_KEYS; TEXT_GENERATION bound to harness.judge only)
task-key-vocabulary.test.ts                             1 ×
ai-model-consolidation-seed.test.ts                     1 × (expected 9 to be 11)
task-858-text-generation-defaults.test.ts               2 × (nlp.topic / nlp.intent is not seeded)
```

**OD-1 (a) — GREEN** (worktree install: its own `.pnpm` store, `lock.yaml` identical to
`pnpm-lock.yaml`; Prisma client generated with a dummy URL; deps built with turbo in the worktree
— nothing built in the primary, whose watch-mode API was running):

```
npx vitest run ai-routing-policy/__tests__/ ai-inference/__tests__/ seed/__tests__/ (routing + 858)
               tests/contracts/routing-task-model-compatibility.contract.test.ts
               effective-config/ tenant-nlp-task-instructions/
  Test Files  85 passed (85)   Tests  1236 passed (1236)
npx vitest run harness-policy/ harness-internal.model-resolve (app + api) ai-routing-policy (api) settings-registry/
  Test Files  63 passed (63)   Tests  637 passed (637)
turbo build --filter=@arcaai/api...    12 successful
pnpm api:openapi:check                 [openapi-coverage] OK
pnpm api:portal:check                  no drift (admin 656 ops, business 190 ops)
vox-node gen:admin:check               no drift (48 areas, 426 routes, 487 schemas)
eslint (changed sources)               0 errors; prettier: the one file I un-formatted re-formatted,
                                       three files were already unformatted at HEAD and are left alone
```

### Live proof (2026-09-29, dev stack from the primary on `dev-2.2`)

**Reseed** (non-destructive, no reset): `NODE_ENV=development RUN_SEED=safe pnpm db:seed` →
`Seeded AiRoutingPolicy defaults: 2 created, 8 skipped, 1 unresolved`. `nlp.topic` and
`nlp.intent` → `lm-studio` / `gemma-4-e2b-it-qat`, TEXT_GENERATION, ACTIVE. The unresolved one
is the pre-existing disabled `nlp.classification` placeholder.

**Stack:** `pnpm stack:dev -- api nlp text guardrail`, LM Studio `gemma-4-e2b-it-qat` at 16k. As
the ARCAAI tenant admin: `PUT admin/nlp-task-instructions/row?taskKey=nlp.topic` with
`["billing","appointments","medical_records"]`, then `POST /api/v1/text-analyses/topic`.

The live run found two more defects on this path, fixed TDD-style (RED → GREEN) and merged:

1. **NLP posted to `{TEXT_URL}/generate`** (404 on every call). `TEXT_URL` is the fleet-wide
   bare origin, and text mounts `/api/v1/generate`. Fix: `GENERATE_PATH` (`210f59d2f`).
2. **No connection reached text** (503 `PROVIDER_CREDENTIALS_MISSING`). Text holds no endpoint
   or credential and reads only the `provider_overrides[provider]` entry its caller forwards.
   Fix: the gateway resolves the connection through the shared
   `TextRequestEnrichmentService` (tenant → SYSTEM, veto + entitlement gate unchanged) and
   injects `text_provider_overrides`. NLP requires it (`repr=False`) and forwards it one hop.
   A missing connection is a named 503 at the gateway. `emit-openapi` bootstraps the full Nest
   app, which proves the new DI import resolves; the documents are unchanged (`c23741191`).

**Environment repair (not code):** the dev Vault had restarted before this session, which
voided the seeded Transit ciphertext of every `AiProviderConnection` key (`Provider credential
failed to decrypt … provider=lm-studio, keyVersion=1`). That breaks **every** text call on the
dev stack, not just this route. Only the SYSTEM `llm/lm-studio` row was re-keyed
(`PUT admin/providers/llm/lm-studio?tenantId=00000000-…`, super admin, `If-Match: "2"`, the
keyless-local placeholder). The other self-hosted rows (`vllm`, `ollama`, `llama-cpp`) and any
BYO keys are still undecryptable on the dev DB.

**Result:**

```
"Please send me a copy of my blood test results and my discharge summary."  201  predicted_topic=medical_records
"I was billed twice for my cardiology consultation last week."             201  predicted_topic=billing
"My chest pain follow-up visit needs to move to next Tuesday."             201  predicted_topic=appointments
  each: llm_usage.provider=lm-studio  model=gemma-4-e2b-it-qat
        connection_id=87000000-0000-0000-0000-000000000002 (SYSTEM)  cost_basis=INTERNAL   (~3.7–4.5 s)
```

**Expected refusal, not a defect of this ticket:** a purely non-clinical utterance ("I need help
understanding my last invoice, please.") is refused by text's input **medical-relevance
guardrail**: 422 `CONTENT_BLOCKED_NOT_MEDICAL`, reproduced directly against text. NLP then retries
that deterministic 422 3× and answers an opaque 503. Whether open-taxonomy topic/intent should be
screened for medical relevance at all (topics like `billing` suggest not) is an **owner
decision** (a per-call `guardrail_policy` opt-out exists since TASK-890 OD-R).

### Follow-ups (not in this ticket)

- `ExternalTextClient` retries **every** exception, including a deterministic 4xx from text. With
  D-1 the missing-selection case no longer reaches text, but any other 4xx would still be
  retried as if it were an outage.
- `apps/api/tests/e2e/task-729-nlp-task-expansion.spec.ts` still posts to `/api/v1/ai/nlp/topic`, a
  redirect shim TASK-1012 D-3 deleted. The live route is `/api/v1/text-analyses/topic`, so that
  spec now meets a 404 its `[200, 503]` expectation does not allow.
- Owner decision: should topic/intent opt out of the input medical-relevance guardrail? (See
  Live proof.)
- Dev Vault: re-key the remaining self-hosted SYSTEM connections, or reseed from a reset, when
  their providers are needed.
- Vision extraction (OD-2) → TASK-1017.

## Change History

| Date | Change |
|---|---|
| 2026-09-29 | Ticket opened (drafted as TASK-1014; renumbered to TASK-1016 because a parallel session merged its own TASK-1014 and opened TASK-1015 in the meantime). Root cause verified, RED tests, fix, GREEN + replay-compat + lint evidence. ODs 1–3 raised. |
| 2026-09-29 | Owner: OD-1 → (a), OD-2 → separate ticket (TASK-1017), go. Gateway half implemented (routing keys + seed elections + injection), artifacts regenerated, merged into `dev-2.2`. |
| 2026-09-29 | Owner: "reseed the dev db and prove topic live". Non-destructive `RUN_SEED=safe` reseed created the two elections. The live run found and fixed the NLP `/generate` path (404) and the missing connection injection (503 PROVIDER_CREDENTIALS_MISSING), both merged. Re-keyed the dev SYSTEM `lm-studio` connection after a Vault restart. Topic proven live: 3/3 correct labels on gemma via the SYSTEM connection. Medical-relevance guardrail refusal of non-clinical text recorded as an owner decision. |
