# TASK-949 — Agent node: per-task configuration & hyper-parameter display

| Field | Value |
|---|---|
| **Status** | In Progress |
| **Type** | bugfix + feature |
| **Branch** | `dev-2.2` |
| **Surface** | `apps/admin-console` (workflow studio inspector, agents feature), `packages/workflow-contract` (read-only consumer) |
| **Opened** | 2026-09-10 |

## Requirement Analysis

Owner ask: *"we need Agent node to render and display the configuration/hyper-parameters properly
per each selected agent."*

A `core.agent` node currently renders one static, task-agnostic form for every agent it can
reference. Selecting the ASR node of an ArcaAI consultation workflow shows five LLM-only controls,
zero ASR knobs, and nothing at all describing the agent that will actually run. The node is a slug
and a guess.

Two defects sit behind that, plus one pre-existing bug found while reviewing:

| # | Defect |
|---|---|
| **A** | **No visibility.** The inspector never shows the referenced agent's model, fallback chain, hyper-parameters or instruction — all of which are already on the wire. |
| **B** | **Wrong knobs.** The editable surface is mis-typed against the referenced agent's task. |
| **C** | **Findings never reach nested fields.** `errorsForPath` compares a dotted descriptor path against a slash JSON pointer, so `OVERRIDE_OUT_OF_RANGE` and `GUARDRAIL_OPTED_OUT` silently fall into the graph-level bucket instead of onto the field they name. |

Blocking prerequisite: `AgentPickerField` hard-codes `task=TEXT_GENERATION`, so a non-LLM agent
cannot be listed or selected at all — the referenced slug renders as `"… (not in the list)"`.

## Current State Evaluation

### What renders today

`InspectorPanel` compiles the static `CORE_AGENT_SCHEMA` through `toFieldDescriptors`, identically
for every agent:

| Field | Path | Applies to |
|---|---|---|
| `overrides.promptVariables` | nested | LLM only |
| `overrides.generation` (7 knobs) | nested | LLM only |
| `overrides.carryForward` | nested | LLM only |
| `dna.enabled` | top-level | LLM only |
| document binding | top-level | LLM only |
| `guardrail`, `execution{lane,cadence}`, `onError` | top-level | task-neutral ✓ |

### What the agent actually declares

`Agent.parameters` is typed per task by `AGENT_PARAMETER_SCHEMAS[task]`
(`packages/workflow-contract/src/agent-schemas.ts:599`) — the same contract the gateway validates
against. Shapes differ completely per task (ASR: `decoding` / `streaming` / `audioFrontEnd` /
`postProcessing` / `fallback`; NER: `threshold` + `aggregation`; TTS: voice/speed/format/…; LLM:
`generation` / `guards` / `responseFormat`).

### What already exists (so this is wiring, not building)

| Asset | Where |
|---|---|
| Per-task hyper-parameter JSON Schema | `AGENT_PARAMETER_SCHEMAS[task]`, exported from `@arcaai/workflow-contract` |
| A schema-driven per-task renderer, incl. TASK-934 ASR model-profile hints | `features/agents/components/parameters-form.tsx:472` |
| The data, already client-side | `GET /admin/agents` returns the full `AgentResponse`; the inspector already holds it as `referencedAgent`. The console merely narrows it away in `AgentOption` |
| Cross-feature home | `src/shared/` (`prompt-picker`, `catalog`) — features/agents already consumes from it |
| A depth-reaching field escape hatch | `fieldOverrides` in `field-renderers.tsx:68` |

Two independent schema→form compilers exist (`features/agents`' bespoke walker and the Studio's
`toFieldDescriptors`). They share the *schema*, not the renderer — the "one definition, three
consumers" line in `agent-schemas.ts:11-14` is aspirational. Reusing `ParametersForm` is therefore
a MOVE, not a port; porting onto `toFieldDescriptors` would mean re-implementing `ModelSlugField`,
`ReasoningField` and the ASR profile hints.

## Owner Decisions (2026-09-10)

| # | Decision | Resolution |
|---|---|---|
| D-1 | Scope | **L0+L1+L2 only.** No per-node ASR/TTS/NER overrides (L3) — the node stays a REFERENCE |
| D-2 | Placement | **Section inside the Config tab**, under the picker |
| D-3 | Display source | **`compiledConfig`**, falling back to the raw columns |
| D-4 | Values shown | **Effective**, marked with the tier that supplied each (ASR resolves agent → model profile → engine default) |
| D-5 | Renderer | **Move `ParametersForm` to `src/shared/`** and add a read-only mode |
| D-6 | Inapplicable-but-set values | **Surface read-only with a warning** — never hide silently |
| D-7 | Ticket | **TASK-949** |
| D-8 | Path-convention bug | **Fix in this ticket** |

## Implementation Plan

Layer order; each layer's tests are written first (RED) and the layer is verified before the next.

### L0 — the picker lists agents of every task (prerequisite)

- `listAgentOptions(task?)` / `useAgentOptions(task?)` / `workflowStudioKeys.agentOptions(task?)`
  accept an absent task = "every task".
- `AgentPickerField` drops `DEFAULT_AGENT_TASK`, lists all published agents grouped by task.
- `InspectorPanel` resolves `referencedAgent` from the unfiltered read, so it resolves for ASR/
  NER/TTS nodes too.

### L1 — the Agent summary section (the ask)

- Widen the `AgentOption` projection to the fields already on the wire: `modelSlug`, full
  `parameters`, `compiledConfig`, `fallbacks`, `status`, `isActive`, `validationReport`,
  and the rest of `instruction`.
- Move `parameters-form.tsx` + `json-field.tsx` + `useTaskModelCatalogue` to
  `src/shared/agent-parameters/`; add a `readOnly` prop; re-point the agents feature at the new home.
- New `AgentSummarySection` (workflow-studio inspector), rendered under the picker: identity +
  task badge + version/pin, model + provider + fallback chain, **hyper-parameters via the shared
  read-only `ParametersForm` over `AGENT_PARAMETER_SCHEMAS[agent.task]`**, per-task instruction
  highlights, blocking validation findings, and an "Open agent" deep link.

### L2 — task-correct editable surface

- Top-level LLM-only paths (`dna`, document binding) → the existing `withheld` Set, conditioned on
  the resolved task.
- Nested LLM-only paths (`overrides.generation`, `overrides.promptVariables`,
  `overrides.carryForward`) → `fieldOverrides`, the only mechanism that reaches inside a group.
- D-6: when such a path carries a value on a non-LLM node, render it read-only with a warning
  rather than dropping it.

### D-8 — normalize finding paths

- `errorsForPath` normalizes both sides to one convention so a slash-pointer finding
  (`/overrides/generation/temperature`) matches its dotted descriptor path.

## Verification Criteria

- `pnpm --filter @arcaai/admin-console test lint typecheck build` green.
- Selecting `n_asr` in an ArcaAI workflow shows `realtime-transcription` selected (not
  "(not in the list)"), its ASR hyper-parameters, its model + fallbacks, and no LLM-only controls.
- Selecting `n_summary_new` is unchanged from today.
- An out-of-range generation override reports on the field, not in the graph-level list.

## Implementation Summary

_(filled in as layers land)_

## Change History

| Date | Change |
|---|---|
| 2026-09-10 | Ticket opened; review + owner decision round D-1..D-8 recorded; implementation started |
