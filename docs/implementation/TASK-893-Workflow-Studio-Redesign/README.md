# TASK-893 — Workflow Studio Redesign & Legacy Vocabulary Retirement

| Field | Value |
|---|---|
| **Status** | `In Progress` — **all four phases are delivered and merged** on `dev-2.2` (Phase 1 2026-09-07; Phases 2 + 4 as **lane R** of the TASK-930 wave plus fix-up lanes F-TS / F-PY, 2026-09-08; Phase 3 superseded by the seed rebuild, lane S). Held open for exactly ONE unrun gate — Phase 4 declares `pnpm test:e2e` and the API e2e suite has not run on the integrated tree (§6). Lane contract: [`../TASK-930-Agent-Workflow-Platform-Commitments/INTERFACES.md`](../TASK-930-Agent-Workflow-Platform-Commitments/INTERFACES.md) §7. |
| **Type** | `refactor` + `feature` (studio UX) / `infrastructure` (registry + seed retirement) |
| **Branch** | `dev-2.2` |
| **Raised** | 2026-09-07 |
| **Memory snapshot** | [`MEMORY.md`](./MEMORY.md) — verbatim copies of the orchestrator memory files governing this ticket (decisions, hazards, working rules) |
| **Supersedes / touches** | TASK-864 (core vocabulary), TASK-885 (import/export), TASK-890 (studio black-box fixes) |

---

## 1. Requirement Analysis

Owner report, verbatim:

> * cannot move any node.
> * cannot delete any node.
> * cannot link the nodes or delete any nodes link.
> * cannot drag-n-drop new node from the left column.
>
> the workflow studio must allow admin to test and inspect node in the same interface instead of
> using a new workbench playground. […] the left column show all available Nodes as card, the card
> must not max-rounded. the canvas takes most of the space. on the right, when selecting a node, it
> MUST display a sidebar […] no detail Explaination […] KEEP IT SIMPLE, COHERENCE, EASY TO READ AND
> UNDERSTAND. it MUST allow admin to undo, redo, save or discard all changes. REMOVE THE LIST
> INTERFACE.
>
> Currently there are some Workflows created in seed, many nodes of them display Deprecated. The
> question is why deprecated things are still exists?

Follow-up directives (2026-09-07, answering the scoping questions):

| # | Directive |
|---|---|
| **OD-1** | Remove **both** list interfaces — the editor's Canvas/List toggle **and** the `/workflow-studio` definitions grid. |
| **OD-2** | Review the seed data; **deprecated things must be removed completely**. |
| **OD-3** | **Consolidate into one Workflow Studio** where an admin can create any kind of agent or workflow. It must be easy to use. |
| **OD-4** | Handles must **present the order of nodes**; data flow uses **one link**, not several split handles. |
| **OD-5** | A loop must be able to **wrap one or many nodes**. |
| **OD-6** | Migrate the legacy graphs if possible; otherwise remove all old things and build new ones fitting the latest implementation. |
| **OD-7** | **Explicit Save + Discard, no autosave.** |

---

## 2. Current State Evaluation — measured, not assumed

All findings below were verified on 2026-09-07 against the running dev stack (admin console
`:5176`, gateway `:8868`, seeded `hope` database) and the source on `dev-2.2 @ 56503f897`.

### 2.1 The four interaction failures are ONE cause: read-only mode

```
$ docker exec hope-postgres psql -U postgres -d hope -t -A \
    -c 'select status, count(*) from core."WorkflowDefinition" group by status'
DRAFT|1
PUBLISHED|11
```

`workflow-studio-editor.tsx:161` sets `readOnly = status === 'PUBLISHED' || status === 'DEPRECATED'`,
and that single flag disables, in one step:

| Prop | Effect when `readOnly` |
|---|---|
| `nodesDraggable={!readOnly}` | node drag off → **"cannot move any node"** |
| `nodesConnectable={!readOnly}` | handle drag off → **"cannot link the nodes"** |
| `deleteKeyCode={readOnly ? null : [...]}` | Delete key off; node `X` button hidden → **"cannot delete any node"** |
| `dropEnabled = onPaneDrop !== undefined && !readOnly` | pane drop target off → **"cannot drag-n-drop from the left column"** |

**Verified live.** On the sole DRAFT (`test`), a real pointer drag moved a node:
`translate(-176.263px, 99.4351px)` → `translate(-176.263px, 163.375px)`. On
`arcaai-consultation-soap` (PUBLISHED) no gesture has any effect.

The read-only banner exists but is one line of muted text; the canvas swallows every gesture in
silence. **This is a UX defect, not a React Flow defect** — but it presents exactly as a broken canvas.

A second, related defect: `PaletteRail`'s `onAddNode` is **not** gated on `readOnly`, so clicking a
palette card on a published workflow *does* mutate the store, sets `dirty`, and can never be saved
(the autosave effect early-returns on `readOnly`). Two paths disagree about the same rule.

### 2.2 Deleting a connection is genuinely broken — on drafts too

`WorkflowCanvas` is never handed `onEdgesChange` by the Studio, and the composite's handler opens
with `if (!onEdgesChange) return;` (`packages/ui/src/components/workflow-canvas/workflow-canvas.tsx:205`).
Every edge `remove` change is dropped on the floor. There is also no click-to-delete affordance on an
edge. **The only way to remove a connection today is the List view** — the interface OD-1 deletes.

*(The earlier hypothesis that xyflow's stylesheet was missing is disproved: the live DOM reports
`.react-flow__edge { pointer-events: visiblestroke }` and `.react-flow__edges { pointer-events: none }`,
both of which come from `@xyflow/react/dist/style.css`. The hand-rolled geometry block added to
`canvas-tokens.css` in `56503f897` is redundant, not harmful.)*

