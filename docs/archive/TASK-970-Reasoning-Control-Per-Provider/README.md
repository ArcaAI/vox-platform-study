# TASK-970 — Reasoning/thinking control that reaches every engine

| Field | Value |
|---|---|
| **Status** | `Review` — WS-1/2/3 merged to `dev-2.2`, gates green, worktrees removed. WS-4 dropped by OD-1. Two follow-ups named in §5.9. |
| **Type** | `bugfix` (enforcement gap) + `feature` (node-level control, pending OD-1) |
| **Branch** | `dev-2.2` |
| **Raised** | 2026-09-13 |
| **Owner ask** | *"make sure all admins can control by enable or disable reasoning/thinking, fit to build-in solution such as lmstudio apis, vllm, ollama, and other third-parties"* + *"it MUST be controlled in any agent node, therefore any admins can do that when building agents/workflows"* |
| **Builds on** | TASK-891 (C1/C4/OD-4, per-agent posture), TASK-968 (`d173c2fc6`, platform default + seeded postures) |

---

## 1. Requirement Analysis

The control the owner asks for **already exists and is already per-agent** —
`parameters.generation.reasoning = { enabled, effort? }`, authored on the Agent,
rendered by the console's `ReasoningField`. Because agents are CONTENT (cloned
per tenant, tenant-owned — `00-project-context.md` §"Content is cloned"), whoever
builds agents already controls it for their own tenant. **No settings-registry
widening is required, and none is proposed.** OD-1…OD-4 of TASK-969 stand.

What does not work is ENFORCEMENT. Three gaps, measured below:

1. The posture reaches **3 of 10** provider adapters. The other seven drop it silently.
2. `reasoning_effort` is OpenAI vocabulary sent to every engine, including engines
   whose off-switch is a different parameter entirely.
3. Workflow NODES cannot override it — deliberately, per TASK-891 OD-4. The owner's
   "MUST be controlled in any agent node" appears to reverse that (§4).

---

## 2. Current State Evaluation — measured 2026-09-13

### F-1 — The posture reaches three adapters out of ten

`extra.reasoning_effort` reaches the wire only through
`openai_compat.py::_apply_request_extras`. Reference count for `request.extra` per
adapter:

| Adapter | Class | Forwards the posture |
|---|---|---|
| `openai_compat` | owns `_apply_request_extras` | **yes** |
| `lmstudio` | `LMStudioProvider(OpenAICompatProvider)` | **yes** |
| `vllm` | `VllmProvider(OpenAICompatProvider)` | **yes** |
| `openai` | `class OpenAIProvider:` — standalone | **no** |
| `azure_openai` | `class AzureOpenAIProvider:` — standalone | **no** |
| `ollama` | `class OllamaProvider:` — native httpx/NDJSON | **no** |
| `anthropic` | `class AnthropicProvider:` — native Messages | **no** |
| `llama_cpp` | `class LlamaCppProvider:` — standalone | **no** |
| `bedrock` | standalone (already documented as ignoring it) | **no** |
| `vertex` | `class VertexProvider:` — standalone | **no** |

`grep -c extra` returns **0** for `openai.py`, `ollama.py`, `anthropic.py`,
`llama_cpp.py`, `vertex.py`, `bedrock.py`; the single hit in `azure_openai.py` is an
unrelated pydantic `extra="allow"` docstring.

This is the exact failure TASK-968 set out to remove — its commit message says
*"Every defect below is a variant of 'absent, therefore on'"* — surviving in seven
adapters. It bites hardest where least expected: `openai` and `azure_openai` are the
two providers where `reasoning_effort` IS the correct native parameter, and neither
forwards it.

### F-2 — The console promises something the transport cannot deliver

`parameters-form.tsx:263` tells the admin, under the Enable-reasoning toggle:

> *"When off, the engine is instructed not to reason and reasoning tokens are never
> billed to this agent."*

