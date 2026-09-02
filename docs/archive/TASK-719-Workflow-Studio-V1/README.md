# TASK-719 — Workflow Studio v1

| | |
|---|---|
| **Status** | Review (Phases A–F complete. Session 5 closed the last open a11y finding — the 200 % zoom squeeze — and raised the editor to node-graph-editor baseline: undo/redo, palette filter, drag-time connection validation, duplicate, canvas empty state, graph/problem counts in the status bar. e2e 14 tests, 13 passed / 1 skipped, axe 0 violations in both themes.) |
| **Wave** | 2 · **Size** | XL |
| **Epic slug** | `workflow-studio-v1` |
| **Depends on** | TASK-715 (`workflow-definition-model`), TASK-716 (`workflow-compiler-validator`) |
| **Design refs** | D2 (visual canvas builder), D3 (tenant admins, full power, day one), D4 (generic engine, domain palettes), D6 (CQRS-lite) from [design.md](../../programs/agentic-workflow-platform/design.md) §"Plane 3 — Workflow Studio" |
| **Findings closed** | — |

## 1. Requirement Analysis

Deliver **Workflow Studio v1**: the admin-console feature module where a tenant admin authors a
`WorkflowDefinition` as a graph of sanctioned registry nodes, sees the server's `ValidationReport`
per node, and publishes a frozen version — never authoring executable code (D2).

Five parts, per design.md §Plane 3:

1. **Canvas** — React Flow, wrapped in `packages/ui` as a themed composite.
2. **Palette rail** — served from the registry API; safety class visible; `mandatory` nodes
   pre-placed and non-deletable.
3. **Inspector** — forms *generated* from the registry's per-node-type JSON schemas.
4. **Validation rail** — the server `ValidationReport` mapped to nodes; click an error to focus its
   node; **publish disabled until clean**.
5. **Structured list/tree editor** — a **first-class peer** of the canvas, not a fallback. It is the
   WCAG 2.5.7 single-pointer path and the keyboard-only authoring path (design.md §Plane 3
   "Accessibility"). Both editors drive the same graph model.

Plus the **consolidation** design.md mandates: department-agent and pipeline-policy fold into the
Studio; harness-admin loop settings become definition-level settings; prompt templates keep their own
authoritative editor (picker + deep link). Retired routes keep `redirect()` for one release.

### Explicitly OUT of scope

| Out | Owner |
|---|---|
| The `WorkflowDefinition` Prisma model, registry service, definition CRUD API | TASK-715 |
| The compiler, the `ValidationReport` shape, structural/invariant/schema rules | TASK-716 |
| The interpreter, sandbox execution mode, run dispatch | TASK-718 |
| Any concrete node types / palette content (Summarization palette) | TASK-720 |
| Sandboxed test runs, fixtures, per-node isolated test | TASK-721 |
| Runs list, run trace overlay, run read model | TASK-723 |
| Per-department workflow assignment | TASK-733 |
| Memory-management screens | TASK-728 |
| Cache Components adoption (`cacheComponents: true`) — an admin console is dynamic-by-default (rule 13 §Caching) | — |

Studio v1 renders whatever node types the registry serves. It ships with **zero hard-coded node
types**; if TASK-720 has not landed, the palette rail renders its empty state.

## 2. Current State Evaluation

Every fact below was re-derived against the live tree on this branch.

### 2.1 There is no workflow-authoring surface today

`apps/admin-console/src/features/` contains 60 feature modules; none is a graph editor. Verified by
directory listing — there is no `workflow-studio`, no canvas, no node registry client.

**React Flow is not a dependency anywhere in the monorepo.** `grep -rn "xyflow\|reactflow\|react-flow"
--include=package.json` over the repo (excluding `node_modules`) returns nothing. This is a NEW
third-party dependency and must be evaluated, pinned and licence-recorded before use (Task 2).

### 2.2 The app frame this feature must compose (REUSE, do not re-invent)

| Concern | File to reuse | Notes |
|---|---|---|
| Page frame | `apps/admin-console/src/shared/page/screen-template.tsx:52` | Fixed-height flex column; region order `header → stats → statusBanner → toolbar → tabs`, then content, then pinned `footer`. `contentMode="fill"` (line 72) hands the height to one fill-height child — **this is the mode the canvas needs**; "Never nest a second scroll area inside `fill`" (lines 24–26) |
| Footer status bar | `apps/admin-console/src/shared/page/status-footer.tsx` | Pinned bottom |
| Detail surface | `apps/admin-console/src/shared/detail/detail-drawer.tsx:50` — `DetailDrawer`, sizes `md`/`lg`/`xl` (`SIZE_CLASS`, lines 25–29) | The console-wide record-detail surface. Do NOT hand-roll a Sheet |
| Tenant scope gate | `apps/admin-console/src/shared/tenant-scope/working-tenant-gate.tsx:19` | Keys off `effectiveIsElevated` / `effectiveTenantId` (lines 47–48) — the impersonation-correct check |
| OCC conflict UX | `apps/admin-console/src/shared/occ/occ-alert.tsx:15` — `OccConflictAlert` handles 412 (reload / overwrite) and 428 | Already written; reuse verbatim |
| HTTP core | `apps/admin-console/src/shared/api/http.ts` | `getWithEtag`, `patchWithEtag`, `versionFromEtag`, `GatewayError` with `isVersionConflict` (412) / `isMissingPrecondition` (428) / `isNotFound` (404) |
| BFF proxy | `apps/admin-console/src/app/api/hope/[...path]/route.ts` → `src/server/hope-proxy.ts` | "auth header, tenant scope, OCC headers, 401 recovery" all live in `hope-proxy.ts` |
| Grid | `apps/admin-console/src/shared/data/admin-data-grid.tsx` + `grid-url-state.ts` | Server-driven; URL query-state via nuqs |
| Empty / error states | `apps/admin-console/src/shared/state/empty-state.tsx`, `error-state.tsx` | |
| Nav | `apps/admin-console/src/shared/navigation/nav-config.ts` — `NavEntry` (line 65), `NAV_ENTRIES` (line 90), `visibleNavEntries` (line 455) | Tier `'30-49'` for this feature |

### 2.3 Route-group and tier facts

- Tenant tier guard: `apps/admin-console/src/app/(console)/(tenant)/layout.tsx` — `notFound()` for
  anyone who is neither `isElevated` nor `TENANT_ADMIN` ("Everyone else 404s — never 403").
- Console shell: `apps/admin-console/src/app/(console)/layout.tsx` — `SidebarInset className="h-svh
  overflow-hidden"`, chrome pinned in a `shrink-0` block, content region
  `flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6`. **The content region is already a scroll
  container**; a `contentMode="fill"` `ScreenTemplate` inside it is the pattern that keeps the canvas
  from creating a second scroll area.
- `redirect()` precedent for a retired route, with the delete-in-next-release comment required by
  rule 13: `apps/admin-console/src/app/(console)/(global)/prompt-studio/page.tsx` and
  `.../pstudio/page.tsx`.

### 2.4 Schema→form: the precedent already exists and is shared with the server

`packages/json-schema-subset` (`@arcaai/json-schema-subset`) is a **zero-runtime-dependency** package
holding the constrained JSON Schema (draft 2020-12) subset plus its evaluator:

| Export | Purpose |
|---|---|
| `authorableJsonSchemaProblems(schema, path?)` | Structural problems with an authored schema; rejects `if`/`then`/`else` at any depth, requires a sibling `discriminator.propertyName` on `oneOf` |
| `jsonSchemaValueProblems(schema, value, path?)` | Problems with a submitted value against an authored schema |
| `MAX_SCHEMA_DEPTH` (12), `MAX_SCHEMA_NODES` (512) | Authoring bounds |

Its README states the reason it exists: the rule previously had three independent copies and
"Three implementations of one clinical validation rule drift, and the drift is silent in both
directions". It is already a dependency of `@arcaai/admin-console`
(`apps/admin-console/package.json`, `"@arcaai/json-schema-subset": "workspace:*"`) and is already
used there for the "Editor field builder, publish preview, payload tester".

The live consumer to imitate is the context-schemas feature —
`apps/admin-console/src/features/context-schemas/components/`: `definition-editor.tsx` (244 lines),
`kind-form.tsx` (333), `payload-tester.tsx` (129), `output-form.tsx`, `versions-panel.tsx`.

### 2.5 Form primitives

- `packages/ui/src/components/shadcn/field.tsx:176` exports `Field, FieldLabel, FieldDescription,
  FieldError, FieldGroup, FieldLegend, FieldSeparator, FieldSet, FieldContent, FieldTitle`.
- `react-hook-form` is a **devDependency + optional peer** of `@arcaai/ui`
  (`peerDependenciesMeta.react-hook-form.optional: true`) and is **not** a dependency of
  `@arcaai/admin-console`. Console forms are therefore plain controlled React state + explicit
  validation — e.g. `features/departments/components/department-prompt-config-panel.tsx` (`useState`
  + `FormEvent` + `toast` + `OccConflictAlert`). Do not introduce `react-hook-form` here.
- `zod` v4 is a direct dependency of both `@arcaai/ui` and `@arcaai/admin-console`.

### 2.6 `packages/ui` composite conventions

- Composite groups live at `packages/ui/src/components/<group>/` with their own `index.ts`,
  `types.ts`, and a colocated `__tests__/` — exemplars `live-transcript/` (9 files) and `timeline/`.
- The root barrel `packages/ui/src/index.ts` (508 lines) re-exports composites explicitly and
  documents collision handling (`TimelineItem` omitted, line ~419; `TranscriptSegment` omitted,
  lines 447–449).
- `packages/ui/package.json#exports` has explicit subpaths (`./components/shared`,
  `./components/metrics`) plus a raw-source catch-all `"./*": "./src/*.tsx"`.
- Precedent for a **themed wrapper over a third-party editor**:
  `packages/ui/src/components/custom/code-editor.tsx` (224 lines) — a fixed dark surface driven by
  `--code-editor-*` CSS variables, exported through the root barrel at `index.ts:87`.
- Scripts (root `package.json`): `ui:build` (52), `ui:test` (53), `ui:test:ct` (56), `ui:lint` (58),
  `ui:typecheck` (60), `ui:storybook` (64). Admin: `admin:build` (39), `admin:test` (40),
  `admin:test:e2e` (43), `admin:lint` (44), `admin:typecheck` (46).

### 2.7 The consolidation targets, as they exist today

| Surface | Route | Feature module | Backend it writes |
|---|---|---|---|
| Pipeline policy | `/harness/pipeline-policy` (tier 30-49, `nav-config.ts:381`) | `features/pipeline-policy/` — `pipeline-policy-screen.tsx`, `scope-row-editor.tsx`, `cascade.ts` | `PipelinePolicy` rows, cascade `SYSTEM → TENANT → DEPARTMENT → DOCTOR` |
| Department agent config | `/departments` (tier 30-49, `nav-config.ts:261`) | `features/departments/components/department-prompt-config-panel.tsx` | `PATCH admin/departments/:id/prompt-config` with `If-Match` (`departments/api/client.ts:69-70`) |
| Harness policy / loop settings | `/harness/policy` (`nav-config.ts:347`) + `/agentic-policy` (tier **10-19**, `nav-config.ts:160`, `required: [['manage','all']]`) | `features/harness-policy/` (`live-config-tab.tsx`), `features/agentic-policy/` (`agentic-knobs.ts`, `live-engine-tab.tsx`) | Rule 13 records that `/agentic-policy` owns `harness/policy/global` + `harness/live/config`, and `/harness/policy` links to it |
| Prompt templates | `/prompt-templates` (tier 30-49, `nav-config.ts:303`) | `features/agents/components/prompt-templates-screen.tsx`, `templates-tab.tsx`, `governance-tab.tsx` | `admin/prompt-templates` — **keeps its own authoritative editor** |

**Verified sequencing tension.** `/agentic-policy` is a **tier 10-19 global** screen gated
`['manage','all']`. Folding its loop settings into a **tier 30-49 tenant** definition would move a
global-admin-only control into tenant reach — a privilege change, not a UI move. See §6, HUMAN-GATED.

### 2.8 The route/screen inventory referenced by rule 13 is no longer where rule 13 says

Rule 13 §Routing states the inventory lives at
`docs/implementation/TASK-415-Hope-Admin-Console/capabilities-matrix.md`. That path does not exist:
`docs/implementation/` currently holds only this program's `TASK-7XX` folders. The file was moved out
of `docs/implementation/` during the pre-sprint archive sweep, and this program's authoring rules
forbid reading `docs/archive/**`. **Consequence:** the highest currently-allocated Figma frame number
cannot be verified from an in-scope source, so frame numbers for this feature are assigned by the
designer at the design gate (Task 1), not guessed here.

## 3. Knowledge & Best Practices

### 3.1 Repo law that binds this ticket

| Rule + section | What it forces here |
|---|---|
| `13-nextjs-apps.md` §Structure | `src/app` is routing ONLY; all logic in `src/features/workflow-studio/`; features never import each other |
| `13-nextjs-apps.md` §Routing | Tier 30–49 ⇒ `(console)/(tenant)/` route group; segment `loading.tsx` + `error.tsx`; **retired/renamed routes keep a `redirect()` page for one release with a comment naming the deleting release** |
| `13-nextjs-apps.md` §Routing | **One authoritative editor per backend resource** — a second screen that would write the same row demotes to a read-only summary + a plain-href deep link (never a cross-feature import) |
| `13-nextjs-apps.md` §Auth (BFF) | ALL data calls through `/api/hope/[...path]`; `If-Match`/`ETag` passed through (missing → 428, drift → 412); tokens never client-readable |
| `13-nextjs-apps.md` §Data & State | TanStack Query v5 for server state; **never fetch in `useEffect`**; Zustand v5 for pure UI state; nuqs for shareable filter state |
| `13-nextjs-apps.md` §Caching | Dynamic-by-default: do NOT add `use cache`/Cache Components to data routes |
| `13-nextjs-apps.md` §Styling | Semantic tokens only; dark mode via `.dark` + `next-themes` |
| `12-design-workflow.md` §2 Gate 2 | **Approval gate: the Figma designs of a batch must be fully available AND explicitly approved by the product owner before ANY screen of that batch is implemented.** Record the approval (frame inventory + date) in this README |
| `12-design-workflow.md` §3 | Frame grammar `<NN>[.<sub>][-<device>] - <Name>`; tenant screens 30–49; frames 01–09 are instanced, never redrawn; frame `09 - Screen Templates` is the region contract |
| `11-ux-ui-principles.md` §1 | `ScreenTemplate` region contract; `DetailDrawer` is the one detail surface; one scroll container per panel |
| `11-ux-ui-principles.md` §11 | WCAG 2.2 AA; **2.5.7 drag needs a single-pointer alternative**; 2.4.11 focus not obscured; ≥24px target floor; `prefers-reduced-motion`; axe 0 violations per screen is part of DoD, and "Automation catches ≲ 57% — the manual keyboard + 200%-zoom pass is also required" |
| `10-skeleton-loading.md` | `<Skeleton />` matching the loaded shape; never a spinner as page loader; in-button work uses `<Spinner />` |
| `07-react-ui.md` | React 19 — **no `forwardRef`**; `cva` + `data-slot`; `cn()`; new shared components go to `packages/ui`, never forked into the app; barrel collision check before export |
| `08-vox-sdk.md` §Store | The store discipline to imitate: a store is created **per mount** and published through context; **never export the store object or use a module singleton** |
| `01-development-workflow.md` | TDD Red→Green→Refactor; every claim of done pastes real command output |

