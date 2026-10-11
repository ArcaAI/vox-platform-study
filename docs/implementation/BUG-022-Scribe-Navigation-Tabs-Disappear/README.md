# BUG-022 — Consultation Scribe: navigation tabs vanish after selecting tenant and user

- **Status:** Review
- **Type:** bugfix (UI / layout)
- **Source:** https://github.com/ArcaAI/project-hope/issues/22 (NeenaPanicker, 2026-09-30; no labels)
- **Severity:** High (layout/usability regression, per reporter)

## Requirement Analysis

Playground → Consultation Scribe → select working tenant (e.g. `ArcaAI`) → select user (e.g. `Cardio_doc`): all other navigation tabs disappear, leaving only the Scribe view; user cannot navigate without reload/back. Expected: global navigation stays visible throughout. Screenshot: https://github.com/user-attachments/assets/a33e0088-958e-4e8a-8209-d8b66beba690

Reporter's hints: route rendered outside the shell layout, or a `hideNav` / full-width / standalone state flag triggered by tenant+user selection.

## Current State Evaluation

Investigated read-only 2026-10-10 (all paths under `apps/admin-console/src`).

- **Not a layout bug.** The route is `app/(console)/playground/consultation/page.tsx` (NOT under `(tenant)`; `playground-route-group.test.ts` pins that). It inherits `app/(console)/layout.tsx:26-59` unchanged: `DomainRail` (`:40`), `AppSidebar` (`:41`), `SiteHeader` + `ImpersonationBanner` + `WorkingTenantBanner` (`:47-51`). `playground/layout.tsx:11-17` only prepends `PlaygroundPersonaBar`. No `hideNav`/standalone flag exists anywhere on this path.
- **Selecting a user = impersonation.** `PersonaControl` (`features/playground-shared/components/persona-control.tsx:135-139`) POSTs `/api/auth/impersonate` (`app/api/auth/impersonate/route.ts:45-80`), then `invalidateQueries()` + `router.refresh()` (`:77-79`). `toSafeSession` (`server/safe-user.ts:52-71`) projects `effectiveUser.roles = impersonation.targetRoles` (a clinician, e.g. DOCTOR, for `Cardio_doc`).
- **Nav filters on the effective identity.** `DomainRail` (`shared/layout/domain-rail.tsx:33-39`) and `AppSidebar` (`shared/layout/app-sidebar.tsx:58-60`) call `visibleNavEntries(rules, session.effectiveUser.roles, gates)` (`shared/navigation/nav-config.ts:1149-1161`). `rules` come from `usePermissions()` (`shared/auth/hooks.ts:47-56`, `POST users/me/permission-checks`), refetched under the target's bearer after the swap, so abilities are the clinician's too.
- **The playground entries themselves vanish.** All five tier 50-59 entries (`nav-config.ts:1005-1052`) carry `required: []`, and `visibleNavEntries` drops them unless `isAdminTier(roles)` (`:1156-1157`, `isAdminTier` at `:1106`: elevated or TENANT_ADMIN). A clinician fails that, so Consultation Scribe leaves the nav. Whatever the clinician's ability grants remains; a narrowly-permissioned role leaves 0-2 domains (`nav-shell-fixture.tsx` `NARROW_TENANT_FIXTURE`). `activeNavDomainId` returns undefined for `/playground/consultation` (no visible owner) so the sidebar falls back to `domains[0]` with nothing selected (`app-sidebar.tsx:64`); if the clinician has no reachable domain `DomainRail` returns null (`domain-rail.tsx:52`) and the sidebar is empty. That matches the screenshot: only the Scribe content remains.
- **Contradiction in the code base.** TASK-890 J5 (`playground-route-group.test.ts` header) deliberately made the playground reachable BY clinicians (route guard is `(console)` only), while `nav-config.test.ts:314-317` ("hides the playground tier from non-admin roles") and the comment at `nav-config.ts:994-1000` still hide the same entries from them. A clinician (or an admin impersonating one) can sit on a page their own nav does not list.
- **Way back exists but is not obvious.** (1) `ImpersonationBanner` "Revoke impersonation" (`shared/layout/session-banners.tsx:58-73`), pinned in shell chrome, shown whenever `impersonatingUserId` is set; (2) `PersonaControl` "Stop acting" (`persona-control.tsx:148-160`) inside the popover. Both POST `/api/auth/revoke-impersonation`, then refresh. After revoking, the admin role is restored and the full nav returns. The topbar (`site-header.tsx`, breadcrumbs, search, user menu) is never hidden. `CommandPalette` (`command-palette.tsx:27`) calls `visibleNavEntries(rules, undefined, gates)` with NO roles, so it hides tier 10-19 and 50-59 for everyone, including admins (separate latent inconsistency).
- Not yet reproduced headed; the above is static analysis. No related ticket in `docs/implementation` or `docs/archive`.

