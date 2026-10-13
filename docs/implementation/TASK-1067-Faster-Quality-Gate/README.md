# TASK-1067 — Faster orchestrator quality gate

**Status:** Review · **Type:** refactor (tooling / test infra) · **Branch:** dev-2.2

## Requirement Analysis

The orchestrator gate took ~22 min (sum of its steps, serial) and a lint error surfaced only at
the very end. Owner asked to rewrite the gate and apply every speed best practice found in the
review of a real run (2026-10-12).

Owner decisions (2026-10-12): ticket TASK-1067 · split `sharp` into its own forks project ·
clean build in CI only · pytest-xdist workers ON by default.

## Current State Evaluation

| Finding | Evidence |
|---|---|
| Duplicate suites: domains / applications / admin-console / vox ran alone AND again inside `pnpm test:unit` | gate log: `apps-test` 199 s + `test-unit` 273 s |
| Lint ran last | 1 lint error reported after ~20 min |
| Everything serial, incl. three independent Python suites | harness 266 s, text 180 s, guardrail 22 s |
| Vitest time is import, not tests | `import 94%, tests 2%` |
| `@arcaai/applications build` always `rimraf`s → never incremental | `Cached: 0`; clean 15 s vs incremental 4 s |
| Root `workspace` project pinned to `pool: 'forks'` for ONE file | `image-thumbnail.service.test.ts` exercises real `sharp` (libvips segfaults under worker_threads); `sharp` is lazily imported, so no other file loads it |
| Flaky audit test | `consultation-read.service.task1038.test.ts` asserted the whole event JSON lacks `"54"` — the event's random UUID can contain it |

## Implementation Plan

1. `scripts/gate.sh` — fast phase first (parallel, stop on red), build + artifacts, parallel tests,
   `--changed` mode, summary table. Drop the duplicate steps.
2. Fix the flaky assertion (scope it to `viewed.data`).
3. Vitest: move `image-thumbnail.service.test.ts` to a `workspace-native` project on `forks`;
   the `workspace` project goes to `threads`. Measure `isolate: false` and adopt it only if green.
4. `@arcaai/applications build`: `rimraf` only when `CI` is set; `build:clean` for a manual clean.
5. Python: `-n 4` by default in the gate; record `--durations` hot spots.
6. Persistent Vitest transform cache (`fsModuleCache`, stable in Vitest 5) on the root, console and vox configs.
7. Per-step watchdog in the gate + pytest `faulthandler_timeout`, so a hang fails instead of blocking.

Verification: full gate green; before/after timings recorded below.

## Implementation Summary

### Measurements (same machine, 2026-10-12/13)

| Suite | Before | After | Change |
|---|---|---|---|
| Root `workspace` Vitest (2,442 files) | 293 s (`forks`) | 230 s (`threads`) → **189 s** (+ warm `fsModuleCache`; cold 208 s) | −36% |
| harness unit | 266 s | **70 s** (`-n 4`) | −74% |
| text unit | 180 s | 68 s (`-n 4`) → **39 s** (+ zero backoff) | −78% |
| guardrail | 22 s | **10 s** | −55% |
| `@arcaai/applications build` | 15 s every time | **4 s** incremental (15 s with `CI=true`) | −73% |
| **Gate wall-clock** | ~22 min serial, lint verdict at the END | **413 s (6.9 min)**; lint verdict at 19 s | **−69%** |

Rejected: `isolate: false` — the workspace run passed 600 s (2.6× slower) and was stopped.
Not done: rewriting barrel imports — the 176 test files that import `@arcaai/applications` reach it
through the controllers anyway, so a test-only rewrite removes nothing; `fsModuleCache` addresses
the same cost without touching source.

Final gate run (2026-10-13): every step green except `ts-unit`, whose only failures are the two
pre-existing admin-console tests listed under Findings (workspace 2,440/2,440 files, vox 237/237).

### Files changed

