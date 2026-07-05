# TASK-425 — Admin Sidebar: Nav Icons + Icon-Collapsed Rail

| | |
|---|---|
| **Status** | Review |
| **Type** | feature (UI/UX + a11y) |
| **Date** | 2026-07-05 |
| **Scope** | `apps/admin-console` sidebar, `packages/ui` sidebar primitive (fitness-pass fix) |

## Requirement Analysis

User request (review + implement): the admin sidebar must (1) show an icon before every navigation item label, (2) collapse to an icon-only rail, (3) stay scrollable on short viewports, (4) follow responsive/accessibility best practices.

## Current State Evaluation (review findings)

1. `AppSidebar` was already `collapsible="icon"`, but entries rendered label-only — collapsing produced a 48px rail of blank buttons.
2. The `SidebarContent` primitive applied `overflow-hidden` in icon mode; with 29 entries (~1,100px of menu) everything below the fold was unreachable on short screens. Expanded mode scrolled fine.
3. The `SidebarMenuButton` built-in `tooltip` prop (collapsed-only, desktop-only) was unused — icon-only buttons had no hover/focus identification.
4. A11y gaps: no `aria-current="page"` on the active link, no labeled `navigation` landmark (only the breadcrumb `<nav>` existed), no `prefers-reduced-motion` guard on the 200ms width slide.
5. Brand header: raw icon + text sliver misaligned in the collapsed rail (shadcn convention is a fixed `size-8` centered box).
6. Mobile was already correct via the primitive's Sheet behavior (`useIsMobile`, trigger in the topbar).

## Implementation Plan (TDD)

1. RED: `nav-config.test.ts` — every entry ships a unique `icon`; new `app-sidebar.test.tsx` — landmark, icon-before-label, `aria-hidden` icons, `aria-current`, tooltip wiring. Verified failing (4 failures).
2. `packages/ui/src/components/shadcn/sidebar.tsx` (upstream fitness fix): icon-collapsed `SidebarContent` keeps vertical scroll (`overflow-x-hidden` instead of `overflow-hidden`); `motion-reduce:transition-none` on the gap/container width transitions and menu-button size transition.
3. `nav-config.ts`: `icon: TablerIcon` field + 29 unique Tabler icons.
4. `app-sidebar.tsx`: leading icon + label per entry, `tooltip={entry.label}`, `aria-current="page"` on exact match, `role="navigation" aria-label="Main"` on the content, brand icon in a fixed `size-8` box, brand tooltip.
5. E2E regression in `app-shell.spec.ts`: collapsed rail is 48px, icons visible, rail scrolls to the last entry, tooltip appears on hover, toggle round-trip restores labels.

## Implementation Summary

Files changed:

- `packages/ui/src/components/shadcn/sidebar.tsx` — scrollable icon rail (`group-data-[collapsible=icon]:overflow-x-hidden`), `motion-reduce:transition-none` × 3.
- `apps/admin-console/src/shared/navigation/nav-config.ts` — `NavEntry.icon: TablerIcon`; 29 unique icons.
- `apps/admin-console/src/shared/layout/app-sidebar.tsx` — icons, tooltips, `aria-current`, labeled nav landmark, brand-header alignment.
- `apps/admin-console/src/shared/navigation/__tests__/nav-config.test.ts` — icon presence/uniqueness test.
- `apps/admin-console/src/shared/layout/__tests__/app-sidebar.test.tsx` — new component suite (4 tests).
- `apps/admin-console/tests/e2e/app-shell.spec.ts` — collapsed-rail regression test.

No route, permission, or data-layer changes. Command palette intentionally untouched (still uses its generic arrow icon; can adopt `entry.icon` later if desired). Design note: this modifies frame-07 shell chrome at the product owner's direct request — reflect the icon set in Figma frame 07 at the next design touch.

Evidence (2026-07-05, live runs):

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/admin-console test` | 512/512 passed (76 files) — was 498 + 14 new/updated |
| `pnpm --filter @arcaai/admin-console lint` | 0 warnings (`--max-warnings 0`) |
| `pnpm --filter @arcaai/admin-console check-types` | clean |
| `pnpm --filter @arcaai/ui test` / `lint` / `build` | 564/564, 0 warnings, build clean |
| `packages/ui` sidebar CT suite (Playwright CT) | 38/38 passed |
| E2E `app-shell.spec.ts` vs live stack (:5176 + :8868) | 2/2 passed (pinned chrome + new collapsed-rail spec) |
| Browser QA (both themes) | expanded icons+labels, collapsed 48px icon rail, rail scroll measured (`scrollHeight` 1096 > `clientHeight` 893, `overflow-y: auto`, `overflow-x: hidden`), active-item highlight, `states: [current]` exposed in the a11y tree |

## Change History

| Date | Change |
|---|---|
| 2026-07-05 | Ticket created; review + TDD implementation + verification completed in one pass. Ticket number assigned as next-in-sequence — initially TASK-423, renumbered to TASK-425 after parallel sessions claimed TASK-423/424; pending user confirmation. |