On seven of ten adapters **no instruction is sent at all**. The toggle is recorded
on the agent, resolved correctly by `resolveTextSelection()`, carried to
`apps/text` — and then dropped at the adapter boundary. An admin who turns
reasoning off on an Ollama- or Anthropic-bound agent today gets a silent no-op and
a bill for reasoning tokens.

### F-3 — One vocabulary, ten engines

Even where `extra` IS forwarded, `reasoning_effort` is OpenAI's parameter. Each
engine family has its own off-switch, and the exact spelling moves with engine
versions — so the mapping table below is the STARTING POINT for implementation and
**every row must be confirmed against the deployed engine version before it ships**,
not taken from this document:

| Engine | Off-switch to verify |
|---|---|
| OpenAI / Azure OpenAI | `reasoning_effort` (o-series / gpt-5 class) — correct today, just unreachable |
| Ollama | top-level `think: false` (Ollama ≥ 0.9) |
| vLLM | `chat_template_kwargs: {enable_thinking: false}` for Qwen3-family; server-side `--reasoning-parser` |
| LM Studio | OpenAI-compatible passthrough; local `<think>` models may need template control |
| llama.cpp | server-side reasoning budget / `chat_template_kwargs` |
| Anthropic | `thinking: {type: "disabled"}` (extended thinking is opt-IN) |
| Bedrock | `additionalModelRequestFields` |
| Vertex | `generationConfig.thinkingConfig` |

### F-4 — The capability declaration describes the MODEL; enforceability is a property of the ADAPTER

`AiModel._metadata.supportedGenerationParams` gates whether an agent may author
`reasoning` at all (`GENERATION_HYPERPARAMETERS`, `hyperparameterCapabilityProblems`;
a missing declaration made a seeded agent unpublishable — TASK-930 D-6). Live rows:

| Model | Provider | Declares `reasoning` | Adapter forwards it |
|---|---|---|---|
| `lms-gemma-4-e2b-it-qat` | lm-studio | **yes** | yes — honest |
| `lms-gemma-4-e4b` | lm-studio | **yes** | yes — honest |
| `azure-gpt-5.4-mini` | azure | no | no — accidentally consistent |

The catalog is currently consistent, so the gap is LATENT rather than actively
wrong. It becomes real the moment anyone binds an Ollama / vLLM / Anthropic model,
or declares `reasoning` on the azure row — which would be truthful about the MODEL
(gpt-5 class honours `reasoning_effort`) and false about our ADAPTER.

**These are two different facts and the schema conflates them.** A model can support
reasoning while our transport cannot express it.

---

## 3. Implementation Plan

### WS-1 — A reasoning capability map per adapter (fixes F-1, F-3)

Give every adapter an explicit translation of the ONE posture
(`{enabled: false}` / `{enabled: true, effort?}` / absent) into that engine's own
parameter, verified against the deployed version. Adapters that genuinely have no
off-switch declare that, rather than silently dropping.

The posture must stop travelling as a raw OpenAI-shaped `extra.reasoning_effort`
ride-along and start travelling as a NEUTRAL posture that each adapter renders —
the `ResolvedAsrSpec` pattern from TASK-861, applied to generation.

### WS-2 — Unenforceable is logged, never silent (owner-answered)

Owner decision: **log and proceed.** When a posture cannot be honoured, send
nothing, record provider + model + posture on the generation's stats/telemetry, and
let the call run. Today's behaviour, made visible. No 422, no outage risk on a
provider swap.

### WS-3 — Honest capability, honest copy (fixes F-2, F-4)

Split "the model supports reasoning" from "our adapter can express it", and correct
`parameters-form.tsx:263`, which currently promises an instruction that is not always
sent. Where a bound model's engine cannot honour the posture, say so in the agent
editor at authoring time rather than letting the admin discover it on the bill.

### WS-4 — Node-level reasoning — BLOCKED on OD-1 (§4)

---

## 4. Owner Decision — ANSWERED 2026-09-13

