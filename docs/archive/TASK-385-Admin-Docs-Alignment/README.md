# TASK-385 — Admin Console Docs Alignment

| | |
|---|---|
| **Ticket** | TASK-385 |
| **Type** | docs (refactor / housekeeping) |
| **Created** | 2026-06-30 |
| **Updated** | 2026-06-30 |
| **Status** | Completed |
| **Related** | TASK-371 (redesign), TASK-372, TASK-379–TASK-384 (per-surface) |

---

## 1. Requirement Analysis

**Description.** The Admin Console redesign produced three kinds of documentation —
design specs, traceability matrices, and manual E2E test suites — but each ticket
(`TASK-371`, `TASK-372`, `TASK-379`–`TASK-384`) kept its own copy inside its
`docs/implementation/TASK-3XX-*/` folder. There was no single place to read "the
admin design system", "what's built vs. gap", or "the manual QA suite". This ticket
**aligns** those deliverables into canonical central homes.

**Business context.** QA/QC engineers, designers, and reviewers need one stable,
discoverable location per concern instead of hunting through ticket folders. Per-ticket
folders remain the historical record (plan + change history); the *living* design/QA
artifacts move to shared homes.

**Acceptance criteria.**
- Admin frontend design specs live under `docs/designs/admin/` (one file per surface + an index).
- Traceability matrices / requirement mappings live under `docs/qa/traceability/` (per-surface + a master index).
- Manual end-to-end test suites live under `docs/qa/manual-tests/` (numbered surface suites + the existing index).
- Old per-ticket paths still resolve (replaced by **stubs** that point to the new home).
- Ticket READMEs and the E2E/QA conventions doc point at the new homes.
- No content lost; all relative links still valid.

## 2. Current State Evaluation (before)

| Concern | Where it lived (per ticket) |
|---|---|
| Design spec | `docs/implementation/TASK-3XX-*/DESIGN-SPEC.md` (+ `TASK-371/UNBUILT-SURFACES-DESIGN.md`) |
| Traceability | `docs/implementation/TASK-3XX-*/TRACEABILITY-MATRIX.md` (master in `TASK-371`) |
| Manual E2E | `docs/implementation/TASK-3XX-*/MANUAL-E2E-TESTS.md` |

Constraints discovered:
- **`theme.css`** (canonical tokens) sits in `TASK-371-Admin-Console-Redesign/` and is
  referenced by `.cursor/rules/11-ux-ui-principles.mdc` / `12-design-workflow.mdc`.
  Moving it would break rule references → **kept in place**, links updated to point at it.
- **TC-ID collision**: TASK-379 (tenant detail) and TASK-380 (tenant dashboard) both used
  the `TD-` manual-test prefix → had to disambiguate before merging into one suite.
- **Screenshots**: per-ticket `screenshots/` folders stay with their tickets (not design source).

## 3. Approach

- **Move, don't copy.** Relocate each living doc to its central home and replace the
  original with a **stub** (`# Moved — TASK-385 docs alignment` + pointer + home table).
- **Granularity.** One file per surface in `docs/designs/admin/` and `docs/qa/traceability/`;
  numbered surface suites (`03`–`09`) in `docs/qa/manual-tests/` alongside the original
  requirement-based suites (`01`–`02`).
- **Indexes.** New `docs/designs/admin/README.md` (taxonomy + tokens + surface map); the
  relocated TASK-371 master matrix becomes `docs/qa/traceability/README.md`; the existing
  `docs/qa/manual-tests/README.md` is extended with the new suites.
- **Link hygiene.** Every relocated doc had its relative links rewritten for the new depth
  (e.g. `./theme.css` → `../../implementation/TASK-371-Admin-Console-Redesign/theme.css`).
- **Parallelism.** Seven sub-agents each owned one ticket's three docs (move + rewrite +
  stub + ticket-README link update); the coordinator owned the indexes, the conventions
  doc, and this record.

## 4. Implementation Summary

### 4.1 Design specs → `docs/designs/admin/`

| New file | Relocated from | Tier |
|---|---|---|
| [`README.md`](../../designs/admin/README.md) | _new index_ | — |
| [`unbuilt-super-admin-surfaces.md`](../../designs/admin/unbuilt-super-admin-surfaces.md) | `TASK-371/UNBUILT-SURFACES-DESIGN.md` | 10–19 |
| [`shared-components.md`](../../designs/admin/shared-components.md) | `TASK-372/DESIGN-SPEC.md` | 20–29 |
| [`tenant-detail.md`](../../designs/admin/tenant-detail.md) | `TASK-379/DESIGN-SPEC.md` | 30–49 |
| [`tenant-dashboard.md`](../../designs/admin/tenant-dashboard.md) | `TASK-380/DESIGN-SPEC.md` | 30–49 |
| [`users-management.md`](../../designs/admin/users-management.md) | `TASK-381/DESIGN-SPEC.md` | 30–49 |
| [`agent-management.md`](../../designs/admin/agent-management.md) | `TASK-382/DESIGN-SPEC.md` | 30–49 |
| [`platform-dashboard-monitoring.md`](../../designs/admin/platform-dashboard-monitoring.md) | `TASK-383/DESIGN-SPEC.md` | 10–19 |
| [`responsive.md`](../../designs/admin/responsive.md) | `TASK-384/DESIGN-SPEC.md` | 00–09 |

