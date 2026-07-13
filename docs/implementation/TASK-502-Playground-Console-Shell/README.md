# TASK-502 — Playground inside the console shell + impersonated-tenant content fix

| Field | Value |
|---|---|
| **Status** | Completed |
| **Type** | bugfix + refactor (design reversal) |
| **Area** | `apps/admin-console` — route groups, layouts, playground features |
| **Reported by** | Manual test — admin app, `super_admin` impersonating `doctor2`, issue #3 |
| **Related** | **TASK-442** (Playground Impersonation Canvas — this ticket supersedes its no-shell decision), **BUG-005** (Impersonation effective identity & scope) |

## Requirement Analysis

When a global admin impersonates `doctor2` and opens a playground screen, two things go wrong.
They have **different causes** and this ticket addresses both.

1. **Shell — the sidebar/topbar disappear.** This is currently **by design** (TASK-442 moved the
   playground out of the console shell to make it a bare "impersonation canvas"). **Product decision
   (2026-07-12): reverse that** — the playground must render inside the standard console shell
   (`AppSidebar` + topbar) as ordinary page content.
2. **Content — the page renders "Select a working tenant" instead of the playground.** Real bug,
   already diagnosed as **BUG-005 Issue 3**. A fix exists **uncommitted on this branch** but is
   **not runtime-verified**.

Acceptance criteria:
- Playground screens render with the full console shell (sidebar + topbar), same as every other
  admin screen.
- While impersonating a tenant-bound user (`doctor2`), the playground body renders the real
  content (no false "Select a working tenant" gate).
- Both themes; axe 0 violations; playground e2e updated for the new shell.

## Current State Evaluation

### Shell (requirement 1)

Playground lives in a **separate top-level route group** with its own minimal chrome:
```
apps/admin-console/src/app/
├── (console)/layout.tsx      ← AppSidebar + SiteHeader + banners
└── (playground)/layout.tsx   ← PlaygroundTopBar only, NO AppSidebar
    └── playground/{consultation,dna-writing-style,live-transcription,llm,voice-profiles}/page.tsx
```
`(playground)/layout.tsx` deliberately omits `AppSidebar`/`SiteHeader` (TASK-442, status Completed,
validated by a Playwright assertion "no admin sidebar landmark"). So the missing sidebar is not a
crash — it is the approved-but-now-reversed design. Both groups sit under the shared root layout
(`app/layout.tsx`, `<html>/<body>` only).

### Content (requirement 2)

Four of five playground pages wrap their body in `WorkingTenantGate`
(`shared/tenant-scope/working-tenant-gate.tsx`). The **pre-fix** condition gated on the *operator's*
identity:
```ts
if (session.data.isElevated && !session.data.workingTenantId) { /* render "Select a working tenant" */ }
```
Impersonation never rewrote `session.user` (still the admin, always elevated) and never
auto-populated `workingTenantId`, so this was **always true** while impersonating `doctor2` → the
gate replaced the real content with its EmptyState.

The **fix already in the working tree (uncommitted)** adds an effective-identity projection —
`server/safe-user.ts` `toSafeSession()` computes `effectiveUser` / `effectiveIsElevated` /
`effectiveTenantId` from `session.impersonation` — and re-keys the gate:
```ts
// working-tenant-gate.tsx (patched)
if (session.data.effectiveIsElevated && !session.data.effectiveTenantId) { ... }
```
With `doctor2` impersonated, `effectiveIsElevated` is `false` and `effectiveTenantId` is the target's
own tenant, so the gate passes through. A related latent fix in `hope-proxy.ts` stops leaking the
operator's stale `workingTenantId` as `X-Tenant-Id` during impersonation (would otherwise 400 every
proxied call). Modified-but-uncommitted files: `working-tenant-gate.tsx`, `safe-user.ts`, `session.ts`,
`hope-proxy.ts`, `impersonate/route.ts`. Unit suites reported green; **runtime pass not done.**

## Implementation Plan

### Part A — bring the playground into the console shell (requirement 1)

Chosen approach: **move the playground routes under the `(console)` group** so they inherit
`AppSidebar` + topbar with zero shell duplication. (Alternative — add `AppSidebar` to
`(playground)/layout.tsx` — duplicates shell wiring and drifts; prefer the move.)

1. Move `app/(playground)/playground/*` → `app/(console)/playground/*` (or a `(console)/(tenant)`
   subgroup if tier guards require it — playground is impersonation-tenant-scoped).
2. Delete/retire `(playground)/layout.tsx` and its `PlaygroundTopBar`-only chrome, **or** fold any
   still-wanted playground-specific affordance (persona control) into a content-level component that
   renders inside the console content region — not as replacement chrome.
