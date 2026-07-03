# TASK-405 — Icon & Dark-Mode Polish (backlog P2-1, code-actionable slice)

| | |
|---|---|
| **Ticket** | TASK-405 |
| **Type** | refactor (presentation-only design polish) |
| **Source** | `docs/qa/OPEN-ITEMS-BACKLOG-2026-07-01.md` **P2-1** ("Lucide icon swap, per-screen dark mode, … tablet/mobile Figma frames") |
| **Created** | 2026-07-02 |
| **Updated** | 2026-07-02 |
| **Status** | Completed |

## 1. Requirement Analysis

Backlog **P2-1 (Deferred design polish)** bundles four strands. This ticket executes the two **code-actionable** strands inside `apps/admin/src`:

1. **Lucide icon sweep** — find emoji / unicode-glyph / ad-hoc-SVG / single-character icons in feature code and replace them with `lucide-react` icons at the app's established sizes (`size-4` default; `aria-hidden` when decorative, `aria-label` when icon-only).
2. **Per-screen dark-mode audit** — the TASK-371 token set fully supports dark mode, but individual screens were never audited. Sweep for hardcoded light-only colors (`bg-white`, `text-black`, raw hex, `bg-gray-*`…) and replace with semantic token classes (`bg-background`, `text-foreground`, `bg-muted`, `border-border`, …); verify treated screens render correctly in BOTH themes.

**Explicitly out of scope (remaining design work, NOT code-actionable here):**
- **Tablet/mobile Figma frame authoring** across TASK-371/379–384 — Figma design work in the `HOPE-Admin-Console` file, tracked as the remaining P2-1 slice.
- **Real chart series (vs illustrative rects)** — chart rendering files are owned by a sibling ticket (see §2 partition).

**Acceptance criteria**
- No emoji/glyph/ad-hoc icons remain in owned `apps/admin/src` files; replacements are lucide, size-consistent, accessible.
- No hardcoded light-only colors in owned files; token classes only.
- `pnpm --filter @arcaai/admin type-check` and `build` pass; no new lint errors.
- Light + dark screenshot pairs for ≥4 treated screens in `.uxu-verify/task-405-*`.
- One existing FE E2E spec re-run green (task-384 responsive) — zero behavioral change.

## 2. Current State Evaluation

Static sweep of `apps/admin/src` (ripgrep, full non-ASCII inventory via python):

**Dark-mode debt: none found statically.** Zero `bg-white` / `text-black` / `bg-gray-*` / `-(gray|slate|zinc|neutral|stone)-N` / raw hex / `[color:…]` arbitrary values in any `.ts(x)` under `apps/admin/src`. All color flows through the TASK-371 semantic tokens (`index.css` defines light `:root` + `.dark` overrides for every token, including `--success/--warning/--ai/--hope/--info/--link`, sidebar and chart ramps). The three `style={{…}}` usages are width-percent / min-height only. The audit therefore reduces to **visual verification per screen** (both themes) plus fixing anything that renders wrong.

**Icon debt: small and enumerable.** 66 files already import `lucide-react`; conventions are `size-4` (buttons/inline), `size-3.5`/`size-3` (dense legends), `size-5+` (feature/empty states), `aria-hidden` decorative, `aria-label` on icon-only controls. Remaining ad-hoc glyph icons:

| File | Glyph | Replacement |
|---|---|---|
| `components/layout/app-shell.tsx` (`BrandMark`) | text `+` in brand tile | `Plus` (lucide), `aria-hidden` |
| `routes/login.tsx`, `routes/forgot-password.tsx`, `routes/reset-password.tsx` | text `+` in brand tile | `Plus` (lucide), `aria-hidden` |
| `features/data-grid/responsive-data-grid.tsx` (mobile FAB fallback) | `<span class="text-2xl">+</span>` | `Plus` `size-6`, `aria-hidden` (button keeps `aria-label`) |
| `features/roles/roles-browser.tsx` (inheritance tree) | `↳` U+21B3 | `CornerDownRight` `size-3` muted, `aria-hidden` |
| `features/roles/permission-matrix.tsx` ("not granted" cell) | `·` middle dot span | `Minus` `size-4 text-muted-foreground/40`, keeps per-cell `aria-label` |

**Deliberate non-icons kept as text (semantic, some test-asserted):** `—` empty-value sentinel (app-wide convention), `…` ellipses, `·` aria-hidden typographic separators, `∞` unlimited sentinel (`entitlements-format.ts`, unit-tested), `••••` secret masks (`api-key-format.ts` unit-tested; `sectioned-settings.tsx` masked display), `«»`/arrows/box-drawing inside comments only.

**No `<svg` inline blobs** exist in `apps/admin/src`.

## 3. Ownership Partition (parallel siblings — strict)

