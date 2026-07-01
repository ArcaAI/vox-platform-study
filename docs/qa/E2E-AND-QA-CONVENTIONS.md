# Admin Console — E2E & QA Conventions (TASK-372/379–384 review pass)

> Shared conventions so the seven per-ticket review agents produce consistent,
> non-colliding deliverables. **Per-ticket agents must treat the files in §5 as
> frozen** (created/owned by the coordinator) and only add their own ticket-scoped
> files.

## 1. Deliverables per ticket

> **Relocated under TASK-385 (docs alignment, 2026-06-30).** The three doc deliverables below now live in **central homes**, not per-ticket folders. The old `docs/implementation/TASK-3XX-*/{DESIGN-SPEC,TRACEABILITY-MATRIX,MANUAL-E2E-TESTS}.md` paths are stubs that point there. New surfaces add their files to the central homes directly.

Each Admin Console surface gets:

1. **Design spec** — Desktop / Tablet / Mobile interface spec (§2) → **`docs/designs/admin/<surface>.md`**.
2. **Plan review** — verify README §3 plan vs shipped code; close trivial in-scope
   gaps; document the rest. Update README status + Change History.
3. **Traceability matrix** — use-case → design frame → backend API (`file:line`)
   → test → status (§3) → **`docs/qa/traceability/<surface>.md`** (master index: `docs/qa/traceability/README.md`).
4. **E2E tests** — automated (frontend Playwright + backend API) **and** manual (§4); the manual suite → **`docs/qa/manual-tests/<NN>-<surface>.md`**.

## 2. Design spec format (`docs/designs/admin/<surface>.md`)

One section per design frame (use the exact frame name + node id already cited in
the ticket README, e.g. `18d · Tenant Dashboard 120:8843`). For each surface give
a **Desktop / Tablet / Mobile** subsection covering: layout & grid, navigation,
primary actions, data display (table vs card-list), dialogs, empty/loading/error,
and ≥44px touch targets. Ground every choice in:

- the documented Figma frame node ids (the live Figma bridge has **no file
  connected this session** — do **not** attempt live Figma reads/writes);
- the TASK-384 responsive model (mobile `< md 768`, tablet `md..lg 768–1023`,
  desktop `≥ lg 1024`);
- semantic theme tokens only (`docs/implementation/TASK-371-Admin-Console-Redesign/theme.css`);
- the design-system rules (`.cursor/rules/11-ux-ui-principles.mdc`, `10-skeleton-loading.mdc`).

End with a **"Figma frames to create later"** list (e.g. dedicated Tablet/Mobile
variants that don't exist as frames yet) — these are deferred to a serialized
Figma pass once a file is connected (screenshots/visual alignment come later).

## 3. Traceability matrix format (`docs/qa/traceability/<surface>.md`)

Mirror the master `docs/qa/traceability/README.md`:
same legend (🟢 built+tested · 🟡 partial · 🔴 gap · 🎯 target · 🔒 super-admin) and
columns `ID | Use case | Design (frame · node) | Backend API (/api/v1… · file:line) |
Test | Status`. Verify backend `file:line` refs against live source under
`apps/api` / `packages/applications`. Cross-link the matching TASK-371 matrix rows.

## 4. E2E tests

### 4a. Automated — backend API (runnable)
- File: `apps/api/tests/e2e/task-3XX-<slug>.spec.ts`.
- Pattern: `@playwright/test` + `import { SEEDED_USERS, loginUser } from '../../../../tests/helpers'`
  (template: `apps/api/tests/e2e/task-375-admin-features.spec.ts`).
- Cover the REAL flows the surface depends on; respect tenant isolation (404-over-403),
  OCC/If-Match, soft-delete, and audit. Do **not** assert TARGET (un-backed) flows.

### 4b. Automated — frontend Playwright (authored; run when stack is up)
- File: `apps/admin/e2e/task-3XX-<slug>.spec.ts`, importing `./fixtures/auth`.
- Exercise the surface across the relevant viewport projects (desktop/tablet/mobile).
- Gate when no stack: `pnpm exec playwright test --config apps/admin/playwright.config.ts --list`.

### 4c. Manual (FE→BE, black-box)
- File: **`docs/qa/manual-tests/<NN>-<surface>.md`** (numbered surface suite in the central
  suite — pick the next free `NN` and a **unique** TC-ID prefix; register it in that folder's
  `README.md` §1 / §3.2 / §7). Mirror the case style of
  `docs/qa/manual-tests/02-user-access-control.md` (TC IDs, persona, steps, expected,
  status legend, X1–X8 cross-cutting flags). Cross-reference the requirement-based suites
  `01` / `02` where they overlap.

## 5. Frozen shared files (coordinator-owned — do NOT edit from a ticket agent)

- `apps/admin/playwright.config.ts`
- `apps/admin/e2e/fixtures/auth.ts`
- `apps/admin/e2e/_smoke.spec.ts`, `apps/admin/e2e/README.md`
- `apps/admin/package.json` (E2E scripts/devDep already added)
- the central index docs: `docs/designs/admin/README.md`, `docs/qa/traceability/README.md`, `docs/qa/manual-tests/README.md`
- this file

Add **new** files only; never rename/move sibling tickets' files.

## 6. Verification gates (run what's feasible; paste real output)

- `pnpm --filter @arcaai/admin type-check`
- `pnpm --filter @arcaai/admin test` (vitest)
- Frontend specs discover: `pnpm exec playwright test --config apps/admin/playwright.config.ts --list`
- Backend specs discover/compile: `pnpm exec playwright test apps/api/tests/e2e/task-3XX-<slug>.spec.ts --list`
- Only run live E2E if a seeded stack is already up (`curl -s localhost:8868/api/v1/health`).
  Otherwise mark E2E **authored — run pending stack** (do **not** stand up docker/API in the background).

## 7. Status handling

Move a ticket README status **Review → Completed** only when its four deliverables
are in place and the feasible gates are green; otherwise keep **Review** with a
Change-History note listing what remains. TASK-372 stays **In Progress** but records
the design/traceability/test additions + the D7/D8 backend follow-up status.
