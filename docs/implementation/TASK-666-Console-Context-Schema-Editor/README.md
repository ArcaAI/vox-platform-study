# TASK-666 — Admin console: context schema editor

- **Status:** Review
- **Type:** feature
- **Wave:** W4 of [TASK-654](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/README.md), parallel with TASK-664/665/667
- **Depends on:** [TASK-658](../TASK-658-Consultation-Context-Schema/README.md) (data model, validation, discovery — merged), [TASK-661](../TASK-661-Schema-Compatibility-And-Lifecycle/README.md) (version pinning, deprecation — merged)
- **Baseline:** `dev-2.1` @ `5a675d3d5` (docs(TASK-654): harness baseline depends on .env.dev presence)
- **Branch/worktree:** `worktree-agent-af8047c67eed696aa` — spawned from `main`; `git reset --hard dev-2.1` performed per the mandatory Step 0 before any work began

---

## 1. Requirement Analysis

**Objective.** Build the first schema builder in the product: an admin-console screen for
tenant admins to author, publish, and govern a `ConsultationContextSchema` (TASK-658) — the
tenant-invented vocabulary of context kinds a consultation carries, each declaring exactly one
of five platform primitives.

| # | Scope item (from the ticket) |
|---|---|
| S1 | Kind editor — key, label, primitive, PHI class, cardinality, lifecycle, producedBy, a field builder, constraints |
| S2 | Output-kind editor — what the loop may emit back |
| S3 | Version history with pin / track-latest, and department default |
| S4 | Publish validation surfacing the server's actual rejection reasons — not a generic error |
| S5 | Deprecation — mark a kind deprecated with a migration window (TASK-661's `deprecated: {since, migrateBy?, message?}`) |
| S6 | A sample-payload tester against a draft |

### 1.1 Hard constraints honored

- Copied the Agent Catalog screen's scaffolding pattern (create/update form, pin/version
  controls, OCC `If-Match` client helpers) — did not hand-roll a page frame or a detail modal.
