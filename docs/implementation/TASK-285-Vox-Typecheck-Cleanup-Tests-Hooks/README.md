# TASK-285: Vox SDK Typecheck Cleanup — Hook Test Fixtures

- **Ticket**: TASK-285
- **Title**: `@arcaai/vox` hook `__tests__/` fixture cleanup (Wave-2B C3c slice)
- **Created**: 2026-05-24
- **Updated**: 2026-05-24
- **Status**: Completed
- **Branch**: `fix/2605-review`
- **Parent ticket**: [TASK-262 — Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md)
- **Related tickets**:
  - [TASK-283 — Vox Typecheck Cleanup, Source Files](../TASK-283-Vox-Typecheck-Cleanup-Source/README.md) — sibling C3a slice that landed first
  - [TASK-279 — ROLE Endpoints Split](../TASK-279-ROLE-Endpoints-Split/README.md) and [TASK-280 — CrossTab HMAC SharedWorker](../TASK-280-CrossTab-HMAC-SharedWorker/README.md) — earlier Wave-2 work that originally surfaced the typecheck drift

## Requirement Analysis

### Description

After C3a (TASK-283) landed, `pnpm --filter @arcaai/vox typecheck` reported **127 remaining errors**, all in test files. The user's `decompose_4` plan splits the test-file cleanup into three parallel slices that touch non-overlapping files:

- **C3b** — store / core / integration / mock test files.
- **C3c (this ticket)** — `src/hooks/__tests__/` slice, **21 errors across 9 files**.
- **C3d** — `useArca.api.test.ts`, exports tests, logger transport tests.

The C3c slice fixes fixture drift in hook test files — the source-of-truth hook return types (`UseArcaSession`, `UseArcaSummary`, `UseArcaAudio`, etc.) are stable after C3a, but the test-side mocks declare narrower literal types (`null` instead of `T | null`, `vi.fn(() => null)` instead of a widened mock return) that reject the values being assigned at runtime.

### Business context

- Wave-2 needs `pnpm typecheck` to be a usable signal again. C3a restored signal in source; C3c restores it in the hook test layer.
- All test files in scope already pass Vitest at runtime — these are pure type-system fixes against fixture mocks.
- Pure type-cleanup; **no runtime behaviour change**, no DB change, no API change, no source-file change.

### Acceptance criteria

1. Slice errors (`src/hooks/__tests__/*.test.{ts,tsx}` excluding `useArca.api.test.ts`) drop from **21 → 0**.
2. Full-package `pnpm typecheck` reduces by the slice contribution (21).
3. Vitest stays **2785/2785 green**.
4. `pnpm --filter @arcaai/vox build` stays green.
5. `pnpm --filter @arcaai/vox lint` stays **0 errors**.
6. No new dependencies, no `pnpm install`, no source-file changes, no destructive git ops, no PR/push.

## Current State Evaluation

### Pre-fix error inventory (21 errors, 9 files)

Captured from `/tmp/c3c-slice.log`:

| File | Count | Dominant kind |
|---|---|---|
| `src/hooks/__tests__/useArcaSession.dx.test.ts` | 6 | TS2322 — `consultation: null` literal cannot accept `Consultation`-shaped overrides |
| `src/hooks/__tests__/useArca.test.tsx` | 3 | TS2339 — `mockKnowledgePipeline` typed as `{}` (return of `?? defaultObj` when LHS is `unknown`) |
| `src/hooks/__tests__/useArca.summary.test.ts` | 3 | TS2352 (direct `Record<string, unknown>` cast) + TS2454 (variable used before assignment in `act` callback) |
| `src/hooks/__tests__/useArca.audio-pipeline.test.ts` | 3 | TS2345 — `getKnowledgePipeline.mockReturnValue` inferred return type `null` |
| `src/hooks/__tests__/useArcaAudio.test.ts` | 2 | TS18046 — `mockStore: ReturnType<typeof useAgenticStore>` widens to `unknown` |
| `src/hooks/__tests__/useDnaStyle.wsH.test.ts` | 1 | TS2353 — `promptTemplateId` excess-property check on `DnaGenerateInput` literal |
| `src/hooks/__tests__/useConsultationJob.test.ts` | 1 | TS2348 — `sseConstructorSpy: ReturnType<typeof vi.fn>` resolves to `Mock<Procedure ∣ Constructable>` (Vitest 2.x type union, not callable) |
| `src/hooks/__tests__/useArca.wsH.test.ts` | 1 | TS2322 — `apiClient` inferred as non-null mock-client literal, can't accept `null` |
| `src/hooks/__tests__/useArca.session.test.ts` | 1 | TS2352 — direct `as Record<string, unknown>` cast on a structured hook return |

