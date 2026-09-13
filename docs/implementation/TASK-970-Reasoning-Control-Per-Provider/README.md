# TASK-970 — Reasoning/thinking control that reaches every engine

| Field | Value |
|---|---|
| **Status** | `In Progress` — OD-1 answered (a); WS-4 dropped; WS-1/2/3 dispatched across 3 lanes |
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

*(pending)*

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-13 | Raised from the owner ask. F-1…F-4 measured against the adapters, the live `AiModel` catalog and the console agent editor. Owner answered the fail-posture question (log and proceed). OD-1 open. |
