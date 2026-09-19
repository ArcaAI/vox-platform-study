# TASK-893 Phase 1 — Lane Ownership & Interface Contract

**This file is the coordination contract for five parallel lanes.** Every lane codes against the
signatures below. A lane MUST NOT change a signature declared here — if one is wrong, stop and
report it to the orchestrator; do not "fix" it locally, because four other agents are writing
against the same text.

---

## 1. File ownership — exclusive, no overlaps

| Lane | Owns (exclusive write access) |
|---|---|
| **A — Canvas** | `packages/ui/src/components/workflow-canvas/**` |
| **B — Copy, palette, inspector** | `packages/workflow-contract/src/node-config-schemas.ts` · `apps/admin-console/src/features/workflow-studio/components/palette/**` · `.../components/inspector/**` · `.../components/canvas/**` |
| **C — Sandbox** | `apps/admin-console/src/shared/sandbox/**` (new) · `apps/admin-console/src/features/workbench/**` · `apps/admin-console/src/app/(console)/(tenant)/playground/workbench/**` |
| **D — Store, hooks, lib** | `apps/admin-console/src/features/workflow-studio/store/**` · `.../hooks/**` · `.../lib/**` |
| **E — Editor shell, routes** | `.../components/workflow-studio-editor.tsx` · `.../components/studio-toolbar.tsx` · `.../components/workflow-studio-screen.tsx` · `.../components/definitions-list-screen.tsx` (DELETE) · `.../components/list-editor/**` (DELETE) · `.../components/validation/**` · `.../components/index.ts` · `apps/admin-console/src/app/(console)/(tenant)/workflow-studio/**` · `apps/admin-console/src/shared/navigation/nav-config.ts` |

**Anything not listed above is owned by nobody.** If your lane needs a change outside its rows —
`nav-config.ts`, a barrel in another lane's tree, a shared type — **do not edit it**. Write the
request in your final report under `### Cross-lane requests` and the orchestrator applies it at
integration.

`apps/admin-console/src/features/workflow-studio/api/**` is **frozen** for Phase 1. No lane edits it.

---

## 2. Contract A — `WorkflowCanvas` (produced by Lane A, consumed by Lane E)

### 2.1 `WorkflowCanvasNode` — changed shape

```ts
export interface WorkflowCanvasNode {
  id: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  safetyClasses?: readonly string[];
  config?: Record<string, unknown>;
  kind?: 'node' | 'group';
  parentId?: string;
  deprecated?: boolean;
  problem?: { severity: 'ERROR' | 'WARNING'; messages: string[] };

  // ---- REMOVED in TASK-893 ----
  // ports?: { inputs: WorkflowCanvasPort[]; outputs: WorkflowCanvasPort[] };
  //   The per-port handle rendering is deleted. `WorkflowCanvasPort` goes with it.
  //   Replaced by the four fields below.

  /** Render the single primary TARGET handle (id `"in"`, left edge). Default `true`.
   *  `false` for a graph entry node such as `core.trigger`. */
  hasInput?: boolean;
  /** Render the single primary SOURCE handle (id `"out"`, right edge). Default `true`.
   *  `false` for a terminal node such as `core.output`. */
  hasOutput?: boolean;
  /** Extra labelled SOURCE handles stacked below the primary output — the ONLY case where a
   *  node shows more than one output. `id` is the React Flow handle id and MUST be the real
   *  wire port name (`then`, `else`, `approved`, `each`, …). Absent/empty = primary only. */
  branches?: readonly { id: string; label: string }[];

  /** 1-based execution order badge. `null`/absent renders no badge. */
  stepNumber?: number | null;
  /** Rendered INSTEAD of `stepNumber` when the node is not linearly ordered. */
  stepMarker?: 'cycle' | 'unreachable';
  /** Per-node sandbox run state, rendered as a status chip in the node header. */
  runState?: 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
  /** Wall time of the last run of this node, rendered beside `runState`. */
  runDurationMs?: number;
}
```

### 2.2 `WorkflowCanvasProps` — added callbacks

```ts
export interface WorkflowCanvasProps {
  // ...every existing prop stays, with existing semantics...

  /** The ONE deletion channel for edges. Lane A calls this for BOTH the Delete/Backspace key on
   *  a selected edge AND the hover-X affordance. Exactly mirrors how node removals already call
   *  `onDeleteRequest`. Absent or `readOnly` = edges are not deletable. */
  onEdgeDelete?: (edgeId: string) => void;

  /** A node was dragged into, out of, or between loop groups. `parentId` is `null` when the node
   *  was dropped on the bare pane. `position` is already expressed relative to the NEW parent
   *  (or to the pane when `parentId` is `null`), so the consumer stores it verbatim. */
  onNodeParentChange?: (nodeId: string, parentId: string | null, position: { x: number; y: number }) => void;
}
```