### 2.3 Palette cards are pills

`PaletteItem` renders a `<Button>`; the shadcn button base class carries `rounded-control`, and
`packages/ui/src/styles/globals.css:428` defines `--radius-control: calc(var(--hope-radius-base) * 999)`
— fully rounded. Confirmed on screen.

### 2.4 The canvas does not get the space

- Grid is `240px / 1fr / 320px`.
- The right column stacks **three** rails vertically — Inspector, Validation, Prompt bindings — in 320px.
- `ScreenTemplate contentMode="scroll"`, so the canvas is a `h-[26rem]` box that scrolls off the
  viewport rather than owning its height. Measured: at 1280×720 the lower edge of the graph sits at
  `y ≈ 768`, i.e. below the fold.
- The minimap covers a large fraction of the small canvas.

### 2.5 The inspector prints normative specification text

The quoted wall of text is the `enabled` field description at
`packages/workflow-contract/src/node-config-schemas.ts:2204`, rendered verbatim by the inspector's
field renderer. Many registry descriptions are written in the same register — they are excellent
*contract* documentation and unusable *UI copy*.

### 2.6 Testing lives in a different screen

The Studio only deep-links to `/playground/workbench` (`studio-toolbar.tsx`). The Workbench owns the
fixture picker, `POST admin/workflow-definitions/:id/sandbox-runs`, the ticket-authenticated progress
stream and the per-node trace inspector. The split was a deliberate reading of rule 13 ("one
authoritative editor per backend resource"); **OD-3 overrides it.**

### 2.7 Why deprecated things still exist — the real answer

This is the most important finding, and it is *not* "nobody cleaned up".

- **62 of ~75** registry node types carry `deprecated: true`, each with `replacedBy` naming one of the
  11 `core.*` types introduced by TASK-864.
- Every seeded graph is authored **entirely** in the deprecated vocabulary (`consultation.*`,
  `agent.*`, `core.start`, `core.end`), while `PaletteRail.authorable()` hides deprecated types. So
  the seeds and the palette are **disjoint vocabularies** — the admin sees a graph containing nothing
  the palette can produce.
- The Python interpreter (`apps/harness/.../interpreter/registry.py`) still declares **64** `NodeSpec`
  entries, including all the legacy ones.

**And the load-bearing part:**

```ts
// packages/workflow-contract/src/core-contract.ts:108
export const ACTION_CATALOGUE = Object.freeze(Object.fromEntries(
  ACTION_KEYS.filter((key) => WORKFLOW_NODE_REGISTRY[key] !== undefined)
             .map((key) => [key, { key, delegateType: key, label: humanLabel(key) }]),
));
```

Every action `core.action` can perform **is** a deprecated legacy node type still resident in the
registry. `actionDelegateOf()` resolves an action's config schema and its effective ports from that
legacy descriptor, and the interpreter dispatches through it. The Studio's own action dropdown is
built the same way — `registryNodes.filter(d => d.deprecated === true && d.replacedBy === 'core.action')`
(`workflow-studio-editor.tsx:174`).

> **The deprecated entries are not residue. They are the current implementation of `core.action`.**
> Deleting them today deletes every action a workflow can perform.

That is why they still exist, and it is the reason OD-2 ("removed completely") cannot be a deletion
pass — it needs the capability table re-homed first (§4, Phase 2).

### 2.8 What the retirement must move in lockstep

| Surface | Dependency |
|---|---|
| `packages/workflow-contract/node-registry.ts` | 62 descriptors |
| `node-ports.ts`, `node-config-schemas.ts` | port + schema tables keyed by those types |
| `rule-catalogue.ts` | 21 `WF-CONS-*`, 10 `WF-S-*`, 12 `WF-I-*`, 6 `WF-SUMM-*`, 1 `WF-STT-*` rules referencing them |
| `apps/harness/.../interpreter/registry.py` + activities | 64 `NodeSpec` entries |
| `__tests__/fixtures/node-registry.snapshot.json` | the committed cross-language parity fixture, gated in CI both sides |
| `seed/21`, `seed/23`, `seed/24` | 11 PUBLISHED definitions + their `compiledConfig` and three checksums |
| `core.\"WorkflowAssignment\"` | 4 rows |

**Assignments bind by `workflowDefinitionSlug`, not by id:**

```
consultation | arcaai-consultation-new-visit    | visit-type:new-visit | TENANT
consultation | arcaai-consultation-revisit      | visit-type:revisit   | TENANT
consultation | arcaai-consultation-soap         |                      | TENANT
consultation | arcaai-rheum-consultation-soap   |                      | DEPARTMENT
```

So a migration that publishes a **new version under the same slug** keeps consultation routing intact.
**Migration is possible (OD-6, first branch).** Deletion-and-rebuild is not required and would break
routing until every assignment was re-pointed by hand.

---

## 3. Design — best practices, and what they cost here

### 3.1 One link between nodes, sockets resolved underneath (OD-4)

**Today.** Ports separate ordering (`control`: `after`/`next`) from data (`in`/`out` plus semantic
sockets), and the compatibility lattice is a genuine safety mechanism — `transcript ⊑ text`,
`document ⊑ text`, and `transcript`/`document` are siblings, which is what makes `document → ner` a
structural type error rather than a code review comment (the anti-hallucination-laundering rule).
`core.action` therefore renders **7 inputs + 7 outputs = 14 handles** on one box. That is the
complexity being complained about, and the complaint is right.

**Concern, stated once.** Collapsing ports on the *wire* would delete the type check and the
interpreter's per-socket value threading (`outputKey`). That would be a real safety regression, so I
am not proposing it.

**Proposal — collapse the presentation, keep the contract.** This is what n8n, Make, Zapier and
LangGraph Studio all do, and it needs **no wire change and no interpreter change**:

```
                       BEFORE                                    AFTER
   ┌───────────────────────────────┐            ┌───────────────────────────────┐
   │ core.action                   │            │ ②  Extract entities           │
   │ ● in        out ●             │            │                               │
   │ ● text      text ●            │            │ ●                           ● │
   │ ● transcript entities ●       │            │                               │
   │ ● entities  verdict ●         │            │ Context ← ① Trigger           │  ← inspector field,
   │ ● document  document ●        │            │                               │     not a wire
   │ ● context   context ●         │            └───────────────────────────────┘
   │ ● after     next ●            │
   └───────────────────────────────┘            ┌───────────────────────────────┐
        14 handles, 2 of them the               │ ④  Route by visit type        │
        ones anyone actually uses               │ ●                    then ●   │  ← branches keep
                                                │                      else ●   │     their handles
                                                └───────────────────────────────┘
```

1. **One input dot, one output dot** for the main flow on every node.
2. **Branch outputs stay separate and labelled** — the one place multiple handles genuinely earn
   their space, and every mature editor keeps them:
   `core.condition` → `then`/`else`; `core.classify` → per-class + `otherwise`;
   `core.humanReview` → `approved`/`rejected`/`timedOut`; `core.loop` → `each`/`done`.
   That is 4 of 11 core types; the other 7 become single-dot.
3. **Secondary data inputs leave the canvas** and become inspector fields with an upstream-node
   picker ("Context ← ① Trigger"). The `celReferences` machinery that feeds `nodes.<id>` already
   exists (`workflow-studio-editor.tsx:97`).
4. **Socket resolution on connect.** Drawing A→B picks A's primary data output and B's primary data
   input; if either side has no data port, it falls back to `next`→`after`. One user gesture, one
   edge, correct `fromPort`/`toPort` on the wire.
5. **The lattice still runs.** `canConnect` keeps calling `checkPortCompatibility`; an incompatible
   pair is refused at drag time with the reason, exactly as now. `workflowEdgePortProblems` still
   runs at publish.

Net: `WorkflowGraphEdge` unchanged, `NODE_PORTS` unchanged, `registry.py` unchanged, the safety
lattice unchanged — and the canvas shows two dots per node instead of fourteen.

### 3.2 The canvas presents execution order (OD-4)

A topological sort over control + data edges assigns every node a **step number** rendered as a badge
in the node header (①②③…). Branch edges carry their label. Nodes in a cycle, or unreachable from
`core.trigger`, get a distinct marker instead of a number — which turns two existing validation
findings into something visible at a glance rather than a line in a rail.

### 3.3 A loop wraps one or many nodes (OD-5)

`parentId` is **already** on the wire (`graph-model.ts:38`) and the compiler already lifts children
into `loops[].body`. Only the authoring affordance is missing. Add:

- **Wrap in loop** — multi-select nodes → one action creates a `core.loop` and re-parents them.
- **Drag into / out of a loop** — React Flow intersection detection on `onNodeDragStop`.
- **Unwrap** — dissolves the loop, re-parenting children to the top level.
- Group auto-sizing already works (`groupSize()` derives the extent from children).

### 3.4 One studio, no lists (OD-1, OD-3)

- `/workflow-studio` **becomes the studio**. The definitions grid is deleted; a workflow switcher
  (searchable combobox: name · version · status) sits in the header, plus **New** / **Clone** /
  **Import**. `/workflow-studio/[definitionId]` stays as the canonical deep link.
- The editor's Canvas/List toggle, `GraphListEditor`, `node-row.tsx`, `edge-editor.tsx` and the
  `?view=` URL state are deleted.
- **Accessibility replacement is mandatory, not optional.** The List view was the documented
  pointer-free path for WCAG 2.5.7 (`create-graph-store.ts`'s `reorderNode` comment says so
  explicitly). It is replaced by keyboard operation *on the canvas*: focus a node with Tab, add via
  the palette's `<button>` (already keyboard-operable), connect with a keyboard "Connect to…"
  command on the focused node, delete with Delete, reorder via the step list in the inspector. Every
  mutation keeps a non-drag path — that is the rule, and the List view was only one way to satisfy it.

### 3.5 Layout and copy (OD-3)

| Region | Now | Proposed |
|---|---|---|
| Frame | `contentMode="scroll"`, canvas `h-[26rem]` | `contentMode="fill"` — the canvas owns the height and never scrolls off |
| Left | 240px, pill buttons | ~260px **collapsible**; real cards (`rounded-md`), icon + name + one-line purpose, grouped, draggable |
| Centre | `1fr` | `1fr`, minimap collapsed by default, zoom/fit/undo/redo as a floating control cluster |
| Right | 320px stacking 3 rails | ~360px, **tabbed**: **Config · Problems · Run**; collapses entirely when nothing is selected, giving the canvas the width |

**Copy discipline.** Add a `summary` (≤ 80 chars, plain language) beside the existing `description`
in the node config schemas. The inspector renders `summary` inline and moves `description` — the
normative text, which stays valuable for the contract and the API docs — behind a `?` popover. The
example from the report becomes:

> **Enabled** — Skip this node without removing it. *(?)*

### 3.6 Test and inspect in the studio (OD-3)

- Extract the Workbench's sandbox API hooks to `shared/sandbox/` (features may not import each
  other — rule 13).
