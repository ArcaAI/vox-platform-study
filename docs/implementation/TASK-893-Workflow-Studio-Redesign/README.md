# TASK-893 — Workflow Studio Redesign & Legacy Vocabulary Retirement

| Field | Value |
|---|---|
| **Status** | `Pending` — plan for approval, no code written |
| **Type** | `refactor` + `feature` (studio UX) / `infrastructure` (registry + seed retirement) |
| **Branch** | `dev-2.2` |
| **Raised** | 2026-09-07 |
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

*(empty — no code written; this document is the Phase 3 plan gate per `01-development-workflow.md`.)*

---

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-07 | Created. Root-caused the four interaction failures to read-only mode on 11/12 seeded PUBLISHED definitions (verified live); found edge deletion unwired in the Studio; found `ACTION_CATALOGUE` derived from the deprecated registry entries, which is why they still exist. Plan drafted in four dependency-ordered phases. |
