# TASK-486 — `@arcaai/vox` Typecheck Cleanup (Pre-existing Test-File Errors Redden the Quality Gate)

- **Status**: Review — fixed + verified (`fix/2605-review`; 4 test files, +15/−12; `typecheck` exit 0)
- **Type**: bugfix (test-only type hygiene — restores a red quality gate to green)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Discovered during the SOTA enhancement track (2026-07-10)
- **Origin**: [TASK-464](../TASK-464-SDK-Provider-Drop-Surfacing/README.md) + [TASK-461](../TASK-461-SDK-Reconnect-UX-Wire-Contract/README.md) reviews — both touch `@arcaai/vox` and both hit the same pre-existing `typecheck` failure while verifying their `build lint test typecheck` gate.
- **Finding + severity**: **Low** — ~10 **pre-existing** TypeScript errors in 4 **untouched** test files leave `pnpm --filter @arcaai/vox typecheck` **RED**. Proven pre-existing (identical with the SOTA changes stashed) and unrelated to any merged ticket, but they mean the `@arcaai/vox` `typecheck` quality gate (rule 13 definition-of-done: `build lint test`, and `typecheck` per the SDK DoD) cannot go green on `fix/2605-review` until fixed.
- **Size**: S
- **Suggested agent**: `tester` (TS / Vitest) — narrow, test-file-only type fixes; no runtime/`src` behavior change.

## Requirement Analysis

The `@arcaai/vox` definition-of-done requires a green `typecheck` (`pnpm --filter @arcaai/vox build test lint typecheck`; see `.claude/rules/08-vox-sdk.md` §Testing & Verification and rule 13 gates). It is currently RED because of pre-existing type errors in four test files that no remediation ticket introduced. Because the errors sit in the shared SDK gate, every SDK-touching ticket (TASK-461, TASK-464, and the SOTA SDK work) inherits a red gate it did not cause. Fix the ~10 errors so the gate is green; do not alter runtime `src` behavior.

### Acceptance criteria

- [ ] **AC-1**: `pnpm --filter @arcaai/vox typecheck` (`tsc --noEmit`) exits **0** — all errors below resolved.
- [ ] **AC-2**: fixes are confined to the **test files** (and, if strictly necessary, test-only type helpers) — no change to shipped `src` runtime behavior; the fixes are type-correctness only (proper casts/guards/error-code values), not `@ts-expect-error` blanket suppressions unless a suppression is the genuinely correct, narrowly-scoped choice.
- [ ] **AC-3**: `pnpm --filter @arcaai/vox test` stays green (the same suites still pass after the type fixes) and `build`/`lint` remain green — the full SDK DoD gate goes green.
- [ ] **AC-4**: evidence (the passing `typecheck` + `test` output) pasted into §Implementation Summary.

### Non-goals

- Any `src`/runtime change to the SDK (this is test-type hygiene only).
- Broadening the `AgenticErrorCode` union or reshaping public types to accommodate a test (fix the test to the real contract, unless the union is genuinely missing a legitimate code — call that out explicitly if so).
- The CommonJS-vs-ESM build config itself (the `bundle-externals` `import.meta` error is fixed at the test-file level, not by changing `tsup`/module output).

## Current State Evaluation (code-verified — `pnpm --filter @arcaai/vox typecheck`, run 2026-07-10 on `fix/2605-review`)

`tsc --noEmit` fails with **Exit status 2** and the following **10 errors across 4 files** (verbatim):

```
src/__tests__/bundle-externals.task364.test.ts(32,36): error TS1470: The 'import.meta' meta-property is not allowed in files which will build into CommonJS output.
src/core/__tests__/SttV2WebSocketClient.test.ts(334,15): error TS2352: Conversion of type 'string | ArrayBufferLike' to type 'Int16Array<ArrayBufferLike>' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
src/hooks/__tests__/useHarnessAdmin.test.ts(123,56): error TS2345: Argument of type '"SERVICE_UNAVAILABLE"' is not assignable to parameter of type 'AgenticErrorCode'.
src/utils/__tests__/promptMetrics.test.ts(31,12): error TS2532: Object is possibly 'undefined'.
src/utils/__tests__/promptMetrics.test.ts(32,12): error TS2532: Object is possibly 'undefined'.
src/utils/__tests__/promptMetrics.test.ts(34,12): error TS2532: Object is possibly 'undefined'.
src/utils/__tests__/promptMetrics.test.ts(38,12): error TS2532: Object is possibly 'undefined'.
src/utils/__tests__/promptMetrics.test.ts(39,12): error TS2532: Object is possibly 'undefined'.
src/utils/__tests__/promptMetrics.test.ts(44,12): error TS18048: 'scores' is possibly 'undefined'.
src/utils/__tests__/promptMetrics.test.ts(45,12): error TS18048: 'scores' is possibly 'undefined'.
```

Grouped by file (all under `packages/agentic-sdk-v2/`):

| File | Error(s) | Line(s) | Kind |
|---|---|---|---|
| `src/__tests__/bundle-externals.task364.test.ts` | TS1470 | 32:36 | `import.meta` used in a file that builds to CommonJS output. |
| `src/core/__tests__/SttV2WebSocketClient.test.ts` | TS2352 | 334:15 | Bad direct cast `string \| ArrayBufferLike` → `Int16Array` (needs `as unknown as …` or a proper buffer view). |
| `src/hooks/__tests__/useHarnessAdmin.test.ts` | TS2345 | 123:56 | `"SERVICE_UNAVAILABLE"` passed where an `AgenticErrorCode` is required — either not a member of the union or needs the correct code. |
| `src/utils/__tests__/promptMetrics.test.ts` | TS2532 ×5, TS18048 ×2 | 31, 32, 34, 38, 39 (TS2532); 44, 45 (TS18048 `scores`) | Possibly-`undefined` access — needs non-null assertions / guards after the lookups. |