**Behaviour Lane A must implement**

1. **Edge delete.** Wire `onEdgesChange` internally (`applyEdgeChanges`), intercept `remove`
   changes and call `onEdgeDelete(id)`. Add a hover-X on the edge via `EdgeLabelRenderer`, hidden
   when `readOnly`, with an `aria-label` naming the edge. Keep `deleteKeyCode` covering edges.
2. **Single-socket rendering.** `workflow-node.tsx` renders at most one target handle (`in`) and
   one source handle (`out`), plus one labelled source handle per `branches` entry. Delete
   `PortHandle` and the two-column ports grid.
3. **Step badge.** A small numeric badge at the head of the node. `stepMarker` renders `↻` (cycle)
   or `⚠` (unreachable) with an accessible name, never colour alone.
4. **Run chip.** `runState` renders a status chip + `runDurationMs`. Text, not colour alone.
5. **Group drag.** On `onNodeDragStop`, hit-test the drop point against `kind: 'group'` nodes and
   call `onNodeParentChange` when the parent changed. Keep `extent: 'parent'` for existing children.
6. Keep every existing anti-re-render guard and the comments that explain them (the
   `selectNodesOnDrag={false}` / memoized-`onSelectionChange` reasoning is load-bearing — it fixed
   a "Maximum update depth exceeded" crash).

---

## 3. Contract D — store, hooks, lib (produced by Lane D, consumed by Lane E)

### 3.1 Save model — `store/types.ts`

```ts
export type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';
```
`AutosaveState` is deleted.

### 3.2 `store/create-graph-store.ts`

```ts
export interface GraphState {
  nodes: GraphStoreNode[];
  edges: GraphStoreEdge[];
  selectedNodeId: string | null;
  dirty: boolean;
  saveState: SaveState;
  lastSavedVersion: number | null;
  /** The last SAVED graph. `discard()` restores it. Set by `hydrate` and `markSaved`. */
  baseline: { nodes: GraphStoreNode[]; edges: GraphStoreEdge[] } | null;
  undoStack: GraphSnapshot[];
  redoStack: GraphSnapshot[];
  // `viewMode` and `autosaveState` are DELETED (single canvas view, no autosave).
}
```

Actions — existing ones keep their signatures unless noted:

```ts
setSaveState(state: SaveState): void;
/** Revert nodes/edges to `baseline`, clear both stacks, `dirty=false`, `saveState='clean'`.
 *  No-op when `baseline` is null. */
discard(): void;
/** Also sets `baseline` to the current graph and `saveState='saved'`. */
markSaved(version: number): void;

/** CHANGED: now marks the graph dirty. With autosave gone, a move that is not dirty is lost. */
moveNode(nodeId: string, position: { x: number; y: number }): void;

/** Creates a `core.loop` sized around the given nodes and re-parents them into it.
 *  Refuses when the set is empty, contains a `mandatory` node, or contains a node that already
 *  has a different parent. Undoable, dirty. Returns the new loop id on success. */
wrapInLoop(nodeIds: string[]): ActionResult & { loopId?: string };
/** Dissolves the loop, re-parenting children to the top level with absolute positions, and
 *  deletes the loop node. Undoable, dirty. */
unwrapLoop(loopId: string): ActionResult;
/** Drag into/out of a group. `parentId` null = top level. Undoable, dirty. */
setNodeParent(nodeId: string, parentId: string | null, position: { x: number; y: number }): void;

// DELETED: setViewMode, setAutosaveState, reorderNode (the list editor is gone).
```

### 3.3 `store/selectors.ts`

Keep every existing selector except `selectViewMode` / `selectAutosaveState`, and add:

```ts
export const selectSaveState: (s: GraphStore) => SaveState;
export const selectCanSave:   (s: GraphStore) => boolean;   // dirty && saveState !== 'saving'
export const selectCanDiscard:(s: GraphStore) => boolean;   // dirty && baseline !== null
```

### 3.4 `hooks/use-save-model.ts` — replaces `hooks/use-autosave.ts`

