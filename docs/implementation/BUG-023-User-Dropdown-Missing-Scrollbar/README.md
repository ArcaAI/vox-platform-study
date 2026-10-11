# BUG-023 — Playground user-selection dropdown shows no scrollbar, list looks truncated

- **Status:** Review
- **Type:** bugfix (UI)
- **Source:** https://github.com/ArcaAI/project-hope/issues/23 (NeenaPanicker, 2026-09-30; no labels)
- **Severity:** Medium

## Requirement Analysis

In the Playground (Consultation Scribe / tenant selection), the **User** dropdown renders no scrollbar when the list exceeds the container height. The list looks cut off, so newly provisioned users appear to be missing. Expected: visible scrollbar when overflowing; keyboard (arrows) and mouse-wheel scrolling clearly indicate scrollability. Screenshot: https://github.com/user-attachments/assets/0be78717-1e4d-422d-8018-12ced8ff5dea

## Current State Evaluation

- The "User" dropdown is the Playground **persona control** ("Acting as ..."), not a Select: `apps/admin-console/src/features/playground-shared/components/persona-control.tsx:119-163` (Popover > `Command` > `CommandList` > `CommandItem`), mounted by `playground-persona-bar.tsx:23`. It is the only consumer of this picker.
- **Data cap (server query):** `persona-control.tsx:86-96` calls `GET admin/users` with `limit: 8`, `search`, `searchFields: 'username,externalId'`, and renders only `usersQuery.data.data`. There is no page param, no "load more", no total/"showing 8 of N" hint, and `count`/`page` from the `Paginated` envelope are ignored. Users beyond the 8th are reachable ONLY by typing a search (debounced 300 ms, lines 55-58). Gateway side `PaginatedQuery.limit` defaults to 10 (`packages/applications/src/common/dto/paginated.query.ts:17,42`), so 8 is a client-chosen cap, not a server limit.
- **Primitive (CSS):** `packages/ui/src/components/shadcn/command.tsx:62-70` — `CommandList` is `max-h-[300px] overflow-y-auto overflow-x-hidden`. It IS scrollable; there is no custom scrollbar styling anywhere (`grep -i scroll packages/ui/src/styles/globals.css` only hits `scroll-behavior` at :849). On macOS/touch with "show scrollbars automatically", native overlay scrollbars are invisible until scrolled, so overflow gives no affordance.
- **Does it even overflow at 8 rows?** Each item is `py-1.5` + one text line (~32 px; the second `email` line at :143 is rarely present because `email` lives on `UserProfile`, not `User` - see comment :24-30), so 8 rows is ~256-300 px, i.e. at or just under the 300 px cap. In the common case the list does NOT overflow: it simply ends at 8 rows, which is what the reporter sees as "users missing". Not verified in a browser (read-only task).
- Blast radius: `CommandList` is used by ~20 files across admin-console and `packages/ui`; any change to the primitive's scrollbar styling affects all of them.

## Root Cause

Primary (confidence: high from code, unverified in a running app): the picker hard-caps the server query at `limit: 8` (`persona-control.tsx:92`) with no pagination/"load more"/count hint, so users beyond 8 are invisible unless searched. Contributing (confidence: medium): `CommandList` relies on native overlay scrollbars with no visible affordance, which hides overflow whenever the cap is raised or rows are taller (e.g. with email). The fix therefore needs BOTH a data change and (optionally) a primitive affordance.

## Implementation Plan

TDD (tests first, see RED):

1. `apps/admin-console/src/features/playground-shared/components/__tests__/persona-control.test.tsx` (extend existing; it already mocks `admin/users` at ~:56):
   - a response with `count > data.length` renders a visible "Showing N of M - type to narrow" hint and a "Load more" item/button; clicking it fetches the next page and appends rows (no duplicates);
   - when `count <= data.length` neither hint nor button renders;
   - the request carries the chosen page size (assert `limit` in the captured URL).
2. (Only if owner approves the primitive change) `packages/ui/src/components/__tests__/shadcn/command.test.tsx` (new or existing sibling): `CommandList` keeps `overflow-y-auto` + bounded `max-h` and carries the always-visible-scrollbar class. Run only that file, because the change is inside `packages/ui` (01 Test Scope Exclusions).

File order:
1. `persona-control.tsx`: switch `useQuery` to `useInfiniteQuery` (page/limit params, `getNextPageParam` from `count`), raise page size (suggest 20), add the count hint + "Load more" `CommandItem`/button (visible disabled reason while fetching, Spinner not "Loading..."), keep skeleton rule 10 for first load instead of the "Searching..." text if touched.
2. Optional `packages/ui/src/components/shadcn/command.tsx:66`: add a visible-scrollbar utility (Tailwind v4.3 `scrollbar-*` / `[scrollbar-gutter:stable]`, semantic tokens only) to `CommandList`, or scope it by passing `className` from `PersonaControl` only (zero blast radius).
3. Tests above.

Verification: `pnpm --filter @arcaai/admin-console test persona-control`, `pnpm admin:typecheck`, `pnpm admin:lint`; if packages/ui touched, `pnpm --filter @arcaai/ui test command`. Orchestrator headed check (next-dev-loop) with >20 seeded users, macOS "automatically hide scrollbars" on, both themes, keyboard arrows scrolling the active item into view (cmdk does this), 200% zoom.