- Inspector gains a **Run** tab: fixture picker → Run → live SSE progress, reusing that client.
- **Per-node run state overlays on the canvas** — pending / running / ok / failed + duration —
  through the canvas's existing `overlay` prop. Selecting a node shows that node's input, output and
  trace for the last run.
- `/playground/workbench` keeps a `redirect()` for one release per rule 13 §Routing, with a comment
  naming the release that deletes it.

### 3.7 Save / Discard (OD-7)

`useAutosave` is retired from the Studio. Edits stay in the client buffer; the toolbar carries
**Undo · Redo · Save · Discard** plus a dirty badge.

- `Save` performs the existing ETag/If-Match `PATCH` and keeps the full OCC behaviour (428 on a
  missing precondition, 412 on drift → the existing `OccConflictAlert`).
- `Discard` reverts to the last saved graph and clears the undo stacks.
- `useUnsavedChangesGuard` stays and becomes load-bearing rather than a backstop.
- **`moveNode` must now mark the graph dirty.** It deliberately does not today, because layout was
  persisted by an autosave side-channel; with no autosave, a move that is never dirty is a move that
  is silently lost.

### 3.8 Read-only is a state, not a silence

Published/deprecated versions render a locked canvas: a lock chip in the header, the palette
visibly disabled, and a primary **Edit as new draft** action (the existing
`createNewVersion` mutation) instead of a muted sentence. `handleAddNode` gets the same `readOnly`
gate the drop path has, so the two paths stop disagreeing.