**OD-1 — "controlled in any agent node" → reading (a): the AGENT entity.**

The control stays authorable on the Agent only. **TASK-891 OD-4 is NOT reversed** —
`core.agent` nodes keep their `config.generation` block free of `reasoning`, and
`agentic-contract.ts:225-227` stands unchanged. **WS-4 is DROPPED.**

Consequence worth stating: the owner ask is already satisfied on the AUTHORING side.
Any admin who builds agents already sets this, and because agents are cloned,
tenant-owned content, a tenant admin already controls it for their own tenant
without any settings-registry widening. TASK-969's OD-1…OD-4 stand untouched. The
whole of this ticket is therefore ENFORCEMENT, not permission.

**Fail posture — ANSWERED: log and proceed.** An engine that cannot honour the
posture sends nothing, records the fact, and the call runs.

---

## 7. Execution Plan — three lanes, contract written first

### 7.1 The contract — authored BEFORE spawning

`tests/contracts/reasoning-posture.fixture.json`, following the repo's own
cross-language pattern (`resolved-asr-spec.fixture.json`,
`guardrail-optout.fixture.json`).

This directly applies the lesson from TASK-969, where a contract specified only
half the surface and a lane discovered the gap after implementing it faithfully.
The fixture is committed BEFORE any lane starts.

**The wire changes shape.** The posture stops being pre-rendered TS-side into
`extra.reasoning_effort` and travels as a posture:

```jsonc
"reasoning": { "enabled": false }                    // off — render the engine's own off-switch
"reasoning": { "enabled": true }                     // on, no budget named
"reasoning": { "enabled": true, "effort": "high" }   // on at a named budget
// absent                                             // engine decides; synthesize nothing
```

Why: `reasoningExtra()` maps `enabled:false` onto `reasoning_effort:'minimal'`, which
is **lossy**. Once on the wire, "the admin turned it OFF" is indistinguishable from
"the admin asked for minimal effort", and an engine with a true off-switch
(`think:false`) can no longer be driven correctly. `extra.reasoning_effort` remains
supported as a caller-pinned override, preserving the documented CALLER-WINS rule.

**Fixture ownership:** L1 is the ONLY writer of `support[*]`. Its seeded values are
a documentation-knowledge starting point with a May-2026 cutoff, explicitly marked
`"verified": false`; L1 must confirm each against the DEPLOYED engine and correct
them. L2 and L3 read the file and never write it.

### 7.2 Lanes — path-disjoint

| Lane | Owns EXCLUSIVELY | Tier | Effort |
|---|---|---|---|
| **L1 — adapters** | `apps/text/src/text/providers/**`, `apps/text/src/text/models/requests.py`, `apps/text/src/text/core/reasoning*.py`, text tests, `tests/contracts/reasoning-posture.fixture.json` | `opus` | high |
| **L2 — TS wire** | `packages/applications/src/services/agent/agent-reasoning.ts`, `packages/applications/src/services/text-request/**`, `.../descriptors/text-reasoning.descriptors.ts`, `tests/contracts/reasoning-posture-parity.contract.test.ts` (new) | `opus` | medium |
| **L3 — console honesty** | `apps/admin-console/src/features/agents/**` | `sonnet` | medium |

L1 is `opus/high`: ten adapters, each with its own engine semantics, and it owns the
verification that the seeded support table is actually true. L2 is `opus/medium` —
the producer half plus the parity test, against a contract handed down. L3 is
`sonnet/medium`: correcting a false promise in the UI and surfacing per-provider
support, mechanical once the fixture exists.

### 7.3 Shared surfaces — ORCHESTRATOR ONLY

`pnpm install`, worktree bootstrap (codegen + dependency builds — the gap every
TASK-969 lane hit independently, fixed in prep this time), all `db:*`, the running
dev stack, and every merge into `dev-2.2`.

## 5. Implementation Summary