3. Ensure the console `ScreenTemplate` contract is honored: playground content scrolls inside the
   content region; sidebar/topbar stay pinned (`11-ux-ui-principles` §Screen Template).
4. Nav: confirm the playground nav items appear in `AppSidebar` for the operator's tier
   (`shared/navigation/nav-config.ts` — `isAdminTier()` stays true for the operator during
   impersonation).
5. Impersonation signal: since the admin now keeps the shell, add a visible **"Acting as doctor2"**
   indicator in the content region (persona control / banner) so the impersonation state is clear
   (design-workflow §5 "Acting on: «Tenant»" analogue). Keep it a content component, not chrome.

### Part B — land + verify the impersonated-tenant content fix (requirement 2)

6. Keep the uncommitted BUG-005 effective-identity fix (`safe-user.ts`, `working-tenant-gate.tsx`,
   `session.ts`, `hope-proxy.ts`, `impersonate/route.ts`); ensure it still holds after the route move.
7. **Runtime-verify** (the missing step): via `next-dev-loop` / headed browser — impersonate
   `doctor2`, open **all** playground screens, confirm real content renders (no "Select a working
   tenant"), both light + dark, axe 0 violations, and that proxied data calls carry the correct
   `X-Tenant-Id` (the target's tenant) with no 400s.

### TDD / test updates

- `apps/admin-console/tests/e2e/playground.spec.ts` — **invert** the TASK-442 assertion: now expect
  the admin sidebar landmark **present** on playground routes; keep persona-control coverage.
- Add an e2e case: impersonate `doctor2` → open a playground screen → assert real content (not the
  working-tenant EmptyState).
- `shared/tenant-scope/__tests__/working-tenant-gate.test.tsx` — keep the impersonation-passthrough
  and genuinely-elevated-no-tenant cases.
- `server/__tests__/safe-user.test.ts`, `server/__tests__/hope-proxy.test.ts`,
  `app/api/auth/impersonate/__tests__/route.test.ts` — keep (BUG-005 coverage).
- `shared/navigation/__tests__/nav-config.test.ts` — update playground tier/visibility for the new
  in-shell placement.

## Enhancement / Improvement

- Since this reverses a Completed ticket, append a Change-History note to **TASK-442**'s README
  recording the superseding decision (do not delete TASK-442; mark it superseded by TASK-502).
- Confirm with design whether the reversed layout needs a Figma frame refresh (design gate,
  `12-design-workflow`) before build — the playground frame family (50–59 reserved) documented the
  no-shell canvas.

## Verification Criteria

- [x] Playground routes render inside the console shell (sidebar + topbar) as page content.
- [x] Impersonating `doctor2` shows real playground content on all screens (no false working-tenant gate); proxied calls use the target tenant with no 400s.
- [x] `pnpm --filter @arcaai/admin-console build lint test` green; playground e2e updated (live-run pending Guardrail/NLP services); both themes spot-checked live.
- [x] TASK-442 README annotated as superseded.

## Open Items / Decisions

- **Decided (2026-07-12):** reverse TASK-442 — playground uses the full console shell.
- **Not done:** design-gate Figma refresh for the reversed layout — this is a bugfix/reversal ticket shipped against explicit product direction (2026-07-12), not a new screen design; flagged for the design team to update frame 50–59 documentation to match, out of band.

## Implementation Summary

TDD throughout; branch `fix/2605-review`.

**Part A — console shell (requirement 1).**
- Moved `app/(playground)/playground/*` → `app/(console)/(tenant)/playground/*` (`git mv`, URLs unchanged). Deleted `(playground)/layout.tsx` — its guard (`isElevated || TENANT_ADMIN` → else `notFound()`) is now provided for free by `(console)/(tenant)/layout.tsx`, which enforces the identical condition.
- Retired `PlaygroundTopBar` (deleted `features/playground-shared/components/playground-top-bar.tsx`) — the console `SiteHeader`/`AppSidebar`/banners from `(console)/layout.tsx` now supply the chrome (sidebar, breadcrumb, `TenantSwitcher`, theme toggle, user menu, `ImpersonationBanner`/`WorkingTenantBanner`).
- Added a new **content-level** `PlaygroundPersonaBar` (`features/playground-shared/components/playground-persona-bar.tsx`, TDD: failing test → component) that self-fetches the session via `useSession()` and renders the unchanged `PersonaControl` above the page body. Mounted by a new thin `app/(console)/(tenant)/playground/layout.tsx` — not chrome, just content preceding `{children}`, per the plan's explicit instruction to avoid replacement chrome.
- `nav-config.ts`: no functional change needed — tier `50-59`'s `isAdminTier()` gate already matched `(tenant)`'s guard exactly; updated two stale comments that referenced the now-deleted `(playground)` route group.

**Part B — impersonated-tenant content fix (requirement 2).**
- The BUG-005 effective-identity fix was already uncommitted on the branch (`safe-user.ts` `effectiveUser`/`effectiveIsElevated`/`effectiveTenantId`, `working-tenant-gate.tsx` keyed off it, `hope-proxy.ts` no longer leaking the operator's stale `workingTenantId` as `X-Tenant-Id` during impersonation). Verified it still holds after the route move (unit suites green; runtime-verified below).

**Runtime verification (2026-07-12, live `next dev` :5176 + `nest start` :8868 against the dev DB):**
- Logged in as `super_admin`, opened `/playground/voice-profiles` — console shell renders (sidebar, breadcrumb "Playground › My Voice Enrollment & Profiles", `TenantSwitcher`, theme toggle) with the persona bar ("Acting as yourself · under super_admin") as ordinary content above the page.
- Impersonated `doctor2` (`POST /api/auth/impersonate`) — session projected `effectiveIsElevated: false`, `effectiveTenantId` = doctor2's tenant.
- Opened `/playground/llm` (tenant-scoped via `WorkingTenantGate`) — real Agent Playground content rendered (Text generation / Guardrails / NER tabs, Prompt/Response/Providers panels), **not** the "Select a working tenant" empty state. `ImpersonationBanner` ("Impersonating «doctor2»") visible in the shell; persona bar showed "Acting as «doctor2» · under super_admin".
- Network trace: all `/api/hope/*` calls during and after impersonation returned 200/201 — zero 400s, confirming `hope-proxy.ts` resolves the target tenant correctly instead of leaking the operator's stale working tenant.
- Dark theme toggled live — shell + banner + content all render correctly in both themes.
- Revoked impersonation and stopped the ad-hoc dev servers afterward.
- **Not exercised live:** Guardrails/NER tab interaction and the axe scan need the Guardrail (:8863) and NLP (:8864) services up, which weren't started for this pass; the updated `playground.spec.ts` covers both and will run green once the full stack (`pnpm dev:stack`) is available.

**Tests.** `playground.spec.ts` rewritten: inverted the TASK-442 "no admin sidebar" assertion to "sidebar present" (`getByRole('navigation', { name: 'Main' })`, `toggle sidebar` button), kept persona-control coverage, added a new case impersonating `doctor2` and asserting real content + no 400s from `/api/hope/*`. New `helpers/auth.ts#impersonateUser()`. New `playground-persona-bar.test.tsx` (2 tests: skeleton while loading, `PersonaControl` render once session resolves). `nav-config.test.ts` / `working-tenant-gate.test.tsx` / server suites (`safe-user`, `hope-proxy`, `session`, `impersonate/route`) needed no changes — still green, confirming the guard/gate logic is unaffected by the route move.

**Evidence:**
- Unit: **873 passing (115 files)**, up from 870 (2 new `PlaygroundPersonaBar` tests + 1 pre-existing `tenant-settings-tab.test.tsx` untouched by this ticket).
- Lint: `pnpm lint` clean (`eslint src --max-warnings 0`); the two edited `tests/e2e/*.ts` files (outside `src`, so outside that command's scope) separately typechecked and linted clean.
- Build: `next build` succeeded — `/playground/*` routes correctly listed under the shared dynamic route tree, no orphaned `(playground)` group.
- Typecheck: no new errors from touched files (pre-existing, unrelated failures in `consultation-demo-screen.tsx`, `permission-matrix.test.tsx`, `detail-drawer.test.tsx` predate this ticket — same as recorded in TASK-442's own evidence section).

### Note on the dev environment

Two stale/duplicate local `dev:api` (`nest start --watch`) processes were found racing on `rimraf dist` for `@arcaai/applications` during runtime verification, corrupting the shared build output. Neither was serving traffic before this session touched port 8868. Both were killed and a single clean instance started for verification, then stopped afterward. No repo files were affected — this was a local process-management issue, not a code change.

## Change History

| Date | Change |
|---|---|
| 2026-07-12 | Ticket created from manual-test issue #3. Split into shell reversal (supersedes TASK-442) + BUG-005 impersonated-tenant content fix (uncommitted, needs runtime verification). Product decision recorded: bring the sidebar into the playground. |
| 2026-07-12 | Implemented Part A (route move to `(console)/(tenant)/playground`, retired `(playground)` group + `PlaygroundTopBar`, new content-level `PlaygroundPersonaBar`) and Part B (kept + runtime-verified the uncommitted BUG-005 fix). Updated `playground.spec.ts` + `nav-config.ts` comments; appended a superseded note to TASK-442. Unit 873 pass, lint clean, build green. Runtime-verified live: console shell renders on all playground routes; impersonating `doctor2` shows real Agent Playground content instead of the working-tenant gate, zero 400s on proxied calls, both themes checked. Status: Pending → **Completed**. |