---

## 4. Implementation Plan — four phases, in dependency order

Phase 4 **cannot** precede Phases 2 and 3: §2.7 shows deletion would remove every `core.action`
capability, and §2.8 shows the seeds and assignments still reference the legacy types.

### Phase 1 — Studio UX and canvas mechanics *(no contract change, no migration)*

Delivers every item in the owner report except the deprecation retirement.

| # | Work | Verify |
|---|---|---|
| 1.1 | Pass `onEdgesChange`; add edge hover-delete + Delete-key; edge selection styling | new `workflow-canvas` vitest: a `remove` change reaches the consumer |
| 1.2 | Read-only: locked canvas, disabled palette, `Edit as new draft` primary; gate `handleAddNode` | editor test: palette click on a published definition is inert |
| 1.3 | Single-socket presentation + auto socket resolution on connect; branch handles retained | `port-compatibility` tests unchanged and still green; new resolution unit tests |
| 1.4 | Step numbering from a topological sort; cycle/unreachable markers | layout unit test |
| 1.5 | Loop: Wrap in loop / drag in-out / Unwrap | store + canvas tests |
| 1.6 | Layout: `contentMode="fill"`, collapsible palette, tabbed inspector (Config · Problems · Run) | axe scan 0 violations, both themes, 200 % zoom reflow |
| 1.7 | Palette cards — `rounded-md`, icon + name + one-line purpose | visual + test |
| 1.8 | Save / Discard replacing autosave; `moveNode` marks dirty | rewrite `use-autosave` tests as save-model tests |
| 1.9 | Delete both list interfaces; single studio + workflow switcher; keyboard parity for every mutation | WCAG 2.5.7 keyboard pass documented |
| 1.10 | Embedded Run tab + per-node run overlays; `shared/sandbox/` extraction; workbench redirect | run against the live stack |
| 1.11 | `summary` field in node config schemas; inspector renders summary inline, description in a popover | schema test |

**Gate:** `pnpm --filter @arcaai/admin-console build lint test` green · `pnpm --filter @arcaai/ui test`
green (this touches `packages/ui`, so its suite is in scope per rule 01) · runtime verified in the
running app · axe 0 violations · both themes.

### Phase 2 — Promote the action catalogue to first class

`ACTION_CATALOGUE` stops being a filtered view of the deprecation table and becomes its own table
(`key → activityName · configSchema · ports · label · flags`), mirrored into `registry.py` and the
parity fixture. The Studio's action list reads that table instead of
`deprecated === true && replacedBy === 'core.action'`.

**Gate:** `pnpm --filter @arcaai/workflow-contract test` · `pnpm harness:test` · parity fixture
regenerated and green on both sides.

### Phase 3 — Migrate the seeded graphs to `core.*`

> **Superseded 2026-09-08 (owner directive, TASK-930 D-8).** The owner asked to delete all old seed data and rebuild it — OD-6's second branch. Lane S authors every seeded graph in `core.*` from scratch (INTERFACES §8); no migration of the 11 legacy graphs happens. The four `WorkflowAssignment` rows are re-seeded against the new slugs under palette `core` (TASK-930 D-6). The text below is the original plan, kept for the record.


A one-shot migration driven by each descriptor's own `replacedBy`:

| Legacy | Becomes |
|---|---|
| `core.start` / `core.end` | `core.trigger` / `core.output` |
| `consultation.*` | `core.action` with `actionKey: '<legacy type>'` |
| `agent.*` | `core.agent` bound to the matching published Agent row |
| `guard.*` | node-level guardrail config on `core.agent` |

Published as a **new version under the same slug** for each of the 11 definitions, so the four
`WorkflowAssignment` rows keep resolving. `compiledConfig` and all three checksums regenerate through
the existing scripts.

**Gate:** every migrated definition validates clean · seed idempotency tests green · the four
assignments still resolve · a sandbox run of `arcaai-consultation-soap` completes.

### Phase 4 — Delete the legacy vocabulary