```ts
export interface UseSaveModelOptions {
  definitionId: string;
  getEtag: () => string | null;
  onSaved: (saved: { version: number }, nextEtag: string | null) => void;
  onStateChange: (state: SaveState) => void;
  onMissingPrecondition: () => void;
}
export interface SaveModel {
  /** Explicit, user-initiated save. Keeps the existing If-Match/ETag OCC behaviour verbatim:
   *  428 on a missing precondition, 412 -> `paused` + `lastError` for `OccConflictAlert`. */
  save: (patch: { graph?: unknown; name?: string; description?: string }) => Promise<void>;
  saving: boolean;
  paused: boolean;
  lastError: unknown;
  resume: () => void;
}
export function useSaveModel(options: UseSaveModelOptions): SaveModel;
```
The debounce, the timer and every `schedule()` call site are deleted.

### 3.5 New pure modules in `lib/`

```ts
// lib/socket-resolution.ts
/** The wire sockets ONE user-drawn link resolves to. Prefers the primary data pair
 *  (`out` -> `in`); falls back to the control pair (`next` -> `after`) when either side has no
 *  compatible data port. `null` = these two nodes cannot be linked at all. */
export function resolvePrimarySockets(
  descriptorByType: ReadonlyMap<string, WorkflowNodeDescriptor>,
  source: { type: string; config: Record<string, unknown> },
  target: { type: string; config: Record<string, unknown> },
  sourceHandleHint?: string | null,   // a branch handle the user actually grabbed — wins when set
): { sourceHandle: string; targetHandle: string } | null;

// lib/step-order.ts
export type StepOrderEntry = { step: number } | { marker: 'cycle' | 'unreachable' };
/** Topological order from the graph's entry node(s). Total: every node id gets an entry. */
export function computeStepOrder(
  nodes: readonly { id: string; type: string }[],
  edges: readonly { source: string; target: string }[],
): Map<string, StepOrderEntry>;

// lib/canvas-handles.ts
/** The labelled BRANCH outputs for this instance (config-dependent for the routers).
 *  Reuse the existing `branchHandlesOf` in `@arcaai/workflow-contract` where it applies. */
export function branchHandlesFor(
  descriptorByType: ReadonlyMap<string, WorkflowNodeDescriptor>,
  type: string, config: Record<string, unknown>,
): { id: string; label: string }[];
/** Whether this node type shows a primary input / output dot. */
export function primaryIoFor(
  descriptorByType: ReadonlyMap<string, WorkflowNodeDescriptor>,
  type: string,
): { hasInput: boolean; hasOutput: boolean };
/** Secondary DATA inputs that are no longer wires — the inspector binds them instead. */
export function secondaryInputsFor(
  descriptorByType: ReadonlyMap<string, WorkflowNodeDescriptor>,
  type: string, config: Record<string, unknown>,
): { name: string; primitive: string; required: boolean }[];
```

`lib/palette-drag.ts`, `lib/graph-serialization.ts`, `lib/core-ports.ts`, `lib/port-compatibility.ts`
keep their current exports. `lib/ensure-canvas-layout.ts` stays.

---

## 4. Contract B — inspector shell + node copy (produced by Lane B, consumed by Lane E)

### 4.1 `InspectorPanel` gains tabs and slots

```ts
export type InspectorTab = 'config' | 'problems' | 'run';

export interface InspectorPanelProps {
  // ...every existing prop keeps its current name and meaning...
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  /** Rendered in the Problems tab (Lane E passes the existing ValidationRail). */
  problemsSlot?: React.ReactNode;
  /** Rendered in the Run tab (Lane E passes Lane C's `SandboxRunPanel`). */
  runSlot?: React.ReactNode;
  /** Count badge on the Problems tab. */
  problemCount?: number;
  /** Upstream nodes offered by the secondary-input pickers, in execution order. */
  upstreamNodes?: { id: string; label: string; step: number | null }[];
  /** Secondary data inputs to render as binding fields (from `secondaryInputsFor`). */
  secondaryInputs?: { name: string; primitive: string; required: boolean }[];
}
```
Tabs use `<TabsList variant="line">` per rule 11 §1. The panel keeps ONE scroll container.

### 4.2 Secondary-input bindings

A secondary input renders as a labelled combobox listing `upstreamNodes`. Its value is written into
node config under `inputs.<portName>` as `{ fromNodeId: string }`, and cleared by selecting "None".
Lane B owns the field component; the config key shape above is the contract.

### 4.3 Copy

Add `summary` beside `description` on every **`core.*`** entry in `NODE_CONFIG_SCHEMAS`
(`packages/workflow-contract/src/node-config-schemas.ts`). Deprecated entries are NOT touched —
they are removed wholesale in Phase 4.

- `summary`: ≤ 80 characters, plain language, sentence case, no ticket ids, no backticks, no
  normative "MUST/never" phrasing. Example — replacing the 500-character `enabled` description:
  **"Skip this node without removing it."**