### Root causes (recurring patterns)

1. **Literal-type narrowing on mock store fields.** `const m = { consultation: null, apiClient: null }` infers each field as the literal type `null`, so later spreads / assignments fail. Established fix in sibling tests is `null as <Shape> | null`.
2. **`vi.fn(() => null)` infers `Mock<() => null>`.** `.mockReturnValue(somePipeline)` then demands a `null`. Widening to `vi.fn<() => Shape | null>(() => null)` keeps the default value but accepts richer overrides.
3. **`ReturnType<typeof vi.fn>` in Vitest 2.x.** Resolves to `Mock<Procedure | Constructable>`. The union is neither callable nor newable without disambiguation; the slice uses `vi.fn<(...args: unknown[]) => void>()` to force the callable form.
4. **`ReturnType<typeof useAgenticStore>` resolves to `unknown`.** Zustand's `UseBoundStore` overloads pick the last signature for `ReturnType`, which is the selector form. The established codebase pattern (used by ~28 other hook tests) is `let mockStore: any;`.
5. **`X as Record<string, unknown>` direct cast.** TS 5.x requires `X as unknown as Record<string, unknown>` for structured hook return types that don't sufficiently overlap with `Record<string, unknown>`.
6. **Excess-property check on object literals.** `generate({ promptTemplateId: ... })` fails because `DnaGenerateInput` does not list `promptTemplateId` — yet the source forwards `input` verbatim to the POST body, so the runtime behaviour is correct. Extracting to a variable removes the excess-property check.
7. **`let x: T;` followed by assignment inside `await act(async () => { x = ... })`.** TS cannot statically prove the assignment ran. Using a definite-assignment assertion (`let x!: T;`) communicates the runtime contract.

### Out of scope (intentional)