Not touched (sibling-owned): `lib/nav.ts`; `routes/_authenticated/system-health.tsx`, `routes/_authenticated/components.tsx`; `features/components-library/**`; `features/rate-limits|queues|prisma-studio/**`; dashboard chart rendering (`features/tenant-dashboard/chart*`, `features/platform-dashboard/**`); `packages/ui/**`; `apps/api`/`packages/**`; `docs/qa/**`.

Leftovers observed in sibling-owned files (for their owners, nothing urgent): `system-health.tsx:274` uses `style={{ minHeight: 240 }}` (could be a Tailwind class); no glyph-icon or color debt spotted elsewhere in the excluded set.

## 4. Implementation Plan

1. Replace the 7 glyph-icon usages above with lucide icons (presentation-only; no props/handlers/test-ids change) → verify: type-check + build + lints.
2. Visual dark-mode audit on the running shared stack (`:5174` against `:8868`): light + dark pairs of login, tenants, roles, settings, api-keys (theme via the app's own mechanism — `ThemeProvider`, storage key `hope.admin.theme`, `.dark` class on `<html>`) → fix any screen-level issues found (token classes only) → re-verify.
3. Evidence into `.uxu-verify/task-405-*`; re-run `task-384-responsive` spec; finish this README.

## 5. Implementation Summary

**Icon sweep — 7 files, presentation-only (no logic/props/handlers/test-ids touched):**

| File | Change |
|---|---|
| `apps/admin/src/components/layout/app-shell.tsx` | `BrandMark` text `+` → lucide `Plus` `size-5` `aria-hidden` (dropped the now-dead `text-lg font-semibold` glyph styling) |
| `apps/admin/src/routes/login.tsx` | brand tile text `+` → `Plus` `size-7` `aria-hidden` |
| `apps/admin/src/routes/forgot-password.tsx` | same brand-tile swap |
| `apps/admin/src/routes/reset-password.tsx` | same brand-tile swap |
| `apps/admin/src/features/data-grid/responsive-data-grid.tsx` | mobile FAB fallback `<span class="text-2xl">+</span>` → `Plus` `size-6` `aria-hidden` (button keeps its `aria-label`) |
| `apps/admin/src/features/roles/roles-browser.tsx` | inheritance-tree `↳` glyph → `CornerDownRight` `size-3 shrink-0 text-muted-foreground/60` `aria-hidden` |
| `apps/admin/src/features/roles/permission-matrix.tsx` | "not granted" matrix cell `·` text span → `Minus` `size-3 text-muted-foreground/40` (keeps the per-cell `aria-label="<subject> <action>: not granted"`) |

Conventions applied: lucide-only, `size-4` family sizing scaled to context, decorative icons `aria-hidden`, icon-only controls keep `aria-label`, colors via semantic tokens.

**Dark-mode audit:** static sweep found **zero** hardcoded light-only colors (see §2) — the admin app is fully token-driven, so no class rewrites were needed. Per-screen visual verification (light + dark, real seeded stack `:5174`→`:8868`, theme via the app's `ThemeProvider` mechanism — topbar toggle / `hope.admin.theme` + `.dark` class): login, tenants grid, roles master-detail (tree + effective abilities), policy permission-matrix sheet, settings sectioned form, API keys table — all render correctly in both themes; status badges, matrix marks, mono/masked values and sidebar tokens hold AA-legible contrast in dark.

**Evidence**
- `pnpm --filter @arcaai/admin type-check` — pass (`tsc --noEmit`, exit 0).
- `pnpm --filter @arcaai/admin build` — pass (`✓ built in 10.90s`; pre-existing chunk-size warning only).
- ReadLints on all 7 edited files — no new issues (2 pre-existing tailwind-shorthand warnings in `app-shell.tsx` on untouched lines).
- Screenshots (light+dark pairs) in `.uxu-verify/`: `task-405-login-*`, `task-405-tenants-*`, `task-405-roles-*`, `task-405-policy-matrix-*`, `task-405-settings-*`, `task-405-api-keys-*` (6 screens × 2 themes).
- Regression: `pnpm exec playwright test --config apps/admin/playwright.config.ts task-384-responsive` — **12 passed (10.0s)** across desktop/tablet/mobile (covers the edited shell BrandMark + data-grid FAB).

**Remaining P2-1 work (not code-actionable here):** tablet/mobile **Figma frame authoring** across TASK-371/379–384 in the `HOPE-Admin-Console` file (design task); real chart series for dashboards (sibling-owned rendering files). Sibling-owned leftover noted: `system-health.tsx:274` inline `minHeight` style.

## 6. Change History

| Date | Change |
|---|---|
| 2026-07-02 | Ticket created; static sweep + plan recorded. |
| 2026-07-02 | Icon sweep implemented (7 files); dark-mode audit verified clean per-screen (6 screens × 2 themes); gates + task-384 regression green. Status → Completed. |