## Risks / Open Questions

Owner decisions needed:
- D1: pagination model - "Load more" (recommended), larger fixed cap (e.g. 50), or rely on search only plus an explicit "Showing 8 of N" hint (smallest change)?
- D2: make the scrollbar always visible in the shared `CommandList` (affects ~20 screens) or only in `PersonaControl` via `className` (recommended, zero blast radius)?
- Is the reporter's list actually overflowing, or just capped at 8? Needs a headed check with the reporter's tenant before choosing; the screenshot (issue link above) was not inspected.
- Risk: `Paginated` envelope echo quirk (F-02 in 05-nestjs-api.md: `limit: 0` echoed when omitted) - always send `limit` explicitly and page from `count`, not from the echoed limit.
- Searching only `username,externalId` means users cannot be found by email; out of scope, noted.

## Decisions (2026-10-10)

- **D1 — pagination:** `useInfiniteQuery` with a "Showing N of M" line and a Load more button (keep the page size; search still works).
- **D2 — scrollbar scope:** visible-scrollbar styling scoped to `PersonaControl` via `className`, NOT the shared `CommandList` (~20 consumers); `packages/ui` stays untouched, so its tests are not run.
- Confirm from a headed check with more than 20 users that the list overflows.

## Addendum — second read-only investigation (2026-10-10)

Independent re-check confirms `limit: 8` (`persona-control.tsx:92`) and the unstyled `CommandList` (`packages/ui/src/components/shadcn/command.tsx:66`). One nuance not recorded above:

- **Default sort is newest-first** — `apps/api/src/modules/user/user.controller.ts:80` `DEFAULT_USERS_SORT = 'createdAt:desc'`. So with no search, a *newly provisioned* user is normally in the first 8. It goes missing only when 8+ users in scope are newer — most likely a SUPER_ADMIN with **no working tenant** (cross-tenant `fetchAll`, platform-wide newest 8, including e2e-seeded users) or a batch provision of >8. Non-impersonable admins also occupy slots (only the currently impersonated user is disabled, `:138`). The headed check should therefore record whether a working tenant was set; consider filtering to impersonable users and sending the sort explicitly.
- Same cap elsewhere (out of scope, possible follow-up): `features/tenants/components/user-picker.tsx:34` uses `limit: 10` in the create-tenant dialog.

## Implementation Summary

Decisions D1/D2 confirmed by the owner in chat (2026-10-11): Load more + "Showing N of M"; visible scrollbar on this picker only.

- `apps/admin-console/src/features/playground-shared/components/persona-control.tsx` — `useInfiniteQuery` over `GET admin/users` (page size 8, `page` + `limit` sent explicitly, next page from the envelope's `count`); a "Showing N of M — type to narrow" line and a **Load more** `CommandItem` (Spinner while fetching) only while more remain; `CommandList` gets a visible-scrollbar className.
- `.../__tests__/persona-control.test.tsx` — `PersonaControl — paging (BUG-023)`: first page + hint + Load more → second page appended, all 12 unique, Load more gone; no hint/Load more when everything fits; list carries the scrollbar class. The paged stub mimics the real offset rule.

Two defects found only in the running console (fixed before commit):
1. **Pages are 1-based in practice.** `PaginatedQuery` documents `page` as 0-based, but the repository skips `max(0, (page - 1) * limit)` (`packages/domains/src/common/repository.helpers.ts:6`), so page 0 and page 1 are both the first page — the first live run listed 24 rows / 16 unique. The picker now starts at page 1; the test stub uses the real rule and fails on the 0-based version (verified). The DTO/repository mismatch itself is a separate pre-existing backend inconsistency (follow-up).
2. **`scrollbar-width` disables `::-webkit-scrollbar` in current Chromium**, so the first styling (copied from `billingsdk/update-plan-dialog.tsx`, which has the same flaw) still rendered the hidden overlay scrollbar. Removed; the list now reserves an 8px scrollbar (clientWidth 278 vs offsetWidth 286) with a visible thumb.

Evidence:
- RED: 2 of 3 new tests failed before the change; the tightened paging test fails on the 0-based variant.
- GREEN: `vitest run src/features/playground-shared` → 3 files, 22 tests (incl. the axe checks) passed; `tsc --noEmit` exit 0; eslint exit 0.
- Running console, `/playground/consultation`, tenant_admin @ Global (21 users): 8 → "Showing 8 of 21" → Load more → 16 → Load more → 21, all unique, Load more gone; scrollbar visible once the list overflows.

Not changed: the list still includes users that cannot be impersonated (e.g. `service_account`), and search still matches only username/externalId.

## Change History

- 2026-10-10 — Ticket scaffolded from GitHub issue #23 (no investigation yet).
- 2026-10-10 - Read-only investigation: root cause identified (client `limit: 8` cap in persona-control.tsx with no pagination, plus no visible scrollbar affordance in `CommandList`); plan and owner decisions D1/D2 recorded.
- 2026-10-10 — D1/D2 recorded as the agreed direction (the owner accepted the recommendations).
- 2026-10-10 — Second read-only investigation: Addendum added — default newest-first sort nuance, working-tenant dependency.
- 2026-10-11 — Fixed (D1 Load more + N of M, D2 picker-only scrollbar; 1-based paging and scrollbar-width defects caught live); tests, typecheck, lint, live console check green. Status Review.