### 4.2 Traceability → `docs/qa/traceability/`

| New file | Relocated from |
|---|---|
| [`README.md`](../../qa/traceability/README.md) (master) | `TASK-371/TRACEABILITY-MATRIX.md` |
| [`shared-components.md`](../../qa/traceability/shared-components.md) | `TASK-372/TRACEABILITY-MATRIX.md` |
| [`tenant-detail.md`](../../qa/traceability/tenant-detail.md) | `TASK-379/TRACEABILITY-MATRIX.md` |
| [`tenant-dashboard.md`](../../qa/traceability/tenant-dashboard.md) | `TASK-380/TRACEABILITY-MATRIX.md` |
| [`users-management.md`](../../qa/traceability/users-management.md) | `TASK-381/TRACEABILITY-MATRIX.md` |
| [`agent-management.md`](../../qa/traceability/agent-management.md) | `TASK-382/TRACEABILITY-MATRIX.md` |
| [`platform-dashboard-monitoring.md`](../../qa/traceability/platform-dashboard-monitoring.md) | `TASK-383/TRACEABILITY-MATRIX.md` |
| [`responsive.md`](../../qa/traceability/responsive.md) | `TASK-384/TRACEABILITY-MATRIX.md` |

### 4.3 Manual E2E → `docs/qa/manual-tests/`

| New file | TC prefix | Relocated from |
|---|---|---|
| [`03-shared-components.md`](../../qa/manual-tests/03-shared-components.md) | _(QA checklist)_ | `TASK-372/MANUAL-E2E-TESTS.md` |
| [`04-tenant-detail.md`](../../qa/manual-tests/04-tenant-detail.md) | `TD-` | `TASK-379/MANUAL-E2E-TESTS.md` |
| [`05-tenant-dashboard.md`](../../qa/manual-tests/05-tenant-dashboard.md) | `TDB-` *(was `TD-`)* | `TASK-380/MANUAL-E2E-TESTS.md` |
| [`06-users-management.md`](../../qa/manual-tests/06-users-management.md) | `T381-` | `TASK-381/MANUAL-E2E-TESTS.md` |
| [`07-agent-management.md`](../../qa/manual-tests/07-agent-management.md) | `T382-` | `TASK-382/MANUAL-E2E-TESTS.md` |
| [`08-platform-dashboard-monitoring.md`](../../qa/manual-tests/08-platform-dashboard-monitoring.md) | `PDM-` | `TASK-383/MANUAL-E2E-TESTS.md` |
| [`09-responsive.md`](../../qa/manual-tests/09-responsive.md) | `RSP-` | `TASK-384/MANUAL-E2E-TESTS.md` |

Suites `01-multi-tenancy-management.md` / `02-user-access-control.md` are the original
requirement-based suites and were left in place.

### 4.4 TC-ID collision fix

`TASK-380` (tenant dashboard) originally reused the `TD-` prefix already owned by
`TASK-379` (tenant detail). All of TASK-380's manual cases were renamed **`TD-` → `TDB-`**
(in `05-tenant-dashboard.md`, its traceability matrix, and the TASK-380 README) so the
merged suite has unique IDs. `TASK-379` keeps `TD-`.

### 4.5 Coordinator-owned edits

- **New:** `docs/designs/admin/README.md` (design index), this record.
- **Updated:** `docs/qa/manual-tests/README.md` (suite index §1, TC-ID scheme §3.2,
  surface-suites table §7), `docs/qa/E2E-AND-QA-CONVENTIONS.md` (deliverables now point at
  central homes; §5 lists the three indexes as coordinator-owned).
- **Stubs:** all 23 original per-ticket docs replaced with redirect stubs; each ticket's
  `README.md` link list updated to the central paths.

### 4.6 Deliberately not moved

| Item | Reason |
|---|---|
| `theme.css` | Referenced by `.cursor/rules/*.mdc`; moving breaks rules. Links point at it in place. |
| Per-ticket `screenshots/` | Implementation evidence, not living design source. |
| `01`/`02` manual suites | Original requirement-based suites, already central. |

## 5. Verification

- Central homes present: `docs/designs/admin/` (index + 8 specs), `docs/qa/traceability/`
  (master + 7 matrices), `docs/qa/manual-tests/` (index + `01`–`09`).
- All 23 original docs are stubs pointing to the central home.
- Relative links from relocated docs re-resolved for the new depth; conventions + ticket
  READMEs updated.

## 6. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-30 | Initial alignment: relocate design/traceability/manual docs for TASK-371/372/379–384 into central homes; add indexes; stub originals; fix `TD-`/`TDB-` collision; update conventions. | `docs/designs/admin/*`, `docs/qa/traceability/*`, `docs/qa/manual-tests/*`, `docs/qa/E2E-AND-QA-CONVENTIONS.md`, `docs/implementation/TASK-3XX-*/{README,DESIGN-SPEC,TRACEABILITY-MATRIX,MANUAL-E2E-TESTS}.md` |
