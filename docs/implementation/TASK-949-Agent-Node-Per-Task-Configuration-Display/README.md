# TASK-949 — Agent node: per-task configuration & hyper-parameter display

| Field | Value |
|---|---|
| **Status** | Review |
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

Four commits on `task-949-agent-node-config`, one per layer, each with its gates green.

### D-8 — findings reach the nested field they name (`81f8569aa`)

Scoped as a path-convention mismatch; it was three defects stacked, and the second was found only
because a test written for the first still failed:

1. `WorkflowFinding.path` is a JSON pointer (`/overrides/generation/temperature`,
   `publish-findings.ts:446`), `FieldDescriptor.path` is dotted — compared with `===`.
2. Only the top-level `descriptors.map` resolved errors at all. `FieldRenderer`'s `group` /
   `discriminated` branches recursed **without passing anything down**, so a nested field received
   none regardless of convention.
3. A `group` never rendered its own errors; it only set `data-invalid`.

`errorsForPath` now normalizes, `FieldRenderer` takes the LOOKUP (`errorsFor`) rather than a
resolved array so every depth resolves its own path, and `group` renders a `FieldError`. The
graph-level residue uses the same normalization — they must agree or a matched finding renders
twice, which the tests pin.

### L0 — the picker lists agents of every task (`d0296dbff`)

`task` is optional through `listAgentOptions` / `useAgentOptions` /
`workflowStudioKeys.agentOptions` (`buildQuery` already drops `undefined`); options are GROUPED by
task rather than filtered to one. `agentTaskLabel` is total — the picker has no error boundary of
its own, so a row missing `task` must not blank the Config tab (caught by an existing test whose
blanket `fetch` stub feeds it template rows).

### L1 — the agent's own configuration, displayed (`f38e3f815`)

- `shared/agent-parameters/schema-walk.ts` — the walk over `AGENT_PARAMETER_SCHEMAS[task]`, moved
  out of the agents editor, which now imports it.
- `shared/agent-parameters/agent-parameters-view.tsx` — a read-only per-task renderer of the same
  contract. Unset knobs collapse to one muted line per group.
- `components/inspector/agent-summary-section.tsx` — identity, model + provider, ordered
  fallbacks, ASR/NER instruction fields, blocking findings, deep link.
- `AgentOption` widened to the fields already on the wire. No new route.

### L2 — the editable surface follows the task (`ba3e4c86c`)

`withheld` for the top-level LLM-only paths, `fieldOverrides` for the three nested `overrides.*`
(spread LAST so suppression wins over the named `promptVariables` entry). Fails OPEN on an unknown
task. D-6's notice names stranded values down to their leaf keys.

## Deviations from the decision round

| Decision | What shipped | Why |
|---|---|---|
| **D-5** — "move `ParametersForm` to `shared/` and add a read-only mode" | The schema WALK moved to `shared/`; a separate read-only `AgentParametersView` renders values. `ParametersForm` stayed in the agents feature and now imports the shared walk. | Read-only mode on the editor means `fieldset disabled` — ~30 greyed-out, unfocusable inputs — which reads badly as a display surface and cannot express "inherited from the model profile" (D-4). One definition of the CONTRACT is preserved; one component doing two jobs is not. |

## Verification

| Gate | Result |
|---|---|
| `apps/admin-console` unit/component tests | **2868 passed**, 1 pre-existing failure (below) |
| workflow-studio + agents + shared/agent-parameters | 682 passed |
| `typecheck` | green |
| `lint` (`--max-warnings 0`) | green |
| `build` | green |
| Runtime verification in a running app | **PASSED** — see below |

**Pre-existing failure, not from this change:** `src/app/(console)/playground/__tests__/playground-route-group.test.ts`
fails identically on a clean `dev-2.2` checkout. Reported, not fixed (out of scope).

**Runtime verification — passed 2026-09-11**, worktree console on :5178 against the live gateway,
ArcaAI working tenant, `arcaai-gen-consultation` v1.

(First attempt was blocked: Docker/OrbStack stopped mid-session, so every DB-backed gateway route
hung. Restarted; the gateway recovered on its own.)

`n_asr` — the node this ticket started from:

| Check | Result |
|---|---|
| Agent resolves | `Realtime transcription (whisper.cpp ML/EN)` selected — **no "(not in the list)"** |
| Model + fallbacks | `arcaai-whisper-large-ml-en-gguf (built-in)`, `…-gguf-q8_0 → faster-whisper-large-v3-turbo-int8` |
| Parameters | 24 rows across Vad / Diarization / Decoding / Post-processing / Streaming — `ml-en`, beam size 5, VAD 0.5/100/500, `cadence-punctuation`, 500 ms partials |
| D-4 tier attribution | `Partial Window Sec 6 — from the model profile` |
| Unset knobs | collapsed per group, e.g. `Vad Filter, Chunk Length Sec, … — engine default` |
| LLM-only controls | **none** — editable set is Agent, guardrail, port bindings, Lane, Cadence, On Error, retry/timeout |

`n_presummary` (TEXT_GENERATION) — unchanged: `Max Tokens, Top P, Carry Forward, Dna, Prompt
variable, Prompt template, Document` all still offered, model `lms-gemma-4-e2b-it-qat (lm-studio)`.

**The runtime pass found a defect the suite could not.** The standalone prompt-template picker is
rendered outside the schema (its path is not a descriptor), so `withheld` never reached it and an
ASR node still offered "Prompt template". Fixed with a regression test — the reason rule 13 makes
a runtime pass part of the definition of done rather than a formality.

## Change History

| Date | Change |
|---|---|
| 2026-09-10 | Ticket opened; review + owner decision round D-1..D-8 recorded; implementation started |
| 2026-09-10 | D-8, L0, L1, L2 implemented on `task-949-agent-node-config`; tests/typecheck/lint/build green; runtime verification blocked by the local Docker stack being down |
| 2026-09-11 | Stack restarted; runtime pass PASSED against ArcaAI `arcaai-gen-consultation` v1. It caught one defect the suite missed (the standalone prompt-template picker was not task-gated) — fixed with a regression test |