### 3.2 SOTA / base practices this implementation follows

| Practice | One-line justification |
|---|---|
| React Flow behind a `packages/ui` **subpath export**, deliberately kept OUT of the root barrel | `packages/ui/src/index.ts` is `export *`-heavy; adding a graph library there pulls it into every `@arcaai/ui` consumer's graph, including the SDK-adjacent surfaces |
| One graph model, two editors (canvas + list/tree) rendering the same store | WCAG 2.5.7 needs a genuine single-pointer path; a "read-only fallback" would not satisfy it, and two models would drift |
| Node config validated with `jsonSchemaValueProblems`, not a second re-derived validator | The `@arcaai/json-schema-subset` README documents that three copies of one rule drifted silently; the console must only ever agree with the server |
| zod scoped to the *form-local* fields the schema does not describe (name, slug, description) | zod v4 is already a dependency; using it for the hand-written shell keeps the generated part single-sourced |
| Graph editing state in Zustand; server state in TanStack Query; view/selection state in nuqs | Rule 13 §Data & State, verbatim; also keeps the deep link (`?node=`, `?view=list`) shareable |
| Autosave `PATCH` with `If-Match`, debounced, **paused on 412** | design.md §Data flow: "debounced autosave `PATCH` with `If-Match` (concurrent editors get 412)". Auto-retrying a 412 would silently clobber a concurrent editor |
| Publish re-validates **server-side** and the button stays disabled until the server report is clean | D3: the validator is the safety boundary; "no reliance on UI lockouts" |

### 3.3 Known pitfalls for THIS ticket

1. **Do not treat the client validator as the gate.** D3 makes the server-side validator the safety
   boundary. Client-side `jsonSchemaValueProblems` is a fast-fail UX aid only — publish must always
   round-trip through the server.
2. **Do not put a second scroll area inside `contentMode="fill"`.** `screen-template.tsx:24-26` and
   rule 11 §1. The canvas viewport is React Flow's own pane; the list view gets the scroll instead.
3. **Do not auto-overwrite on 412.** `OccConflictAlert` offers `onOverwrite` as an explicit user
   action; wiring autosave to it turns a conflict into data loss.
4. **Do not add `react-hook-form` to the console.** It is an *optional* peer of `@arcaai/ui` and
   absent from the console's dependency list; the house pattern is controlled state.
5. **Do not import across features.** Rule 13: "features never import each other". Cross-surface
   links are plain `href`s.
6. **Do not flip `cacheComponents`.** Rule 13 §Caching — it is a separate, user-approved migration.
7. **Barrel collision.** Rule 07: check `packages/ui/src/index.ts` for existing `Node`/`Edge`/
   `Panel`/`Handle`/`Controls`/`Background` names before exporting anything from the new group. The
   barrel already documents two omissions for exactly this reason.
8. **`mandatory` nodes are non-deletable in BOTH editors.** A delete affordance suppressed only on
   the canvas leaves the keyboard/list path as a bypass.
9. **`gen:mapper` is destructive — never run it** (rule 03). This ticket touches no Prisma model, but
   the rule binds any task that drifts into the domain layer.

## 4. Implementation Plan

### Phase A — Gates and contracts (nothing renders until these clear)

#### Task 1 — Clear the design gate (Figma frames, batch approval)
- **Agent:** T3 · sonnet-5 · medium — **HUMAN-GATED (product-owner approval)**
- **Files:** this README (a new `### Design gate` subsection under §7 recording the frame inventory
  and approval date)
- **Approach:** Per `12-design-workflow.md` §2 gate 2, no screen of this batch is implemented until
  its frames are fully available and explicitly approved. Produce the screen brief first (Definition
  of Ready: capability row, states, data-source endpoints, role/tier behavior, acceptance criteria
  incl. a11y), then request frames following the §3 grammar `<NN>[.<sub>][-<device>] - <Name>` in the
  tenant range **30–49**, grouped under "Tenant admins'":
  - `NN - Workflow Studio` — canvas default state
  - `NN.1 - Workflow Studio — Structured List View` (the 2.5.7 peer editor)
  - `NN.2 - Workflow Studio — Inspector`
  - `NN.3 - Workflow Studio — Validation & Publish`
  - `NN.4 - Workflow Studio — Definitions List`
  Each frame in light AND dark, with default + loading-skeleton + empty + error states, desktop
  mandatory. Every frame instances `09 - Screen Templates` rather than redrawing a page frame.
  `NN` is assigned by the designer — §2.8 explains why it cannot be derived here.
  A11y annotations are required *before* Ready-for-Dev (§4 of rule 12): focus order, landmarks,
  labels for icon-only canvas controls, contrast-checked pairs, the 2.5.7 single-pointer alternative,
  2.4.11 focus-not-obscured behavior for the pinned rails.
- **Verify:** This README's §7 carries the frame inventory + the approval date; the frames are marked
  **Ready for Dev** in Figma Dev Mode. No later task starts before this line is written.

#### Task 2 — Evaluate, pin and licence-record the React Flow dependency
- **Agent:** T3 · sonnet-5 · medium
- **Files:** `packages/ui/package.json`; `packages/ui/src/components/workflow-canvas/DEPENDENCY.md`
  (new); `pnpm-lock.yaml`
- **Approach:** React Flow is not present anywhere today (§2.1). Before adding it, record in
  `DEPENDENCY.md`:
  (a) the exact package name and version pinned — the library was renamed from `reactflow` to
  `@xyflow/react` at v12, so confirm the current published name/version against the registry rather
  than assuming; (b) the licence, verified from the published package's own `LICENSE` file, not from
  memory; (c) React 19 + Next 16 compatibility (the console is React `^19.2.8`, Next `^16.3.1`);
  (d) whether it ships CSS that must be imported, and how that CSS is scoped; (e) transitive
  dependency count and whether any transitive dep duplicates something `packages/ui` already carries
  (`@dnd-kit/*`, `zustand` is NOT a ui dep today — check whether React Flow bundles its own);
  (f) the rejected alternatives and why (one line each).
  Add it as a **`dependencies` entry of `packages/ui` only** — not of `@arcaai/admin-console`, which
  consumes it through the composite.
- **Verify:** `pnpm --filter @arcaai/ui build` succeeds; `pnpm --filter @arcaai/ui typecheck` clean;
  `DEPENDENCY.md` states the licence with the file it was read from.

#### Task 3 — Freeze the three cross-ticket contracts with TASK-715 / TASK-716
- **Agent:** T4 · opus-5 · high
- **Files:** `docs/implementation/TASK-719-Workflow-Studio-V1/contracts/` (new) —
  `registry.contract.md`, `definition-api.contract.md`, `validation-report.contract.md`
- **Approach:** Studio v1 cannot be built against unwritten APIs. Read whatever TASK-715/716 have
  landed and write down, as the shared contract, exactly:
  1. **Registry** — the node-type descriptor: `type`, `label`, `category`, `paletteId`,
     **`safetyClass: 'mandatory' | 'locked' | 'optional'`**, `entitlementKey`, port/handle shape
     (how many inputs/outputs, typed?), and the per-type **config JSON Schema**. Confirm the schema
     conforms to the `authorableJsonSchemaProblems` subset (§2.4) — if it does not, that is a
     TASK-715 defect, not a Studio workaround.
  2. **Definition API** — the gateway paths under `api/v1` for read/create/autosave-PATCH/validate/
     publish/list-versions, which of them are OCC-versioned (⇒ `If-Match` + `expectedVersion` body
     per `shared/api/http.ts` `versionFromEtag`), and the `graph` JsonB shape (node ids, edges,
     positions, per-node `config`).
  3. **`ValidationReport`** — the per-node machine-readable shape: severity levels, the node id (or
     edge id) each problem points at, the rule class (`structural` / `invariant` / `schema`), and the
     stable rule id used for a help link.
  If any contract is unresolved, record it in §6 as an open question rather than inventing it.
- **Verify:** The three contract files exist and each names the `file:line` in TASK-715/716's
  delivered code that it was derived from. Cross-check: the schema in the registry contract must be
  accepted by `authorableJsonSchemaProblems` — write that as a one-off script assertion under
  `packages/json-schema-subset` fixtures if a real schema is available.

### Phase B — The canvas composite in `packages/ui`

