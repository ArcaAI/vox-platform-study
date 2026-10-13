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

### Findings (out of scope — not fixed here)

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
