# TASK-968 — Reasoning off for text generation, and a governed judge posture

| | |
|---|---|
| **Status** | Completed |
| **Type** | bugfix |
| **Branch** | `dev-2.2` |
| **Owner directives** | 2026-09-13 — (1) "disable reasoning feature for any text generation LLM models"; (2) for harness, "avoid to declare ENV variable as much as possible, and give the platform admin to control as much as possible" |

## Requirement Analysis

The ask began as a review of the ArcaAI agent + workflow SEED data and widened, on the owner's
instruction, to every defect of the same class: a text-generation LLM whose reasoning posture is
left to the engine, or decided by an environment variable instead of by a platform admin.

"Disabled" is not silence. `parameters.generation.reasoning.enabled: false` reaches the wire as
`reasoning_effort: 'minimal'` — the engine's own off switch (`agent-reasoning.ts`, TASK-891 OD-4).
An ABSENT posture is the opposite: it is the engine's default, which is the state TASK-891
measured at **5168 ms / 184 reasoning tokens against 1237 ms / 30** on `gemma-4-e2b-it-qat`.
Every defect below is a variant of "absent, therefore on".

## Current State Evaluation

### Seed data — 35 agents, 29 of them `TEXT_GENERATION`

| Source | Agents | Posture before |
|---|---|---|
| `25-agents.ts` SYSTEM + Global | `case-notes-pre-summary`, `general-medicine-summarization` | `{ enabled: false }` ✅ |
| `25-agents.ts` SYSTEM + Global | **`casenote-finalization`** | **absent** ❌ |
| `29-arcaai-agents-and-workflows.ts` | 22 department agents + ArcaAI's own warm start | `{ enabled: false }` ✅ |

One gap, and it is the agent every consultation ENDS on: `n_finalize` in all 11 ArcaAI department
graphs and both library workflows. Phase 26 clones `parameters` verbatim, so every tenant
inherited it.

It was not an oversight. TASK-891 **C3** says: *"Seed the platform agents with
`reasoning.enabled: false` for the **realtime** tier … leave the finalize tier as-is."* The owner
directive reverses that carve-out, and the code comment says so rather than pretending the line
was always meant to be there.

**Workflows: nothing to change.** All 13 seeded graphs reach an LLM only through `core.agent`
nodes — zero `generation` / `reasoning` overrides in the authored graphs or in the compiled
blobs (`grep -c reasoning` = 0 in both `.generated.ts` files). `task-930-workflow-seeds.test.ts`
re-runs the real compiler and stays green, so no regeneration was needed.

### Runtime — two call sites resolved the posture and threw it away

Both are TASK-891 C2's defect one call site later: `resolveTextSelection()` returns
`{ provider, model, generation }` and the caller kept the first two.

| Where | What happened |
|---|---|
| `dna-writing-style.processor.ts:454` | `({ provider, model } = await …resolveTextSelection())`, then `applyTextRuntimeProfile(textPayload)` with no second argument — a no-op. Every DNA writing-style extraction ran on the engine default. |
| `prompt-management.service.ts:1485/1607` | `resolveTestTextTarget` kept only `{ provider, model }` off the resolved candidate. TASK-876 pointed the bench at the assigned agent precisely so a template is not "tested against a model no consultation would ever run" — and then the bench ran without that agent's posture. |

### Harness judge — an env var was deciding a live clinical pass

`JudgeConfig` (`apps/harness/src/harness/eval/config.py`) carried three `HARNESS_JUDGE_*` fields:
`reasoning_mode` (default `"auto"`), `suppress_reasoning` (`False`) and `extra_body` (`None`).

The important finding is that **`extra_body` is not eval-only.** It is applied inside
`JudgeClient.complete()` at the TRANSPORT layer (`providers.py:311`, `:379`), so it rides every
judge call — including the `GroundednessSensor` and `CitationVerifySensor` that
`run_inferential_sensors` runs from `HarnessDocWorkflow` / `ConsultationLoopWorkflow` on every
real consultation. So an environment variable, immutable for the process lifetime
(`09-infrastructure-devops.md` §Configuration Tiers L1), was deciding a live clinical assurance
pass's token budget — and its default left reasoning on.

`reasoning_mode` / `suppress_reasoning` reach only the PDSQI-9 rubric prompt (`resolve_prompt` →
`NO_THINK_SUFFIX` / `THINK_SUFFIX`), i.e. CI, the promotion gate and the admin run-now endpoint.
They were still env-tier, and `suppress_reasoning` was a second name for `reasoning_mode == "none"`
— the consuming code reads them as one (`if suppress_reasoning or reasoning_mode == "none"`).