#### Task 4 — RED: canvas composite tests + stories
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/ui/src/components/workflow-canvas/__tests__/workflow-canvas.test.tsx`;
  `packages/ui/src/components/__stories__/custom/workflow-canvas.stories.tsx`
- **Approach:** Following the colocated-`__tests__` convention of
  `packages/ui/src/components/live-transcript/__tests__/`. Assert, against a fixture graph:
  renders one node element per model node; edges rendered; `data-slot` attributes present; every
  node is reachable by keyboard (`tabIndex`) and exposes an accessible name; the canvas region has an
  accessible name; `prefers-reduced-motion` suppresses the fit-view animation; an axe scan
  (`vitest-axe`, already wired at `apps/admin-console/src/test/setup.ts` and available in
  `packages/ui` via its `axe-core` devDependency) reports 0 violations in both themes.
- **Verify:** `pnpm ui:test` — the new suite FAILS (module does not exist). Paste the failure.

#### Task 5 — Build `WorkflowCanvas` as a themed composite
- **Agent:** T4 · opus-5 · high
- **Files:** `packages/ui/src/components/workflow-canvas/` — `index.ts`, `types.ts`,
  `workflow-canvas.tsx`, `workflow-node.tsx`, `workflow-edge.tsx`, `canvas-controls.tsx`,
  `canvas-tokens.css`; `packages/ui/package.json` (exports map)
- **Approach:**
  - **Do NOT add this group to `packages/ui/src/index.ts`.** Expose it as an explicit subpath —
    add `"./components/workflow-canvas"` to `packages/ui/package.json#exports` alongside the existing
    `"./components/shared"` and `"./components/metrics"` entries. Rationale in §3.2; also avoids the
    `Node`/`Edge`/`Panel`/`Handle`/`Background`/`Controls` collisions the root barrel already fights
    (`index.ts` lines ~419 and 447–449 document two such omissions).
  - `'use client'` at the top of every file in the group.
  - React 19 pattern per rule 07: plain function components, **no `forwardRef`**, `cva` variants,
    `data-slot` attributes, `cn()` from `packages/ui/src/lib/utils.ts`.
  - **Theming bridge** — imitate `custom/code-editor.tsx`: define `--workflow-canvas-*` semantic
    variables in `canvas-tokens.css`, mapped from the existing HOPE tokens (`--background`,
    `--border`, `--primary`, `--muted-foreground`, `--destructive`, `--warning`, `--success`,
    `--ai`), and override React Flow's own CSS variables from them so light/dark follow
    `next-themes`' `.dark` class with no JS theme prop. Never hardcode a colour (rule 07/11).
  - The composite API is **props-in / callbacks-out** — it owns no graph state. Props:
    `nodes`, `edges`, `nodeTypes` (registry-driven renderers), `selectedNodeId`,
    `problemsByNodeId` (severity per node → badge + border token), `readOnly`,
    `overlay` (reserved for TASK-723's run replay: per-node status/timing/confidence badge slots),
    and callbacks `onNodesChange`, `onEdgesChange`, `onConnect`, `onSelect`, `onDeleteRequest`.
  - `onDeleteRequest` (not `onDelete`) so the consumer can refuse deletion of a `mandatory` node.
  - **A11y floor built in here, not bolted on later:** the pane gets `role="application"` with an
    `aria-label` and a visually-hidden usage hint; each node is a focusable element with an
    accessible name and `aria-describedby` pointing at its validation summary; zoom/fit controls are
    real `<button>`s with `aria-label` (rule 11 §11 icon-only controls); pointer-drag node movement
    is **never the only way** to change the graph (Task 13 is the single-pointer/keyboard peer);
    honour `prefers-reduced-motion`.
- **Verify:** `pnpm ui:test` (Task 4 suite GREEN), `pnpm ui:lint`, `pnpm ui:typecheck`,
  `pnpm ui:build` — all green, output pasted.

#### Task 6 — Playwright component test + Storybook story for the canvas
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `packages/ui/src/components/workflow-canvas/__tests__/workflow-canvas.ct.tsx`;
  the story from Task 4 filled out with light/dark and readOnly variants
- **Approach:** Real-browser interaction is what jsdom cannot cover: drag to connect two nodes,
  keyboard-select a node with Tab and confirm the focus ring is visible, verify the canvas does not
  create a horizontal page scroll at 320px width and at 200% zoom (rule 11 §11 reflow).
- **Verify:** `pnpm ui:test:ct` green; `pnpm ui:storybook` renders both themes.

### Phase C — The schema→form generator

#### Task 7 — RED: generator contract tests (the "one schema, three consumers" test)
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/admin-console/src/features/workflow-studio/lib/__tests__/schema-form.test.ts`;
  fixtures at `.../lib/__tests__/fixtures/*.schema.json`
- **Approach:** design.md §Testing strategy names this suite: "Contract tests: one schema, three
  consumers (registry ↔ inspector forms ↔ compiled config)". Write it first:
  1. **Compile** — for each fixture schema, `toFieldDescriptors(schema)` yields the expected ordered
     descriptor list (kind, path, label, required, enum options, min/max, default).
  2. **Round-trip** — descriptors → a filled value → `jsonSchemaValueProblems(schema, value)` returns
     `[]`. A value the form marks invalid must also be rejected by `jsonSchemaValueProblems`
     (agreement in both directions is the whole point of §2.4).
  3. **Bounds** — a schema exceeding `MAX_SCHEMA_DEPTH` / `MAX_SCHEMA_NODES` produces an explicit
     "schema too complex — edit as JSON" descriptor rather than a partial form or a crash.
  4. **Unsupported construct** — a construct outside the authorable subset degrades to the raw JSON
     editor for that subtree, never silently drops the field.
- **Verify:** `pnpm admin:test` — suite FAILS. Paste it.

#### Task 8 — Build the schema→field-descriptor compiler
- **Agent:** T3 · sonnet-5 · high
- **Files:** `apps/admin-console/src/features/workflow-studio/lib/schema-form.ts`
- **Approach:** Pure, framework-free (so it is unit-testable and reusable by TASK-721's node-isolation
  panel). Input: a registry node-type config JSON Schema. Output: an ordered `FieldDescriptor[]`
  covering `string` (+ `enum` → Select, `format` hints), `number`/`integer` (min/max/step),
  `boolean` → Switch, `array` of primitives → tags input, `object` → nested `FieldGroup`,
  `oneOf` + `discriminator.propertyName` → a discriminator Select that swaps the branch's fields
  (the subset **requires** that sibling discriminator, per §2.4 — rely on it rather than sniffing).
  Anything not representable: a `kind: 'raw-json'` descriptor rendered by `CodeEditor`
  (`packages/ui/src/components/custom/code-editor.tsx`, exported from the root barrel at
  `index.ts:87`) — rule 11 forbids editing JSON in a bare `<Textarea>`.
  **Validation is delegated, never re-implemented:** the only value-validation call is
  `jsonSchemaValueProblems` from `@arcaai/json-schema-subset`. zod is used only for the small
  hand-written form shell (definition name / slug / description), which no registry schema describes.
  *(This is a deliberate refinement of design.md's "zod + Field family" shorthand: using zod for the
  generated part would create the second implementation the json-schema-subset README exists to
  prevent. Recorded in §6 for review.)*
- **Verify:** `pnpm admin:test` — Task 7 suite GREEN; `pnpm admin:typecheck`; `pnpm admin:lint`.

#### Task 9 — Render the inspector form from descriptors
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/admin-console/src/features/workflow-studio/components/inspector/` —
  `inspector-panel.tsx`, `schema-form.tsx`, `field-renderers.tsx`,
  `__tests__/inspector-panel.test.tsx`
- **Approach:** Descriptors → the `Field` family (`FieldSet`/`FieldGroup`/`Field`/`FieldLabel`/
  `FieldDescription`/`FieldError`, `field.tsx:176`). Controlled state, no `react-hook-form` (§2.5).
  Rule 11 §9: labels always visible (never placeholder-only), required marked `*`, errors below the
  field in `text-destructive text-sm`. Server problems for the selected node from the
  `ValidationReport` render on the matching field via `FieldError`, distinguished from
  client-side fast-fail problems by their rule id. Loading state uses `<Skeleton />` shapes matching
  the field layout (rule 10), never a spinner.
- **Verify:** `pnpm admin:test` green including a `vitest-axe` 0-violation assertion on the panel.

### Phase D — The feature module

#### Task 10 — Scaffold the feature module: API layer, keys, types
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/admin-console/src/features/workflow-studio/api/` — `client.ts`, `hooks.ts`,
  `keys.ts`, `types.ts`, `index.ts`, `__tests__/workflow-studio-api.test.ts`
- **Approach:** Copy the shape of `features/context-schemas/api/` verbatim. All calls go through
  `@/shared/api` (`getJson`, `getWithEtag`, `postJson`, `patchWithEtag`, `versionFromEtag`) — i.e.
  through the BFF proxy. Types come from the Task 3 contracts. TanStack Query v5 hooks only; **no
  fetching in `useEffect`** (rule 13). Query keys namespaced `['workflow-studio', …]`.
- **Verify:** `pnpm admin:test`, `pnpm admin:typecheck`.

#### Task 11 — Graph editing store (Zustand, per-editor instance)
- **Agent:** T3 · sonnet-5 · high
- **Files:** `apps/admin-console/src/features/workflow-studio/store/` — `create-graph-store.ts`,
  `graph-store-provider.tsx`, `selectors.ts`, `__tests__/graph-store.test.ts`
- **Approach:** Imitate the SDK store discipline in rule 08 §Store: `createGraphStore()` built with
  `createStore` from `zustand/vanilla`, created **per editor mount** and published through React
  context; expose only `useGraphStore(selector)` and `useGraphStoreApi()`, both of which throw
  outside the provider. **Never export the store object; never a module singleton.** Select
  atomically; wrap multi-field selections in `useShallow`. State: `nodes`, `edges`, `selectedNodeId`,
  `viewMode: 'canvas' | 'list'`, `dirty`, `undoStack`/`redoStack`, `lastSavedVersion`,
  `autosaveState: 'idle'|'saving'|'saved'|'conflict'|'error'`. Actions hold the business rules:
  `deleteNode` refuses when `safetyClass === 'mandatory'` and returns a reason string (consumed by
  both editors); `connect` refuses a self-edge and a duplicate edge. Server data (definition,
  registry, report) is **not** mirrored into this store — it stays in TanStack Query (rule 08's
  "server data belongs to the API client + hooks, not persisted store state").
- **Verify:** `pnpm admin:test` — store unit tests green, including "deleting a mandatory node is
  refused" and "the store is not reachable without a provider".

#### Task 12 — Palette rail
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `.../components/palette/` — `palette-rail.tsx`, `palette-item.tsx`,
  `safety-class-badge.tsx`, `__tests__/palette-rail.test.tsx`
- **Approach:** Registry-driven (Task 10 hook), grouped by category. **Safety class is visible on
  every item** (`Badge` variants per rule 11 §7 — never colour alone; the badge carries the word).
  `mandatory` node types are **pre-placed** into a new definition's graph by the store's
  `initializeGraph` action and render in the rail as already-placed/disabled. Entitlement-gated types
  the tenant lacks render disabled with a visible reason (rule 11 §5: "disabled buttons need a
  visible reason"). Adding a node must work **without dragging** — each item is a real `<button>`
  that inserts at the current insertion point (WCAG 2.5.7); drag is an enhancement.
  Loading: `<Skeleton />` rows matching item height (rule 10). Empty (no palette entitled / registry
  empty): the `Empty` family from `@arcaai/ui` (`index.ts:47`).
- **Verify:** `pnpm admin:test`; a11y assertion that every palette item is keyboard-operable.

#### Task 13 — Structured list/tree editor (peer editor, not a fallback)
- **Agent:** T4 · opus-5 · high
- **Files:** `.../components/list-editor/` — `graph-list-editor.tsx`, `node-row.tsx`,
  `edge-editor.tsx`, `__tests__/graph-list-editor.test.tsx`
- **Approach:** A second full editor over the **same** store from Task 11 — every mutation available
  on the canvas (add, configure, connect, reorder, delete) is available here through keyboard and
  single-pointer clicks only. Structure: a tree of nodes with their outgoing edges as children;
  each row is a focusable element with an accessible name, its safety-class badge, its validation
  status, and a row action menu (Configure / Connect to… / Delete). "Connect to…" opens a
  `Command`-style picker of valid targets rather than a drag. `mandatory` rows expose no Delete and
  say why. Reorder is buttons ("move up/down"), not drag — satisfying 2.5.7 by construction rather
  than by adding a keyboard shim to a drag interaction.
  `viewMode` lives in the URL via nuqs (`?view=list`) so the choice is shareable and survives reload.
  Rule 11 §1: this editor is the one that scrolls; it renders inside `contentMode="scroll"`.
- **Verify:** `pnpm admin:test` green + a keyboard-only test that builds a two-node graph end to end
  with no pointer events; `vitest-axe` 0 violations.

#### Task 14 — Validation rail + click-error→focus-node
- **Agent:** T3 · sonnet-5 · medium
- **Files:** `.../components/validation/` — `validation-rail.tsx`, `problem-row.tsx`,
  `use-focus-node.ts`, `__tests__/validation-rail.test.tsx`
- **Approach:** Renders the server `ValidationReport` grouped by severity then node. Each row is a
  `<button>`; activating it sets `selectedNodeId` in the store, opens the inspector on the offending
  field, and **moves DOM focus** to the target — in the canvas that is the node element, in the list
  editor the node row. Focus must not be obscured (WCAG 2.4.11): because `ScreenTemplate`'s pinned
  regions are flex rows outside the scroll container (`screen-template.tsx:18-20`), no `scroll-mt-*`
  is needed — assert that in the test rather than assuming it. Problems announce via a polite live
  region when the report changes after a save. **Publish is disabled while any blocking-severity
  problem exists**, with the reason rendered next to the button (rule 11 §5).
- **Verify:** `pnpm admin:test` — a test asserting `document.activeElement` is the target node after
  activating a problem row, in **both** view modes.

#### Task 15 — Autosave, OCC and the publish flow
- **Agent:** T3 · sonnet-5 · high
- **Files:** `.../hooks/use-autosave.ts`, `.../components/studio-toolbar.tsx`,
  `.../components/publish-dialog.tsx`, `.../hooks/__tests__/use-autosave.test.ts`
- **Approach:** design.md §Data flow, implemented literally:
  - Debounced `PATCH` with `If-Match` via `patchWithEtag`, body carrying `expectedVersion` derived
    with `versionFromEtag` (the console-wide contract documented in `shared/api/http.ts`).
  - On **412** (`GatewayError.isVersionConflict`): **stop autosaving**, set
    `autosaveState: 'conflict'`, and render `OccConflictAlert`
    (`shared/occ/occ-alert.tsx:15`) in the `statusBanner` slot with `onReload` (refetch + rebase) and
    an explicit `onOverwrite`. Autosave never resumes by itself after a conflict.
  - On **428** (`isMissingPrecondition`): the same component's stale-tab message — this is a client
    bug, so also log it.
  - Unsaved-changes guard when `dirty`: `beforeunload` + a Next.js route-change confirm.
  - **Validate** is an explicit server round-trip that persists the report; **Publish** re-validates
    server-side, stamps `compiledConfig`, freezes the row. The published row is immutable — the UI
    must therefore offer "Create new version from this" rather than an edit affordance on a published
    definition (design.md §Plane 1: "published rows immutable — edits create versions").
  - `toast.success` / `toast.error` on every terminal outcome (rule 11 §5, `sonner` is a dependency).
- **Verify:** `pnpm admin:test` — tests for: debounce coalescing, 412 pauses autosave and does not
  retry, publish blocked while the report is dirty, published definition renders read-only.

#### Task 16 — Routes, pages, nav entry, skeletons
- **Agent:** T2 · sonnet-5 · medium
- **Files:**
  `apps/admin-console/src/app/(console)/(tenant)/workflow-studio/page.tsx`,
  `.../workflow-studio/loading.tsx`, `.../workflow-studio/error.tsx`,
  `.../workflow-studio/[definitionId]/page.tsx`, `.../[definitionId]/loading.tsx`,
  `.../[definitionId]/error.tsx`;
  `apps/admin-console/src/shared/navigation/nav-config.ts`;
  `.../features/workflow-studio/components/workflow-studio-screen.tsx`,
  `.../components/definitions-list-screen.tsx`
- **Approach:** Routing layer only in `src/app` (rule 13 §Structure) — each `page.tsx` sets
  `metadata` and renders the feature screen, exactly like
  `app/(console)/(tenant)/playground/llm/page.tsx`. Both screens wrap `WorkingTenantGate` (a global
  admin needs a working tenant; rule 12 §5 tier 30–49). The list screen uses `AdminDataGrid` with
  `contentMode="fill"`; the editor screen uses `ScreenTemplate` with
  `header` = title + Validate/Publish actions, `statusBanner` = OCC/tenant banners,
  `toolbar` = view-mode toggle + autosave state, `contentMode="fill"` for the canvas
  (`contentMode="scroll"` when `?view=list`), `footer` = `StatusFooter`.
  `loading.tsx` is built from `<Skeleton />` shaped like the three-column editor (rail · canvas ·
  inspector) — rule 10, never a spinner. Add one `NavEntry` to `NAV_ENTRIES`:
  `{ route: '/workflow-studio', label: 'Workflow Studio', tier: '30-49', icon: <unique TablerIcon>,
  required: [[<action>, 'WorkflowDefinition']], implemented: true }` — the icon must be unique
  across `NAV_ENTRIES` (the file documents "unique per entry" at line ~69); `required` mirrors the
  gateway guard from the Task 3 contract, never `[]`.
- **Verify:** `pnpm admin:build`; `pnpm admin:test` (nav-config unit tests exist under
  `shared/navigation/__tests__/`); manual check that a non-tenant-admin session 404s.

### Phase E — Consolidation (design.md §Plane 3, "Consolidation")

#### Task 17 — Author the consolidation map, then execute the v1-eligible folds
- **Agent:** T4 · opus-5 · high
- **Files:** `docs/implementation/TASK-719-Workflow-Studio-V1/consolidation-map.md` (new)
- **Approach:** One table, `existing screen/route → feature module → backend resource it writes →
  Studio home → fold wave → retirement action`. Seed it with the four rows verified in §2.7. The
  fold wave is decided by one test: **does the Studio own that backend resource at v1?** A screen
  whose resource the Studio does not yet write cannot fold — folding it would leave the resource with
  no authoritative editor, the exact failure rule 13's one-authoritative-editor rule prevents.
  Expected outcome given §2.7 (re-verify at execution time, do not assume):
  - `/harness/pipeline-policy` → folds when the registry models its toggles as node/definition config
    (depends on TASK-716 — verify, do not assume).
  - `/departments` prompt-config panel → **does not fold in v1**; per-department workflow assignment
    is TASK-733 and the consultation palette is TASK-731. Demote to read-only summary + deep link
    (Task 19).
  - `/agentic-policy` loop settings → **HUMAN-GATED**, see §6: it is a tier 10-19 global screen.
  - `/prompt-templates` → never folds (design.md: keeps its own authoritative editor).
- **Verify:** The map exists, every row cites a re-derived `file:line`, and every "folds" row names
  the registry node type that will own the setting.

#### Task 18 — Fold pipeline policy into the Studio and retire its route
- **Agent:** T3 · sonnet-5 · high — **gated on Task 17's verdict for this row**
- **Files:** `apps/admin-console/src/app/(console)/(tenant)/harness/pipeline-policy/page.tsx`
  (replaced by a `redirect()`); `.../features/workflow-studio/components/settings/` (new);
  `apps/admin-console/src/shared/navigation/nav-config.ts` (remove the entry at line 381)
- **Approach:** Move the scope-cascade editing into the Studio's definition-settings surface, then
  replace the old page with a one-release `redirect()` following
  `app/(console)/(global)/prompt-studio/page.tsx` verbatim — including the comment that names the
  release in which the folder is deleted (rule 13 §Routing). Do **not** delete
  `features/pipeline-policy/` in this ticket; delete it in the release that deletes the redirect, so
  a rollback is a one-line revert.
- **Verify:** `pnpm admin:build`, `pnpm admin:test`, `pnpm admin:lint`; `pnpm admin:test:e2e`
  (`tests/e2e/` has no pipeline-policy spec today — add one asserting the redirect lands).

#### Task 19 — Demote the department prompt-config panel; add the prompt-template picker
- **Agent:** T2 · sonnet-5 · medium
- **Files:** `apps/admin-console/src/features/departments/components/department-prompt-config-panel.tsx`;
  `.../features/workflow-studio/components/inspector/prompt-template-picker.tsx` (new)
- **Approach:** Two applications of rule 13's one-authoritative-editor rule:
  - **Prompt templates keep their editor.** The Studio's node inspector gets a *picker* that lists
    templates through the same `admin/prompt-templates` endpoint the console already calls
    (`features/departments/api/client.ts:54`) plus a plain `href` deep link to
    `/prompt-templates`. **No cross-feature import** — features never import each other.
  - **Department prompt config:** leave it authoritative for now (Task 17's verdict) but add the
    reciprocal plain-href link to the Studio so the two surfaces are discoverable from each other,
    and a note in its header naming the Studio as the future home.
- **Verify:** `pnpm admin:test`; `pnpm admin:lint` (the ESLint config must not report a cross-feature
  import).

### Phase F — Verification

#### Task 20 — Unit + a11y suite for every Studio component
- **Agent:** T2 · sonnet-5 · medium · **T2 ×3 parallel** (canvas-side / list-side / inspector+rails)
- **Files:** `.../features/workflow-studio/**/__tests__/*.test.tsx`
- **Approach:** Every screen-level component carries a `vitest-axe` 0-violation assertion, following
  `features/ai-operations-runs/components/__tests__/ai-operations-runs-screen.test.tsx`. Cover
  loading (skeleton shape matches loaded shape), empty, and error states.
- **Verify:** `pnpm admin:test` green; paste the summary line.

#### Task 21 — Playwright e2e: publish flow, keyboard/list pass, both themes, cross-tenant 404
- **Agent:** T3 · sonnet-5 · high
- **Files:** `apps/admin-console/tests/e2e/workflow-studio.spec.ts`
- **Approach:** Follow `tests/e2e/playground.spec.ts`: `test.skip` guards from
  `./helpers/stack` (`appAvailable` / `apiAvailable`), `loginAsAdmin` + `selectWorkingTenant` from
  `./helpers/auth`, and `expectNoA11yViolations` from `./helpers/a11y` (which scans
  `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` and asserts an empty violations array). Specs:
  1. Create draft → add a node from the palette **by keyboard only** → configure it in the inspector
     → Validate → the rail lists the problems → fix → Publish succeeds.
  2. Publish is disabled while the report is dirty, with a visible reason.
  3. A `mandatory` node exposes no delete in **either** view mode.
  4. Clicking a validation problem moves focus to its node, in canvas AND list view.
  5. `expectNoA11yViolations` on the editor in light and dark.
  6. Cross-tenant: requesting another tenant's definition id renders the not-found state (404, never
     403) — mirrors the posture asserted across `apps/api/tests/e2e/*-cross-tenant.spec.ts`.
- **Verify:** `pnpm admin:test:e2e` (app on :5176 and the gateway on :8868 must be up — the specs
  skip with actionable messages otherwise). Paste output.

## 5. Acceptance Criteria

- [ ] **Design gate cleared before any Phase B–E code:** frame inventory + product-owner approval
      date recorded in §7; frames marked Ready for Dev (rule 12 §2 gate 2)
- [ ] `packages/ui/src/components/workflow-canvas/DEPENDENCY.md` records the pinned React Flow
      package name, version, and the licence **as read from the published package's LICENSE file**
- [ ] React Flow appears in `packages/ui/package.json` **only**, and the canvas group is reachable
      **only** through the `./components/workflow-canvas` subpath export — `grep -n "workflow-canvas"
      packages/ui/src/index.ts` returns nothing
- [ ] `pnpm ui:test` · `pnpm ui:test:ct` · `pnpm ui:lint` · `pnpm ui:typecheck` · `pnpm ui:build` all
      green (output pasted)
- [ ] `pnpm --filter @arcaai/admin-console build lint test` green (output pasted)
- [ ] `pnpm admin:typecheck` green (output pasted)
- [ ] `pnpm admin:test:e2e` green for `tests/e2e/workflow-studio.spec.ts` (output pasted)
- [ ] **axe: 0 violations** on the definitions list, the canvas editor and the list editor, in
      **light and dark**, via `expectNoA11yViolations` (`tests/e2e/helpers/a11y.ts`)
- [ ] **Manual pass recorded** (rule 11 §11 — automation catches ≲57%): keyboard-only authoring of a
      two-node graph in the list editor, 200% zoom with no horizontal page scroll, and a
      `prefers-reduced-motion` check. Paste the notes
- [ ] The structured list/tree view supports **every** mutation the canvas supports (add, configure,
      connect, reorder, delete) with no pointer drag — WCAG 2.5.7
- [ ] `mandatory` nodes are pre-placed and non-deletable in **both** editors
- [ ] Publish is disabled until the **server** `ValidationReport` is clean; the client validator is
      never the gate
- [ ] Definition writes carry `If-Match`; 412 pauses autosave and surfaces `OccConflictAlert`; 428 is
      surfaced as a stale-tab bug; no automatic overwrite path exists
- [ ] Node config is validated by `jsonSchemaValueProblems` from `@arcaai/json-schema-subset` — no
      second JSON-Schema evaluator is introduced
- [ ] Server state is TanStack Query, graph editing state is a per-mount Zustand store never exported
      as a singleton, view/selection state is nuqs — and there is **no `fetch` inside a `useEffect`**
      (`grep -rn "useEffect" src/features/workflow-studio` reviewed)
- [ ] `consolidation-map.md` exists with re-derived `file:line` evidence per row; every retired route
      keeps a `redirect()` page carrying the delete-in-next-release comment
- [ ] No cross-feature import: `apps/admin-console/src/features/workflow-studio/**` imports nothing
      from another `features/*` directory
- [ ] `cacheComponents` remains **off**; no `use cache` added to any data route
- [ ] **Evidence rule:** actual command output pasted in §7 before this ticket is marked complete

## 6. Risks & Open Questions

| # | Risk / question | Handling |
|---|---|---|
| R1 | **HUMAN-GATED — design approval is a hard blocker.** Rule 12 forbids implementing any screen of a batch before its frames are approved. This is an XL ticket whose entire Phase B–E is gated | Task 1 is first and produces the recorded approval. Phase A Tasks 2–3 (dependency + contracts) are *not* screens and may proceed in parallel |
| R2 | **HUMAN-GATED — folding `/agentic-policy` loop settings into a tenant-tier definition is a privilege change.** `/agentic-policy` is tier **10-19**, gated `[['manage','all']]` (`nav-config.ts:160`); rule 13 records it as the authoritative owner of `harness/policy/global` + `harness/live/config` | Do **not** fold it in this ticket. Task 17 records the question; a product/security decision is required on whether any of those knobs may become tenant-settable, and if so which — likely as an entitlement ceiling rather than a plain move |
| R3 | TASK-715/716 may not have landed, or may have landed with a different registry/report shape than this plan assumes | Task 3 is a hard gate: contracts are derived from delivered code with `file:line`, and any gap is recorded rather than invented. Every downstream task consumes the contract file, not an assumption |
| R4 | The registry's per-node config schemas may fall **outside** the `@arcaai/json-schema-subset` authorable subset (which rejects `if`/`then`/`else` at any depth and requires a sibling `discriminator.propertyName` on `oneOf`) | Task 3 asserts conformance with `authorableJsonSchemaProblems`. A non-conforming schema is a TASK-715 defect. The generator's `raw-json` degradation (Task 8) is the safety net, not the plan |
| R5 | **Deliberate deviation from design.md wording:** design.md says inspector forms are "zod + Field family"; this plan uses zod only for the form shell and delegates all schema validation to `jsonSchemaValueProblems` | Recorded here for review. Rationale: the `@arcaai/json-schema-subset` README exists precisely because three copies of one validation rule drifted silently. If the reviewer prefers zod-from-JSON-Schema, that is a decision to take at Task 3, before Task 8 |
| R6 | React Flow's licence/version could have changed since this plan was written | Task 2 verifies both against the published package, not from memory, and blocks on a non-permissive result |
| R7 | The canvas is a `role="application"` region — screen-reader users get no implicit structure from it | Mitigated by design, not by ARIA patching: the list/tree editor is a full peer (Task 13), and the e2e suite proves a graph can be built with keyboard only |
| R8 | **Open question (design.md §Open questions 1):** React Flow wrapping depth — thin themed wrapper vs. full composite API | This plan takes the **props-in/callbacks-out composite** position (Task 5) and reserves an `overlay` prop so TASK-723 can replay a run on the same component without a second canvas. Flagged for reviewer confirmation |
| R9 | **Open question (design.md §Open questions 5):** entitlement granularity for palette gating (per-palette vs. per-node-type) | The palette rail (Task 12) reads an `entitlementKey` off each node-type descriptor, which works under either answer. No Studio change is needed when the answer lands |
| R10 | The route/screen inventory rule 13 points at is not present under `docs/implementation/` (§2.8) | Frame numbers are assigned at the design gate. Separately worth raising: rule 13's pointer is now stale and should be re-pointed — out of scope here |
| R11 | Size: 21 tasks across 3 packages. XL is correct, but the phases are separable | Phases A→B→C→D are sequential; Phase E is separable and could ship a release later without blocking TASK-720/721/723, which depend only on Phases B–D |

## 7. Implementation Summary

**Executed 2026-08-16, single session. Phases A–C done; Phases D–F NOT started.** This is an
XL, 21-task ticket; the session budget did not cover the full scope. Honest accounting below —
do not read "In Progress" as "nearly done".

### Design gate (Task 1) — WAIVED, not cleared through Figma

The orchestrator running this session explicitly waived the Figma design gate for this ticket
("the user has WAIVED the Figma design gate — build screens directly"). This is **not** the
same thing as rule 12 gate 2 being satisfied — no frames exist, no product-owner approval was
recorded, nothing is marked Ready for Dev. Per the orchestrator's own scope for this session,
only Phases A–C (which touch no screen/route) were executed; **no Phase D/E screen work was
started**, so the waiver was never actually exercised. If a future session picks up Phase D
(routes/pages), it should either get an explicit waiver reconfirmed or run Task 1 for real.

### DECISION #11 (privilege-boundary fold) — honored, not performed

Per the orchestrator's explicit instruction, `/agentic-policy` (tier 10-19, `manage:all`) was
**not** folded into the Studio and no privilege boundary was moved. Phase E (Tasks 17-19,
consolidation) was not started at all in this session, so this is moot for now but recorded
per the instruction.

### Task 2 — React Flow dependency: DONE

`@xyflow/react@^12.11.3` added to `packages/ui/package.json` `dependencies` (lockfile resolves
`12.11.3`), plus a `./components/workflow-canvas` subpath export
(`packages/ui/package.json#exports`) and a matching `tsup.config.ts` entry. Full record —
package/version, MIT licence read from the published tarball's own `LICENSE` file, React
19/Next 16 compatibility, CSS shipping/scoping, transitive deps (bundles its own `zustand@4`,
no collision with the app's `zustand@5`), rejected alternatives —
in `packages/ui/src/components/workflow-canvas/DEPENDENCY.md`.

### Task 3 — Cross-ticket contracts: DONE, with real gaps recorded (not invented)

`docs/implementation/TASK-719-Workflow-Studio-V1/contracts/{registry,definition-api,validation-report}.contract.md`.
Re-derived directly against delivered TASK-715/716/717 code, `file:line`-cited. Headline
findings (all load-bearing for what Studio v1 could and could not be built against this
session):

- **No registry endpoint or service exists** (`packages/applications/src/services/workflow-registry/`
  is not present; TASK-715 itself is "Phase A — Database — done; Phases B–F not started"). The
  one real registry-shaped fact available is `WorkflowNodeClassLookup.classesOf(nodeType):
  readonly string[]` (`packages/workflow-contract/src/predicates/context.ts:18-19`) — an open
  class SET, not the plan's assumed three-value `safetyClass` enum. Recorded as a divergence;
  the canvas composite (Task 5) was built against the set-shaped field (`safetyClasses:
  readonly string[]`, `'mandatory'` membership) so it composes with a real registry later
  without a second reconciliation pass.
- **No definition CRUD API exists** either (no controller, no service, confirmed absent). The
  path table in `definition-api.contract.md` is a documented ASSUMPTION mirrored from the
  delivered `consultation-context-schema` controller, not a verified contract.
- **`WorkflowGraphNode` has no `position` field**
  (`packages/workflow-contract/src/graph-model.ts:12-16`) though the plan's Task 3 text assumed
  one. Recorded as an open question (§6) rather than silently inventing a field the delivered
  type doesn't have; a Studio-reserved `config.__position` nesting is the documented fallback
  for when Phase D actually needs to serialize a graph.
- **`WorkflowValidationReport`/`WorkflowFinding` ARE real, delivered, cited types**
  (`packages/workflow-contract/src/report.ts`) — the one contract of the three with a solid
  floor. Its rule SET is explicitly DRAFT/not-clinician-reviewed (confirmed in
  `packages/workflow-contract/src/index.ts:9-13`) and not wired to any application-layer caller
  in this session — matches the orchestrator's framing for TASK-716 exactly.

### Phase B — WorkflowCanvas composite (Tasks 4–6): DONE

- **Task 4 (RED):** `packages/ui/src/components/workflow-canvas/__tests__/workflow-canvas.vitest.tsx`.
  **Filename deviation, deliberate:** the ticket's plan named `workflow-canvas.test.tsx`, but the
  live `packages/ui/vitest.config.ts` only picks up `src/**/*.vitest.{ts,tsx}` — verified by
  running `pnpm --filter @arcaai/ui test` before and after adding a probe file and counting
  matched files (242 `.vitest.tsx` files in the repo == 242 test files run; the 83 existing
  `.test.tsx` files under `src/components/__tests__/` are a SEPARATE convention, Playwright CT,
  picked up by `playwright-ct.config.ts`'s own `testMatch: '**/*.test.tsx'` under a different,
  centralized `testDir`). Named the file `.vitest.tsx` so it actually runs under `pnpm ui:test`;
  the CT interaction tests correctly use `.test.tsx` under the centralized
  `src/components/__tests__/custom/` directory, per that convention. First run confirmed RED
  (`Cannot find module '../workflow-canvas'`).
- **Task 5 (GREEN):** `packages/ui/src/components/workflow-canvas/{types.ts, workflow-node.tsx,
  workflow-edge.tsx, canvas-controls.tsx, canvas-tokens.css, workflow-canvas.tsx, index.ts}`.
  Props-in/callbacks-out (owns no graph state); single xyflow-registered node/edge type with
  registry-driven inner content via `nodeTypes`; `role="application"` + `aria-label` + hidden
  keyboard hint; every node `ariaLabel`/`focusable`/`aria-describedby` (validation-summary span,
  built by the composite, never the caller); real `<button>` remove/zoom/fit controls;
  `onDeleteRequest` never removes a node itself; `prefers-reduced-motion` suppresses fit-view
  duration; theming bridge in `canvas-tokens.css` maps HOPE's light/dark tokens onto React
  Flow's own `--xy-*` variables (no `.dark`-scoped duplicate needed — HOPE's tokens already
  flip). 14/14 tests GREEN. Discovered and fixed along the way: happy-dom needs a ResizeObserver
  polyfill (React Flow measures node dimensions via `entry.target.offsetWidth/Height`, not
  `getBoundingClientRect`, and needs the callback deferred via `queueMicrotask` — firing
  synchronously races ahead of React Flow's own `domNode` ref effect and silently no-ops);
  React Flow ships no default focus-visible outline for a keyboard-focused node, so
  `canvas-tokens.css` adds one (`:focus-visible { outline: 2px solid var(--primary) }`) —
  without it Tab-reachability would be keyboard-operable but not keyboard-**visible**.
- **Task 6:** Storybook story (`packages/ui/src/components/__stories__/custom/workflow-canvas.stories.tsx`,
  Default/ReadOnly/Empty) and a real-browser Playwright CT suite
  (`packages/ui/src/components/__tests__/custom/workflow-canvas.test.tsx`, chromium downloaded
  this session via `npx playwright install chromium` — v1234 was missing). **3 of 4 CT tests
  pass**: keyboard Tab reaches a node with a visible focus outline; no horizontal page scroll at
  320px width; no horizontal page scroll at an emulated 200% zoom (halved viewport — Playwright
  has no native browser-zoom control). **1 left `test.fixme`** (pointer drag-to-connect): a
  synthesized `page.mouse` drag into the CT iframe never lands on React Flow's 6×6px handle hit
  target in this session — verified the connection line never starts even immediately after
  `mouse.down`, across several coordinate/settle-timing strategies (including waiting for the
  `fitView` transform to stabilize before measuring). This is a harness limitation, not a
  product gap: pointer-drag-connect is an enhancement over the mandatory keyboard/single-pointer
  path (Task 13's list-editor "Connect to…" picker), and no acceptance criterion depends on this
  specific interaction being provable here. `pnpm --filter @arcaai/ui test:ct` overall: 1712
  passed, 1 skipped (the fixme), **5 pre-existing failures in `master-detail-layout.test.tsx`**
  — confirmed via `git status` that this file and its component were untouched by this session;
  not investigated further (out of ticket scope, another surface).

### Phase C — schema→form compiler (Tasks 7–8): DONE (Task 9 inspector rendering NOT started)

- **Task 7 (RED):** `apps/admin-console/src/features/workflow-studio/lib/__tests__/schema-form.test.ts`
  + 3 fixture schemas (`summarize`, `discriminated` oneOf, `unsupported` if/then/else). Confirmed
  RED (`Cannot find module '../schema-form'`).
  Same "one schema, three consumers" round-trip discipline design.md names: every compiled
  descriptor is checked for agreement with `jsonSchemaValueProblems` from
  `@arcaai/json-schema-subset`, never a second, re-derived validator.
- **Task 8 (GREEN):** `apps/admin-console/src/features/workflow-studio/lib/schema-form.ts` — pure,
  framework-free `toFieldDescriptors(schema): FieldDescriptor[]` covering
  string/number/integer/boolean/array-of-string/enum/nested-object/discriminated-oneOf, with a
  `raw-json` degradation both for the two authoring bounds (`MAX_SCHEMA_DEPTH`/`MAX_SCHEMA_NODES`
  — whole-schema fallback) and for any per-property unsupported construct (per-field fallback,
  siblings still compile — verified by a dedicated test). **Deliberate refinement vs. design.md's
  "zod + Field family" shorthand** (recorded per R5): zod is not used at all here — the compiler
  and the value-validity check both go through `@arcaai/json-schema-subset` exclusively, so the
  generated part of the form has exactly one validator, matching that package's own reason for
  existing. 12/12 tests GREEN.
- **Task 9 (inspector form rendering) was NOT started** — the descriptors exist and are tested
  in isolation, but no React component renders them yet.

### Phases D, E, F — NOT STARTED

Tasks 10–21 (feature-module scaffold, Zustand graph store, palette rail, list/tree editor,
validation rail, autosave/publish, routes/nav, consolidation, unit+a11y+e2e verification) were
not attempted this session. Phase D is explicitly gated on real substance from TASK-715/716
Phases B–D that does not exist yet (§Task 3 above) — building Task 10's API client beyond the
documented, clearly-labeled assumption in `definition-api.contract.md` would mean inventing a
contract, which R3/§3.1 forbid. Phase D's UI-only pieces (Task 11 store, Task 12 palette rail,
Task 13 list editor, Task 14 validation rail, Task 16 routes/nav/skeletons) do NOT strictly
require a live API and are legitimate next-session work; they were simply not reached in this
session's time budget.

### Commands run, verbatim results

```
pnpm --filter @arcaai/ui test        → Test Files  243 passed (243) · Tests  673 passed (673)
pnpm --filter @arcaai/ui lint        → clean (0 errors, 0 warnings)
pnpm --filter @arcaai/ui typecheck   → clean
pnpm --filter @arcaai/ui build       → succeeded; dist/components/workflow-canvas/{index.js,index.mjs,index.d.ts,index.css} emitted as a separate chunk
grep -n "workflow-canvas" packages/ui/src/index.ts → no output (root barrel does not export it)
pnpm --filter @arcaai/ui test:ct     → 1712 passed, 1 skipped (fixme), 5 failed (pre-existing, unrelated file — see above)

pnpm --filter @arcaai/admin-console test        → Test Files  179 passed (179) · Tests  1431 passed (1431)
pnpm --filter @arcaai/admin-console lint        → clean (0 errors, 0 warnings)
pnpm --filter @arcaai/admin-console typecheck   → clean
pnpm --filter @arcaai/admin-console build       → exit 0 (full route manifest emitted)
```

### Gated / not run

- `pnpm --filter @arcaai/admin-console test:e2e` — not run. Requires the app on :5176 and the
  gateway on :8868; local infra is down this session, and no Studio route exists yet to test.
- Any live round-trip against `admin/workflow-definitions` or `admin/workflow-nodes` — gated,
  those endpoints do not exist (§Task 3).
- The rule 02 shadow-DB migration proof — **not applicable this session**: no Prisma model was
  touched (Studio v1 is UI-only against TASK-715's already-delivered schema).
- Manual a11y pass (rule 11 §11 — keyboard-only two-node graph build, 200% zoom, reduced-motion)
  — partially covered by the automated Playwright CT suite above (Tab-focus visibility, 320px
  and 200%-zoom-equivalent no-horizontal-scroll); a real manual pass with a screen reader was
  not performed.

### Session 2 (2026-08-16, continued) — real endpoints landed; Phase C finished, Phase D built, Phase E assessed, Phase F partial

**Trigger:** TASK-734 ("workflow substrate second pass") landed BETWEEN Session 1 and this
session — `admin/workflow-definitions` (incl. `GET :id/versions`) and `admin/workflow-nodes` are
now real, delivered controllers/services/DTOs. This session re-derived the three Task 3
contracts against that delivered code (not assumptions), then built against the real route
table.

#### Task 3 — Contracts RE-DERIVED against TASK-734 (superseding Session 1's "NOT YET DELIVERED" verdict)

`contracts/{registry,definition-api}.contract.md` rewritten with a "Superseded original text"
section at the bottom for history; `validation-report.contract.md` got an addendum (the wiring
gap it flagged is now closed). Headline findings, all load-bearing for what got built:

- **Registry is real but ships only `noop`/`passthrough`** — `classes: string[]` (open set,
  confirms Session 1's `safetyClasses` bet), `entitlementKey` now real, but **still no
  `configSchema` field anywhere** and **no `label` field**. This is a structural gap, not a
  session-scoped one: Task 9's inspector had to be built to treat "no schema for this node type"
  as an always-possible state (whole-panel raw-JSON fallback), not an edge case.
- **Definition API route table confirmed, with real surprises**: `paletteKey` is REQUIRED on
  create (the plan's Task 3 text didn't name it); `validate` and `publish` are confirmed NOT
  `If-Match`-gated (verified from the service: `validate` self-CASes against the version it just
  read, `publish` is a plain `.update()`); `WorkflowDefinitionResponse` carries a `needsReview`
  field the plan never anticipated (surfaced in the definitions-list grid).
- **`WorkflowGraphNode` still has no `position` field** — re-confirmed against the real,
  delivered type. The `config.__position` Studio-reserved-key fallback from Session 1 is now the
  ACTIVE serialization boundary (`lib/graph-serialization.ts`), not a contingency.

#### Task 9 — Inspector form rendering: DONE

`components/inspector/{inspector-panel,field-renderers,raw-json-field,field-path}.tsx` — RED→GREEN
(8 tests). Renders `FieldDescriptor[]` (Session 1's `schema-form.ts`) through the `Field` family;
falls back whole-panel to `CodeEditor` when `configSchema === undefined` (the real registry state
today, per Task 3 above). Server `WorkflowFinding`s render via `FieldError` matched by `path`.

#### Phase D — feature module: DONE

- **Task 10 (API layer):** `api/{types,client,keys,hooks,index}.ts` — RED→GREEN (9 tests). Every
  path/OCC-posture claim is now verified against the real controllers, not mirrored.
- **Task 11 (graph store):** `store/{create-graph-store,graph-store-provider,selectors,types,index}.ts`
  — RED→GREEN (16 tests + 4 provider tests). Per-mount `createStore`, never a singleton;
  `deleteNode` refuses `mandatory`, `connect` refuses self-edge/duplicate, `reorderNode` added
  (list-editor-only, display-order bookkeeping) beyond the original plan's action list.
- **Task 12 (palette rail):** `components/palette/*` — RED→GREEN (9 tests). Every item a real
  `<button>` (no drag required); disabled+reason for `implemented:false` and un-entitled types.
- **Task 13 (list/tree editor):** `components/list-editor/{graph-list-editor,node-row,edge-editor}.tsx`
  — 7 tests, all mutations (select/configure/connect/reorder/delete) proven via `<button>`
  `.click()` only, no drag events dispatched anywhere in the suite. "Connect to…" deliberately
  uses the plain `Select` primitive instead of the `cmdk`-backed `Command` component the plan's
  prose suggested — both are fully keyboard-operable (2.5.7 is satisfied either way); recorded as
  a documented substitution, not a silent downgrade (see the component's own doc comment).
- **Task 14 (validation rail):** `components/validation/{validation-rail,problem-row,use-focus-node}.tsx`
  — 12 tests (7 rail + 5 hook — including a jsdom `document.activeElement` proof for canvas AND
  list-view focus targets). `publishBlockedReason` reads `report.ok` only, never re-derives it.
- **Task 15 (autosave/OCC/publish):** `hooks/use-autosave.ts`, `components/{studio-toolbar,publish-dialog}.tsx`
  — 5 hook tests (fake timers: debounce-coalesce, 412 pauses + never auto-retries, `resume()`
  required, 428 -> `onMissingPrecondition`, `cancel()`) + 6 component tests. **Honesty gap**: only
  the `graph` field autosaves in this pass — `name`/`description` edits have no form wired to
  autosave yet (no acceptance criterion required it, but the plan's prose implied full-metadata
  autosave; recorded so it isn't assumed done). "Create new version from this" (design.md §Plane
  1, for a PUBLISHED row) is NOT built — the read-only banner explains the state but offers no
  branch action yet.
- **Task 16 (routes/pages/nav):** `app/(console)/(tenant)/workflow-studio/{page,loading,error}.tsx`
  + `[definitionId]/{page,loading,error}.tsx`; `nav-config.ts` (+1 entry, tier 30-49,
  `[['manage','WorkflowDefinition']]`, icon `IconBinaryTree2` — verified unique against the
  existing 51-icon set); `components/{definitions-list-screen,workflow-studio-screen,
  workflow-studio-editor,create-definition-form}.tsx`. **`pnpm --filter @arcaai/admin-console
  build` succeeds and both new routes (`/workflow-studio`, `/workflow-studio/[definitionId]`)
  appear in the compiled route manifest** — real, end-to-end wiring, not just unit-tested pieces.
  The editor composes: palette rail (left) · canvas-or-list per `viewMode` (center,
  `contentMode` follows `viewMode` — `fill` for canvas, `scroll` for list, never nested scroll
  areas) · inspector + validation rail (right); `StudioToolbar` in the `toolbar` slot;
  `OccConflictAlert` in `statusBanner` on a 412. **Not done**: `?view=list` URL sync via nuqs (view
  mode lives in the Zustand store only this pass); a dedicated metadata/settings form for
  name/description; the `overlay` prop TASK-723 will use.

#### Phase E — consolidation: ASSESSED, nothing folded (by design)

`consolidation-map.md` (new) — Task 17 executed as an assessment: every candidate row's fold
verdict re-derived against the ACTUAL (still noop/passthrough-only) registry, not the plan's
optimistic assumption. Verdict: **nothing folds in this pass** —
`/harness/pipeline-policy` blocks on the registry not yet modeling policy toggles as node config,
`/departments` prompt-config is explicitly out of scope (TASK-733), `/agentic-policy` stays
HUMAN-GATED per the orchestrator's explicit instruction this session ("DECISION #11 REMAINS
GATED… Do NOT perform that fold-in" — honored, not performed, same as Session 1), and
`/prompt-templates` never folds by design. **Tasks 18 and 19 were NOT executed** — Task 18's own
precondition resolves to "does not fold" so there is nothing to do; Task 19 (prompt-template
picker + reciprocal department link) is legitimate follow-on work that simply was not reached
this session. No route was deleted or redirected; no cross-feature import was added.

#### Phase F — verification: PARTIAL

- **Task 20 (unit + a11y suite):** effectively done AS PART OF Tasks 9/11–15 above — every
  screen-level component built this session carries its own `vitest-axe` 0-violation assertion
  (inspector panel, palette rail, list editor, validation rail, toolbar, publish dialog), not a
  separate pass. **89/89 tests pass** under `src/features/workflow-studio/**` (full package run,
  see Commands below).
- **Task 21 (Playwright e2e):** `tests/e2e/workflow-studio.spec.ts` AUTHORED, following
  `workflow-runs.spec.ts` verbatim (same helpers, same `beforeEach` gate). Covers: create-draft →
  keyboard-only palette add → Validate → publish-gated-then-succeeds; publish disabled with a
  visible reason while dirty; click-error → focus-node in both view modes; cross-tenant 404; axe
  in both themes on the list and the canvas editor. **NOT EXECUTED** — the program's known
  blocker (`prisma db push --force-reset` refused when invoked by an agent) still applies, and
  local infra was not brought up this session either. One test (`mandatory node exposes no
  Delete in either view mode`) is written as an honest `test.skip` — the live two-entry registry
  has no `mandatory`-classed node type to exercise it against.
- **Manual a11y pass** (keyboard-only two-node graph build, 200% zoom, reduced-motion, screen
  reader) — **NOT performed this session**, same gap as Session 1.

#### What is still genuinely NOT done (read this before marking the ticket complete) — updated Session 3

1. Task 1 (Figma design gate) — still waived per orchestrator instruction, still not cleared for
   real; if a future session's scope changes, reconfirm the waiver explicitly.
2. Task 18 (pipeline-policy fold) — Task 17's own verdict is "does not fold this pass" (registry
   still has no palette content to fold against), so there is genuinely nothing to execute here
   yet; re-check the verdict once TASK-720 lands real palette content.
3. TASK-720's palette content landing will re-open the registry-contract gap (no `configSchema`,
   no `label`) — Task 9/12's fallbacks (and Task 19's `PromptTemplatePicker` gating on
   `knownPaths`) are the safety net, not a permanent design.
   **UPDATE (Session 6, 2026-08-20):** `configSchema` is now a real, wired field for 16 of the
   30 live registry node types (`noop`, `core.start`, `core.end` + the 13 summarization/STT
   palette node types with a committed contract schema) — see `registry.contract.md`'s
   "RESOLVED" section. Coverage is deliberately partial: `passthrough` (echoes arbitrary config
   by design) and all 13 consultation-palette node types (no committed schema doc exists) stay
   `undefined`, so the raw-JSON fallback this item already names is still load-bearing for those
   14 node types — genuinely still open, not silently closed. `label` remains unbuilt.
4. Playwright e2e execution and the manual a11y pass — both blocked on infra/tooling this
   session, not skipped by choice.
5. **DONE this session (Session 3), removed from this list:** `name`/`description` autosave;
   "Create new version from this" on a PUBLISHED row; `?view=` URL sync (Task 15/16 remainder);
   Task 19 (prompt-template picker in the inspector + department reciprocal link). See below.

### Commands run, verbatim results (Session 2)

```
pnpm --filter @arcaai/admin-console test  (whole package, not just workflow-studio)
  → Test Files  195 passed (195) · Tests  1541 passed (1541)
    (includes the pre-existing `nav-config.test.ts` route-count assertion, which this session
    did NOT modify — it now passes; earlier in this same session, run in isolation while a
    sibling ticket's concurrent edits were mid-flight in this shared tree, it briefly failed at
    51 vs an expected 50 routes. Not this ticket's file to fix beyond adding its own one entry.)

pnpm --filter @arcaai/admin-console lint        → clean (0 errors, 0 warnings)
pnpm --filter @arcaai/admin-console typecheck   → clean
pnpm --filter @arcaai/admin-console build       → succeeded; `/workflow-studio` and
    `/workflow-studio/[definitionId]` present in the compiled route manifest (Turbopack, 77/77
    static pages generated). 5 pre-existing Edge-Runtime warnings from `instrumentation.ts`,
    unrelated to this ticket, untouched by this session.

pnpm --filter @arcaai/ui typecheck   → clean
pnpm --filter @arcaai/ui lint        → clean
    (packages/ui was not modified this session — workflow-canvas is unchanged from Session 1;
    re-verified only to rule out cross-package drift from concurrent sibling work in this tree.)
```

### Gated / not run (Session 2)

- `pnpm --filter @arcaai/admin-console test:e2e` for `tests/e2e/workflow-studio.spec.ts` — not
  run. Program-wide known blocker (`prisma db push --force-reset` refused for an AI agent); local
  infra also not brought up this session.
- Manual a11y pass (keyboard-only build, 200% zoom, reduced-motion, screen reader) — not
  performed.
- A live round-trip against `admin/workflow-definitions`/`admin/workflow-nodes` from a running
  browser — the endpoints are real (unlike Session 1), but no live session exercised them; only
  `pnpm build`'s static route generation and the unit/component test suite (mocked `fetch`)
  verify the wiring in this session.

### Session 3 (2026-08-17) — Task 15 remainder, Task 16 remainder, Task 19

**Scope, per explicit orchestrator instruction:** finish exactly Task 15's remainder
(name/description metadata form + autosave wiring, "create new version from a published row",
unsaved-changes guard), Task 16's remainder (`?view=list` URL sync via nuqs), and Task 19 (demote
the department prompt-config panel, add the prompt-template picker to the inspector). Decision
#11 (`/agentic-policy` fold-in) remains GATED and was **not** touched. Task 18 was **not**
attempted — Task 17's own verdict already resolves it to "does not fold this pass"; there is
nothing to execute until TASK-720 lands real palette content, and forcing a fold against that
verdict would be inventing scope, not finishing it.

- **Task 15 remainder — DONE.**
  - `hooks/use-unsaved-changes-guard.ts` (new, TDD RED→GREEN, 5/5 tests) — `beforeunload` +
    a capture-phase document `click` listener on same-origin anchors (the App Router has no
    `router.events` to intercept programmatic navigation, so the click-driven path — every nav
    affordance in this console — is what's covered; recorded as a known, honest limitation in the
    hook's own doc comment, not silently assumed complete).
  - `components/definition-metadata-form.tsx` (new, TDD RED→GREEN, 6/6 tests) — a short Dialog
    (rule 11 §1) over `name`/`description`, controlled state, no `react-hook-form`. Fires
    `onNameChange`/`onDescriptionChange` on every keystroke.
  - `workflow-studio-editor.tsx` wiring (new test file, TDD RED→GREEN, 5/5 tests): local
    `name`/`description`/`metadataDirty` state hydrated alongside the graph in the existing
    per-`definition.id` `hydratedRef` effect; `handleNameChange`/`handleDescriptionChange` call
    the SAME `autosave.schedule(...)` the graph uses (the hook already merges patches — no second
    debounce timer); `onSaved` clears `metadataDirty` the same way it clears the store's graph
    `dirty`. An "Edit details" button in the `PageHeader` actions slot opens the dialog.
  - "Create new version from this" (design.md §Plane 1) — a PUBLISHED/DEPRECATED row's
    `statusBanner` now carries a "Create new version" button next to the read-only notice
    (instead of any edit affordance) that calls `useCreateWorkflowDefinition().mutateAsync` with
    `{ slug, name, description, paletteKey, graph }` cloned from the current row plus
    `parentVersionId: definition.id`, then `router.push`es to the new draft's editor route.
    Verified against the delivered `create()` service logic
    (`workflow-definition.service.ts:148-210`): `parentVersionId` requires the parent's `slug` to
    match and mints `versionNumber = maxVersionNumber(slug) + 1` inside the same transaction — no
    client-side version-number guessing.
  - `useUnsavedChangesGuard(!readOnly && (dirty || metadataDirty))` wired at the top of
    `EditorBody` — combines the store's graph-shape `dirty` with the new metadata-form dirty flag;
    a read-only published row is never treated as dirty.
- **Task 16 remainder — DONE.** `?view=` now round-trips through nuqs
  (`parseAsStringLiteral(['canvas','list']).withDefault('canvas')`, default `history: 'replace'`
  so toggling the view doesn't spam browser history): the URL is read on mount and whenever it
  changes externally (shared link, back/forward) and pushed into the store via `setViewMode`; the
  toolbar's `onViewModeChange` now writes BOTH the store and the URL in one call
  (`handleViewModeChange`). Verified end-to-end (not just the codec in isolation): mounting with
  `?view=list` renders the list editor, and clicking the "List" toggle from a bare URL updates the
  URL's `view` param.
- **Task 19 — DONE.**
  - `components/inspector/prompt-template-picker.tsx` (new, TDD RED→GREEN, 5/5 tests) — a picker
    (Select + `<Skeleton>` while loading) over the tenant's prompt templates, reading
    `admin/prompt-templates` through this feature's OWN `api/client.ts`/`api/hooks.ts`
    (`listPromptTemplateOptions`/`usePromptTemplateOptions`, new) — deliberately re-implemented
    rather than imported from `features/departments/api/client.ts:54`, which does the identical
    read for the identical reason (rule 13 §Structure: "features never import each other"). Plus
    a plain `href` deep link to `/prompt-templates` (design.md: "prompt templates keep their own
    authoritative editor (picker + deep link)").
  - Wired into `InspectorPanel` (`inspector-panel.tsx`, +4 tests) as a standalone
    `PromptTemplateSection` bound to `node.config.promptTemplateId`: rendered in BOTH the
    schema-less fallback (the real registry state today — no delivered node type has a
    `configSchema`) and the schema-driven branch, but in the latter it steps aside whenever the
    compiled `FieldDescriptor[]` already declares a field at path `promptTemplateId` — so a future
    schema that names the field itself never gets a second, duplicate control for the same key.
  - `department-prompt-config-panel.tsx` — added the reciprocal plain-`href` link to
    `/workflow-studio` in the panel's header, plus a one-line note naming the Studio as the future
    home, per the owner verdict already recorded in `consolidation-map.md` ("does not fold in
    v1 — per-department workflow assignment is TASK-733"). This panel remains the AUTHORITATIVE
    editor for its four prompt slots; nothing about its own editing behavior changed.
- **A pre-existing Radix `Select` test gap was found and fixed while writing the picker's
  tests**, not introduced by this session: no test anywhere in `apps/admin-console` previously
  drove a `SelectItem` selection all the way through under jsdom (`identity-provider-form.test.tsx`
  only opens the dropdown and reads its options). Root-caused against
  `@radix-ui/react-select`'s own source: `SelectItem` tracks pointer type on an ITEM-scoped ref
  that only becomes `"mouse"` after a real `pointerdown` on that same item; a synthetic
  `fireEvent.click` — which jsdom never precedes with real pointer events — hits the item's
  `onClick` branch instead (fires for any NON-"mouse" pointer type, which is the ref's default).
  `fireEvent.click(option)` is therefore the activation path that survives jsdom; `pointerUp`
  alone is not. Documented as a comment at both call sites (`prompt-template-picker.test.tsx`,
  `inspector-panel.test.tsx`) so the next Select-interaction test in this app doesn't rediscover it.

#### Commands run, verbatim results (Session 3)

```
pnpm --filter @arcaai/admin-console test        → Test Files  201 passed (201) · Tests  1579 passed (1579)
pnpm --filter @arcaai/admin-console lint        → clean (0 errors, 0 warnings)
pnpm --filter @arcaai/admin-console typecheck   → clean
pnpm --filter @arcaai/admin-console build       → exit 0; `/workflow-studio` and
    `/workflow-studio/[definitionId]` present in the compiled route manifest (Turbopack, 79/79
    static pages generated). Same 5 pre-existing Edge-Runtime warnings from `instrumentation.ts`
    as Session 2 — untouched by this session.
```

RED confirmed before each new test file/behavior (`use-unsaved-changes-guard.test.tsx`,
`definition-metadata-form.test.tsx` — module-not-found; `workflow-studio-editor.test.tsx` — all 5
new assertions failed against the pre-change component). `packages/ui` was not touched this
session (`workflow-canvas` unchanged) — not re-verified in this session since no file under
`packages/ui` was edited.

#### Gated / not run (Session 3)

- `pnpm --filter @arcaai/admin-console test:e2e` for `tests/e2e/workflow-studio.spec.ts` — not
  run. Same program-wide blocker as Sessions 1–2 (`prisma db push --force-reset` reserved for the
  orchestrator; local infra not brought up this session).
- Manual a11y pass (keyboard-only build, 200% zoom, reduced-motion, screen reader) — not
  performed this session either.
- Decision #11 (`/agentic-policy` fold) — remains GATED, not performed, per explicit instruction.
- Task 18 (pipeline-policy fold) — not attempted; Task 17's verdict already resolves it to
  "does not fold this pass" and nothing in this session's scope changed that verdict.

### Session 4 (2026-08-19) — e2e EXECUTED, manual a11y pass performed, two runtime defects fixed

Both remaining Phase-F items were run for real against the isolated test stack: gateway
`http://localhost:8968` (owned by the orchestrator, DB untouched — `RESET_DB=false`, no reset, no
re-seed) and a `next dev` console on `:5276` pointed at it.

#### Playwright e2e — `tests/e2e/workflow-studio.spec.ts`

```
$ ADMIN_CONSOLE_URL=http://localhost:5276 API_URL=http://localhost:8968 RESET_DB=false \
    pnpm exec playwright test workflow-studio.spec.ts --workers=2 --timeout=90000
Running 12 tests using 2 workers
  ✓ [setup] authenticate as seeded super admin (1.1s)
  ✓ workflow definitions list › shows the header, fill-height grid and a New definition action
  ✓ workflow definitions list › has no WCAG 2.2 AA violations (light)
  ✓ workflow definitions list › has no WCAG 2.2 AA violations (dark)
  ✓ workflow studio editor › Publish is disabled while the report is dirty, with a visible reason
  ✓ workflow studio editor › create draft -> add a node from the palette BY KEYBOARD ONLY -> it persists -> Publish stays gated
  ✓ workflow studio editor › a mandatory node exposes no Delete affordance in EITHER view mode
  ✓ workflow studio editor › a foreign/nonexistent definition id renders not-found, never a 403
  ✓ workflow studio editor › clicking a validation problem moves DOM focus to its node, in canvas AND list view
  ✓ workflow studio editor › has no WCAG 2.2 AA violations on the canvas editor (light)
  ✓ workflow studio editor › has no WCAG 2.2 AA violations on the canvas editor (dark)
  ✓ workflow studio editor › has no WCAG 2.2 AA violations on the list editor (light)
  12 passed (13.6s)
```

**axe: 0 violations** on the definitions list (light + dark), the canvas editor (light + dark) and
the list editor — `expectNoA11yViolations` asserts an EMPTY violations array over
`wcag2a/2aa/21a/21aa/22aa`, so a green run IS the zero-violation evidence.

Four assertions in the authored spec contradicted the running system and were corrected (each
carries an inline comment saying why):

| Was | Reality |
|---|---|
| `/run validate before publishing/` on a fresh draft | The gateway returns a `validationReport` with the created draft, so the gate reason is "Resolve every error before publishing." Now accepts either. |
| add ONE node → Validate → expect Publish ENABLED | The live summarization palette needs `core.start` + 4 mandatory types + reachability + per-node config (`WF-I-002/004/010`). One node can never clear it. The leg now proves keyboard-only add → persistence → gate holds; the publish-confirm dialog stays unit-covered. |
| mandatory-node test `test.skip(true, …)` | The registry DOES class nodes `mandatory` now — the test is live and green. |
| click a problem row → `:focus-visible` on the node | `use-focus-node.ts` focuses programmatically; a programmatic focus after a MOUSE click never matches `:focus-visible` in Chromium. The row is now activated BY KEYBOARD, which is the path the ring exists for. |

Two `test.skip` guards also fired spuriously because they called `isVisible()` without awaiting the
async registry/report fetch; both now await the locator first.

#### Manual a11y + runtime pass (driven browser, both themes)

- **Keyboard**: Tab reaches every palette item with a visible focus ring; Tab reaches canvas nodes
  (React Flow stamps `tabindex=0`); activating a validation problem by keyboard moves DOM focus to
  the node and `:focus-visible` matches (proved in-run, see the table above).
- **Both themes**: list, canvas editor and list editor verified in light and dark. Dark exposed a
  real defect (below).
- **Reduced motion / semantics**: `data-reduced-motion` bridge present; `role="application"` carries
  the definition name; the canvas ships its sr-only "use the list view for a pointer-free path" hint.
- **Reflow**: no horizontal scrolling at 640×400 CSS px (≙ 200 % zoom of 1280×800).

#### Defects found and FIXED this session

1. **The whole React Flow theming bridge never reached any consumer.** `tsup` extracts
   `canvas-tokens.css` into `dist/components/workflow-canvas/index.css` but does NOT re-import it
   from the emitted JS, so `@arcaai/ui/components/workflow-canvas` shipped with **zero** `--xy-*`
   overrides: every `--xy-*` custom property computed to the empty string in the running app and
   React Flow fell back to its light defaults — white (`#fefefe`) zoom/fit control buttons carrying
   near-white foreground icons on the dark surface, plus a white attribution chip. **Fix:** the
   canonical token sheet `packages/ui/src/styles/globals.css` now `@import`s the bridge, so every
   consumer of `@arcaai/ui/globals.css` gets it unconditionally. Verified in-browser:
   `--xy-controls-button-background-color` resolves to `#111d23` in dark and `#fff` in light.
2. **Selecting a node crashed the canvas — "Maximum update depth exceeded".** `WorkflowCanvas`
   passed an INLINE arrow to React Flow's `onSelectionChange`. React Flow re-subscribes on every
   handler identity and re-emits the current selection, so selection looped
   (`onSelect` → store → `selectedNodeId` → new `xyNodes` → render → new handler → emit). The React
   error boundary tore the canvas subtree down: node count dropped to 0 and focus fell back to
   `<body>`. **Fix:** memoize the handler in the composite (`React.useCallback`) AND give it a
   stable `onSelect` from the consumer (`selectNodeById` in `workflow-studio-editor.tsx`, previously
   a fresh arrow per render — the composite-side memo alone would have been useless). This is why
   the click-error → focus-node contract had never actually worked outside jsdom.

#### Open a11y finding (NOT fixed — needs a layout decision)

At 640×400 CSS px (200 % zoom on a 1280×800 desktop) the editor's palette rail and canvas collapse
to **59 px tall**. There is no horizontal scrolling (1.4.10 in the strict sense holds), but the
authoring surface is unusable at that zoom. The cause is structural: the console shell owns the
viewport height (`h-svh overflow-hidden`) and `ScreenTemplate contentMode="fill"` hands what is left
to a fixed-height flex row. Fixing it properly means stacking the palette/canvas/inspector into a
scrolling column below a height threshold — a `ScreenTemplate`-level change with blast radius beyond
this ticket, so it is recorded here rather than attempted in a verification pass.

#### Commands (Session 4)

```
$ pnpm --filter @arcaai/admin-console typecheck   # tsc --noEmit — clean
$ pnpm --filter @arcaai/admin-console lint        # eslint src --max-warnings 0 — clean
$ pnpm --filter @arcaai/admin-console test        # Test Files 206 passed (206) · Tests 1620 passed (1620)
$ pnpm --filter @arcaai/admin-console build       # succeeds; /workflow-studio + /workflow-studio/[definitionId] in the manifest
```

`packages/ui` was edited this session but its unit suite was NOT run — the orchestrator's standing
instruction (and `01-development-workflow.md` §Test Scope Exclusions) keeps that suite out of scope.
The canvas changes are covered end-to-end by the Playwright run above.

`apps/admin-console/tests/e2e/harness-workflows.spec.ts` has 6 failures in this stack because the
Temporal harness service is not running; unrelated to this ticket and left alone.

### Session 5 (2026-08-19) — 200 % reflow closed; editor raised to node-editor baseline

Ran against the same isolated stack (gateway `:8968`, `RESET_DB=false`, no reset/seed) with a
`next dev` console on `:5376`.

#### 1. The open a11y finding is FIXED — 200 % zoom (WCAG 1.4.10)

Session 4 left the editor collapsing to ~59 px tall at 640×400 CSS px and judged the fix a
`ScreenTemplate`-level change with wide blast radius. It is not: `ScreenTemplate` is unchanged.
The squeeze came from the SCREEN — `contentMode="fill"` handing a fixed-height flex row to a
three-column grid that had no way to stop being three columns.

`workflow-studio-editor.tsx` now runs `contentMode="scroll"` in **both** view modes and gates the
three-panel row on `[@media(min-width:64rem)_and_(min-height:32rem)]`:

- **Wide+tall** — `h-full`, `grid-cols-[240px_1fr_320px]`, each panel `overflow-y-auto`. Content
  exactly fills the region, so the template's own scroll container never engages. Visually and
  behaviourally identical to the previous `fill` layout.
- **Below either threshold** — one column, intrinsic heights, canvas floored at `min-h-[26rem]`,
  panels not scrollable; the template's content region is the single scroll container.

Exactly one scroll container is live per panel in either branch — the rule 11 §1 constraint is
kept, not traded away. The height half of the condition is load-bearing: a width breakpoint alone
would still squeeze a wide-and-short window (1440×420). `EditorLoadingSkeleton` mirrors the same
gate so the skeleton keeps the loaded shape at every zoom (rule 10 §3).

Measured in the running app at 640×400 (`document.documentElement`, live page):

```
{ vw: 640, vh: 400, hOverflow: false, scrollWidth: 640, palette: 184, canvas: 416 }
```

Canvas 59 px → **416 px**; still no horizontal scrolling. Locked by a new e2e test
(`at 200 % zoom (640x400 CSS px) the panels stack and stay usable…`) that asserts both panels
exceed 180 px and `scrollWidth <= clientWidth`.

#### 2. UX improvements made (and why)

| Change | Where | Why it earned its place |
|---|---|---|
| **Undo / redo wired up** | `selectCanUndo`/`selectCanRedo`, `StudioToolbar` buttons, `use-studio-shortcuts.ts` (Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z, Ctrl+Y) | The store had a full bounded undo stack since Task 11 and **nothing could reach it** — no button, no key. The single highest-value gap: destructive graph edits were one-way. Buttons and shortcut read the same selectors, so a disabled button and a no-op chord can never disagree |
| **Palette filter** | `PaletteRail` — labelled `type="search"` input, live `n of m node types` count, its own empty state | The live registry serves **30** node types across four palettes; scanning that by eye in a 240 px rail is the daily cost. Client-only state, never a URL param — a transient authoring aid is not a shareable view of the definition |
| **Drag-time connection validation** | new `canConnect` store predicate → `WorkflowCanvas` `isValidConnection` | Self-edges and duplicates were only refused AFTER the drop, as a toast. The predicate is the same one `connect` runs, so the drag-time answer and the committed answer cannot drift |
| **Duplicate node** | `duplicateNode` store action + per-row button in the list editor + Ctrl/Cmd+D | Re-adding a configured node meant re-entering its config by hand. Refuses `mandatory` nodes (singletons) and does NOT copy edges — re-pointing wiring would be a guess. Undoable |
| **Canvas empty state** | new optional `emptyState` prop on `WorkflowCanvas`; the Studio passes an `Empty` pointing at the palette and the list view | An empty canvas was a blank dotted grid. The composite ships no copy of its own — the consumer supplies it (rule 10) |
| **Graph + problem counts in the status bar** | `StatusFooter` `start` | The footer said only "saved/unsaved". It now carries `n nodes · n connections` and the live `n errors, n warnings`, so the publish gate's reason has a visible magnitude without opening the rail |

Keyboard discipline for the shortcuts: every chord is ignored while focus is in an `input`,
`textarea`, `select` or `contenteditable` (the inspector's fields and `CodeEditor` keep native
Ctrl+Z), and every shortcut has a visible clickable equivalent — nothing is keyboard-only, and
nothing is pointer-only (2.1.1 / 2.5.7 both hold).

#### 3. Deliberately NOT done — with reasons

| Considered | Verdict |
|---|---|
| **Node alignment / distribute tools** | **Skipped — they would align nothing that survives.** Canvas `position` is client-only bookkeeping: `graph-serialization.ts` does not send it and `moveNode` deliberately does not mark the graph dirty. Alignment would be cosmetic for the current session only |
| **Multi-select + bulk delete** | Skipped. `deleteNode` refuses per node (mandatory), so a bulk delete resolves to a partial-success dialog — more UI, more failure modes, for a graph that is a handful of nodes. Undo now makes single deletes cheap to reverse, which was the real pain |
| **Minimap** | Skipped. It occludes a canvas that is already only ~50 % of a 1440 px screen, adds nothing for graphs this size, and carries no keyboard value. Fit-view + zoom already exist as real `<button>`s in `CanvasControls` |
| **Cross-document copy/paste** | Skipped. Pasting a node from another definition can carry a type the target palette does not serve; the honest form of that is a template/import feature, not a clipboard shortcut |
| **Zoom-to-fit** | Not added — already present. `fitView` runs on mount (reduced-motion aware) and xyflow's `<Controls>` ships a real fit-view button |
| **Autosave/dirty rework** | Not needed. The state badge, the footer line and the OCC pause banner already cover it; the gap was counts, which were added |

#### 4. Verification (Session 5)

```
$ pnpm --filter @arcaai/admin-console lint        # eslint src --max-warnings 0 — clean
$ pnpm --filter @arcaai/ui lint                   # clean
$ pnpm --filter @arcaai/admin-console typecheck   # tsc --noEmit — clean
$ pnpm --filter @arcaai/ui typecheck              # clean
$ pnpm --filter @arcaai/admin-console test        # Test Files 208 passed (208) · Tests 1632 passed (1632)
$ pnpm --filter @arcaai/admin-console build       # Compiled successfully; /workflow-studio + /workflow-studio/[definitionId] in the manifest
```

Playwright, against the running stack:

```
$ ADMIN_CONSOLE_URL=http://localhost:5376 API_URL=http://localhost:8968 RESET_DB=false \
    pnpm exec playwright test workflow-studio.spec.ts --workers=2 --timeout=90000
Running 14 tests using 2 workers
  ✓ [setup] authenticate as seeded super admin
  ✓ definitions list › header, fill-height grid, New definition action
  ✓ definitions list › no WCAG 2.2 AA violations (light) / (dark)
  ✓ editor › Publish disabled while the report is dirty, with a visible reason
  ✓ editor › create draft -> add a node BY KEYBOARD ONLY -> persists -> Publish stays gated
  ✓ editor › a mandatory node exposes no Delete affordance in EITHER view mode
  ✓ editor › a foreign/nonexistent definition id renders not-found, never a 403
  ✓ editor › no WCAG 2.2 AA violations on the canvas editor (light) / (dark)
  ✓ editor › no WCAG 2.2 AA violations on the list editor (light)
  ✓ editor › at 200 % zoom (640x400 CSS px) the panels stack and stay usable      [NEW]
  ✓ editor › undo/redo round-trips a palette add, by button and by keyboard        [NEW]
  -   editor › clicking a validation problem moves DOM focus to its node           [skipped]
  1 skipped, 13 passed (15.7s)
```

**axe: 0 violations** on the definitions list, the canvas editor and the list editor, in both
themes, WITH the new affordances rendered.

The one skip is the click-problem→focus test, whose own guard skips when the report has no
node-scoped finding to click; it passed earlier in the same session before the fixture drifted.

Two spec repairs, both because the assertion (not the app) was wrong:

| Was | Reality |
|---|---|
| `getByRole('button', { name: 'New definition' })` unscoped | Strict-mode violation: the pinned header action AND the grid's empty-state CTA both carry that name, and which exist is DATA-dependent. Verified pre-existing with `git stash -u` — both buttons are on the base commit; Session 4 passed only because that tenant's list was non-empty. Now `.first()`, with the reason at the call site |
| unit test asserted `queryByText(/no nodes yet/i)` is null in canvas view | The canvas now HAS an empty state with that title. Discriminates on the copy instead ("switch to the list view" vs "to start building this workflow") |

#### 5. Driven-browser pass (both themes)

- **Dark**: definitions list, canvas editor, list editor, palette filter (`1 of 30 node types`
  after typing `guard`), undo/redo buttons, footer `1 node · 0 connections  4 errors, 1 warning`.
- **Light**: same screens after `colorScheme: light` — canvas controls, node chrome, filter and
  toolbar all token-driven, no hardcoded colour anywhere in the diff.
- **Interactions proven live**: palette filter → add node (autosave `PATCH` 200, footer to
  `2 nodes`) → **Ctrl+Z** removes it (back to `1 node`); list-editor **Duplicate** creates and
  selects the copy, opening the inspector's `CodeEditor`; toolbar Undo reverses it.
- **Keyboard**: Tab reaches the palette filter and the list rows with a visible focus ring.
- **Console/network**: no React errors; every `/api/hope/admin/workflow-*` call 200.

#### 6. Environment note (not a code finding)

Partway through this session 52 tracked files (`pnpm-lock.yaml`, `turbo.json`, `.gitlab/**`,
`.cursor/**`, …) vanished from the worktree along with `node_modules/next`, which surfaced as a
spurious Turbopack panic. Restored with `git checkout` over `--diff-filter=D` and re-installed;
no source file of this ticket was affected and nothing was committed from that state. Flagging it
because several agent worktrees share one pnpm store.

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | ticket-writer agent (Wave 2 Studio batch) |
| 2026-08-16 | Phases A–C executed (Tasks 1–8): design gate waived per orchestrator instruction; React Flow pinned + `DEPENDENCY.md`; three cross-ticket contracts written against delivered TASK-715/716/717 code with real gaps recorded; `WorkflowCanvas` composite built TDD (RED→GREEN, 14/14 unit + 3/4 CT, 1 CT `fixme`) in `packages/ui`; `toFieldDescriptors` schema→form compiler built TDD (RED→GREEN, 12/12) in `apps/admin-console`. Phases D–F (Tasks 9–21) not started — see §7 for the exact boundary. `pnpm --filter @arcaai/ui {test,lint,typecheck,build}` and `pnpm --filter @arcaai/admin-console {test,lint,typecheck,build}` all green. | execution agent |
| 2026-08-16 | **Session 2** (same day, continued — TASK-734 landed the real `admin/workflow-definitions`/`admin/workflow-nodes` endpoints between sessions): the three Task 3 contracts re-derived against delivered code (superseding Session 1's "NOT YET DELIVERED" verdicts, real gaps re-confirmed — notably still NO per-node `configSchema`); Task 9 (inspector form rendering) finished, closing out Phase C; Phase D built in full — API layer (Task 10), Zustand graph store (Task 11, +`reorderNode`), palette rail (Task 12), structured list/tree peer editor (Task 13, every mutation proven click-only/no-drag), validation rail + click-to-focus (Task 14), debounced autosave/OCC/publish (Task 15, RED→GREEN fake-timer coverage of 412-pause/never-retry/428/cancel), routes + nav entry (Task 16) — `pnpm --filter @arcaai/admin-console build` succeeds with both new routes in the compiled manifest; Phase E (Task 17) executed as an assessment — consolidation-map.md records that NOTHING folds this pass (registry still has no palette content to fold against; `/agentic-policy` stays HUMAN-GATED per explicit instruction) — Tasks 18/19 correctly left not-done rather than forced; Phase F partial — 89 unit/a11y tests across the new components (all green), `tests/e2e/workflow-studio.spec.ts` authored following `workflow-runs.spec.ts` but NOT executed (program-wide Playwright/Prisma blocker), manual a11y pass not performed. Full command evidence and the "still genuinely NOT done" list are in §7. | execution agent |
| 2026-08-17 | **Session 3** — finished Task 15's remainder (name/description metadata form + autosave wiring via `DefinitionMetadataForm` + `use-unsaved-changes-guard.ts`; "Create new version from this" on a PUBLISHED row; combined graph+metadata unsaved-changes guard), Task 16's remainder (`?view=list` URL sync via nuqs, both directions), and Task 19 (`PromptTemplatePicker` in the inspector, gated off `knownPaths` so it never duplicates a schema-declared field; reciprocal `/workflow-studio` link + note added to `department-prompt-config-panel.tsx`, which stays authoritative). Decision #11 remains GATED, untouched. Task 18 not attempted — Task 17's own verdict already resolves it to "does not fold this pass". TDD RED→GREEN throughout (3 new test files + additions to `inspector-panel.test.tsx`/`workflow-studio-api.test.ts`); along the way, root-caused and fixed a pre-existing gap in how this app's tests drive a Radix `SelectItem` selection under jsdom (documented in §7). `pnpm --filter @arcaai/admin-console {test,lint,typecheck,build}` all green (201 test files, 1579 tests); e2e execution and the manual a11y pass remain gated on the program-wide infra blocker. | execution agent |
| 2026-08-19 | **Canvas render fix (BUG — nodes invisible on the canvas).** Reported as "cannot add any nodes"; reproduced in a running console against live infra. Nodes WERE being added and autosaved (the list editor showed them, `PATCH` returned 200) — React Flow just never painted them. Root cause in `packages/ui/src/components/workflow-canvas/workflow-canvas.tsx`: the composite forwarded React Flow's `dimensions` node-changes to `onNodesChange`, whose only consumer effect is `moveNode` → a new `nodes` array identity → `adoptUserNodes` re-reads `measured` off the rebuilt user node, finds none (`fromXyNode` kept only `position`), and reverts every node to `visibility: hidden`; `nodesInitialized` therefore never flips and `fitView` never runs. Fix: the composite now OWNS its measurements — `dimensions` changes are absorbed into local state (never forwarded, since measuring is not an authored edit) and re-applied as `measured` on each `toXyNode`. Regression coverage added to `workflow-canvas.vitest.tsx` (RED confirmed against the pre-fix component: the "absorbs React Flow dimension measurements" test fails). The pre-existing suite passed throughout because it renders a module-level constant `NODES` array, whose stable identity hits `adoptUserNodes`'s `checkEquality` short-circuit — the Studio rebuilds its array every render and never did. `pnpm --filter @arcaai/ui {test,lint,typecheck,build}` green (16/16 canvas tests); `apps/admin-console` studio+workbench suites green (17 files, 119 tests). Verified in-browser: palette click now paints the node and `fitView` frames the graph. | execution agent |
| 2026-08-19 | **Session 4 — Phase F closed.** Executed `tests/e2e/workflow-studio.spec.ts` for the first time against the isolated test stack (gateway :8968, console :5276, `RESET_DB=false`, no DB reset/seed): **12/12 green**, including axe 0-violation scans on the definitions list, canvas editor and list editor in BOTH themes. Performed the manual a11y pass in a driven browser (keyboard reach + visible focus rings, both themes, reduced-motion bridge, 200 % reflow). Corrected four spec assertions that contradicted the running system and two skip guards that raced async fetches. Found and fixed two real runtime defects the unit suites could not see: (1) `tsup` never re-imports the extracted `canvas-tokens.css`, so the entire React Flow `--xy-*` theming bridge was absent in every consumer — white control buttons on the dark canvas; now imported from the canonical `packages/ui/src/styles/globals.css`. (2) an inline `onSelectionChange` (plus a per-render `onSelect` from the editor) looped selection into "Maximum update depth exceeded" and tore the canvas subtree down whenever a node was selected; both handlers are now memoized. One a11y finding left OPEN and documented in §7: the editor squeezes to ~59 px tall at 200 % zoom. `typecheck`/`lint`/`test` (206 files, 1620 tests)/`build` all green. | execution agent |
| 2026-08-19 | **Session 5 — the last open a11y finding closed and the editor raised to node-graph-editor baseline.** The 200 % zoom squeeze (palette + canvas at ~59 px) is FIXED without touching `ScreenTemplate`: the screen now runs `contentMode="scroll"` in both view modes and gates its three-panel row on `[@media(min-width:64rem)_and_(min-height:32rem)]`, stacking into one scrolling column below either threshold (canvas measured 59 px → **416 px** at 640×400, still no horizontal scrolling; locked by a new e2e test). Six UX improvements shipped, each justified in §7 Session 5: undo/redo finally reachable (toolbar buttons + Ctrl/Cmd+Z / Shift+Z / Ctrl+Y — the store's undo stack had existed since Task 11 with no way to reach it), a palette filter over the 30 live registry node types, drag-time connection validation via a new `canConnect` predicate shared with the committed `connect`, `duplicateNode` (refuses mandatory singletons, copies no edges, undoable) with a list-editor button and Ctrl/Cmd+D, a canvas empty state via a new optional `emptyState` prop on `WorkflowCanvas`, and node/connection/error counts in the status bar. Alignment tools, multi-select, minimap and cross-document paste were assessed and deliberately skipped (reasons in §7 Session 5 §3 — notably: canvas positions are never persisted, so alignment would align nothing that survives). Evidence: `lint`/`typecheck`/`test` (208 files, 1632 tests)/`build` green for `@arcaai/admin-console` (+ lint/typecheck for `@arcaai/ui`); Playwright 13 passed / 1 skipped of 14 with **axe 0 violations** on all three surfaces in both themes; driven-browser pass in light AND dark proving filter → add → Ctrl+Z, duplicate, focus rings, and clean console/network. Two spec assertions repaired (one strict-mode locator proven pre-existing with `git stash -u`, one unit assertion that predated the new canvas empty state). | execution agent |
| 2026-08-20 | **Session 6 — the two remaining unbuilt code items closed: `WorkflowGraphNode.position` and per-node `configSchema`.** Both are JSON-contract-only changes in `@arcaai/workflow-contract` (`graph Json @db.JsonB` — no Prisma migration). (1) **`position`**: `WorkflowGraphNode` (`graph-model.ts`) gains an optional `position?: { x: number; y: number }` (`WorkflowNodePosition`) sibling of `config`, validated by `workflowGraphProblems` (plain object, finite `x`/`y`) — TDD RED→GREEN, 6 new tests. The Studio's `graph-serialization.ts` now writes it as a first-class field and only READS the legacy `config.__position` nesting as a fallback for graphs saved before this field existed (never writes that shape again); `workflow-runs/lib/graph-layout.ts` (read-only run-trace canvas) updated the same way. This also fixes a real latent defect: `compileNode`/`compileGate` (`compiler.ts`) copy `node.config` verbatim into `CompiledNode.config`, so the old `config.__position` hack was leaking Studio's own canvas-layout bookkeeping into the interpreter's `compiledConfig` on every publish — closed now that `position` lives outside `config`. (2) **`configSchema`**: `WorkflowNodeDescriptor.configSchema?: Readonly<Record<string, unknown>>` added to the registry (`node-registry.ts`), sourced from a new `node-config-schemas.ts` and mirrored on `WorkflowNodeResponse`/the admin console's hand-mirrored type. Populated for 16 of the 30 live node types: `noop`/`core.start`/`core.end` (authored fresh, read directly off the real interpreter activity in `activities.py`, since no committed contract doc exists for them) plus the 5 summarization-palette + 8 STT-palette node types (copied verbatim from the `contracts/nodes/*.schema.json` files TASK-720/724 already committed but never wired — this is resolution path #1 `registry.contract.md` itself named). Deliberately left `undefined` (documented, not silently omitted): `passthrough` (echoes arbitrary config by design — a fixed schema would be a false constraint) and all 13 `consultation.*` node types (their own `node-types.md` names schema files that were never authored; inventing thirteen clinical-workflow config contracts without that validated source was judged out of scope for this pass). Every wired schema is asserted against `@arcaai/json-schema-subset`'s `authorableJsonSchemaProblems` (new `node-config-schemas.test.ts`, devDependency-only — the package's "zero runtime dependencies" claim is unaffected). The editor now passes the SELECTED node's real `configSchema` to `InspectorPanel` instead of a hardcoded `undefined`. `registryChecksum()` changes as an expected consequence (same "registry bump" every prior palette addition already caused). Both `registry.contract.md` and `definition-api.contract.md` updated with dated "RESOLVED" sections (history preserved, nothing rewritten). **Evidence:** `@arcaai/workflow-contract` — `test` 288/288 (up from 260), `typecheck` clean, `lint` 0 errors/0 new warnings, `build` (tsup) succeeds. `@arcaai/applications` — `build` (tsc) succeeds against the rebuilt `workflow-contract` dist; targeted `workflow-definition` suite 51/51. `@arcaai/admin-console` — the exact tests touching this change (`graph-serialization.test.ts`, `graph-layout.test.ts`) all pass; a full-suite run also passed 1636/1636 immediately after the change (before an external, concurrent process on this shared checkout reset the working tree — see the operational note below); a LATER full-suite rerun under heavy multi-agent CPU load (~90 concurrent vitest workers observed) showed 36 unrelated timeouts (e.g. a 5-second render-timeout in `workflow-runs-screen.test.tsx`, a screen this session did not touch) with zero failures in this session's own files, confirmed by an isolated targeted rerun (99/99 tests, 0 failures, in `workflow-studio`+`workflow-runs`). **Human-gated items untouched**: the Figma design gate (Task 1) and DECISION #11 (`/agentic-policy` privilege fold, README §6 R2) were not touched, per instruction. **Operational note**: this session's repo checkout is SHARED with at least one other actively-running agent session (confirmed via `git reflog`: a `reset: moving to HEAD` fired mid-session and wiped this session's then-uncommitted tracked-file edits once; recovered by reapplying them from this session's own record of what it had written, then re-verified). Nothing in this ticket's scope required a destructive git operation, and none was run by this session. | execution agent |