## Root Cause

Intended role filtering with no escape affordance, not a layout bug: after impersonating a clinician the effective roles fail the tier 50-59 admin check (`nav-config.ts:1156-1157`) and the clinician's abilities cover few or no domains, so rail and sidebar shrink to (almost) nothing while the Scribe route stays renderable (route guard is `(console)` only, TASK-890 J5). The two rules (route reachable by clinicians, nav hidden from clinicians) disagree. Confidence: high on mechanism (code-traced); medium on exact residual tabs (depends on Cardio_doc's seeded role/abilities; confirm headed).

## Implementation Plan

TDD, smallest viable fix; option picked by owner (see Open Questions). Recommended: **Option A** (nav shows what the route already allows) plus **Option C** (stranding affordance).

Tests first (RED), in this order:
1. `shared/navigation/__tests__/nav-config.test.ts`: replace the case at `:314-317` with: a DOCTOR (effective roles) sees all five `/playground/*` entries; empty roles/anonymous still do not (`visibleNavEntries([])`). Update the table row `:663` if the expected visibility changes.
2. `shared/layout/__tests__/app-sidebar.test.tsx`: with `stubNavSession({ roles: ['DOCTOR'], isElevated: false, rules: NARROW_TENANT_RULES })` on `/playground/consultation`, the sidebar renders the Playground domain with "Consultation Scribe" selected (`aria-current`); and with impersonation active it still renders at least one nav link.
3. `shared/layout/__tests__/domain-rail.test.tsx`: same fixture, the Playground rail item is present and `aria-current`.
4. `shared/layout/__tests__/session-banners.test.tsx` (Option C): while impersonating, the banner's "Revoke impersonation" button is present and reachable (already true; pin it) and, if added, the persona bar shows a prominent "Stop acting" outside the popover.
5. `shared/layout/__tests__/command-palette` (new, only if the palette fix is in scope): palette entries match the sidebar's for the same roles.

File order:
1. `shared/navigation/nav-config.ts`: drop (or widen) the tier 50-59 `isAdminTier` check at `:1156-1157` and the stale comments at `:1001`/`:1105`; keep `required: []`.
2. Update `13-nextjs-apps.md` Routing note and the nav-config test comments only if the tier semantics change (docs follow code).
3. Optional C: `features/playground-shared/components/persona-control.tsx` / `playground-persona-bar.tsx`: surface "Stop acting" as a visible button next to the trigger while `impersonating`.
4. Optional D: `shared/layout/command-palette.tsx:27`: pass `session.effectiveUser.roles`.

Verification: `pnpm --filter @arcaai/admin-console test src/shared/navigation/__tests__/nav-config.test.ts src/shared/layout/__tests__/app-sidebar.test.tsx src/shared/layout/__tests__/domain-rail.test.tsx src/shared/layout/__tests__/session-banners.test.tsx "src/app/(console)/playground/__tests__/playground-route-group.test.ts"`, then `pnpm admin:typecheck`, `pnpm admin:lint`. Orchestrator headed pass (next-dev-loop): super admin, select tenant, impersonate Cardio_doc, confirm nav, Revoke/Stop acting restores full nav; both themes, axe 0 violations (rule 11 §11).