- Did not touch `packages/agentic-sdk-v2/**` (TASK-665) or `apps/harness/**` (TASK-664).
- Own route (`/context-schemas`) and own feature folder (`features/context-schemas/**`) —
  never imported from or into `features/agents/**` (TASK-667's concurrent territory). The only
  shared-file edits are a single nav-config.ts entry (own line only) and a generic,
  backward-compatible addition to `shared/api/http.ts`.
- `apps/ui-playground` no longer exists — no references added.

---

## 2. Current State Evaluation

Verified against `dev-2.1` @ `5a675d3d5` (TASK-658 and TASK-661 merged, confirmed by the
presence of `apps/api/src/modules/consultation-context-schema/**` and
`packages/applications/src/services/consultation-context-schema/**`).

| Area | Finding |
|---|---|
| Backend surface | `ConsultationContextSchemaAdminController` (`admin/consultation-context-schemas`) — full CRUD + `POST :id/publish` + `POST :id/pin` + `GET :id/versions`. `PATCH :id` is the only If-Match-gated route; `publish`/`pin` are plain POSTs the server validates itself. |
| Publish rejection shape | `ConsultationContextSchemaService#publish` throws `BadRequestException({ message, problems })` for structural failures and `BadRequestException({ message, breakingChanges })` for a refused breaking change — both carry the reasons as **sibling arrays**, not just in `message`. |
| Client HTTP layer | `GatewayError` (`shared/api/http.ts`) only ever surfaced `message`/`status`/`code` — the `problems`/`breakingChanges` arrays were silently dropped by `toGatewayError`, so "surface the server's actual rejection reasons" was not reachable from any client code as it stood. |
| JSON Schema subset | The authorable-subset + payload validators (`packages/applications/.../json-schema-subset.ts`) are pure functions with **zero framework dependencies**, but live in `@arcaai/applications`, a server-only package `apps/admin-console` does not (and must not) depend on. |
| Exemplar screen | `features/agents/{api,components}/**` — `DetailDrawer` with tabs, `usePinDepartmentAgent`, `getWithEtag`/`patchWithEtag`/`versionFromEtag`, `CreateAgentForm` inside the drawer's create mode, `ConfirmDialog` for delete. Copied wholesale as instructed. |
| Nav / routing | No `/context-schemas` nav entry or route existed; `NAV_ENTRIES` tier `30-49` is where every other tenant-admin-scope screen lives (`ability` grant `manage:ConsultationContextSchema`, seeded on `tenant-full-access` by TASK-658). |

---

## 3. Implementation Plan (as executed)

| # | Layer | Files |
|---|---|---|
| 1 | Shared (generic, additive) | `shared/api/http.ts` — `GatewayError.details: unknown`, populated from the parsed error body |
| 2 | Feature — API | `features/context-schemas/api/{types,client,keys,hooks,index}.ts` |
| 3 | Feature — client-side validators | `features/context-schemas/lib/json-schema-subset.ts` (faithful port of the server's pure functions), `lib/publish-error.ts` |
| 4 | Feature — components | `create-schema-form`, `settings-form`, `kind-form`, `output-form`, `definition-editor`, `versions-panel`, `payload-tester`, `context-schema-detail-drawer`, `context-schemas-list`, `context-schemas-screen` |
| 5 | Route | `app/(console)/(tenant)/context-schemas/page.tsx` |
| 6 | Nav | One line in `shared/navigation/nav-config.ts` `NAV_ENTRIES` (tier `30-49`, `IconSchema`, `required: [['manage', 'ConsultationContextSchema']]`) |
| 7 | Tests | Colocated `__tests__/*.test.ts(x)` at every layer above, plus `nav-config.test.ts` route-count update |

### TDD list (RED first)

| # | Test | Drove |
|---|---|---|
| T1 | `GatewayError` carries the raw parsed body as `.details` | `shared/api/__tests__/http.test.ts` |
| T2 | `authorableJsonSchemaProblems`/`jsonSchemaValueProblems` client mirror behaves identically to the server suite | `lib/__tests__/json-schema-subset.test.ts` (ported 1:1 from the server's own test file) |
| T3 | `publishRejection` extracts `problems`/`breakingChanges` from a 400, returns `null` otherwise | `lib/__tests__/publish-error.test.ts` |
| T4 | Client wrappers hit the right paths/methods, OCC only on `PATCH :id` | `api/__tests__/context-schemas-api.test.ts` |
| T5 | Working-tenant gate, catalog + empty state, primitive allow-list enforcement, publish `problems` surfacing, breaking-change confirm-and-retry, deprecation authoring, payload tester, version pin, axe (both themes) | `components/__tests__/context-schemas-screen.test.tsx` |

---

## 4. Implementation Summary

**Status: Review.** All six scope items implemented and covered by tests; every gate green.

### 4.1 The route and nav entry

- Route: `apps/admin-console/src/app/(console)/(tenant)/context-schemas/page.tsx` → `<ContextSchemasScreen />` (tier 30-49, `WorkingTenantGate` + `ScreenTemplate`, mirroring `AgentsScreen`).
- Nav: one entry added to `shared/navigation/nav-config.ts` `NAV_ENTRIES` (import `IconSchema` added to the existing import block; entry inserted just before `/dna-writing-styles`):
  ```ts
  {
    route: '/context-schemas',
    label: 'Context Schemas',
    tier: '30-49',
    icon: IconSchema,
    required: [['manage', 'ConsultationContextSchema']],
    implemented: true,
  }
  ```
  `nav-config.test.ts`'s route-count assertion updated 48 → 49 (tier `30-49` 15 → 16) — the only other change to that shared test file.

### 4.2 How the primitive allow-list is enforced in the UI

**By construction, not by validation.** Both `KindForm` (`components/kind-form.tsx`) and
`OutputForm` (`components/output-form.tsx`) render `primitive` as a Radix `<Select>` whose
`<SelectItem>`s are generated by mapping over the closed `CONTEXT_PRIMITIVES` constant
(`STREAM_AUDIO | TEXT | DOCUMENT | IMAGE | STRUCTURED`, `api/types.ts`) — there is **no free-text
input** anywhere an author could type a sixth value. `context-schemas-screen.test.tsx`'s
`"enforces the primitive allow-list…"` test opens the select and asserts the rendered option
list equals `CONTEXT_PRIMITIVES` exactly. This mirrors, but does not replace, the server's own
enforcement (TASK-658 AC-3, `contextSchemaDefinitionProblems`) — the UI closes off the mistake
class before the round trip; the server remains the authority.

### 4.3 How server rejection reasons are surfaced

Two problems had to be solved, in order:

1. **The transport was dropping the data.** `GatewayError` (`shared/api/http.ts`) only ever
   captured `message`/`status`/`code` from an error body — `problems`/`breakingChanges` were
   parsed and then discarded. Fixed with a small, generic, additive change: `GatewayError` gained
   a `details: unknown` field carrying the raw parsed body, and `toGatewayError` now passes it
   through. This is deliberately generic (not context-schema-specific) so any future feature
   with a similarly-shaped structured 400 can reuse it; covered by two new cases in the
   pre-existing `shared/api/__tests__/http.test.ts`.
2. **`lib/publish-error.ts#publishRejection(error)`** reads `error.details` and returns
   `{ problems?, breakingChanges? }` only for a 400 that actually carries one of those arrays —
   `null` otherwise, so callers fall back to the generic `error.message` toast for anything else.
   `DefinitionEditor`'s `runPublish` uses it to:
   - render every `problems[]` entry as a bulleted destructive `Alert` **inline**, under the
     Publish button — not a one-line toast (which is what the "not a generic error" requirement
     rules out);
   - render every `breakingChanges[]` entry the same way, with an explicit **"Publish anyway"**
     button that resubmits with `allowBreakingChange: true` — never a silent auto-retry.

   The server itself already writes the breaking-change list into `message` too
   (`consultation-context-schema.service.ts#publish`'s own comment: *"The breaks are named IN
   the message, not only in a sibling field"*) — `publishRejection` prefers the structured array
   when present so the UI can render a real list instead of parsing prose, but the design was
   explicitly defense-in-depth on both sides already.

### 4.4 The sample-payload tester (S6) — a deliberate scope decision

No backend endpoint validates an arbitrary payload without writing a real `ContextItem` (the
closest thing, `ConsultationContextSchemaService#validateContextPayload`, is not exposed over
HTTP and TASK-666 may not add API surface — it depends only on 658/661). Two honest options:
add a new backend endpoint (out of this ticket's scope and layer), or give the tester a
client-side evaluator. Chose the latter: `lib/json-schema-subset.ts` is a **faithful line-by-line
port** of the server's `authorableJsonSchemaProblems`/`jsonSchemaValueProblems`
(`packages/applications/.../json-schema-subset.ts`) — `apps/admin-console` cannot import that
package (it is server-only NestJS code with framework dependencies), so porting the pure
functions was the only way to get real, correct local validation rather than a stub. The module
docstring and the Tester tab's own footer both say explicitly: this is a **local preview**; the
server re-validates every payload at actual write time, and the port is kept in lockstep with
the server module by having literally copied its test suite (`lib/__tests__/json-schema-subset.test.ts`
mirrors `packages/applications/.../__tests__/json-schema-subset.test.ts` almost line-for-line).

### 4.5 Version history / pin / department default (S3)

- `VersionsPanel` lists `GET :id/versions` newest-first, badges the currently pinned row, and
  offers **Pin** on every other row via `POST :id/pin`. There is no "track latest" pin-to-null
  variant here (unlike `DepartmentAgent`'s pin): `publish` always advances the pin itself
  (TASK-658 D-3), so `pin` exists only to roll back to an already-published version — confirmed
  against `PinConsultationContextSchemaVersionRequest` (`versionNumber` is required, no `null`
  branch).
- Department default: `CreateSchemaForm` offers `scope: TENANT | DEPARTMENT` with a department
  picker (reusing `admin/departments`, independently fetched — features never import each
  other); `SettingsForm`'s "Department default" switch maps to `isDefault` in the metadata PATCH.

### 4.6 Deprecation authoring (S5)

`KindForm`'s `DeprecationFields` toggles a `deprecated` block on/off (`Switch`), defaulting
`since` to today's date when turned on, with optional `migrateBy` and a 500-char `message` —
directly matching TASK-661's `KindDeprecation` shape (`since`/`migrateBy`/`message`, `YYYY-MM-DD`
dates). No client-side enforcement of the window (matching TASK-661 D-2: deprecation is
representable and visible, never a server-enforced hard cutoff at this layer).

### 4.7 Decisions worth reviewing

| # | Decision | Reasoning |
|---|---|---|
| D-1 | `fields` (the JSON Schema subset for a STRUCTURED kind) is authored in the shared `CodeEditor` (`@arcaai/ui`), not a property-by-property visual builder | This is the house pattern for editing any JSON/array value (`11-ux-ui-principles.md` anti-pattern table: "JSON/array value edited in a bare Textarea → CodeEditor"), and the server's own `fields` document is already JSON Schema — a bespoke builder would be a second, lossier authoring surface for the same document. The rest of a kind's metadata (key/label/primitive/phiClass/…) uses structured controls; only the nested schema itself is JSON-authored. |
| D-2 | The Definition draft is lifted to `ContextSchemaDetailDrawer`, not owned by `DefinitionEditor` | The Tester tab must validate against the exact in-progress kinds/outputs the admin is editing (not the last published version) — S6 says "against a draft". Lifting the state is what makes that true rather than aspirational. |
| D-3 | The draft reseeds via a render-time conditional `setState` keyed on `(schemaId, versionsQuery.isSuccess)`, not a `useEffect` | `react-hooks/set-state-in-effect` (the newer eslint-plugin-react-hooks rule) flags synchronous `setState` inside an effect body. React's own "adjusting state when a prop changes" pattern — comparing a derived key against a `seededFor` state variable and calling `setState` directly in the render body when it differs — reseeds exactly once per schema switch / initial load, never on an unrelated background refetch (e.g. after Settings-tab `Save changes`), with no effect and no lint suppression. |
| D-4 | `PayloadTester`'s picked kind self-heals via `structuredKinds.some(...) ? picked : structuredKinds[0]?.key` computed at render time, rather than a `useState` initializer | Radix `Tabs.Content` keeps every panel mounted (just `hidden`), so `PayloadTester` mounts immediately when the drawer opens — before the draft is seeded from the versions query. A `useState(structuredKinds[0]?.key ?? '')` initializer would capture the pre-load EMPTY list forever (React never re-runs a `useState` initializer). Computing the effective key from current props on every render fixes this and is simpler than a sync effect. Caught by `context-schemas-screen.test.tsx`'s Tester-tab test, which failed before this fix. |
| D-5 | The two axe scans (light/dark) scan the list `container` before opening the drawer, then re-scan the portaled `dialog` element after opening it and expanding a kind | `axe(container)` alone flags `aria-hidden-focus` once the Sheet opens: Radix marks the rest of the page `aria-hidden` for the open dialog (correct real-browser behavior — the background becomes inert), but jsdom/happy-dom doesn't apply `inert` semantics, so axe sees a still-focusable button inside an `aria-hidden` region. The house fix, already established in `discovery-drawer.test.tsx`, is to scan the dialog itself once one is open — that is real markup under this ticket's control; the background inertness is a jsdom limitation, not a defect. |
| D-6 | `updateContextSchema`/PATCH is the only If-Match-gated client call; `publish`/`pin` send no `If-Match` header | Matches the controller exactly — `publish` and `pin` carry no `@RequiresIfMatch()` decorator (verified by reading `consultation-context-schema.controller.ts` before writing the client). Getting this wrong either way would either 428 every publish or silently skip a real OCC contract. |

### 4.8 Files changed

**Shared (generic, additive)**
| File | Change |
|---|---|
| `apps/admin-console/src/shared/api/http.ts` | `GatewayError.details: unknown`, populated by `toGatewayError` |
| `apps/admin-console/src/shared/api/__tests__/http.test.ts` | +2 tests for `.details` |
| `apps/admin-console/src/shared/navigation/nav-config.ts` | `IconSchema` import + one `NAV_ENTRIES` line for `/context-schemas` |
| `apps/admin-console/src/shared/navigation/__tests__/nav-config.test.ts` | Route-count assertion 48→49, tier `30-49` 15→16 |

**New feature — `apps/admin-console/src/features/context-schemas/`**
- `api/{types,client,keys,hooks,index}.ts` + `api/__tests__/context-schemas-api.test.ts`
- `lib/json-schema-subset.ts` + `lib/publish-error.ts` + `lib/__tests__/{json-schema-subset,publish-error}.test.ts`
- `components/{create-schema-form,settings-form,kind-form,output-form,definition-editor,versions-panel,payload-tester,context-schema-detail-drawer,context-schemas-list,context-schemas-screen}.tsx`
- `components/__tests__/context-schemas-screen.test.tsx`

**New route**
- `apps/admin-console/src/app/(console)/(tenant)/context-schemas/page.tsx`

---

## 5. Verification Evidence

All commands run from the worktree at `dev-2.1` @ `5a675d3d5`. A fresh worktree needed
`pnpm install`, then `@arcaai/ui` + `@arcaai/room`/`noise-filter`/`vad`/`stt`/`med-ner`/`pipeline`/`vox`
built before `tsc --noEmit`/`vitest run` were meaningful (TASK-658 README's documented caveat,
confirmed again here — the first typecheck attempt failed only on unrelated `@arcaai/vox`/`@arcaai/stt`
module-resolution errors from packages/agentic-sdk-v2 and packages/stt not yet being built).

### `pnpm --filter @arcaai/admin-console build`

```
✓ Compiled successfully in 14.3s
  Running TypeScript ...
  Finished TypeScript in 12.7s ...
  Collecting page data using 15 workers ...
✓ Generating static pages using 15 workers (75/75) in 2.4s
  Finalizing page optimization ...

Route (app)
...
├ ƒ /context-schemas
...
```
Exit 0. The 5 pre-existing Turbopack warnings (`instrumentation.ts` Node APIs not supported in
Edge Runtime) predate this ticket and are unrelated to `context-schemas`.

### `pnpm --filter @arcaai/admin-console lint`

```
> eslint src --max-warnings 0
```
Exit 0, zero output — no errors, no warnings (two real lint failures were caught and fixed
during implementation: an unused `chooseSelectOption` test helper, an unused `toast` import, and
a `react-hooks/set-state-in-effect` violation — see D-3 above).

### `pnpm --filter @arcaai/admin-console test`

```
 Test Files  176 passed (176)
      Tests  1382 passed (1382)
   Duration  57.10s
```

**Baseline comparison** (same worktree, `dev-2.1` before this ticket): **172 files / 1,339
tests** → **176 / 1,382** (+4 files, +43 tests, all new; every pre-existing test still passes
unmodified except the one `nav-config.test.ts` route-count update in §4.8).

### Axe result

`context-schemas-screen.test.tsx` — `"has no axe violations in the light theme…"` and
`"…in the dark theme…"`, each scanning the catalog list AND the opened drawer (with a kind
expanded, so `KindForm`'s full field set — selects, checkboxes, switch, `CodeEditor` textarea —
is included in the scan): **0 violations in both themes**, both passing in the run above.

### Both-theme verification

Both axe tests toggle `document.documentElement.classList.add('dark')` (removed in `afterEach`)
before rendering, matching the house pattern in `changelog-screen.test.tsx`. Semantic tokens only
were used throughout (`bg-primary`, `text-muted-foreground`, `text-destructive`, `text-success`,
`bg-destructive/10`, …) — no hardcoded colors, so no additional dark-mode-specific styling was
needed.

### AC → test map

| Scope item | Test | File |
|---|---|---|
| S1 (kind editor, primitive allow-list) | `"enforces the primitive allow-list…"` | `context-schemas-screen.test.tsx` |
| S2 (output-kind editor) | `OutputForm` exercised via the definition-editor path; primitive select shares the same closed-set assertion pattern (not separately re-asserted — same component, same enforcement) | `kind-form`/`output-form` (components, no dedicated unit test beyond the integration coverage above) |
| S3 (version history, pin, department default) | `"pins the schema to an older version…"`, `CreateSchemaForm` scope/department fields | `context-schemas-screen.test.tsx` |
| S4 (publish validation surfacing rejection reasons) | `"surfaces the server-reported structural problems…"`, `"refuses a breaking publish…"` | `context-schemas-screen.test.tsx` |
| S5 (deprecation) | `"authors a deprecation window on a kind…"` | `context-schemas-screen.test.tsx` |
| S6 (sample-payload tester) | `"validates a sample payload against the STRUCTURED kind…"` | `context-schemas-screen.test.tsx` |
| — | Client JSON Schema subset mirror correctness | `lib/__tests__/json-schema-subset.test.ts` (18 tests, ported from the server suite) |
| — | `GatewayError.details` plumbing | `shared/api/__tests__/http.test.ts` (+2) |
| — | `publishRejection` helper | `lib/__tests__/publish-error.test.ts` (5 tests) |
| — | API client paths/methods/OCC | `api/__tests__/context-schemas-api.test.ts` |
| — | axe, both themes | `context-schemas-screen.test.tsx` |

---

## 6. Incomplete / explicitly out of scope

- **No dedicated unit test file for `OutputForm`/`KindForm` in isolation** — both are exercised
  through the screen-level integration tests (which is where the primitive-allow-list assertion
  and the deprecation-authoring assertion actually live); a future pass could add narrower
  component tests if the form logic grows more branches.
- **No server-side "test payload" endpoint** — the sample-payload tester is a client-side
  preview only (§4.4). If a future ticket wants server-authoritative testing without writing a
  real `ContextItem`, that is new backend surface outside TASK-666's dependency scope (658/661
  only).
- **No hard enforcement of a deprecation window's end in the UI** — matches TASK-661 D-2
  (deprecation is representable and visible, not enforced); a countdown/warning UX is a
  reasonable follow-up but wasn't in this ticket's TDD list.

---

## Change History

- 2026-08-12 — Ticket opened. Worktree reset from `main` to `dev-2.1` @ `5a675d3d5` per the
  mandatory Step 0. Read TASK-658/661 code and READMEs in full, studied the Agent Catalog
  exemplar (`agent-detail-drawer.tsx`, `agents-screen.tsx`, `client.ts`), mapped every shared
  component to reuse (`ScreenTemplate`, `DetailDrawer`, `WorkingTenantGate`, `CodeEditor`,
  `OccConflictAlert`, `ConfirmDialog`, `EmptyState`/`ErrorState`).
- 2026-08-12 — Implemented in stages: (1) generic `GatewayError.details` addition + test,
  (2) client-side JSON Schema subset port + tests, (3) API layer (types/client/keys/hooks) +
  tests, (4) all components (create/settings/kind/output/definition/versions/tester/drawer/list/
  screen), (5) route + nav entry, (6) screen-level integration test suite incl. axe. Fixed two
  real bugs found by the tests themselves: `PayloadTester`'s `kindKey` never resyncing after the
  draft loaded (D-4), and a `react-hooks/set-state-in-effect` lint violation in the drawer's
  draft-seeding logic (D-3). All gates green; status **Review**. Not merged, not pushed.