### L1 — adapters (`task-970-adapters` @ `ad8a81871`) — COMPLETE, unmerged

17 files, **all inside the declared paths**. New `core/reasoning.py`, a
`ReasoningPosture` on `GenerateRequest`, all ten adapters rendering, and
log-and-proceed recorded three ways (structlog `text.reasoning.unenforceable`, span
attributes, and a `text_reasoning_unenforceable_total{provider,model,reason}`
counter). **Gates:** pytest 1810 passed / 4 skipped; ruff clean; mypy clean on 82
files. RED observed first (37 failed / 13 errors → 63 passed).

#### The seeded support table was WRONG in three rows — the verification requirement earned its keep

| Provider | Seeded guess | Verified truth |
|---|---|---|
| `openai` | `effort-only` | **`native-off`** — `openai==3.1.0` types `ReasoningEffort = Literal['none','minimal','low','medium','high','xhigh','max']`; `'none'` is a real off rung |
| `azure_openai` | `effort-only` | **`native-off`** — same SDK, same wire |
| `vertex` | `unsupported` | **`native-off` with BOTH halves** — `google-genai==2.18.1` `ThinkingConfig` carries `thinking_budget` (0 = disabled) AND `ThinkingLevel = [MINIMAL, LOW, MEDIUM, HIGH]`, an exact match for this contract's effort vocabulary |

**Orchestrator re-verified both corrections independently** by importing the pinned
libraries and printing the literals — not taken on the lane's word. `openai_compat`
is the one row left `verified: false`, with a principled reason: the class is
wire-only by definition, so it cannot promise an unknown server knows `'none'`, and
an unknown enum is a 400. An honest unknown, as the brief asked for.

#### The find that explains the original symptom

`ollama.py:112` hardcoded `"think": True` on **every** request — a reasoning
selection baked into the adapter. Confirmed present at `dev-2.2` HEAD by the
orchestrator. That is the direct, provable cause of "reasoning off on an Ollama
agent still bills thinking tokens": the posture was dropped AND thinking was forced
on. Deleted; absent posture now sends no `think` key at all.

#### ⚠ RESIDUAL RISK accepted, not hidden — the `'none'` rung is per-MODEL

`core/reasoning.py:184` reasons that *"only `openai` and `azure_openai` talk to a
server that is guaranteed to know [`'none'`]"*. That is true of the SERVER and not of
every MODEL on it: `'none'` is a newer rung, and an o1/o3-era reasoning deployment on
the same Azure endpoint would reject it where the previous `'minimal'` worked. A
rejected enum is a 400 — a FAILED generation, which cuts against the owner's
log-and-proceed posture.

Accepted for now because the live catalog holds exactly one OpenAI-wire cloud model,
`azure-gpt-5.4-mini` (gpt-5 class, accepts `'none'`), so nothing deployed is affected.
It is exactly the F-4 finding one level deeper: capability is a property of the MODEL,
and this ticket fixed it only at the ADAPTER. **Follow-up: gate the `'none'` rung on a
per-model declaration, or fall back to `'minimal'` when the model does not declare it.**

#### Three gaps L1 found and correctly refused to fix in-scope

1. `GenerateBatchRequest` carries no `reasoning` — its documented consumer
   (`worker.py::_handle_batch_generation`) no longer exists anywhere in `apps/text/src`,
   so extending it would be speculative.
2. `api/endpoints/judge.py:237` rebuilds a `GenerateRequest` field-by-field from
   `JudgeRequest`, which has no `reasoning` field — **the judge lane can never carry a
   posture.** Out of scope (judge selection is `AiRoutingPolicy`, not an Agent) but real.
3. A pinned `extra.reasoning_effort` still reaches nothing on `openai`/`azure_openai`,
   which forward no `extra` at all — pre-existing, and adding general `extra` forwarding
   would have been scope creep.

