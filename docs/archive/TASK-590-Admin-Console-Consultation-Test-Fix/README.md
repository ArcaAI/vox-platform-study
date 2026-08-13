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

The three column components already render the expected accessible section landmarks. The updated `ConsultationDemoScreen` also calls the newly added SDK hook `useArcaSttLanguageModes()`, but the screen test's `@arcaai/vox` boundary mock did not expose that hook. The component therefore failed before rendering, leaving Testing Library with an empty DOM.

## Implementation Plan

1. Reproduce the targeted screen failure and inspect the render boundary, new SDK hook usage, and test double.
2. Add the missing `useArcaSttLanguageModes` SDK mock with the hook's empty-catalog contract.
3. Run the targeted test, admin-console typecheck/lint, and the full admin-console test command where the local dependency state permits.
4. Record actual verification output and changed files here.

## Implementation Summary

- Updated the `@arcaai/vox` mock in `consultation-demo-screen.test.tsx` to include `useArcaSttLanguageModes()` with an empty catalog, idle loading state, null error, and no-op refresh.
- This keeps the test boundary aligned with the production SDK surface added by TASK-587 and allows the screen to reach its three accessible column landmarks.

### Files Changed

- `apps/admin-console/src/features/playground-consultation/components/__tests__/consultation-demo-screen.test.tsx`

### Verification

- `git diff --check` — passed.
- Targeted Vitest run — blocked locally before test collection because the checkout has stale/incomplete dependencies; `vitest-axe/matchers` is unavailable and local Vitest is 4.1.1 while the lockfile resolves 4.1.9.
- Admin-console typecheck — blocked by the same dependency state (`next`, React, workspace packages, and test declarations unavailable).
- Admin-console lint — blocked before linting because `@eslint/compat` is unavailable.
- CI must rerun the admin-console test job with the lockfile-installed dependency tree before the image build.

## Change History

- 2026-07-31 — Ticket created after CI reported two failing `ConsultationDemoScreen` tests. Plan approved by the user. Initially assigned as TASK-586 before the updated `dev-2.1` history revealed TASK-586–589; corrected to TASK-590 before publication. Status In Progress.
- 2026-07-31 — Root cause identified after the updated `dev-2.1` code added `useArcaSttLanguageModes` without extending the screen test mock. Added the missing SDK mock. Local test/typecheck/lint execution remains blocked by stale incomplete `node_modules`. Status Review.