Remove the 62 descriptors, their ports, config schemas, the `WF-CONS-*` / `WF-S-*` / `WF-I-*` /
`WF-SUMM-*` / `WF-STT-*` rules that reference them, the Python `NodeSpec`s and their activities, then
regenerate the parity fixture. TS and Python move in the same change or CI fails on both sides.

**Gate:** `pnpm verify` · `pnpm harness:test` · `pnpm test:e2e` · no `deprecated: true` left in the
registry · the deprecation register (`docs/operations/deprecation-register.md`) updated to record the
removal.

---

## 5. Open Questions for the owner

| # | Question | Recommendation |
|---|---|---|
| **Q-1** | Confirm ticket number **TASK-893** (highest existing is TASK-892). | Proceed as TASK-893. |
| **Q-2** | Phase 1 alone answers the whole owner report and ships without touching the contract, the interpreter or the seeds. Ship it first and review before Phases 2–4? | **Yes.** Phases 2–4 are a cross-language retirement with a CI parity gate on both sides; they deserve their own review. |
| **Q-3** | Secondary data inputs move from wires to inspector fields (§3.1.3). This is the one change an author will *feel* — richly-wired graphs lose visible wires. | Accept: it is what makes "one link" honest, and the binding is still explicit and validated. |
| **Q-4** | The `summary` field (§3.5) means touching ~75 config schema entries. Do it across the board, or only for the `core.*` types an admin actually authors? | `core.*` only in Phase 1; the rest disappear in Phase 4 anyway. |

---

## 6. Implementation Summary