- Any source file under `src/**` outside `__tests__/` (C3a's lane, already complete).
- C3b's lane: `src/store/__tests__/`, `src/__tests__/integration/`, `src/__tests__/mocks/`.
- C3d's lane: `useArca.api.test.ts`, `exports.*.test.ts`, `plugins.exports.test.ts`, `plugins-med-ner.exports.test.ts`, `stream-e-types.test.ts`, `src/core/logger/__tests__/*`.

## Implementation Plan

1. Fix files largest-to-smallest (6 → 3 → 3 → 3 → 2 → 1 → 1 → 1 → 1) so verification noise is visible at each step.
2. After each file, re-run `pnpm typecheck`, filter to the slice, confirm the file's count drops to 0.
3. Apply the smallest fixture cast that satisfies TS — never widen the source, never change a test assertion, never add `@ts-expect-error`.
4. Final gates: `pnpm typecheck` (slice 21 → 0), `pnpm test --run` (2785/2785), `pnpm build`, `pnpm lint` (0 errors).

### Per-file fix recipes

| File | Fix |
|---|---|
| `useArcaSession.dx.test.ts` | `consultation: null` → `consultation: null as Record<string, unknown> ∣ null` in `mockStoreDefaults` (matches the established pattern used by 4 sibling tests). |
| `useArca.test.tsx` | Narrow `setupAutoNERMocks` `overrides.knowledgePipeline` from `unknown` to `{ process: ReturnType<typeof vi.fn>; state: { isReady: boolean } } ∣ null` so `?? defaultPipeline` no longer widens to `{}`. |
| `useArca.summary.test.ts` | `result.current.summary as Record<string, unknown>` → `as unknown as Record<string, unknown>`. Declare `let diff!: { stats: { additions: number; deletions: number } }` so post-`act` reads are not flagged TS2454. |
| `useArca.audio-pipeline.test.ts` | `getTranscriptionPipeline / getKnowledgePipeline: vi.fn(() => null)` → `vi.fn<() => { state: { isReady: boolean }; process: ReturnType<typeof vi.fn> } ∣ null>(() => null)`. |
| `useArcaAudio.test.ts` | `let mockStore: ReturnType<typeof useAgenticStore>` → `let mockStore: any` (matches ~28 sibling hook tests). |
| `useDnaStyle.wsH.test.ts` | Extract literal `{ departmentId, promptTemplateId }` into a `const input = …` before `result.current.generate(input)` to bypass the excess-property check while preserving the test's behavioural assertion that `promptTemplateId` is forwarded to the POST body. |
| `useConsultationJob.test.ts` | `let sseConstructorSpy: ReturnType<typeof vi.fn>` → `ReturnType<typeof vi.fn<(...args: unknown[]) => void>>`, and `vi.fn()` → `vi.fn<(...args: unknown[]) => void>()` so the spy is unambiguously callable. |
| `useArca.wsH.test.ts` | `mockStore.apiClient = null` → `(mockStore as { apiClient: unknown }).apiClient = null` (one-off cast at the assignment that toggles the SDK-initialised flag). |
| `useArca.session.test.ts` | `result.current.session as Record<string, unknown>` → `as unknown as Record<string, unknown>`. |

## Implementation Summary

### Files modified

| File | Hunks |
|---|---|
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArcaSession.dx.test.ts` | 1 |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.test.tsx` | 1 |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.summary.test.ts` | 2 |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.audio-pipeline.test.ts` | 1 |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArcaAudio.test.ts` | 1 |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useDnaStyle.wsH.test.ts` | 1 |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useConsultationJob.test.ts` | 2 |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.wsH.test.ts` | 1 |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.session.test.ts` | 1 |

### Per-file before / after

| File | Before | After |
|---|---|---|
| `useArcaSession.dx.test.ts` | 6 | 0 |
| `useArca.test.tsx` | 3 | 0 |
| `useArca.summary.test.ts` | 3 | 0 |
| `useArca.audio-pipeline.test.ts` | 3 | 0 |
| `useArcaAudio.test.ts` | 2 | 0 |
| `useDnaStyle.wsH.test.ts` | 1 | 0 |
| `useConsultationJob.test.ts` | 1 | 0 |
| `useArca.wsH.test.ts` | 1 | 0 |
| `useArca.session.test.ts` | 1 | 0 |
| **Slice total** | **21** | **0** |

### Package-level impact

| Metric | Before (post-C3a baseline) | After C3c |
|---|---|---|
| Slice errors | 21 | 0 |
| Full-package `pnpm typecheck` errors | 127 | 18 (logger-transport tests — C3d's lane) |

The drop from 127 → 18 includes work landed in parallel by C3b and C3d. The portion attributable to C3c alone is **21 errors closed**.

### Verification evidence

```text
$ pnpm --filter @arcaai/vox test --run | tail -3
 Test Files  118 passed (118)
      Tests  2785 passed (2785)
   Duration  14.05s
```

```text
$ pnpm --filter @arcaai/vox build | tail -3
ESM ⚡️ Build success in 9011ms
CJS dist/index.js     5.44 MB
CJS ⚡️ Build success in 9011ms
```

```text
$ pnpm --filter @arcaai/vox lint | tail -3
✖ 13 problems (0 errors, 13 warnings)
  0 errors and 13 warnings potentially fixable with the `--fix` option.
```

```text
$ rg "src/hooks/__tests__/" /tmp/c3c-after.log | rg -v "useArca\.api\.test\.ts" | wc -l
0
```

`ReadLints` on all nine modified files returns **No linter errors found**.

### Deviations & follow-ups

- **`DnaGenerateInput` is missing `promptTemplateId`.** The runtime spread in `useDnaStyle.generate` already forwards arbitrary input to the POST body, so the test behaviour is correct, but the type does not advertise this field. C3c kept the change inside the test (variable-extraction pattern) per the slice rules. **Follow-up suggestion**: a future source ticket may add `promptTemplateId?: string` to `DnaGenerateInput` if the backend treats it as a public field.
- **`useAgenticStore` `ReturnType` collapses to `unknown` in test contexts.** A few hook tests (e.g. `useArca.wsH.test.ts`) rely on factory-return inference to type their mock store; the apiClient field then becomes non-nullable. We did the one-off cast in `useArca.wsH.test.ts`; a long-term cleanup might introduce a shared `createMockStore<T>` helper, but that is outside the slice.

## Change History

| Date | Author | Description | Files modified |
|---|---|---|---|
| 2026-05-24 | C3c | Initial slice — 21 hook-test typecheck errors closed across 9 files. | See "Files modified" above. |