## Risks / Open Questions for the owner

- **Decision 1 (behaviour):** is hiding the playground from clinicians intended? TASK-890 J5 says the playground exists FOR clinicians, so Option A (show tier 50-59 to any signed-in user; no role check) is consistent. Option B (keep hiding, and redirect/404 playground routes for non-admins) contradicts J5. Option C alone (leave filtering, add a visible "Stop acting"/"Back to admin" control) fixes the stranding but leaves the clinician with an empty nav.
- **Decision 2:** beyond the playground, a clinician with few abilities still gets a short nav. That is by design (ability gating); should an impersonating admin additionally keep a "Return to admin view" entry in the rail?
- Reporter's wording ("hideNav/standalone") is not what the code does; reply on the issue accordingly after the fix.
- Widening tier 50-59 changes visibility only; backend guards are plain `@Authorize()` so no authorization change, but `13-nextjs-apps.md` and `12-design-workflow.md` §5 state the tier as admin-gated and must be reconciled.
- Palette/sidebar inconsistency (`command-palette.tsx:27`) is adjacent; fix in this ticket only if the owner agrees (surgical-changes rule).
- Exact residual tabs for Cardio_doc need a headed check (seeded role in `packages/database/src/prisma/db_main/seed`).

## Decisions (2026-10-10)

- **D1 — Option A:** show the tier 50-59 Playground nav entries to any signed-in user (consistent with the route guard); drop the role check in `visibleNavEntries`.
- **D2 — no extra "Return to admin" rail entry;** instead make "Stop acting" a visible button next to the persona trigger (the impersonation banner already offers Revoke).
- **Command palette:** fix the no-roles `visibleNavEntries` call in this ticket.
- **Docs:** update `13-nextjs-apps.md` and `12-design-workflow.md` §5 to say tier 50-59 is no longer admin-gated at nav level.

## Addendum — second read-only investigation (2026-10-10)

Independent re-check confirms the mechanism above (high confidence): `persona-control.tsx:139` POSTs `/api/auth/impersonate`; the sealed session then carries the target's token and `targetRoles` (`server/safe-user.ts:57`), `usePermissions()` refetches the doctor's CASL rules, and `visibleNavEntries` (`nav-config.ts:1149-1161`) drops tier 50-59 for non-admins at `:1157` (`isAdminTier`, `:1105-1108`) — contradicting TASK-890 J5 (`620267ea3`), which made `/playground/*` reachable for DOCTOR (`app/(console)/playground/__tests__/playground-route-group.test.ts:38-48`). Layout-flag and feature-gate hypotheses rejected: `app/(console)/layout.tsx:33-56` always renders the rail/sidebar/header, and no playground entry carries a `gate`. Exact remaining tabs for `Cardio_doc` are unverified (runtime-created user; needs a headed check).

## Implementation Summary

Decisions confirmed by the owner in chat (2026-10-11): D1 (Option A), D2 (visible Stop acting), the command-palette roles fix, and the rule-doc updates.