## Implementation Summary

### 1. Seed (`packages/database/src/prisma/db_main/seed/25-agents.ts`)

`casenote-finalization` gains `reasoning: { enabled: false }`. All 29 seeded `TEXT_GENERATION`
agents now carry it. `compiledConfig` and its checksum derive from the spec at seed time, so
nothing else regenerates; `lms-gemma-4-e2b-it-qat` DECLARES `reasoning` in
`supportedGenerationParams`, so the publish gate accepts it
(`task-930-agent-publish-gate.test.ts` already asserts both halves).

### 2. Two runtime call sites

- `dna-writing-style.processor.ts` — keeps `generation` from `resolveTextSelection()` and passes
  it to `applyTextRuntimeProfile`. Selection stays the `finalize` task (the default): which agent
  serves is unchanged, only whether its posture reaches the wire.
- `prompt-management.service.ts` — `resolveTestTextTarget` returns `generation` on the agent path
  and `submitTextGenerationJob` forwards it. A caller-pinned `provider`/`model`/`modelId` names a
  raw registry row with no agent behind it, so there is no authored posture and **none is
  invented** — the same refusal `reasoningExtra` makes.

### 3. Harness judge — env out, settings registry in

**New descriptors** (`settings-registry/descriptors/harness-judge.descriptors.ts`, registered in
`registry.ts`). Two keys, because there are genuinely two levers acting in different places:

| Key | Lever | Default | Reaches |
|---|---|---|---|
| `harness.judge.reasoningMode` | PROMPT (`/no_think` vs think-first vs silence) | `none` | the PDSQI-9 rubric judge |
| `harness.judge.reasoningEffort` | WIRE (`extra_body.reasoning_effort`) | `minimal` | **every** judge call, live sensors included |

Both `global-kv` · `maxScope: 'system'` · `globalOnly: true` · `consumedBy: ['harness']` ·
`failMode: 'open-to-default'`, with a `validate` hook per vocabulary. Platform scope matches the
judge's MODEL election, which is already a SYSTEM-only `AiRoutingPolicy` row — governing the
posture at a deeper scope than the model would be incoherent.

Unlike `HARNESS_SENSOR_SETTINGS`, whose defaults were transcribed verbatim so that registering
them changed nothing, **these two deliberately change the value in force.** The deployed judge is
`lms-gemma-4-e2b-it-qat` on LM Studio — exactly the small local judge `NO_THINK_SUFFIX` was
written for.

**New resolver** (`apps/harness/src/harness/eval/reasoning.py`) mirrors
`resolve_sensor_thresholds` deliberately: same pull route, same degradation contract. No snapshot,
a failed pull, an absent key, a null, a wrong type or an out-of-vocabulary value all keep the base
— and the base is reasoning off. An out-of-contract value is REFUSED and logged, never coerced.

**Wiring.** `_build_runtime_judge` takes `reasoning=` and `run_inferential_sensors` resolves it
from `_config_snapshot()` (the live path); `/eval/run` resolves it and `model_copy`s the config.
`ci.py` stays on the in-code floor by design — it is a `python -m harness.eval.ci` process in a
GitLab job where the gateway is unreachable, and a gate wants one fixed, reproducible posture.

**`reasoning_effort` is its own field, always on the wire.** `_reasoning_extra_body` merges it
over `extra_body` on every call, so there is no path on which the judge is left to decide for
itself. `extra_body` survives as the generic passthrough for the OTHER engine knobs
(`chat_template_kwargs`, …) and the governed field wins over a same-named key in it.

**Env closed structurally.** All three fields carry dead `validation_alias` names
(`…__ENV_REMOVED`) — the `apps/tts` pattern the judge CREDENTIAL fields already use. That also
closes field-name construction, which made `_parse_extra_body` and `_validate_reasoning_mode`
unreachable; they were removed rather than left as guards that cannot fire, and the file says
where validation moved to. `model_copy` is the one way in, which is what production uses.

`HARNESS_JUDGE_REASONING_MODE`, `HARNESS_JUDGE_SUPPRESS_REASONING` and `HARNESS_JUDGE_EXTRA_BODY`
are gone from `turbo.json#globalEnv`, both `.env.sample` files and
`scripts/generated/python-env-surface.json`. Registered in
[`docs/operations/deprecation-register.md`](../../operations/deprecation-register.md) §Environment
variables as **removed outright**, with the evidence for why no window applies.

### 4. The TEXT plane gets a second cascade tier

