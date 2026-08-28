# TASK-809 — Workflow Node Contract

| Field | Value |
|---|---|
| **Status** | **`Completed`** 2026-08-28 — all 14 tasks merged to `dev-2.2`; §2y1 closed by TASK-811. |
| **Type** | `feature` (contract) |
| **Branch** | `dev-2.2` |
| **Architecture** | <https://claude.ai/code/artifact/b6b68b73-3cb9-4cec-89f3-8afd1553c13b> |
| **Master** | [TASK-806](../TASK-806-Consultation-Workflow-Substrate-Unification/README.md) |
| **Depends on** | TASK-808 |
| **Blocks** | 810, 811, 812, 815 |
| **Agent** | `planner` → `general-purpose` · `opus` · effort `high` · **worktree** |

> **No Prisma change.** `WorkflowDefinition.graph` / `compiledConfig` are opaque `Json @db.JsonB`
> read by a **code-owned** registry. This is a contract-package change plus its Python mirror.

## 1. Requirement Analysis & Scope

### In scope
- `WorkflowNodeDescriptor` gains `inputs` / `outputs` (typed ports), `trigger`, `requires[]`,
  `schemaVersion`, `lane`, `idempotent`.
- Port type vocabulary extending `CONTEXT_PRIMITIVES`.
- Type-checked edge validation; remove the interpreter's whole-object fallback.
- Config schemas for the 13 `consultation.*` nodes that lack one.
- Python mirror + parity fixture; `GET /admin/workflow-nodes` surfaces ports; canvas
  `isValidConnection` wired.

### Out of scope — the compat fence (owner: "Do NOT touch the compat things")

Reproduced in full so this ticket is self-contained. **Do not read, edit, refactor, rename, or
"tidy" anything below.** If a change appears to require touching one of these, make it **additively**
instead and report the constraint rather than editing.

```
apps/compat-playground/**                        apps/quick-compat-app/**
apps/api/src/modules/text-compat/**              apps/api/src/modules/stt-compat/**          (OD-8)
apps/api/src/global-prefix.config.ts             apps/api/src/main.ts:109-111
packages/vox-node/src/resources/summarization.ts packages/vox-node/src/types/summarization.ts
packages/vox-node/src/core/url.ts                (PREFIX_EXEMPT_PATHS)
packages/agentic-sdk-v2/src/compat.ts            packages/agentic-sdk-v2/src/compat/**
packages/agentic-sdk-v2/src/types/consultation.ts:117-122   (the @deprecated `department` field ONLY)
packages/agentic-sdk-v2/src/types/context.ts:172-179        (AddContextInput.structuredData ONLY)
```


## 2. Current State Evaluation

| Defect | Evidence |
|---|---|
| **D-4** — ports undeclared | `node-registry.ts:46-80` |
| **D-5** — edge validation checks only non-empty strings | `graph-model.ts:34,36,160` |
| **D-6** — interpreter threads the whole upstream object on port mismatch | `workflow.py:189-201` |
| **D-9** — 13 of 16 `consultation.*` nodes have no config schema | `node-config-schemas.ts:25-38` |

Verified current registry: **14 nodes, all `implemented: true`** — palettes `null` (4),
`summarization` (5), `stt` (2), `consultation` (3). D-2 confirmed: transcription and NER/text-gen
are in different palettes, so AC-1.2 is structurally impossible until 811 lands lanes.


## 2y1. ✅ CLOSED by TASK-811 — `consultation.captureBinding` now produces a transcript

`node-ports.ts:205` declares `out: transcript {outputKey:'transcript'}`, but the activity emits
`{action, consultationId}` — it never produces a transcript. This is the **third** descriptor-vs-code
divergence found (after `assemblePrompt` and the `persistDraft`/`finalizeAssurance` pair).

It was left as **design intent, deliberately**, and the reasoning is worth preserving: retyping it
`control` would leave the consultation palette with **no producer of `transcript` at all**, making
`extractEntities`' required `transcript` input unsatisfiable in every graph. Neither direction is a
call an implementer should make alone.