**All four phases are delivered on `dev-2.2`.** Phase 1 merged 2026-09-07 (recorded immediately
below); Phases 2 and 4 merged 2026-09-08 as **lane R** of the TASK-930 wave, with the Python half
finished by fix-up lane **F-PY**; Phase 3 was **superseded** — the owner directed a deletion and
rebuild (TASK-930 D-8) instead of a migration, delivered by lane S. That record is
[§6 Phases 2–4](#phases-24--the-legacy-vocabulary-retirement-2026-09-08) below.

**One declared gate is still unrun, which is why this ticket is not yet `Completed`:** Phase 4's
gate line names `pnpm test:e2e`, and the API e2e suite has not been run on the integrated tree —
the isolated test infra (`:5433`) was down for the whole wave, and one e2e spec was EDITED during
the merge (`task-776-credential-classes.spec.ts`, whose deny-by-default example moved off
`GET /workflows` now that route admits service accounts). It rides on the same local-stack and
database consent that gates TASK-930's ask #2/#3 runs. Everything else in the Phase 4 gate is
green: `pnpm typecheck:all` 0 · `pnpm lint:all` 0 · workspace `pnpm test:unit` **23 803 passed /
0 failed** · `pnpm harness:test` **2 201 passed / 6 failed** (the six are a pre-existing task-355
patch-marker defect, its own ticket — §6 below) · `grep "deprecated: true"` over the registry
returns 0 · the deprecation register records both the removal and its deploy precondition.

### Delivery — five parallel lanes against one written contract

Built in five isolated worktrees with exclusive file ownership and the signatures in
`INTERFACES.md` agreed up front. **All five merged into `dev-2.2` with zero conflicts**, which is
the partition working as intended rather than luck: the 767-line editor was touched by nearly every
task, so it was given a single owner and everyone else coded against the document.

| Lane | Model | Delivered |
|---|---|---|
| A — canvas | opus | Single-socket rendering + branch handles, `onEdgeDelete`, step badges, run chips, group drag |
| B — copy / palette / inspector | sonnet | Palette cards (not pills), 63 plain-language `summary` entries, tabbed inspector, binding fields |
| C — sandbox | sonnet | `shared/sandbox` extraction, `SandboxRunPanel`, workbench route retired to a redirect |
| D — store / lib | opus | Save-Discard state machine, loop wrap/unwrap, `computeStepOrder`, `resolvePrimarySockets` |
| E — editor / routes | opus | One studio, both lists deleted, read-only lock, layout, keyboard parity |

### Defects the cross-lane review caught before they shipped

Each was found because one lane could see what another could not; none would have been caught by
either lane alone.

| # | Defect | Resolution |
|---|---|---|
| **I-1** | `resolvePrimarySockets` treated the canvas's primary handle id `out` as an explicit branch grab, so the `next -> after` ordering fallback was unreachable and `consultation.synthesize -> consultation.extractEntities` was REFUSED rather than degrading. Lane A predicted it from the canvas side; Lane D's own 4761-pair sweep ran hint-free and could not see it. | Primary id filtered out of the hint; pinned by a sweep asserting hinted and unhinted answers agree for every pair. |
| **I-2** | Secondary-input bindings were written to `config.inputs.<port>`. The interpreter never reads that — `_resolve_bound_inputs` resolves data flow from EDGE bindings only — so a bound field would have validated, rendered as bound, and threaded nothing into the run. | Bindings are real typed edges; only the DRAWING moved into the inspector. The dead config surface (a permissive `object` punched through 10 schemas' `additionalProperties: false`) was reverted and its removal pinned. |
| **I-3** | `useSaveModel.save()` is a deliberate no-op while `paused`, but `canSave` ignored `paused` — after a 412 the Save button stayed enabled and did nothing. | `!save.paused` added to `canSave`; recovery is the `OccConflictAlert`'s Reload/Overwrite. |
| **I-4** | `wrapInLoop` accepts many nodes but the canvas exposed single selection only, so OD-5's "one or many" could only ever wrap one. | `selectedNodeIds` / `onSelectionChange` added to the canvas; the editor wraps the whole selection. |

### The defect only the running app could show

**I-5 — ordering edges rendered as nothing.** Collapsing the node chrome to one input and one
output dot deleted the `after`/`next` handles, and React Flow silently DROPS an edge whose named
handle does not exist. Every `next -> after` edge therefore vanished from the canvas while the wire
data was perfectly intact — and every seeded graph is built out of those, so a whole 24-node chain
would have looked disconnected. Every unit fixture wired `out -> in`, so no suite could see it.

Fixed by projecting wire sockets onto the rendered handles when building `canvasEdges` (the inverse
of `resolvePrimarySockets`); branch handles keep their own id, everything else lands on the primary
pair, and the store is untouched. Two regression tests pin both halves: the canvas gets the
projection, the saved graph keeps the real sockets.

### Verified against the running stack

Logged into the dev console and exercised the paths the owner reported as broken:

| Check | Result |
|---|---|
| Node drag on a DRAFT | moves, marks dirty (`translate(12.95, 40.22)` -> `translate(12.95, 91.22)`) |
| Save / Discard | Discard reverts the position and returns the footer to "All changes saved" behind a confirmation |
| Edge delete | hover-X removes it — 2 rendered -> 1, footer 3 -> 2 connections, graph dirty. **Impossible before this ticket.** |
| Ordering edge | renders after I-5 (2 of 3 edges drawn; the third is the secondary binding, shown in the inspector) |
| Read-only (PUBLISHED) | Locked badge, explanatory banner, `Edit as new draft` primary, locked palette with its reason, no Save/Publish |
| Palette | real cards, `rounded-md`, icon + name + one-line purpose |
| Step order | ① ② ③ badges from the topological sort |

### Gates

`@arcaai/workflow-contract` 1701 tests · `@arcaai/ui` 755 tests · `@arcaai/admin-console` 2639 tests
· `@arcaai/applications` 12254 tests — all green. Lint, typecheck and build clean for all four.

One suite could not run: `agentPromotion/.../membership-bounded-sync.integration.test.ts` needs the
isolated test infra (Postgres 5433 / Redis 6380), which was not up. Environmental, unrelated to this
change, and unverified rather than passing.

### Carve-out — per-node run overlays are blocked on the backend

The Run tab and the per-node trace list work in the studio as OD-3 requires. The per-node CANVAS
overlays do not, and cannot yet: `RunNodeRollupResponse` carries `nodeType` + `order` and
deliberately no graph node id (its own field doc says so). With two `core.agent` nodes, or any loop
body, attributing a trace row to a node is a guess — and a wrong "ok" chip on the wrong box is worse
than none. `useSandboxNodeStates` is wired forward-compatibly and returns an empty map today; the
rendering is already in place on the canvas. Unblocking it needs the interpreter to stamp a graph
node id onto trajectory rows, which is outside this ticket.

### Phases 2–4 — the legacy vocabulary retirement (2026-09-08)

Run as **lane R** of the TASK-930 wave (worktree `../hope-v2-t893-r`, branch `task-893-retire`,
35 commits, merged at `699c0ca33`), against the written contract in
[`../TASK-930-…/INTERFACES.md`](../TASK-930-Agent-Workflow-Platform-Commitments/INTERFACES.md) §7.
Two fix-up lanes finished the integration it could not reach from inside its own file ownership:
**F-TS** on the primary checkout (`474cc2728`…`17aa15a77`) and **F-PY** (`fixup-930-harness`,
merged at `2232354c6`). The full wave record, including the rulings that decided the reds, is
TASK-930 README §4.3 / §4.5 / §4.6.

**Phase 2 — the action catalogue is its own table.** `ACTION_CATALOGUE` stopped being a filtered
view of the deprecation table (§2.7's load-bearing finding) and became a first-class table in both
languages — `packages/workflow-contract/src/action-catalogue.ts` and
`apps/harness/…/interpreter/action_catalogue.py` — with `ACTION_PORTS` and `ACTION_CONFIG_SCHEMAS`
beside it. **17 keys kept, 17 agent-shaped keys dropped** (INTERFACES §7.2). `effective_spec` (Python)
and `actionDelegateOf` / `classesOf()` (TS) resolve a `core.action` INSTANCE through the catalogue,
never through the node registry, so a `mandatory` / `redaction` / `activity` class still reaches a
rule or a finding. The Studio's action dropdown reads the catalogue instead of
`deprecated === true && replacedBy === 'core.action'`.

**Phase 3 — superseded, not skipped.** The owner directed deletion-and-rebuild (TASK-930 D-8,
recorded inline at §4 Phase 3 above), so no legacy graph was migrated. Lane S deleted seeds
`21` / `23` / `24` / `07e-consultation-loop-defaults` / `07g-consultation-legacy-context-schema`
with their regen scripts and authored the replacement set in `core.*` from scratch:
`07e-consultation-note-context-schema.ts` (ONE trigger context schema, `isDefault: true`),
`28-workflow-library{,.generated}.ts` (Global and SYSTEM each carrying five agents and two
workflows, SYSTEM stamped `sourceTenantId = Global`) and
`29-arcaai-agents-and-workflows{,.generated}.ts` (27 agents / 13 workflows generated from the
department × visit-type table, 1 TENANT + 11 DEPARTMENT assignments). The §2.8 concern that
assignments bind by slug is answered by re-seeding them against the new slugs under palette `core`.

**Phase 4 — the vocabulary is gone, in lockstep.** `WORKFLOW_NODE_REGISTRY` 72 → **11 `core.*`
types**; `registry.py` 64 → the **11** matching `NodeSpec`s; `NODE_ACTIVITIES` 65 → **29**, derived
from the catalogue so the worker serves exactly what the interpreter dispatches;
`MANDATORY_NODE_TYPES = {core.trigger, core.output}`; the `WF-CONS-*` / `WF-SUMM-*` rules and
`DRAFT_CONSULTATION_RULE_SET` deleted; `grep "deprecated: true"` returns 0. Seventeen of the retired
types **survive as actions** behind `core.action`, descriptors, ports, schemas and activity callables
copied verbatim — they are no longer node types.

**Source defects found and fixed, rather than tests edited.** Each was invisible until the
vocabulary moved:

| # | Defect | Fix |
|---|---|---|
| **P-1** | `GUARDRAIL_OPTED_OUT` in `publish-findings.ts` had become dead code — it tested the mandatory SET, which is now exactly the two types whose schema withholds `enabled`. It is the first of TASK-890 D-1's three compensating controls | resolve the mandatory class per INSTANCE |
| **P-2** | `core.start` was still in `ENTRY_NODE_TYPES` after being retired | removed; the Studio no longer treats it as a graph entry |
| **P-3** | The realtime flush projection, degrade reason and admin read-out keyed on the retired `canonicalRealtimeNodeType` | re-keyed on a CAPABILITY (`realtimeCapabilityOf()`) |
| **P-4** | `node-prompt-binding.ts` never read a `core.action`'s `config.action.promptTemplateId`, so **every core graph pinned no prompt version** — a template edit silently re-prompted a published clinical workflow | binding collected from the delegate config |
| **P-5** | `config-resolver.service.ts`'s `isGenerationNode` missed core graphs, so **auto-summary stayed ON for a graph that switched it off** | resolved through `classesOf` |
| **P-6** | `GET /admin/workflow-nodes` served node types only, so the Studio's `effectiveNodePorts` fell back to the generic superset (six sockets where the action has one) | serves the 17 action descriptors too, each labelled `kind: 'node' \| 'action'`; the palette rail filters on it, because an action is not a draggable node type |
| **P-7** | `agentic.tts` streamed every synthesis frame on the delta lane; its `core.agent` `_run_speech` replacement stored the artifact and streamed nothing — the audio half of the two-lane split had been lost with the node type | emission ported into `_run_speech`, measured by `test_task849_audio_two_lane_split.py` |

**The agentic-loop subsystem was removed, not orphaned.** `agentic.loop` was the only dispatcher of
`AgenticLoopWorkflow` / `AgenticSubAgentWorkflow` and left the registry in Phase 4; under OD-2 the
subsystem is deleted (531 lines, 8 activities, both worker registrations, its tests and fixtures).
`interpreter/loop_activities.py` is KEPT — the live `core.loop` schedules
`interpreter.loop_state_checkpoint` through it. Register entry:
[`deprecation-register.md` §"TASK-893 fix-up"](../../operations/deprecation-register.md).

**Deploy precondition (unchanged, and the reason this is not a pure code change): drain in-flight
harness workflows before deploying.** Deleting a node type changes what the interpreter SCHEDULES,
so a history recorded when that node dispatched replays as `TMPRL1100 Nondeterminism`, and
`workflow.patched` cannot rescue it because the old path IS the deleted entry. The six backward-guard
replay tests were re-fixtured onto `core.*` under the owner ruling of 2026-09-08 (TASK-930 §4.5) —
a recorded history stops being evidence once the vocabulary it replays is retired by decision.

**Pinned as tests rather than silently changed** (each is a real consequence of the retirement, and
a reviewer's most likely undo): all ten `WF-I-*` invariants are INERT under `core` (they declare
`paletteKey: 'summarization'` and `validate()` skips a foreign palette); `WF-S-007` is vacuous for
`core`; anti-laundering is weaker for NER (a `core.agent` typed on `text`, which `document` widens
to); and `compileGate` may now be unreachable, since nothing is `gate`-classed.

**Follow-ups this retirement created, each out of scope here:** `proposeCorrections` /
`extractFindings` are implemented but unreachable — no `core.*` node resolves to either capability,
so grammar corrections and important-findings mining left the realtime lane (TASK-930 §4.6 G-2);
`PromptResolutionService` graph tier 1a is unauthorable under `core` and is now inert source (G-3);
and the six remaining harness reds are a **live defect, not fixture rot** — `HarnessDocWorkflow` no
longer issues `workflow.patched("task-355-optimistic-delivery")` while recorded histories carry the
marker, the same deploy hazard class as the drain precondition.

**Gates.** Lane R: workflow-contract 38 files / 827 · Studio 56 files / 544 (`--max-warnings 0`) ·
`py-workflow-contract` 75 · harness ruff + mypy (152 files) clean. F-TS: `build:packages` 22/22 ·
applications **12 242 passed / 0 failed** · api **4 270 passed** · admin-console **2 640 passed** ·
workflow-contract 839 · database 1 651. F-PY: `pnpm harness:test` **34 → 6 failed / 2 201 passed** ·
ruff + mypy (150 files) clean. Integrated tree at `61e05e089`+: `pnpm typecheck:all` 0 errors,
`pnpm lint:all` 0 errors, workspace `pnpm test:unit` **23 803 passed / 0 failed**. `pnpm test:e2e`
is the one gate still owed (see the top of §6).

*(The section below is the accessibility record the plan requires from the editor-shell lane, and it
outlives the ticket because it is the contract that replaced the List view.)*

### Keyboard parity (WCAG 2.5.7) — the List view's replacement

Deleting the List view (OD-1) removes what `create-graph-store.ts`'s `reorderNode` comment called
the pointer-free path: it satisfied 2.5.7 "by construction rather than by adding a keyboard shim to
a drag interaction". Every mutation therefore keeps a non-drag path **on the canvas**, and this is
the register of them. A future change that removes one of these without replacing it re-opens the
accessibility defect, not just a convenience.

| Mutation | Drag path | Non-drag path (WCAG 2.5.7) | Where |
|---|---|---|---|
| **Add** a node | drag a palette card onto the pane (`onPaneDrop`) | activate the palette card — it is a real `<button>`, reached by Tab | `palette/palette-item.tsx` → `handleAddNode` |
| **Add into a loop** | drag onto the group | select the loop, then activate a palette card — the new node joins that loop's body | `handleAddNode`'s `parentId` branch |
| **Connect** two nodes | drag handle → handle | **Node actions → Connect to…**, listing every other node in execution order | `StudioToolbar` `nodeCommands.onConnectTo` |
| **Disconnect** | hover-X on the edge, or Delete on a selected edge | Delete/Backspace with the edge selected (canvas `deleteKeyCode`) | `onEdgeDelete` → `disconnectEdge` |
| **Move into / out of a loop** | drag across the group boundary (`onNodeParentChange`) | **Node actions → Move into…**, offering every `core.loop` plus "Top level" | `nodeCommands.onMoveToLoop` → `setNodeParent` |
| **Wrap / Unwrap** a loop | — (no drag path at all) | **Node actions → Wrap in loop / Unwrap loop** | `nodeCommands.onWrapInLoop` / `onUnwrapLoop` |
| **Duplicate** | — | **Node actions → Duplicate**, and `Ctrl/Cmd+D` (`useStudioShortcuts`) | `duplicateNode` |
| **Delete** a node | — | Delete/Backspace on the selected node, the node's own Remove button, **Node actions → Remove node** | `onDeleteRequest` → `deleteNode` |
| **Reorder** | — | not an authored property any more: execution order is DERIVED from the graph (`computeStepOrder`), so it changes by connecting/disconnecting, which both have keyboard paths above | `lib/step-order.ts` |
| **Undo / Redo / Save / Discard** | — | toolbar buttons, plus `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` | `StudioToolbar`, `useStudioShortcuts` |
| **Focus a problem's node** | — | activate the finding in the Problems tab; selection *and* DOM focus move to the node | `validation/use-focus-node.ts` |

Two consequences worth stating, because they are the parts a reviewer is most likely to undo:

1. **`reorderNode` has no replacement and needs none.** It reordered the `nodes` array, which was
   the List view's row order and nothing else. The canvas presents execution order as a derived
   step badge, so there is no authored ordering left to move up and down.
2. **The "Node actions" menu is not a convenience.** *Connect to…* and *Move into…* have no other
   non-drag path anywhere in the studio. It is disabled — not hidden — when nothing is selected, so
   it stays discoverable, and it is absent on a read-only version where no mutation is possible.

Automation covers what it can (the menu's enabled/disabled contract and every store-facing callback
are unit-tested; each screen is axe-scanned). Radix submenu traversal is not exercised in jsdom, so
the manual pass in the `web-accessibility` skill — Tab to each control, operate the menu with the
keyboard only, confirm focus is never obscured at 200 % zoom — remains part of this ticket's
definition of done.

---

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-08 (close) | §6 records Phases 2–4: the action catalogue as a first-class table (17 kept / 17 dropped), the vocabulary deleted TS + Python in lockstep (registry 72 → 11, `NodeSpec` 64 → 11, activities 65 → 29), Phase 3 superseded by the seed rebuild, seven source defects fixed rather than tests edited (P-1..P-7), the agentic-loop removal and the drain deploy precondition. Two follow-ups the retirement created are named (G-2 unreachable realtime capabilities, G-3 the inert prompt tier) and so is the pre-existing task-355 patch-marker defect behind the six harness reds. Status kept `In Progress` for one reason only: Phase 4's declared `pnpm test:e2e` has not been run on the integrated tree. Rule amendments landed with it (05 promotion gate, 06 harness vocabulary + drain precondition, and the register's `21/23/24` row made renderable). |
| 2026-09-07 | Created. Root-caused the four interaction failures to read-only mode on 11/12 seeded PUBLISHED definitions (verified live); found edge deletion unwired in the Studio; found `ACTION_CATALOGUE` derived from the deprecated registry entries, which is why they still exist. Plan drafted in four dependency-ordered phases. |
| 2026-09-08 (later) | Lane R worktree `../hope-v2-t893-r` (branch `task-893-retire`, base `7793d09ca`): first run killed by the account spend limit before committing; relaunched. Amendment: R exports `outputSchemaResponseFormat` from `packages/workflow-contract/src/index.ts` (TASK-930 §4.2 A-4). Full lane log: TASK-930 README §4.1. |
| 2026-09-08 | Phases 2 + 4 started as lane R of the TASK-930 wave (measured baseline: 72 registry entries / 61 deprecated / 11 `core.*`; rule counts WF-CONS 19, WF-S 7, WF-I 10, WF-SUMM 6, WF-STT 0, WF-CORE 3 — the §2.7/§2.8 figures were approximate). Phase 3 superseded by the seed rebuild. Action catalogue curated to 17 kept / 17 dropped keys (INTERFACES §7.2). |
| 2026-09-07 | Phase 1 delivered across five parallel worktrees and merged to `dev-2.2` with zero conflicts. Five integration defects caught and fixed (I-1..I-5, §6) — four by cross-lane review, one only by exercising the running app. All gates green; per-node run overlays carved out pending an interpreter change. |