`text.reasoning.defaultEffort` (`settings-registry/descriptors/text-reasoning.descriptors.ts`),
read by `TextRequestEnrichmentService.applyTextRuntimeProfile`. TASK-891 OD-4 gave the posture
exactly ONE tier, so an agent that authored nothing resolved to the ENGINE's default — and
enforcing the directive meant authoring a block on every agent that will ever exist, on every
tenant, forever. Now:

```
the agent's authored block  →  text.reasoning.defaultEffort  →  nothing
```

| | |
|---|---|
| Values | `minimal` \| `low` \| `medium` \| `high` \| `engine-default` |
| Default | `minimal` — the engine's own off switch |
| Scope | `global-kv` · `maxScope: 'system'` · `globalOnly: true` · `failMode: 'open-to-default'` |
| `consumedBy` | **none** — read by the GATEWAY, which owns the agent cascade and is the only layer that can see that an agent authored nothing. `apps/text` forwards `extra_body` verbatim by design |

No `enabled` half, unlike the agent's `{ enabled, effort }`: on this wire `minimal` IS off — it is
what `reasoningExtra` maps `enabled: false` onto — and a second boolean would be a second name
for one state, which is exactly what `HARNESS_JUDGE_SUPPRESS_REASONING` was. `engine-default` is
a member because "give the platform admin control" has to include choosing the state this ticket
removed; the difference is that it becomes a decided state with a row and an admin behind it
rather than the accident of nobody having said anything.

**It fills ABSENCE ONLY**, which is the half most worth stating. An agent that authored
`{ enabled: true }` with no effort still sends nothing — `reasoningExtra` refuses to invent a
budget for an agent that asked to reason without naming one, and the platform tier must not
answer over an opinion. That is `AiProviderConnection`'s rule verbatim (absent = no opinion →
platform default; present = the tenant wins and the platform is not consulted), and it is why
six of the twelve new tests are negative.

Degradation never fails a consultation over a hyper-parameter: an unwired settings facade (every
positional test fixture), a resolve that throws, an out-of-vocabulary stored value and a wrong
type all yield no posture and the call proceeds. The read itself is a synchronous in-memory cache
hit under `resolveEffective`, so it costs nothing on the live flush path.

Registering the descriptor is the whole wiring step — it is reachable from the admin settings
surface automatically, with no per-key allow-list. No SYSTEM row is seeded: `open-to-default`
means an unwritten row already resolves to `minimal`.

## Files Changed

| File | Change |
|---|---|
| `packages/database/src/prisma/db_main/seed/25-agents.ts` | `casenote-finalization` → `reasoning: { enabled: false }` |
| `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts` | keep + forward `generation` |
| `packages/applications/src/services/prompt-management/prompt-management.service.ts` | return + forward `generation` on the agent path |
| `packages/applications/src/services/settings-registry/descriptors/harness-judge.descriptors.ts` | NEW — two descriptors |
| `packages/applications/src/services/settings-registry/descriptors/text-reasoning.descriptors.ts` | NEW — `text.reasoning.defaultEffort` |
| `packages/applications/src/services/text-request/text-request-enrichment.service.ts` | `applyTextRuntimeProfile` gains the platform tier (`platformReasoningExtra`) |
| `packages/applications/src/services/settings-registry/registry.ts` | register both families |
| `apps/harness/src/harness/eval/reasoning.py` | NEW — vocabularies, floor, resolver |
| `apps/harness/src/harness/eval/config.py` | env closed; defaults off; dead validators removed |
| `apps/harness/src/harness/eval/judge/providers.py` | `_reasoning_extra_body`; posture always sent |
| `apps/harness/src/harness/temporal/activities.py` | `_build_runtime_judge(reasoning=…)`; resolve on the live path |
| `apps/harness/src/harness/api/endpoints/eval.py` | resolve + `model_copy` (now async) |
| `apps/harness/src/harness/eval/ci.py` | drop the stale `getattr(..., "auto")` seam |
| `turbo.json`, `.env.sample`, `apps/harness/.env.sample`, `scripts/generated/python-env-surface.json`, `env-surface.generated.md` | three names removed (regenerated) |
| `.gitlab/ci/test.yml` | `harness-eval-gate` no longer sets the removed variable (it would be inert); a comment says the floor now provides it |
| `apps/harness/eval/run-gate.sh` | same, in the local gate runner |
| `apps/harness/eval/README.md` | the two retired rows replaced by a settings table; both runnable examples and the troubleshooting row updated |
| `docs/operations/deprecation-register.md` | removal row |