Live consequence today: a `captureBinding`-wired edge binds nothing at runtime (the declared
`transcript` key is absent from the activity's output), so those graphs **degrade exactly as they
do now** rather than failing — the resolver treats a declared-but-absent key as "nothing bound",
reserving its raise for a genuine contract violation. So this is not urgent, but it is unresolved.

**Resolved 2026-08-28 without an owner decision being needed.** TASK-811's realtime lane took the
first branch: capture publishes the session's ingested ASR stream, so the declared
`out: transcript {outputKey:'transcript'}` is now kept rather than aspirational. The consultation
palette has a real transcript producer, and `extractEntities`' required input is satisfiable.

Verified on `dev-2.2` (`realtime-node-registry.test.ts:98,106`):
`portPrimitiveSatisfies(capture.out, extractEntities.in) === true`, while
`realtimeSummary.out → extractEntities.in` remains `false` — the anti-laundering rule is untouched.

## 2y. ✅ RESOLVED — OD-15: two incompatible port vocabularies

Discovered by the seed-migration lane on 2026-08-26, **verified by the orchestrator against
`dev-2.2` HEAD**. It stopped before writing code. Correctly.

**The merged contract and the interpreter mean different things by "port".**

| Layer | Model | Evidence |
|---|---|---|
| TS contract (merged) | Ports are **named, typed sockets** — `out`, `in`, `next`, `after`, `context`, `prompt` | `node-ports.ts:150` — `ports([port('in','transcript',…), AFTER], [port('out','entities',…), NEXT])` |
| Python interpreter | `from_port` is a **key into the producing activity's output dict** | `workflow.py` — `if binding.from_port in upstream_output: bound[binding.to_port] = upstream_output[binding.from_port]` |

**Overlap on the primary data port is zero** — no activity emits a key named `out`.
`extractEntities` emits `{entities, count, persisted}`. The whole-object fallback is the ONLY thing
bridging the two models, which is why removing it looked like a small task and is not.

Measured against the merged validator: **2 of 3** edges fail in seed 21, **14 of 16** in the ARCAAI
graph, **15 of 17** in the Rheumatology variant. (Seed 21 is 2, not 3 — `e2` already passes because
`document ⊑ text`.)

### Two consequences that are independent of which vocabulary wins

- **Silent clinical data loss.** `_consultation_shared.py:68` `bound_value()` searches for a key
  *inside* dict-valued bound inputs — its own docstring says a node "cannot assume which it
  received and must look inside". Under any strict per-key binding it receives a bare string, so
  `scores`, `citationsMap`, `ragTriadScore`, `guardrailDecisions` and `contextItemId` return `None`
  and **vanish from persisted drafts without error**. Must be fixed in the same change.
- **Two nodes declare no data output at all.** `persistDraft` and `finalizeAssurance` declare
  `[NEXT]` only (`node-ports.ts:179-180`), yet `persistDraft` emits `{contextItemId, text}` that
  `finalizeAssurance` genuinely consumes. No legal edge can express that flow.

Also: `_resolve_bound_inputs` has **zero test coverage** — removing the fallback would be caught by
no existing test.

### Options

| | Approach | Cost |
|---|---|---|
| **A (recommended)** | Named sockets win. Declare the runtime key **on the port descriptor** — `port('out','entities', …, { outputKey: 'entities' })`. `_resolve_bound_inputs` reads `upstream_output[outputKeyFor(nodeType, fromPort)]`. | Reopens Task 10's TS-only closure for **one** field (a deliberate five-place parity change). Keeps socket names stable for the canvas and keeps every type check intact. |
| B | Activity keys win; re-author `node-ports.ts` to name ports after output keys. | Ports churn whenever an activity's output shape changes, and control edges (`after`/`next`) have no natural key. Risks the 532-test suite. |
| C | Declare a whole-object `bundle` port. | **Reject.** A bundle cannot be typed as "contains a document", so generated text can reach NER again — it reintroduces exactly the laundering path D-6 exists to close. |

**Recommendation: A.** Named sockets are the right authoring model (the canvas validates on
handles, and typed sockets are what make `document → ner` a type error); the output key is a
runtime detail that belongs declared next to the socket, in one place, rather than in a second
mapping table.

**Also needs owner sign-off:** under named sockets the seeded chain is partly ordering and partly
data, so roughly **8 new data edges** must be authored. That is a re-authoring of the graph's data
flow — it changes what each activity receives at runtime — not a port rename.

## 2y2. OD-15 RESOLVED — option A implemented (2026-08-26)

Owner approved **option A**: named sockets win, and the runtime key is declared **on the port
descriptor**. Implemented in the order the ordering trap demands — contract, parity, seeds, and
only then the fallback removal.

### The shape

```ts
port('out', 'entities', /*required*/ true, /*multiple*/ true, { outputKey: 'entities' })
```

`outputKey` is `?: never` on a `control` port — ordering carries no payload, so that half of the
rule is enforced by the TYPE rather than by a convention. Every non-control OUTPUT port must
declare one; `node-contract.test.ts` asserts it across all 33 nodes.

**There is deliberately no "whole output object" encoding.** That is option C, which the owner
rejected: a bundle cannot be typed as "contains a document", so it reopens the laundering path.
Four activities whose natural output shape offered no key for their socket were changed to publish
one instead — `input.context_binding` and `consultation.retrieveEvidence` publish a context object
under `context`; `consultation.sensors` and `consultation.inferentialSensors` publish their
assurance record under `verdict`.

### Descriptor-vs-activity divergences

| Node | State |
|---|---|
| `consultation.persistDraft` | **FIXED.** Declared `[NEXT]` only while emitting `{contextItemId, text}`. Now declares `out: document` (`text`) and `contextItemId: text` (`contextItemId`), plus an `assurance` input distinct from `verdict`. |
| `consultation.finalizeAssurance` | **FIXED.** Same defect; now declares `contextItemId` as both an input and an output, so the persist → assure flow is a type-checked edge for the first time. |
| `consultation.captureBinding` | ⚠ **OPEN OWNER ITEM.** A THIRD divergence, found during this lane: `out: transcript` is design intent — the activity starts the live-documentation session and emits `{action, consultationId}`, no transcript. Left as design intent because retyping it `control` would leave the palette with NO producer of `transcript`, making `extractEntities`' required input unsatisfiable in every graph. The interpreter's "declared key absent from this run's output contributes nothing" rule keeps a graph that wires it degrading exactly as it does today. |

### The interpreter now distinguishes three outcomes, not two

| Case | Behaviour |
|---|---|
| socket declares `null` (a `control` port) | binds nothing — ordering carries no payload |
| declared key absent from THIS run's output | contributes nothing (a DEGRADED predecessor stores no output at all) — never a `KeyError`, never a fabricated value |
| port not declared by the producer at all | **raises** a non-retryable `ApplicationError` naming the node and the port |

`_resolve_bound_inputs` had ZERO coverage; it now has 12 tests
(`test_bound_input_resolution.py`), including one that asserts the whole output object is never
threaded.

### Silent clinical data loss — closed

`bound_value` searched only INSIDE dict-valued bound inputs. Under strict binding it receives bare
values (`contextItemId`, an entity list), so `scores`, `citationsMap`, `guardrailDecisions`,
`ragTriadScore` and `reducedAssurance` would have returned `None` — and `PersistDraftInput` reads
`None` as "no verifier ran", so a draft would persist with its assurance record missing and report
success. Two changes, both tested (`test_bound_value_no_data_loss.py`, 8 tests): `bound_value`
consults the top-level key first, and the verifiers publish their assurance record as one object
on one socket instead of scattering it across keys a single-key binding would drop.

### Seed migration — the constraint that shaped it

The consultation palette's structural rules are `allPathsPassThrough` checks, so a data edge that
skips a mandatory node makes the graph FAIL validation, not merely look untidy.
`captureBinding -> realtimeSummary` is the clearest casualty: it jumps `extractEntities`, and
WF-CONS-012 refuses it. The transcript-typed inputs of `realtimeSummary`, `phiHop` and
`suggestions` are therefore left UNWIRED — honest, since those activities resolve what they need
server-side from `consultationId`, exactly as `assemblePrompt` already does.

Both seeds validate with **0 findings** against the full rule set after regeneration by their own
scripts. Seed 21's script had a fourth defect that made its `compiledConfig.checksum` drift
unclearable — it omitted `compiledAt`, so `compile()` hashed a wall-clock value while the printed
config carried the pinned constant. Fixed; its drift verdict now reads 0, which also closed the
three TASK-790 W6 drifts on that row.

`registryChecksum()` hashes every descriptor in the node registry, INCLUDING its `configSchema`, so
its value moves whenever any ticket adds or edits a node. It is therefore not a constant worth
pinning in prose — a literal written here is stale as soon as the next node lands, and one written
here did go stale (TASK-810's DD-11 prompt pin added `promptTemplateId`/`promptVersionNumber` to
seven config schemas and moved it).

For the current value, read `REGISTRY_CHECKSUM` in
`packages/database/src/prisma/db_main/seed/23-arcaai-workflow-authoring.generated.ts`. That file is
engine output, and both `regen-arcaai-consultation-workflow-seed.ts` and
`regen-workflow-definition-seed.ts` reproduce it with a drift verdict of 0 — which is what makes it
the source of truth rather than a transcription of one.

## 2z. Progress — verified 2026-08-26

**DONE and merged to `dev-2.2`** (commits `090048cbd`, `6a79509c8`, `8a1958ac4`):
tasks 1–7 and 9 — typed ports, `trigger`, `lane`, `requires[]`, `idempotent`, `schemaVersion`,
`evalGate`, the port-compatibility lattice, the four publish-time rules, and all 16 missing
`consultation.*` config schemas. **532 tests pass** (independently re-run by the orchestrator).
`document → ner` is a type error, asserted exhaustively over the registry.

Two extensions accepted during implementation, both flagged rather than buried:
- **A ninth port primitive, `control`**, for ordering edges. Without it the ticket is
  undeliverable — `core.start`, `consentGate` and `hitlGate` produce no data. Precedent verified at
  `docs/implementation/TASK-715-Workflow-Definition-Model/README.md:735` (*"One of
  CONTEXT_PRIMITIVES … or 'CONTROL'"*). Safety-neutral: `control` satisfies only itself.
- **`consultation.hitlGate` no longer declares `{}`.** It declares the four fields `compileGate`
  actually honours (`gateType`, `blocking`, `timeoutSeconds`, `onTimeout`). `{}` had told the
  Studio the platform's only durable human wait takes no configuration.

**OUTSTANDING** (verified against `dev-2.2` HEAD, not assumed):

| Task | State | Evidence |
|---|---|---|
| 8 — remove the interpreter whole-object fallback | **DONE** (OD-15 lane) | `_resolve_bound_inputs` resolves through `NodeSpec.output_keys` and raises on an unresolvable binding; 12 new tests |
| 10 — Python mirror | **REOPENED and DONE for ONE field** (OD-15). `outputKey` is shared; the other six port fields stay TS-only. Five places changed together: the TS descriptor, `NodeSpec.output_keys`, both projections, and the fixture | parity green on both sides |
| 11 — surface ports on `GET /admin/workflow-nodes` | **DONE**, merged `b8c697271` | 8 fields + 2 new response classes; totality test derives the expected set from three independently-failing sources rather than a hand-listed array |
| 12 — canvas `isValidConnection` wired to the registry | **DONE**, merged `781810cc4` — one predicate backs drag-time + both commit paths; mirror pinned to the contract by a drift guard | the SDK carries the real lattice: `primitive: 'control' \| 'stream<audio>' \| … \| 'context<schemaRef>'` |
| 13 — seed migration | **DONE** (OD-15 lane, landed BEFORE task 8 in the same change) | both seeds on named sockets, blobs regenerated by their own scripts, `publishTo` dropped, 0 validation findings |
| 14 — regenerate the five artifacts | **DONE**, merged `b8c697271` | `route-manifest.json` correctly produced **no** diff (no route metadata moved, only the response schema); `openapi.json` +118, `schemas.ts` +34. All three drift checks clean |

### ⚠ Ordering trap — tasks 8 and 13 are NOT independent

The ticket lists them as separate rows, which understates the risk. **The seed migration MUST land
before (or in the same commit as) the fallback removal.**

Every edge in every committed seed uses `fromPort:'out'`/`toPort:'in'`, and **no interpreter
activity ever emits a key named `"out"`**. The whole-object fallback is the only reason those
graphs execute. Remove it first and every seeded graph raises at runtime: **14 of 15** edges in
`ARCAAI_CONSULTATION_GRAPH`, **15 of 16** in the Rheumatology variant, and **all 3** in the SYSTEM
platform-default (`seed/21-workflow-definition.ts`).

The seeds also carry derived blobs (`23-arcaai-workflow-authoring.generated.ts` —
`GEN_COMPILED_CONFIG`, `RHEUM_COMPILED_CONFIG`, checksums, validation reports). **Regenerate them by
the script named in that seed's docstring; never hand-patch.**

### Operational consequence to expect at deploy

`registryChecksum()` is now **`a03faf93063adc0fa061eadae64eedc973387eb8ed1965357185785403953b3b`**.
Every stamped `WorkflowDefinition` will flag `NEEDS_REVIEW` on next read. That is designed behaviour and correct here — the node contract genuinely changed — but it
should be expected rather than discovered.

### Open owner decisions surfaced (none blocking)

- `bindTerminology.purposeScope` — validator-required, read by no code, no taxonomy. Left as a
  non-empty string.
- `consultation.assemblePrompt` — the documented port table says it consumes text+structured, but
  the activity reads no `bound_inputs` at all. Both inputs are optional, so no wrong contract is
  produced today; the divergence is recorded.
- `publishTo` in the realtime-summary seed — dead config, read by nothing. The seed lane drops it.
- `requires[]` is `[]` on all 33 nodes. The mechanism is built and tested; assigning real guard
  requirements waits for the `guard.*` node types.
- Pre-existing, deliberately NOT fixed here: `compiler.ts` reads `config.timeoutSeconds` and
  `config.retry.*` off every node, yet no committed schema declares them and all set
  `additionalProperties: false`.

## 2a. Findings this ticket closes

| # | Finding | Evidence |
|---|---|---|
| **D-2** | Transcription and NER/text-gen live in **different palettes**, so AC-1.2 is structurally impossible | palette split below |
| **D-4** | `WorkflowNodeDescriptor` declares no `inputs`/`outputs` | `node-registry.ts:46-80` |
| **D-5** | Edge validation only checks `fromPort`/`toPort` are non-empty strings | `graph-model.ts:34,36,160` |
| **D-6** | Interpreter threads the **whole upstream output object** on port-name mismatch | `workflow.py:189-201` |
| **D-9** | **17 of 33** node types have no config schema — `passthrough` plus **all 16** `consultation.*` keys. `NODE_CONFIG_SCHEMAS` (`node-config-schemas.ts:322-339`) holds exactly 16 entries. *(Corrected from "13 of 16".)* | verified against the map |
| **D-15** | Only the `summarization` palette is invokable over the exposure plane | `exposure-palette-policy.ts:61` |
| **D-29** | *(rejected claim — do not re-introduce)* The registry is **not** empty. All 14 nodes are `implemented: true`; a `palette-rail.tsx` comment conditional on TASK-720 misled a reviewer | orchestrator re-verification |

**Verified registry as of 2026-08-25 — 33 nodes** (authoritative source: the committed parity
fixture `docs/implementation/TASK-734-Workflow-Substrate-Second-Pass/contracts/node-registry.snapshot.json`,
whose 33-key list is independently hard-coded in BOTH parity tests).

> ⚠ **Corrected 2026-08-25.** An earlier revision of this ticket said "14 nodes". That was an
> orchestrator counting error — a regex matched only entries written as `key: '…'`, but the registry
> declares them as keyed object literals (`'core.start': Object.freeze({…})`). The consultation
> palette grew 3 → 16 keys across TASK-731/791. Do not reintroduce the 14 figure.

| Palette | Count | Nodes |
|---|---|---|
| `null` (agnostic) | 4 | `noop`, `passthrough`, `core.start`, `core.end` |
| `summarization` | 5 | `input.context_binding`, `prompt.template_ref`, `generate.text`, `guardrail.check`, `output.deliver` |
| `stt` | 8 | `stt.audioInput`, `stt.vad`, `stt.noiseFilter`, `stt.diarization`, `stt.languageDetection`, `stt.asrEngine`, `stt.transcriptOutput`, `stt.phiHop` |
| `consultation` | 16 | `consentGate`, `captureBinding`, `extractEntities`, `bindTerminology`, `phiHop`, `retrieveEvidence`, `assemblePrompt`, `synthesize`, `sensors`, `inferentialSensors`, `persistDraft`, `finalizeAssurance`, `hitlGate`, `realtimeSummary`, `suggestions`, `proposeCorrections` |

`stt.phiHop` is `implemented: false`; the other 32 are `implemented: true`.

**All 8 `stt.*` activities are documented NON-execution placeholders** (`nodes/stt_placeholder.py:1-13`)
— a published STT graph compiles to an `AsrPipeline` rather than executing node-by-node. Declare
their ports as design intent, with a comment saying so; there is no runtime behaviour to infer from.

**No Prisma change.** `WorkflowDefinition.graph` / `compiledConfig` are opaque `Json @db.JsonB`
interpreted by the code-owned registry. Extending the vocabulary is a change to
`packages/workflow-contract` + the Python mirror + the shared parity fixture — **not a migration**.

## 2b. Target contract (design settled — implement, do not re-litigate)

**Descriptor fields to add:**

| Field | Purpose |
|---|---|
| `inputs` / `outputs`: `WorkflowPortDescriptor[]` | `{ name, primitive, required, multiple }` |
| `trigger` | `on-start` \| `per-turn` \| `on-end` — *when* a node runs, orthogonal to lane |
| `lane` | `realtime` \| `durable` — realtime has a latency budget; durable must survive restart |
| `requires[]` | guard attachment keys; publish fails until satisfied (**per node instance**) |
| `idempotent` | **required true** for any durable-lane node (Temporal retries activities) |
| `schemaVersion` | never reshape a published node's ports in place — add `agent.ner@2` |
| `evalGate?` | `{ goldenSetId, enabled }` — **OD-11**: the binding TASK-815 migrates off `DepartmentAgent` |

**Port type vocabulary** — extends the closed `CONTEXT_PRIMITIVES` set so "input is any variable in
the context object" is expressible *and* checkable:
`stream<audio>` · `transcript` · `text` · `entities` · `document` · `edits` · `verdict` · `context<schemaRef>`

**Publish-time rules:** a durable-lane node MUST be `idempotent`; a realtime-lane node MUST NOT be
`externalWrite`; `document → ner` is a **type error** (the anti-laundering rule made structural).

**Design decisions this ticket implements:**

| # | Decision | How it lands here |
|---|---|---|
| **DD-5** | `trigger` is a node property **orthogonal to `lane`** (`on-start` / `per-turn` / `on-end`) | It is what lets pre-summarization and the running note share the realtime lane without sharing a cadence, and it absorbs the endpoint stage uniformly as `on-end`. |
| **DD-6** | **Pre-summarization is a node**, fed from context supplied at runtime, running `on-start` | Add `agent.presummarization` with `trigger: on-start`, input `context<kinds>`, output `document`. Today's pre-summary job already takes `caseNoteIds` — it summarizes *provided context*, not the transcript, so this formalizes existing intent and widens the input to admin-selected context kinds. It must stay **non-signable** (`isFinalSummary` excludes `PRE_SUMMARY`, locked by `kept-generators-signability.task732.test.ts:63`). |
| **DD-9** | **One generation engine, three palette entries** | `agent.presummarization`, `agent.summarization`, `agent.discharge_summary` differ only in default trigger, ports and bound shape. Three entries so an admin can find them; one implementation behind them. Do not fork the engine. |

**Target catalog** (nine connectable nodes; three of them are one generation engine behind three
palette entries): `agent.transcription`, `agent.normalization`, `agent.ner`,
`agent.presummarization`, `agent.summarization`, `agent.discharge_summary`, `agent.retrieval`,
`agent.feedback`, plus guards `guard.phi`, `guard.moderation`, `guard.groundedness` and controls
`core.start`/`core.end`.

## 3. Implementation Plan (TDD)

| # | Task | Test first |
|---|---|---|
| 1 | `WorkflowPortDescriptor` + `inputs`/`outputs` on the descriptor | contract test: every node declares ports |
| 2 | Port vocabulary: `stream<audio>`, `transcript`, `text`, `entities`, `document`, `edits`, `verdict`, `context<schemaRef>` | type-compat matrix test |
| 3 | `trigger`: `on-start` \| `per-turn` \| `on-end` | descriptor test |
| 4 | `requires[]` (guard attachment) + `schemaVersion` + `lane` + `idempotent` | descriptor test |
| 5 | Edge validation type-checks ports | compatible edge passes / incompatible refused |
| 6 | **`document → ner` is a TYPE ERROR** — the anti-laundering rule encoded structurally | dedicated regression test |
| 7 | Publish-time rule: durable-lane node MUST be `idempotent`; realtime-lane node MUST NOT be `externalWrite` | validation tests |
| 8 | Remove the interpreter whole-object fallback → unresolved binding raises | Python test |
| 9 | **16** missing `consultation.*` config schemas (NOT `passthrough` — see above) | schema validation per node |
| 10 | Python mirror + parity fixture. **Per new descriptor field, decide explicitly: shared (extend Python `NodeSpec`, BOTH projection functions, the fixture JSON, and BOTH hard-coded 33-key lists) or TS-only (precedent: `classes`, `paletteKey`).** Never add to one side's projection without the other | `node-registry-parity.test.ts` + `test_node_registry_parity.py` |
| 11 | Surface ports on `GET /admin/workflow-nodes` + `workflow-node.response.ts` | controller test |
| 12 | Canvas `isValidConnection` wired to the registry (the hook already exists at `workflow-canvas/types.ts:64-69`) | component test |
| 13 | Audit `seed/23-arcaai-workflow-authoring.ts` for graphs relying on the removed fallback; migrate in the same commit | seed test |
| 14 | **Regenerate the five artifacts** (master §2.6) | `gen:admin:check` green |

## 4. Verification
```bash
pnpm --filter @arcaai/applications test
pnpm harness:test
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal
pnpm --filter @arcaai/vox-node gen:admin && pnpm --filter @arcaai/vox-node gen:admin:check
pnpm --filter @arcaai/admin-console build lint test
```
`packages/ui` suite only if the canvas package itself changed (owner directive).

## 5. Definition of Done
- [ ] Every descriptor declares ports, trigger, lane, requires, schemaVersion
- [ ] Incompatible edges refused at author time; `document → ner` proven impossible
- [ ] Registry parity green in both languages
- [ ] Interpreter fallback removed; seeds migrated
- [ ] Five artifacts regenerated and committed together

## Best Practices — apply to every task here

- **If it has no independently meaningful clinical output, it is configuration — not a node.**
  VAD and diarization produce nothing another agent consumes; they are fields on the transcription
  node. This one rule keeps the catalog from sprawling.
- **Version node types.** A node type is a contract with every saved tenant graph. Never reshape a
  published node's ports in place — add `agent.ner@2`. Otherwise definition-level immutability is
  undermined by node-level mutation.
- **Keep the catalog small and closed.** Roughly nine connectable nodes. An unbounded catalog is an
  API surface you cannot version.
- **Ports type over the SAME closed vocabulary the context schema uses** (`CONTEXT_PRIMITIVES`),
  so "input is any variable in the context object" becomes expressible *and* checkable.
- **Fail closed on an unresolved binding.** Removing the whole-object fallback is the point; do not
  replace it with a softer default.
- **Registry parity is a gate, not a chore.** TS and Python move together with the shared fixture.
- **D-29 — do not re-introduce a rejected claim:** the registry is NOT empty. All 14 nodes are
  `implemented: true`. A comment in `palette-rail.tsx` conditional on TASK-720 misled one reviewer.

## Standing instructions (every task in this ticket)

- **Evidence, not assertion.** "Tests pass" with nothing pasted is not a result. Paste actual
  command output (`01-development-workflow.md` §Phase 5).
- **TDD:** failing test first, and you must *see it fail*. A test that never failed verifies nothing.
- **Branch is `dev-2.2`**, never `dev`.
- **Never `git stash` in a worktree** — the stash stack is shared repo-wide. Commit, then
  `git checkout HEAD~1 -- <path>` for a baseline.
- **Orchestrator owns shared surfaces:** merges, `pnpm install`, `db:push`/`db:migrate`/
  `test:db:reset`, Docker/infra, and every `gen:*` invocation. Do not run them.
- **Lint warnings in `packages/*` are errors.** `eslint-plugin-only-warn` downgrades them; treat
  them as hard failures anyway.
- **Do not run** the test suites of `apps/compat-playground`, `apps/quick-compat-app`, or
  `packages/ui` unless your change lands inside that package (owner directive).

### The five-artifact rule (this ticket changes an admin route)

`.claude/rules/05-nestjs-api.md:155` still says **four** artifacts and omits the fifth. That
omission turned TASK-805's pipeline #990 red. The real rule:

```bash
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal \
  && pnpm --filter @arcaai/vox-node gen:admin
```
Verify with `pnpm api:openapi:check`, `pnpm api:portal:check`, `pnpm --filter @arcaai/vox-node gen:admin:check`.
**`packages/vox-node/src/resources/admin/**` is GENERATED — never hand-edit.** Only
`admin-resource.ts` is hand-authored.

### Finishing protocol — land it on `dev-2.2`, leave no worktree behind (owner directive, 2026-08-25)

**No work is "done" while it sits in a worktree.** When your gates are green, you MUST complete
this sequence. It is not optional and its order is not negotiable.

1. **Bring the target in first.** `git merge dev-2.2` INTO your branch and resolve any conflicts
   **in your own worktree**, never in the primary checkout.
2. **Re-run every gate AFTER that merge.** A clean merge is not a passing build. Paste the output.
3. **Merge your branch into `dev-2.2`** — the target is always `dev-2.2`, never `dev`.
4. **Only once step 3 is committed:** remove your worktree (`git worktree remove <path>`) and delete
   your branch.

**Before step 4, prove there is nothing left to lose:**
```bash
git log <your-branch> --not dev-2.2 --oneline   # MUST be empty
```
If it is not empty, stop — you have unmerged commits. Never use `git worktree remove --force`,
never `git worktree prune` "to tidy up", and never delete the directory by hand. An abandoned
worktree is recoverable; a removed one is not.

**If you cannot complete the merge** — conflicts you cannot resolve, a failing gate, an ambiguous
call — **LEAVE THE WORKTREE IN PLACE** and report it at the TOP of your final message with its path
and branch. Never bury an un-merged worktree in the body of a report.

**Concurrency note:** when several lanes run at once, the orchestrator may tell you to stop after
step 2 and hand off, so the final merges are serialized and lanes do not race each other into
`dev-2.2`. Follow that instruction if you receive it; otherwise complete all four steps yourself.

## Close-out protocol — MANDATORY (owner directive 2026-08-26, amended by measurement)

**Which path applies depends on where you work. Read the right one.**

### If you work in a WORKTREE

You **cannot** merge into `dev-2.2` yourself, and you must not try. `dev-2.2` is checked out in the
primary checkout, so git refuses every route into it — `git push . HEAD:dev-2.2` returns
*"refusing to update checked out branch"*, and it is right to: the primary's index and work tree
would desync from HEAD. This was measured, not assumed.

1. **Verify your base FIRST — before any other work.** Worktrees have been created off **`dev`**,
   where `packages/workflow-contract` does not exist at all; two of two agents hit this.
   Run `git merge-base --is-ancestor $(git rev-parse dev-2.2) HEAD`. Non-zero ⇒ confirm your tree
   is clean, then `git reset --hard dev-2.2`. Report which you found.
2. Gates green on your branch, with output pasted.
3. Commit everything. Leave the worktree and branch **intact**.
4. Report your branch name, commit SHA, and that the merge is pending. The orchestrator merges from
   the primary checkout, re-runs the gates there, and only then destroys the worktree and branch.

### If you work in the MAIN CHECKOUT

1. Gates green on your branch, output pasted.
2. **Merge into `dev-2.2`.** Never `dev`.
3. **Re-run the affected gates AFTER the merge** — a clean merge is not a passing build; a sibling
   lane may have moved the base underneath you.
4. **Delete your branch**, only after confirming the merge is on `dev-2.2`
   (`git log dev-2.2 --oneline | grep <your-sha>`).

### Stop conditions — never force past these

- A merge that conflicts in a way you cannot resolve with confidence ⇒ **STOP and report**, leaving
  the branch intact. An abandoned branch is recoverable; a bad merge or a deleted branch is not.
- Gates failing after a merge ⇒ **STOP and report**. Delete nothing.
- Never `git worktree remove --force`, never `git worktree prune`, never delete a branch holding
  commits absent from `dev-2.2`.
- Never `git stash` — the stash stack is shared repo-wide across every worktree.

## Agent Brief (self-contained — copy verbatim when dispatching)

**Ticket:** TASK-809 · **Branch:** `dev-2.2` · **Tree:** worktree `../hope-v2-task-809` off `dev-2.2`
**Agent:** `planner` → `general-purpose` · **Model:** `opus` · **Effort:** `high`

**Per-task tiers:** inventory/discovery sub-steps may run at `sonnet`; the port-vocabulary design
and the edge-compatibility matrix are the deciding stages — keep those at `opus`/`high`. A wrong
vocabulary is expensive to unwind because four later tickets consume it.

**You own:** `packages/workflow-contract/**`, the Python mirror
`apps/harness/src/harness/temporal/interpreter/registry.py`, the parity fixture,
`GET /admin/workflow-nodes` + its response DTO, and the canvas `isValidConnection` wiring.
**You must not touch:** the compat fence; node *implementations* (contract only); Prisma (this
ticket needs none — `graph`/`compiledConfig` are opaque JSONB read by a code-owned registry).
**Fresh worktree:** run `pnpm install`; copy `.env.dev`/`.env.test` in (gitignored files do not follow).
**Return contract:** `CONTRACT` (descriptor fields added), `VOCABULARY` (port types + compat matrix),
`PARITY` (both parity tests pasted), `MIGRATED_SEEDS`, `ARTIFACTS` (five-artifact output).

**Rules to read before starting:** `.claude/rules/` files 00, 01, 03, 05, 06. A subagent inherits NONE of the orchestrator's context — read them.

## 6. Implementation Summary
_Not started._

## 10. Lane status (reviewed 2026-08-26)

| Lane | Tasks | State |
|---|---|---|
| **A — TS contract** | 1-7, 9 | ✅ **MERGED** (`090048cbd`, `8a1958ac4`). 532 tests, +243 over baseline. Worktree + branch destroyed. |
| **B — Python interpreter** | 8, 10 | ⛔ Outstanding. The whole-object fallback is still live at `workflow.py:196-201`. Parity is green (all 7 fields TS-only), so the mirror itself needs no change. |
| **C — Gateway DTO** | 11 | ⛔ Outstanding. `workflow-definition.dto.mapper.ts:74-88` projects field-by-field and drops all 7 new fields, so the API cannot expose ports. |
| **D — Canvas** | 12 | ⛔ Outstanding. `isValidConnection` already exists (`workflow-studio-editor.tsx:213`) but predates the port model — it must be re-pointed at the registry's port types. |
| **E — Seed migration** | 13 | ⛔ Outstanding, and **larger than this ticket originally scoped**. Every seed edge uses `out`/`in`; no activity emits `"out"`. 14/15 edges in `ARCAAI_CONSULTATION_GRAPH`, 15/16 in the Rheum variant, 3/3 in the SYSTEM default. Derived blobs must be regenerated by the seed's own script, never hand-patched. |
| **F — Five artifacts** | 14 | Blocked on C — no admin route has changed yet. |

**Deploy-visible consequence:** `registryChecksum()` changed to
`9d84cb97be251093bb9364810d98f210d592a0e347044144acf62e361acb3c33`. Every stamped
`WorkflowDefinition` flags `NEEDS_REVIEW` on next read. Designed behaviour, but expect it.

**Open owner decisions surfaced by lane A** (none blocking):
- `requires[]` is `[]` on all 33 nodes — real guard assignment waits for the `guard.*` node types.
- `bindTerminology.purposeScope` — validator-required, read by no code, taxonomy unknown.
- `assemblePrompt` reads no `bound_inputs` at all, contradicting `node-types.md:117`.
- A 9th port primitive `control` was added (precedent verified: TASK-715 README:735).

## 7. Change History
| Date | Change |
|---|---|
| 2026-08-25 | Opened from TASK-806 §7. |
| 2026-08-26 | **Lane A merged to `dev-2.2`** (`090048cbd` + comment fix `8a1958ac4`); worktree and branch destroyed after proving no unmerged commits. Post-merge gates re-run green: 532 tests, build, typecheck. Lanes B-F outstanding (§10). |
| 2026-08-26 | **Lane B merged (`b8c697271`)** — tasks 11 + 14 done; post-merge gates re-run green (applications 10242, contract 532). Worktree and branch destroyed after confirming the merge. Task 12 (canvas) unblocked. Close-out protocol amended: a worktree agent **cannot** merge into `dev-2.2` (git refuses to update a checked-out branch — measured, not assumed), so the orchestrator merges for worktree lanes; and worktrees have twice been created off `dev`, so base verification is now step 1. |
| 2026-08-26 | **BLOCKED on OD-15.** Seed lane found the merged contract and the interpreter use incompatible port models (named sockets vs output-dict keys); the whole-object fallback was the only bridge. Verified by the orchestrator. Two independent consequences recorded: silent loss of assurance data via `bound_value`, and two nodes declaring no data output port. |
| 2026-08-26 | **Contract lane merged to `dev-2.2`.** Tasks 1–7, 9 complete; 532 tests green. `control` primitive and the `hitlGate` schema correction accepted. Propagation lanes (8, 11, 12, 13, 14) outstanding — §2z records the tasks-8-before-13 ordering trap. Close-out protocol added per owner directive. |
| 2026-08-26 | **OD-15 RESOLVED (option A) — tasks 8, 10, 13 landed.** `outputKey` on every data output socket; parity surface reopened for that one field across five places (TS descriptor, `NodeSpec.output_keys`, both projections, the fixture). Seeds migrated to named sockets and regenerated BEFORE the fallback removal. `_resolve_bound_inputs` now raises on an unresolvable binding and has 12 tests where it had none; `bound_value` reads the top-level key first and has 8. `persistDraft`/`finalizeAssurance` fixed; a THIRD divergence (`captureBinding`) recorded as an open owner item. Gates: contract 632, harness 1652, database 1661, applications 10245, the three drift checks clean. |
| 2026-08-25 | **Registry facts corrected: 33 nodes, not 14** (orchestrator counting error — regex missed keyed object literals). D-9 rescoped from "13 of 16" to **17 of 33** missing config schemas. Added the `stt.*` placeholder caveat and the parity-surface decision rule. Writer agent corrected mid-flight. |
