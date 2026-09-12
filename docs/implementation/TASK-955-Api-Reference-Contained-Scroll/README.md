# TASK-955 — API reference: scroll the reference container, not the page

| Field | Value |
|---|---|
| **Status** | Completed |
| **Type** | bugfix |
| **Surface** | `apps/admin-console` — `/developer/reference` (the Developer portal's Scalar API reference, TASK-783) |
| **Reported** | 2026-09-12, owner: "it should scroll the explorer container only instead of scroll the whole page" (preceded by "I don't see the API Explorer for any tenant") |
| **Branch** | `dev-2.2` |

## 1. Requirement Analysis

On `/developer/reference` the whole page scrolls: the "API reference" page header,
the Business / Administration plane tabs and the status footer all scroll away with
the Scalar document, and Scalar's sticky endpoint sidebar (the "explorer") is sized to
the VIEWPORT rather than to the panel it sits in, so its lower part is clipped by the
shell. The expected behaviour is the console's standard `fill` panel contract
(rule 11 §Screen Template): pinned header / tabs / footer, and ONE scroll container —
the reference itself — owning the remaining height, with the sidebar sticking inside it.

Out of scope: the visibility question raised first. Verified in this ticket (§2.3) —
the portal is reachable for every tenant; nothing to change there.

## 2. Current State Evaluation

### 2.1 Measured on the running console (2026-09-12, `pnpm --filter @arcaai/admin-console dev`, 1280×1204)

| Element | height | scrollHeight | overflow-y |
|---|---|---|---|
| shell content region (`(console)/layout.tsx`, `overflow-y-auto p-4 md:p-6`) | 1107 | **34 993** | auto ← the page-level scroll the owner sees |
| `ScreenTemplate` fill wrapper → `TabsContent` → `[data-slot="api-reference"]` (`h-full`) | 892 | 34 850 | visible ← spills |
| `.scalar-app.references-layout` (grid) | 34 850 | 34 850 | visible, `min-height: 100dvh` |
| Scalar `aside` sidebar | 1204 (= 100dvh) | — | `position: sticky; top: 0; height: var(--refs-sidebar-height)` |

Scalar's stylesheet (`@scalar/api-reference-react@0.9.67/dist/style.css`) assumes the
DOCUMENT scrolls: `.references-layout { min-height: 100dvh; --full-height: 100dvh }` and
`--refs-sidebar-height: calc(var(--full-height) - var(--refs-header-height))`. The
comment promising a resize observer that sets `--full-height` in the style attribute is
not borne out at runtime (no inline style is set), so `100dvh` is what applies.

The console's document never scrolls (`SidebarInset` is `h-svh overflow-hidden`); the
nearest scrollable ancestor of the spilled layout is the shell's content region, which
is why the page frame scrolls as a whole.

### 2.2 Why a utility class alone does not fix it

Scalar's declarations are UN-layered; the console's Tailwind v4 utilities live in
`@layer utilities`. Un-layered normal declarations beat layered ones regardless of
specificity, so an override of `min-height` / `--full-height` must be `!important`
(Tailwind's `!` suffix) — the same lever Scalar's own `@media print` block uses
(`--full-height: 100% !important`).

`--full-height: 100%` is not usable: the sidebar's `height` would resolve the percentage
against its grid area (the full 34 850 px column), not the panel. A container-query
height unit (`100cqh`) resolves against the nearest size container — the wrapper, once it
is `container-type: size` (`@container-size`, Tailwind v4.3).

### 2.3 Visibility of the portal ("I don't see the API Explorer for any tenant") — verified, not a defect

- Nav placement: since TASK-788 (2026-08-22) the **Developer** entry lives in the topbar
  **account menu** (`USER_MENU_ENTRIES`), not the rail. The reference is
  `/developer/reference`.
- Gate: `read:ApiDocumentation` (`api-documentation-read`, seeded on `TENANT_ADMIN` and
  `DOCTOR`; super admins hold `manage:all`). Confirmed on the local dev DB AND on the
  `hope-v2-dev` cluster DB (`hope-postgres-0`): both roles carry the policy, ENABLED.
- Gateway: `POST users/me/permission-checks` returns `read:ApiDocumentation` for
  `tenant_admin`, `manage:all` for `super_admin` with and without an `X-Tenant-Id`.
- Browser: Developer → API reference renders for `tenant_admin` (Global), `super_admin`
  (no working tenant) and `super_admin` acting on ArcaAI (both planes).

## 3. Implementation Plan

1. RED — `features/developer-docs/components/__tests__/api-reference.test.tsx`: the
   wrapper is the scroll container (`overflow-y-auto h-full min-h-0`), is a size container
   (`@container-size`), and re-points Scalar's `min-height` and `--full-height` at itself;
   plus the skeleton-until-theme behaviour and the D-3 read-only configuration.
2. GREEN — `features/developer-docs/components/api-reference.tsx`: wrapper classes
   `@container-size h-full min-h-0 overflow-y-auto [&_.scalar-app.references-layout]:min-h-full! [&_.scalar-app.references-layout]:[--full-height:100cqh]!`.
3. Verify in the running console (both planes, both themes): the shell content region no
   longer scrolls (`scrollHeight == clientHeight`), the wrapper does, the sidebar height
   equals the wrapper height, header / tabs / footer stay pinned while the reference scrolls.
4. Gates: `pnpm --filter @arcaai/admin-console test` (the new file + the developer-docs
   suite), `lint`, `typecheck`.

## 4. Implementation Summary

### Files changed

| File | Change |
|---|---|
| `apps/admin-console/src/features/developer-docs/components/api-reference.tsx` | The Scalar wrapper (`[data-slot="api-reference"]`) becomes the panel's one scroll container and a size query container, and re-points Scalar's viewport assumptions at itself: `@container-size h-full min-h-0 overflow-y-auto [&_.scalar-app.references-layout]:min-h-full! [&_.scalar-app.references-layout]:[--full-height:100cqh]!`. Doc comment records why (`!important` vs un-layered Scalar CSS; `100cqh` vs `100%`). |
| `apps/admin-console/src/features/developer-docs/components/__tests__/api-reference.test.tsx` | **New.** Pins the scroll-container contract, the skeleton-until-theme behaviour, and the D-3 read-only Scalar configuration (client off, developer tools / agent / MCP off). RED before the fix on the scroll assertion, GREEN after. |

No gateway, schema, env or dependency change. `globals.css` untouched (rule 13 keeps it at three lines) — the override is a scoped utility on the wrapper, not global CSS.

### Evidence (2026-09-12)

Gates, `apps/admin-console`:

```
vitest run src/features/developer-docs   → Test Files 2 passed (2) · Tests 13 passed (13)
vitest run (full suite)                  → Test Files 321 passed (321) · Tests 2926 passed (2926)
eslint src --max-warnings 0              → clean
tsc --noEmit                             → clean
pnpm --filter @arcaai/admin-console build → exit 0 (Next 16.3.4, Turbopack)
```

Runtime, `next dev` on :5176 against the local gateway on :8868 (measured via DOM, then by a real wheel scroll over the reference):

| Session | shell content region scrolls? | wrapper `overflow-y` / scrolls? | Scalar `--full-height` | sidebar height = wrapper height |
|---|---|---|---|---|
| `super_admin`, no working tenant, Business plane | no (1107 / 1107) | auto / yes (892 / 34 850) | `100cqh` | 892 = 892 |
| `super_admin` acting on ArcaAI, Administration plane | no | auto / yes (892 / 88 579) | `100cqh` | 892 = 892 |
| `super_admin`, light theme (after reload) | no | auto / yes | `100cqh` | 892 = 892 |
| `tenant_admin` (Global; no plane tabs, wrapper directly in the `fill` column) | no | auto / yes (985 / 34 850) | `100cqh` | 985 = 985 |

After a 10-tick wheel scroll over the reference: wrapper `scrollTop` 3500, shell region `scrollTop` 0, the "API reference" `h1` still at y = 121, the sticky sidebar pinned at the wrapper's top edge, the status footer visible. Before the fix the same page measured the shell region at 34 993 px of scroll height and the sidebar at 1204 px (= 100dvh).

### Observations outside this ticket's scope (not changed)

- Toggling the console theme while the reference is open leaves Scalar in the previous palette until the page is reloaded — Scalar's React wrapper does not react to `darkMode` / `forceDarkModeState` changing after mount. Pre-existing; reload renders the right palette.
- `api-reference-screen.tsx` says both plane panels stay mounted, but Radix `TabsContent` unmounts the inactive panel (one `[data-slot="api-reference"]` in the DOM at a time; switching back re-fetches the spec). Pre-existing; `forceMount` would make the comment true.
- A React hydration error is logged on every console page in dev (login page included); unrelated to this feature.

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-12 | Ticket opened; root cause measured in the running console (§2.1); plan §3. |
| 2026-09-12 | Fix landed (wrapper = scroll container + `100cqh` override), test added, all gates green, runtime verified for three sessions and both themes (§4). Status → Completed. Not committed — awaiting the owner's go. |