- `description` keeps its existing text verbatim. It is the contract documentation and the API-docs
  source; do not shorten or reword it.
- The inspector renders `summary` inline under the field label, and `description` behind a `?`
  popover trigger with an accessible name. When `summary` is absent, fall back to `description`
  **truncated to one line** with the full text in the popover.

### 4.4 Palette cards

`PaletteItem` stops being a `<Button>`. It becomes a real card: `rounded-md` (never
`rounded-control` / `rounded-full`), an icon, the node name, and a one-line purpose from the
descriptor's `summary`. It stays a semantic `<button>` element (keyboard + WCAG 2.5.7), stays
`draggable` with the existing `writePaletteDragType`, and keeps the disabled/unentitled reasons.

---

## 5. Contract C — sandbox (produced by Lane C, consumed by Lane E)

```ts
// apps/admin-console/src/shared/sandbox/index.ts
export type SandboxNodeRunState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

/** Fixture picker + Run button + live progress. Self-contained; safe to mount in a narrow rail.
 *  Reports the active run id so the caller can drive per-node overlays. */
export function SandboxRunPanel(props: {
  definitionId: string | null;
  /** Disables Run with a stated reason (e.g. unsaved edits). */
  blockedReason?: string | null;
  onRunIdChange?: (runId: string | null) => void;
}): React.ReactElement;

/** Per-node state for the canvas overlay. Empty map when `runId` is null. */
export function useSandboxNodeStates(
  runId: string | null,
): Map<string, { state: SandboxNodeRunState; durationMs?: number }>;

/** The per-node trace for the inspector's Run tab. */
export function SandboxNodeTrace(props: { runId: string | null; nodeId: string | null }): React.ReactElement;
```

Lane C also converts `app/(console)/(tenant)/playground/workbench/page.tsx` into a `redirect()` to
`/workflow-studio`, with a comment naming the release that deletes it (rule 13 §Routing), and removes
the superseded `features/workbench/components/**`. **Lane C does not edit `nav-config.ts`** — it
reports the required nav change instead.

---

## 6. Contract E — what Lane E integrates

Lane E consumes A, B, C and D and owns the studio shell:

1. Single studio at `/workflow-studio` — delete `DefinitionsListScreen` and the grid page; the
   route renders the editor with a **workflow switcher** (searchable combobox: name · v · status)
   plus New / Clone / Import in the header. `/workflow-studio/[definitionId]` stays the deep link.
2. Delete `components/list-editor/**`, the Canvas/List toggle and the `?view=` nuqs state.
3. Toolbar: **Undo · Redo · Save · Discard** + a save-state badge. No autosave.
4. Read-only: locked canvas, disabled palette, primary **Edit as new draft**; `handleAddNode`
   gated on `readOnly` the same way the drop path is.
5. Layout: `contentMode="fill"`; grid `260px / 1fr / 360px`; palette collapsible; the right rail
   collapses entirely when no node is selected.
6. Map store nodes onto Contract A's `WorkflowCanvasNode` using Lane D's `computeStepOrder`,
   `branchHandlesFor` and `primaryIoFor`; connect via `resolvePrimarySockets`.
7. Wire `onEdgeDelete`, `onNodeParentChange`, `wrapInLoop`/`unwrapLoop`.
8. Keyboard parity for every mutation (WCAG 2.5.7) now that the List view is gone: add, connect,
   delete, reorder and wrap must each have a non-drag path. Document the pass in the ticket README.

---

## 7. Rules for every lane

1. **Write code and colocated tests. Do NOT run `pnpm install`, `build`, `lint`, `typecheck`,
   `test` or any `db:*` / `infra:*` command.** The orchestrator runs every gate once, after the
   merge. Your worktree has no `node_modules` and that is expected — do not create one.
2. Stay inside your worktree path. Never write to the primary checkout.
3. Never `git stash` (the stash stack is shared repo-wide).
4. Commit your work on your own branch with a clear message. Do not merge, rebase or push.
5. Follow the repo rules for your surface: `07-react-ui.md` (React 19, no `forwardRef`, cva +
   `data-slot`), `10-skeleton-loading.md`, `11-ux-ui-principles.md`, `13-nextjs-apps.md`.
   Semantic tokens only — never a hardcoded colour, never `rounded-control` on a card.
6. Keep existing explanatory comments that record *why* something is the way it is. If you delete
   the code they describe, delete the comment with it; never delete the comment alone.
7. Final report: files added/changed/deleted, the decisions you made, anything you could not do,
   and a `### Cross-lane requests` section for edits outside your ownership rows.