**Pre-existing determination:** per the TASK-464 and TASK-461 reviews these errors are identical with the SOTA changes stashed (i.e. present on the base tree, not introduced by any merged remediation ticket). The four files are untouched by the merged tickets. This ticket only makes the standing gate green.

## File-ownership manifest (proposed — confirm on assignment)

| File | Expected change |
|---|---|
| `packages/agentic-sdk-v2/src/__tests__/bundle-externals.task364.test.ts` | Resolve the `import.meta` (TS1470) in a CommonJS-targeted test — read the module value without `import.meta`, or scope it so `tsc` accepts it. |
| `packages/agentic-sdk-v2/src/core/__tests__/SttV2WebSocketClient.test.ts` | Fix the `Int16Array` cast at ~`:334` (`as unknown as Int16Array` or construct a real view). |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useHarnessAdmin.test.ts` | Use a valid `AgenticErrorCode` at `:123` (or, if `SERVICE_UNAVAILABLE` is a legitimate missing code, surface that decision — do not silently widen the union in a test). |
| `packages/agentic-sdk-v2/src/utils/__tests__/promptMetrics.test.ts` | Guard/assert the possibly-`undefined` accesses at lines 31/32/34/38/39/44/45. |

Test files only. Any need to touch SDK `src` types → STOP and report to the orchestrator (it would make this more than a test-hygiene ticket).

## Implementation Summary

Fixed (test-only, surgical — 4 files, +15/−12; no `src`/runtime change):

- **TS1470** `bundle-externals.task364.test.ts:32` — replaced `dirname(fileURLToPath(import.meta.url))` with `__dirname` (CommonJS-valid under `module: NodeNext`; matches sibling suites) and removed the now-orphaned `fileURLToPath`/`dirname` imports.
- **TS2352** `SttV2WebSocketClient.test.ts:334` — `as Int16Array` → `as unknown as Int16Array` (mock `sent` is `string | ArrayBufferLike`; AC-2-sanctioned cast).
- **TS2345** `useHarnessAdmin.test.ts:123,132` — `SERVICE_UNAVAILABLE` is genuinely NOT in the `AgenticErrorCode` union; the real contract (`classifyHttpError`, `errorUtils.ts:104`) maps 5xx → `API_ERROR`, so the constructed error + `.code` assertion were corrected to `API_ERROR`. The union was **not** widened (the test was wrong, not the type).
- **TS2532 ×5 / TS18048 ×2** `promptMetrics.test.ts` — non-null assertions at the 7 sites; `toPromptTestMetricScores` only returns `undefined` for `null`/`undefined` input, and every call here passes a real object.

No `any` / `@ts-ignore` / `@ts-expect-error`. SDK invariants preserved (no store-object exports, public accessors untouched, no entry-point/`"use client"` change).

**Gates (verified in the main tree on merge, not just the worktree):** `pnpm --filter @arcaai/vox typecheck` → **exit 0, 0 errors** (AC-1). Agent-run in-worktree: `build` exit 0, `lint` exit 0 (0 errors; 71 pre-existing `prettier/prettier` warnings, none in the 4 touched files), `test` 198 files / 3517 passed (AC-3).

**Out-of-scope observation (left untouched):** `src/hooks/useHarnessAdmin.ts:146` doc-comment still says "rejects with SERVICE_UNAVAILABLE when the harness is down" — stale vs the real `API_ERROR` contract, but a `src` edit is a non-goal; flagged for a possible follow-up doc tidy.

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | **Fixed + verified (test-only, surgical) on `fix/2605-review`.** All 10 errors across the 4 test files resolved per §Implementation Summary (TS1470 `import.meta`→`__dirname`; TS2352 `as unknown as Int16Array`; TS2345 `SERVICE_UNAVAILABLE`→`API_ERROR` faithful to the 5xx→`API_ERROR` contract, union untouched; TS2532/TS18048 non-null assertions). `pnpm --filter @arcaai/vox typecheck` exit 0 re-verified in the main tree at merge; build/lint/test green in-worktree (3517 tests). No `src` runtime change; SDK invariants preserved. Flagged the stale `useHarnessAdmin.ts:146` doc-comment as an out-of-scope follow-up. Status → Review. |
| 2026-07-10 | Ticket scaffolded from the TASK-464 + TASK-461 reviews. Ran `pnpm --filter @arcaai/vox typecheck` on `fix/2605-review` and captured the exact 10 errors / 4 files / Exit status 2 (verbatim above): `bundle-externals.task364.test.ts:32` (TS1470 import.meta), `SttV2WebSocketClient.test.ts:334` (TS2352 Int16Array cast), `useHarnessAdmin.test.ts:123` (TS2345 `SERVICE_UNAVAILABLE` not an `AgenticErrorCode`), `promptMetrics.test.ts` (TS2532 ×5 + TS18048 ×2 at lines 31/32/34/38/39/44/45). Noted the errors are proven pre-existing (identical with SOTA changes stashed) and unrelated to any merged ticket, but leave the `@arcaai/vox` `typecheck` gate RED. Status → Pending. |