| File | Change |
|---|---|
| `scripts/gate.sh` | NEW — the phased, parallel gate (`--changed`, `--keep-going`, `GATE_STEP_TIMEOUT`, `PY_WORKERS`) |
| `vitest.config.ts` | `workspace` → `threads`; new `workspace-native` (`forks`) project for `NATIVE_ADDON_SUITES`; `include` moved per project; `fsModuleCache: true` |
| `apps/admin-console/vitest.config.ts`, `packages/agentic-sdk-v2/vitest.config.ts` | `fsModuleCache: true` |
| `packages/applications/package.json` | `build` cleans only when `CI` is set; `build:clean` added |
| `packages/applications/.../consultation-read.service.task1038.test.ts` | flaky assertion scoped to `viewed.data` |
| `apps/text/src/text/tests/conftest.py`, `apps/text/pyproject.toml`, `.../test_retry_and_timeout.py` | autouse zero-backoff stub + `real_backoff` opt-out marker |

### Findings (fixed in the follow-up — see Change History 2026-10-13 b)

| Finding | Evidence |
|---|---|
| `harness` `test_consultation_loop_workflow.py::TestCheckpointing::test_continue_as_new_preserves_state_across_the_checkpoint` hangs intermittently under CPU load (2 of 4 loaded runs; never alone) | idle event loop in `handle.result()`, time-skipping env; workflow's checkpoint guard looked correct — likely the test server/harness. The gate's watchdog now turns it into a FAIL |
| 2 admin-console tests fail on HEAD, independent of this ticket | `app-sidebar.test.tsx` (gated entries), `findings-list.asr-warnings.task1048.test.tsx` (`No QueryClient set`) — fail with the original config too |
| text `test_semaphore_timeout_returns_503` waits the real 30 s | `_SEMAPHORE_ACQUIRE_TIMEOUT` is a function-local constant in `generate.py`, not injectable |
| harness `test_phi_redactor.py::test_redacts_name_phone_mrn_dob` ~11 s | model/recogniser load per test |

## Change History

- 2026-10-12 — ticket opened; gate script rewritten; flaky test fixed; CI-only clean.
- 2026-10-13 — threads + `workspace-native` split, `fsModuleCache`, pytest-xdist, text zero-backoff stub,
  step watchdog; full gate measured at 413 s. Status → Review.
- 2026-10-13 b — the three findings fixed; full gate GREEN 10/10 in 517 s.
  - **harness hang** — root cause: under load the time-skipping test server marks the first run
    `CONTINUED_AS_NEW` but leaves its history without the closing event (ends at a
    `WorkflowTaskStarted`; SDK logs "Task not found when completing ... already completed"), so
    `handle.result()` following the chain from that run long-polls forever. The workflow itself
    completed correctly (`phase=DONE`, counts as asserted). Fix: `result_of_current_run()` in
    `_temporal_sync.py` reads the CURRENT run's result (typed, time skipping unlocked via the test
    service). Hammer under full Vitest load: before 2 hangs in < 1 min; after 48/48 passed.
    `test_loop_lifecycle_bounds.py` was tried with the same helper and REVERTED — its run needs an
    idle timer, and the helper hung there (6/24) while the original `handle.result()` passed 48/48.
  - **admin-console** — both were stale tests, not regressions: `app-sidebar.test.tsx` still expected
    "Tools & MCP", which TASK-1065 locked off (`LOCKED_OFF_GATES`); `FindingsList` gained a catalog
    query, so its test now uses `renderWithProviders` with a stubbed `fetch`.
  - **text 30 s wait** — `_SEMAPHORE_ACQUIRE_TIMEOUT` moved to module level (value unchanged); the
    test patches it to 0.2 s.
