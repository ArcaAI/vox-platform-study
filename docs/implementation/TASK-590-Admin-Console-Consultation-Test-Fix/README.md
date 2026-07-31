# TASK-590 — Admin Console Consultation Screen Test Fix

| Field | Value |
|---|---|
| **Status** | Review — implementation complete; CI verification pending |
| **Type** | bugfix (CI test regression) |
| **Surface** | `apps/admin-console` — `ConsultationDemoScreen` |
| **Related** | TASK-543 (Consultation Scribe Playground) |

## Requirement Analysis

The GitLab admin-console test job fails in the test stage before the image build. Two `ConsultationDemoScreen` tests cannot find the expected `Consultations`, `Live session`, and `Case note` landmarks, while the remaining admin-console tests pass. The fix must preserve the SDK-backed column-layout settings behavior and leave the image build unblocked.

## Current State Evaluation

The three column components already render the expected accessible section landmarks. The screen currently waits for the asynchronous SDK settings read before mounting the resizable panel group. The existing failing tests are the regression evidence: the expected workspace never becomes queryable in CI.

## Implementation Plan

1. Reproduce the targeted screen failure and inspect the render boundary, layout persistence hook, and test doubles.
2. Add the smallest readiness fix that keeps the workspace renderable while retaining best-effort persisted layout loading.
3. Run the targeted test, admin-console typecheck/lint, and the full admin-console test command where the local dependency state permits.
4. Record actual verification output and changed files here.

## Implementation Summary

- `ConsultationDemoScreen` now mounts the three-column workspace immediately with the default layout instead of blocking on the best-effort settings read.
- The panel group remounts once the settings read settles, allowing valid persisted sizes to apply without delaying the consultations, live session, and case-note landmarks.
- Added a regression test proving that the workspace renders while `useUserSettings().list()` is pending.

### Files Changed

- `apps/admin-console/src/features/playground-consultation/components/consultation-demo-screen.tsx`
- `apps/admin-console/src/features/playground-consultation/components/__tests__/consultation-demo-screen.test.tsx`
- `apps/admin-console/src/features/playground-consultation/hooks/use-column-layout.ts`

### Verification

- `git diff --check` — passed.
- Targeted Vitest run — blocked locally before test collection because the checkout has stale/incomplete dependencies; `vitest-axe/matchers` is unavailable and local Vitest is 4.1.1 while the lockfile resolves 4.1.9.
- Admin-console typecheck — blocked by the same dependency state (`next`, React, workspace packages, and test declarations unavailable).
- Admin-console lint — blocked before linting because `@eslint/compat` is unavailable.
- CI must rerun the admin-console test job with the lockfile-installed dependency tree before the image build.

## Change History

- 2026-07-31 — Ticket created after CI reported two failing `ConsultationDemoScreen` tests. Plan approved by the user. Initially assigned as TASK-586 before the updated `dev-2.1` history revealed TASK-586–589; corrected to TASK-590 before publication. Status In Progress.
- 2026-07-31 — Workspace readiness fix and pending-settings regression test implemented. Local `git diff --check` passed; test/typecheck/lint execution was blocked by stale incomplete `node_modules`. Status Review.
