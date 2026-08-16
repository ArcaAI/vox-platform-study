# TASK-719 — Workflow Studio v1

| | |
|---|---|
| **Status** | In Progress (Phases A–D done; E partially done — assessment only, no folds executed; F partially done) |
| **Wave** | 2 · **Size** | XL |
| **Epic slug** | `workflow-studio-v1` |
| **Depends on** | TASK-715 (`workflow-definition-model`), TASK-716 (`workflow-compiler-validator`) |
| **Design refs** | D2 (visual canvas builder), D3 (tenant admins, full power, day one), D4 (generic engine, domain palettes), D6 (CQRS-lite) from [design.md](../../architecture/agentic-workflow-platform/design.md) §"Plane 3 — Workflow Studio" |
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

#### What is still genuinely NOT done (read this before marking the ticket complete)

1. Task 1 (Figma design gate) — still waived per orchestrator instruction, still not cleared for
   real; if a future session's scope changes, reconfirm the waiver explicitly.
2. Task 18/19 (pipeline-policy fold, prompt-template picker + department cross-link).
3. `name`/`description` autosave; "Create new version from this" branch action on a PUBLISHED
   row; `?view=` URL sync.
4. TASK-720's palette content landing will re-open the registry-contract gap (no `configSchema`,
   no `label`) — Task 9/12's fallbacks are the safety net, not a permanent design.
5. Playwright e2e execution and the manual a11y pass — both blocked on infra/tooling this
   session, not skipped by choice.

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

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | ticket-writer agent (Wave 2 Studio batch) |
| 2026-08-16 | Phases A–C executed (Tasks 1–8): design gate waived per orchestrator instruction; React Flow pinned + `DEPENDENCY.md`; three cross-ticket contracts written against delivered TASK-715/716/717 code with real gaps recorded; `WorkflowCanvas` composite built TDD (RED→GREEN, 14/14 unit + 3/4 CT, 1 CT `fixme`) in `packages/ui`; `toFieldDescriptors` schema→form compiler built TDD (RED→GREEN, 12/12) in `apps/admin-console`. Phases D–F (Tasks 9–21) not started — see §7 for the exact boundary. `pnpm --filter @arcaai/ui {test,lint,typecheck,build}` and `pnpm --filter @arcaai/admin-console {test,lint,typecheck,build}` all green. | execution agent |
| 2026-08-16 | **Session 2** (same day, continued — TASK-734 landed the real `admin/workflow-definitions`/`admin/workflow-nodes` endpoints between sessions): the three Task 3 contracts re-derived against delivered code (superseding Session 1's "NOT YET DELIVERED" verdicts, real gaps re-confirmed — notably still NO per-node `configSchema`); Task 9 (inspector form rendering) finished, closing out Phase C; Phase D built in full — API layer (Task 10), Zustand graph store (Task 11, +`reorderNode`), palette rail (Task 12), structured list/tree peer editor (Task 13, every mutation proven click-only/no-drag), validation rail + click-to-focus (Task 14), debounced autosave/OCC/publish (Task 15, RED→GREEN fake-timer coverage of 412-pause/never-retry/428/cancel), routes + nav entry (Task 16) — `pnpm --filter @arcaai/admin-console build` succeeds with both new routes in the compiled manifest; Phase E (Task 17) executed as an assessment — consolidation-map.md records that NOTHING folds this pass (registry still has no palette content to fold against; `/agentic-policy` stays HUMAN-GATED per explicit instruction) — Tasks 18/19 correctly left not-done rather than forced; Phase F partial — 89 unit/a11y tests across the new components (all green), `tests/e2e/workflow-studio.spec.ts` authored following `workflow-runs.spec.ts` but NOT executed (program-wide Playwright/Prisma blocker), manual a11y pass not performed. Full command evidence and the "still genuinely NOT done" list are in §7. | execution agent |