- 2026-10-13 c — real root cause of the harness hang, and the timer case.
  - The trigger is a QUERY racing the `continue_as_new` handover: the test then leaves the first run's
    history without its closing event, `handle.result()` long-polls it forever, and the dangling
    workflow task also stops time skipping — which is why the earlier `result_of_current_run()`
    workaround hung on the idle-timer test (server time never advanced past the 3,600 s bound).
    `test_loop_lifecycle_bounds.py` at HEAD never queries, which is why it was always 48/48.
  - Fix: `await_continued_as_new()` (`_temporal_sync.py`) waits for the handover with `describe()`,
    which the server answers without the worker; the consultation test calls it BEFORE its state
    query and is back on the plain `handle.result()`. `result_of_current_run()` is removed.
  - Proof under full Vitest load, 6 parallel loops × 8: both checkpoint tests 48/48 runs (96
    executions), no hangs; a describe-wait + timer debug variant 48/48; harness unit 3843 passed.
- 2026-10-13 d — local coverage reports. `scripts/gate.sh` collects coverage by default on a full
  run (`--no-coverage` skips; off for `--changed` unless `--coverage`), reports in `coverage/gate/`
  (gitignored) plus a per-suite totals table. Python: the pyprojects' existing `--cov` plus gate
  json/html/xml reports. TS: V8 provider with `--pool=forks` — istanbul made the unit run 787 s and
  timed out 13 tests; V8 under `threads` died with SIGBUS (even a quarter shard). Root coverage
  `include` gained `apps/api/src/**`. `dotenv` is called as `pnpm exec dotenv` (bare `dotenv` resolves
  to python-dotenv's CLI from the conda env). Full gate on HEAD 9c3462353: GREEN 10/10, 587 s.
  Coverage: workspace 80.9% lines · admin-console 85.9% · vox 87.2% · database 77.4% · harness 89.7% ·
  text 92.4% · guardrail 92.3%.
- 2026-10-13 e — database package coverage 77.4% → 81.4% lines, 70.6% → 75.9% branches,
  83.2% → 87.4% functions (132 files / 2528 tests green). Targeted the security-relevant gaps, each
  new test proven by a mutation that it catches:
  - `src/client.ts` 76.9 → 100% — soft-delete filter on `findFirst`/`count`/`aggregate`/`groupBy`
    (`client.softDelete.read-ops.test.ts`); dropping the `count` filter now fails 2 tests.
  - `src/extensions/tenant-scope.ts` 89.1 → 100% — no-tenant-context throw / super-admin pass-through /
    unscoped model for every write op, upsert pinning both branches, provider without
    `isSuperAdmin` fails closed. Removing the update/delete throw (an unscoped cross-tenant write)
    used to pass the whole suite; it now fails 4 tests.
  - `seed/phi-encryption.ts` 66.7 → 100% — AppRole wrapped/direct login, every fail-closed branch,
    empty ciphertext, key-version fallback, null/empty values, JSON fields.
  - `scripts/decrypt-row.ts` 48.6 → 91.1% and `scripts/dna-phi-scan.ts` 54.0 → 94.2% — `main()` end to
    end with mocked Vault + Prisma: read-only, always disconnects, refuses without Vault, and the scan
    never prints decrypted text (a mutation that leaks it fails).
  - Found, not fixed: `@arcaai/database` has no `lint` script and no ESLint config.
- 2026-10-13 f — `@arcaai/database` gets `lint` / `lint:fix` and an `eslint.config.mjs` (the
  `library` preset, as `packages/domains`); turbo `pnpm lint` — and so the gate — now covers it.
  0 errors; the 7 undescribed `eslint-disable` directives got their reasons. Left: ~10,294
  `prettier/prettier` warnings (180 of 241 files were never Prettier-formatted — a reformat is held
  for an owner decision) and 3 pre-existing warnings (two unused constants, one `any`).
  Runbook: `docs/operations/testing/test-execution.md` rewritten around `scripts/gate.sh` — gate,
  unit, integration, E2E, Python, coverage, troubleshooting — every command checked against
  `package.json`; the testing README links it.