Also pre-existing and NOT caused by this lane: `black --check apps/text/src/` fails on
`tests/unit/test_task871_output_gate.py` at HEAD. `black` is not one of the three gates.

#### Cross-lane check — L1's fixture change vs L2's parity test

L1 added `effort`, `evidence`, `$classes`, `$fields` to the fixture and flagged that
L2's parity test might assert an exact key set. **Verified safe by the orchestrator
before merging:** that test already filters `$`-prefixed keys
(`.filter(([key]) => !key.startsWith('$'))`), types `support` structurally rather than
exactly, and its `renders === null ⟺ class === 'unsupported'` invariant still holds
under all three reclassifications (each moved to `native-off` WITH a non-null
`renders`).

### L2 — TS wire (`task-970-wire` @ `7151c2ecf`) — COMPLETE, unmerged

17 files, **all inside the declared paths** (boundary verified by
`git diff --name-only`). `reasoningExtra()` → `reasoningWire()`; the enrichment
service writes a top-level `reasoning` posture; `REASONING_EFFORT_EXTRA_KEY`
survives only to RECOGNISE a caller pin. 13 downstream suites had 24 wire
assertions translated (`.extra` → `.reasoning`) with the same claims — not weakened.

**Gates:** build 0; lint 0 errors, **0 warnings in touched files**; test 850 files
passed, 13828 tests, with the single known port-5433 environmental red (file
untouched, imports nothing changed). Parity test 20/20 — it correctly noticed the
package config globs only `src/**` and ran the root contract suite (27 files / 379
tests) to exercise it. TDD confirmed RED first at 14/20.

**Cascade + CALLER-WINS proven, not asserted.** Every TASK-968 precedence test
survives; the parity test additionally drives each agent-tier case against a
*disagreeing* platform value, so a pass cannot come from the two tiers coinciding.
One deliberate shape change: a pinned `extra.reasoning_effort` now SUPPRESSES the
posture entirely, because on an `effort-only` adapter the pin and a rendered posture
land on the same engine parameter — shipping both would let ordering decide whether
the pin survived.

**The flagged judgement call is not one — orchestrator ruling.** L2 mapped platform
`minimal` → `{enabled: false}` and asked for a sanity check. It is correct and it is
pre-existing semantics, not a new decision: `text-reasoning.descriptors.ts:50-52`
states *"on this wire `minimal` IS off — it is precisely what `reasoningExtra` maps
`enabled: false` onto. A second boolean would be a second name for one state."* The
dependency L2 named (an `effort-only` adapter must render `{enabled:false}` back to
`reasoning_effort: 'minimal'`) is already mandated by the fixture's own definition of
that class, so the two halves agree by construction. The OpenAI family stays
byte-identical; only the engines that were silently dropping the posture change.

### L3 — console (`task-970-console` @ `28a497425`) — COMPLETE, merged

4 files, **all inside `features/agents/**`**. New `reasoning-support.ts` mirroring the
fixture's classification plus an `AiModel.provider` spelling-alias table
(`azure`→`azure_openai`, `lm-studio`→`lmstudio`, `llama-cpp`→`llama_cpp`), and a
`ReasoningProviderSupportNote` rendering one of three messages. **Gates:** build 0,
`lint --max-warnings 0` 0, 333 files / 3102 tests. `unsupported` renders a
non-destructive `Alert role="status"`, and a test asserts the toggle still fires
`onChange` against such a model — saving is informed, never blocked, per the owner's
log-and-proceed decision.

The copy that replaces the false promise:

> *"An explicit posture recorded on the agent either way. Whether the bound engine
> can actually be instructed to honour it depends on the model's provider."*

### The trip-wire fired — cross-lane reconciliation (`5b135c92b`)

L3 built its TS mirror from the fixture as SEEDED and wrote a parity test reading the
fixture directly, warning that an L1 correction would fail it. On merge it did —
**7 failures**, exactly as designed. Two causes, both reconcilable only at this level:

1. **The three verified reclassifications** — `openai`, `azure_openai`, `vertex` →
   `native-off`. The TS table was updated to the verified truth.
2. **A second-order effect of L1's fixture additions** — L3's test filtered `$comment`
   by NAME, so L1's new `$classes` / `$fields` read as adapters with no classification
   (`providerLabel` of `undefined`). Now filters the whole `$` prefix, so the next
   metadata key upstream cannot reintroduce it.

**A shortcut deliberately not taken.** The stale case used AZURE to exercise the
`effort-only` copy. With Azure reclassified, flipping that assertion was the one-line
fix — but the test catalogue held no other `effort-only` provider, so it would have
silently deleted a whole branch from coverage while reporting green. Instead an LM
Studio row was added (genuinely `effort-only`: documented vocabulary low|medium|high,
no off value), the case moved there, and Azure gained its own case pinning the
correction. All three branches still covered; 44 tests pass.

### Post-merge gates — `dev-2.2`

| Gate | Result |
|---|---|
| `admin-console` build / lint / test | build 0 · `--max-warnings 0` 0 · **3103 passed** |
| `applications` test | 853 files passed, 1 failed — the known port-5433 environmental red |
| `text` test | **1810 passed**, 4 skipped |
| root contract suite | **379 passed** (27 files) |

### Stale copy — taken by the orchestrator (`8bab00a61`)

### ⚠ Orchestrator follow-up — stale copy outside every lane's boundary

L2 found two places still describing the retired ride-along, neither owned by any
lane:

- `packages/workflow-contract/src/agent-schemas.ts:147` — *"Rides
  GenerateRequest.extra.reasoning_effort -> extra_body"*. **Admin-visible**: it is the
  agent-parameter schema description rendered in the console. Now inaccurate.
- Comments in `seed/25-agents.ts`, `seed/ai-models/llm.ts`, `seed/ai-models/shared.ts`.

Both fixed in `8bab00a61`, comments only, `workflow-contract` build and `database`
typecheck clean. `agent-schemas.ts` was the one that mattered — its `description` is
ADMIN-VISIBLE. And `seed/ai-models/shared.ts` was worse than stale: it instructed seed
authors to *"Declare it only on a row whose engine actually carries that ride-along"*,
which after this ticket would wrongly EXCLUDE Ollama, Anthropic and Vertex. It now
points at the fixture's `support` table and says why the old guidance is retired. `apps/harness`'s judge plane keeps its own
separate governed `reasoning_effort` (`HARNESS_JUDGE_*`) — a different field on a
different path, deliberately out of this contract.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-13 | Raised from the owner ask. F-1…F-4 measured against the adapters, the live `AiModel` catalog and the console agent editor. Owner answered the fail-posture question (log and proceed). OD-1 open. |

---

## 5.9 Follow-ups carried out of this ticket

1. **The `'none'` rung is a per-MODEL capability, gated per-PROVIDER.** `core/reasoning.py`
   sends `reasoning_effort: 'none'` for OpenAI/Azure. The SDK types it, but an o1/o3-era
   deployment on the same endpoint would reject it where `'minimal'` worked — a 400 is a
   failed generation, which cuts against log-and-proceed. Harmless today (the only live
   OpenAI-wire cloud model is `azure-gpt-5.4-mini`, gpt-5 class). Fix: gate the rung on a
   per-model declaration, or fall back to `'minimal'` when the model does not declare it.
2. **The judge lane can never carry a posture.** `api/endpoints/judge.py:237` rebuilds a
   `GenerateRequest` field-by-field from a `JudgeRequest` that has no `reasoning` field.
   Judge selection is `AiRoutingPolicy`, not an Agent, so it was correctly out of scope —
   but it means the assurance plane's reasoning is governed only by `HARNESS_JUDGE_*`.
3. `GenerateBatchRequest` carries no `reasoning`; its documented consumer no longer exists
   in `apps/text/src`, so extending it would have been speculative.