### Tests

| File | Covers |
|---|---|
| `dna-writing-style.processor.reasoning.task968.test.ts` | NEW — 3 cases, REAL `TextRequestEnrichmentService` |
| `prompt-management.bench-reasoning.task968.test.ts` | NEW — 4 cases, incl. "a pinned model invents no posture" |
| `text-request-enrichment.platform-reasoning.task968.test.ts` | NEW — 12 cases over the REAL `EffectiveSettingsService` + registry: the default, a written row, `engine-default`, four negative cases that prove the tier never answers over an agent's opinion, and four degradation paths |
| `test_task968_judge_reasoning.py` | NEW — 14 cases: floor, both levers, every degradation path, refusal-not-coercion, and the live `_build_runtime_judge` wiring |
| `test_judge_config.py` | REWRITTEN — the env path is closed, `model_copy` is the way in |
| `test_judge_transport.py` | REWRITTEN — the posture is ALWAYS on the wire (the old pair pinned "omitted when not configured", which WAS the defect) |

Both TS tests were verified RED against the unfixed services before the fix, with the defect's own
message:

```
AssertionError: the agent`s reasoning posture never reached the wire: expected undefined to deeply equal { reasoning_effort: 'minimal' }
AssertionError: the bench ran on a posture it had already resolved and dropped: expected undefined to deeply equal { reasoning_effort: 'minimal' }
```

The platform tier was proven RED the same way, and the shape of the failure is the point: only
the THREE widening cases failed against the unfixed service. The nine that pin "an agent with an
opinion is untouched" passed before and after, which is what makes them a guard rather than a
restatement of the new code.

## Verification

```
pnpm --filter @arcaai/database test        91 files / 1813 tests passed
pnpm --filter @arcaai/database typecheck   clean
pnpm --filter @arcaai/applications test     848 files / 13808 tests passed, 2 skipped
pnpm --filter @arcaai/applications typecheck clean
pnpm harness:test                           2616 passed
pnpm harness:typecheck                      Success: no issues found in 155 source files
pnpm harness:lint                           All checks passed!
pnpm env:sync:check                         OK — 12 artifacts match their declarations
pnpm env:python-surface:check               OK — 346 distinct env names across 6 services
```

A post-fix sweep for surviving readers found four operational uses the first pass missed — the
`harness-eval-gate` CI job, `run-gate.sh`, and three places in `apps/harness/eval/README.md` — all
of which would have gone silently inert. They are fixed above; `bash -n run-gate.sh` and a
tolerant YAML parse of `test.yml` both pass.

One PRE-EXISTING failure, unrelated and not caused by this change:
`agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts` needs a live
test database and an unsealed Vault (`Vault is sealed` in teardown). It is an
`**/integration/**` suite, i.e. `pnpm test:integration` territory, and touches nothing here.

## Open items for the owner

1. **`ci.py` runs on the floor, not on the control plane** — deliberate (unreachable gateway in a
   GitLab job), but it means the CI gate and the deployed judge can hold different postures if an
   admin raises `harness.judge.reasoningMode`. Confirm that is wanted, or the gate should read a
   pinned value from the repo instead.
2. **One residual absence, deliberately left.** An agent that authored `{ enabled: true }` with
   no effort still sends nothing and rides the engine's default. It is not an absence — the agent
   stated a posture — so the platform tier correctly declines to answer over it. Closing it would
   mean either inventing a budget at the call site (which `reasoningExtra` refuses on purpose) or
   letting a platform `minimal` contradict an explicit "reason", which inverts the cascade. If it
   matters, the fix is authoring-side: make the agent editor require an effort when reasoning is
   enabled.
3. **Azure cannot express "reasoning off".** `azure-gpt-5.4-mini` does not declare `reasoning` in
   `supportedGenerationParams` (correctly — `AzureOpenAIProvider` forwards no `extra`), so the
   publish gate REFUSES a reasoning block on any Azure-bound agent. No seeded agent binds Azure
   today, but a tenant that does has no way to comply with this directive.

## Change History

| Date | Change |
|---|---|
| 2026-09-13 | Platform-wide default reasoning posture added on owner approval (§4): `text.reasoning.defaultEffort`, second tier of the cascade, filling absence only. Open item 2 closed, replaced by the residual it leaves. |
| 2026-09-13 | Ticket opened, implemented and verified in one pass. Seed gap closed; two runtime call sites fixed (RED proven first); harness judge posture moved from three env vars to two `global-kv` descriptors, defaulted off, with the env path closed structurally. Three open items above. |