- `apps/admin-console/src/shared/navigation/nav-config.ts` — `visibleNavEntries` drops the tier 50-59 role check and the now-unused `isAdminTier`; comments say the playground is open to every signed-in caller (route `(console)/playground`, TASK-890 J5).
- `apps/admin-console/src/shared/layout/command-palette.tsx` — passes `session.effectiveUser.roles` (was `undefined`, which hid every tier 10-19 screen from ⌘K even for a super admin).
- `apps/admin-console/src/features/playground-shared/components/persona-control.tsx` — "Stop acting" moved out of the popover to a visible button beside the trigger while impersonating.
- Tests: `nav-config.test.ts` (4 pinned expectations rewritten: zero grants and DOCTOR now see the five playground routes, the playground domain is visible to DOCTOR and lands on Consultation Scribe; unknown permissions still show nothing), `app-sidebar.test.tsx` (impersonated clinician on `/playground/consultation` keeps the Playground nav, Consultation Scribe `aria-current`), `domain-rail.test.tsx` (narrow fixture now includes Playground), new `command-palette.test.tsx` (super admin sees Tenants; clinician sees Consultation Scribe, not Tenants), `persona-control.test.tsx` (Stop acting visible without opening the picker; absent when acting as yourself).
- Docs: `.claude/rules/13-nextjs-apps.md` §Routing and `.claude/rules/12-design-workflow.md` §3 table — playground under `(console)/playground/*`, no nav role check (also corrected the stale `(console)/(tenant)/playground` path).

Evidence:
- RED: 8 new/updated tests failed before the change; the palette test was re-verified to fail on the old (no-roles) palette.
- GREEN: `vitest run src/shared src/features/playground-shared "src/app/(console)/playground"` → 93 files, 1044 tests passed. `tsc --noEmit` exit 0; eslint on all 8 changed files exit 0.
- Running console (`/playground/consultation`, tenant_admin @ Global): acting as `doctor_med` → rail = Tenancy, Identity & Access, Playground (current) with all five playground screens, Consultation Scribe `aria-current`; "Stop acting" visible beside the trigger; clicking it → "Acting as yourself", full admin rail (8 domains) restored.

Found during the live check, NOT fixed here (separate regression, TASK-1057's area): selecting a user in the playground picker returns **400 "A reason is required for this action."** — commit `300c1b8df` (TASK-1057 lane C, 2026-10-09) made `impersonation.start` require a reason on both routes, and `persona-control.tsx` sends none (the Users screen collects one via its confirm dialog with `reasonActionId: 'impersonation.start'`). The live check therefore started the impersonation through `POST /api/auth/impersonate` with a reason. Until that is fixed, the playground picker cannot impersonate anyone.

**Follow-up fix (owner asked, 2026-10-11):** `persona-control.tsx` now opens the shared `ConfirmDialog` with `reasonActionId: 'impersonation.start'` when a user is picked (same policy-driven Reason field as the Users screen; confirm disabled until the policy is satisfied) and POSTs `{ userId, reason }`. A refused switch is now shown as an error toast (the response was previously ignored and the layout refreshed as if it had worked), and the dialog stays open with the typed reason. Tests: the two impersonate flows go through the dialog and assert the posted body; a 400 shows the gateway message, does not refresh, keeps the reason. `vitest run src/features/playground-shared` → 25 passed; tsc exit 0; eslint exit 0. Live: picker → doctor_med → dialog (Reason *, button disabled) → reason typed → Act as user → "Acting as «doctor_med»" + Stop acting, Playground nav kept; AuditLog `IMPERSONATION` row carries the reason; Stop acting → "Acting as yourself".

## Change History

- 2026-10-10 — Ticket scaffolded from GitHub issue #22 (no investigation yet).
- 2026-10-10 — Read-only investigation: root cause (effective-role nav filtering of tier 50-59 vs clinician-reachable route), TDD plan and owner decisions recorded. Status unchanged (Pending).
- 2026-10-10 — D1/D2, the palette fix and the rule-doc updates recorded as the agreed direction (the owner accepted the recommendations).
- 2026-10-10 — Second read-only investigation: findings appended as an Addendum (no change to the decisions above).
- 2026-10-11 — Fixed (D1 + D2 + palette roles + rule docs); tests, typecheck, lint, live console check green. Found the TASK-1057 picker-reason regression (not fixed here). Status Review.
- 2026-10-11 — Follow-up: playground picker asks for the TASK-1057 impersonation reason and surfaces refusals; tests, typecheck, lint, live check green.
