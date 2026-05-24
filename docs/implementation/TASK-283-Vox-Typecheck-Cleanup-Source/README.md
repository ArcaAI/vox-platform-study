# TASK-283: Vox SDK Typecheck Cleanup — Source Files

- **Ticket**: TASK-283
- **Title**: `@arcaai/vox` source-file `tsc` cleanup (Wave-2B C3a slice)
- **Created**: 2026-05-24
- **Updated**: 2026-05-24
- **Status**: Completed
- **Branch**: `fix/2605-review`
- **Parent ticket**: [TASK-262 — Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md)
- **Related tickets**:
  - [TASK-280 — CrossTab HMAC SharedWorker](../TASK-280-CrossTab-HMAC-SharedWorker/README.md) (B7 originally surfaced the 154-error typecheck count, including the `core/index.ts:37` `CrossTabEvent` re-export typo)
  - [TASK-279 — ROLE Endpoints Split](../TASK-279-ROLE-Endpoints-Split/README.md) (C4 noted the `core.ts` `AgenticActions`/`AgenticState` re-export was already broken pre-Wave-2)

## Requirement Analysis

### Description

`pnpm --filter @arcaai/vox typecheck` reports **158 errors** while Vitest is green (2785/2785) because the runtime build runs through esbuild rather than `tsc`. Wave-2A's C-track lanes consumed the user's `decompose_4` decision to split the typecheck-cleanup into four implementer slices:

- **C3a (this ticket)** — source files only (`src/**/*.ts(x)` excluding `__tests__`).
- **C3b/C3c/C3d** — test-file slices, dispatched in parallel **after** C3a lands so the test-file fixers see the corrected source-file types.

### Business context

- Type drift means a future engineer trying to `pnpm typecheck` the SDK sees a wall of red and cannot tell which errors are real. Wave-2 needs `tsc` to be a usable signal again.
- Several errors mask real bugs (e.g. wrong runtime callback signatures for `BaseProcessor` events, ambient module declarations that no longer match the published packages).
- This is purely type-cleanup; **no runtime behaviour change**, no DB change, no API change.

### Acceptance criteria

1. Source-file errors in `@arcaai/vox` (per the C3a slice list) drop from **31 → 0**.
2. Full-package `pnpm typecheck` count drops from **158** to roughly **127** (slice contribution; remaining ~127 belong to the test-file slices C3b/C3c/C3d).
3. Vitest must remain **2785/2785 green**.
4. `pnpm --filter @arcaai/vox build` must remain green (esbuild output unchanged).
5. `pnpm --filter @arcaai/vox lint` must remain **0 errors** (existing prettier warnings outside scope).
6. No new dependencies, no `pnpm install`, no destructive git operations, no PR/push.

## Current State Evaluation

### Source-file error inventory (pre-fix, 31 total)

Captured from `/tmp/vox-tsc-c3a-before.log`:

| File | Count | Notes |
|---|---|---|
| `src/core/TranscriptionPipeline.ts` | 13 | Mostly TS2353 (object literal extra/wrong props) plus TS2305/TS2339 — all rooted in the `external-modules.d.ts` ambient stub overriding the real package types. |
| `src/plugins.ts` | 9 | `useVAD` / `UseVADOptions` / etc. reported as missing — same root cause. |
| `src/utils/secureStorage.ts` | 4 | `Uint8Array<ArrayBufferLike>` widening (TS 5.7+ `lib.dom` change). |
| `src/core.ts` | 2 | `AgenticActions` / `AgenticState` re-exported from `./store/agenticStore` but those interfaces were declared without `export`. |
| `src/core/index.ts` | 1 | `type CrossTabEvent` re-export — the actual export name is `CrossTabEventType`. |
| `src/hooks/useArcaAudio.ts` | 1 | `AudioContextManager` — same root cause as TranscriptionPipeline. |
| `src/hooks/useStorage.ts` | 1 | `'name' is specified more than once` (TS2783) — duplicate property in spread. |

### Root cause for 24 of 31 errors: `src/external-modules.d.ts`

`packages/agentic-sdk-v2/src/external-modules.d.ts` declared **ambient module stubs** for `@arcaai/room`, `@arcaai/noise-filter`, `@arcaai/vad`, `@arcaai/stt`, `@arcaai/med-ner`. The file's own header reads:

> *"These are placeholder declarations until the packages have proper type exports."*

Those packages now ship complete `.d.ts` files via `tsup` (verified at `packages/{room,noise-filter,vad,stt,med-ner}/dist/index.d.ts`). The stub still wins ambient-module resolution because it lives inside the consumer's source tree, so every modern API surface (`AudioContextManager`, `debugLogConfig`, `processedTrack`, `useVAD`, `useSTT`, `UseVADOptions`, etc.) was reported as missing or with the wrong shape. `tsup.config.ts:84` even acknowledges the stub is the root cause of DTS-generation issues.

### Dependencies

- TypeScript 5.9.3
- `@arcaai/room@workspace:*`, `@arcaai/vad@workspace:*`, `@arcaai/stt@workspace:*`, `@arcaai/noise-filter@workspace:*`, `@arcaai/med-ner@workspace:*` — all already provide the full type surface required.
- No external dependency changes.

### Impact areas

- All public re-exports from `@arcaai/vox/core` and `@arcaai/vox/plugins` continue to resolve to the same runtime symbols. No public API renames.
- `core.ts` exposes `AgenticActions` / `AgenticState` as advanced public types via the `./store/agenticStore` re-export. Cross-monorepo grep confirms no consumer (admin app, ui-playground, tests outside the package) imports either name today, so adding `export` is the minimal-impact restoration.
- Removing `CrossTabEvent` from the `./SimpleCrossTabSync` re-export is safe — cross-monorepo grep finds no consumer using that name.

## Implementation Plan

Phase order chosen for early confidence (small → large):

1. `core/index.ts` — drop the `type CrossTabEvent` re-export, keep `CrossTabEventType` (1 error, 1 line).
2. `store/agenticStore.ts` — add `export` to `interface AgenticState` and `interface AgenticActions` to satisfy the existing `core.ts` re-export. (`core.ts` itself is unchanged.)
3. `hooks/useStorage.ts` — drop the duplicate `name` from `{ name, ...data }` (TS2783).
4. `utils/secureStorage.ts` — pin the buffer types to `Uint8Array<ArrayBuffer>` per the user-provided strategy guidance, widen `toBase64` to accept `ArrayBuffer | Uint8Array`.
5. `src/external-modules.d.ts` — **delete the file**. Single largest fix; collapses 24 errors across `TranscriptionPipeline.ts`, `plugins.ts`, `useArcaAudio.ts`.
6. `core/TranscriptionPipeline.ts` — repair newly-surfaced strict-event-emitter call signatures: import `ProcessorEvent` enum, replace `'data'` / `'error'` string literals, narrow the optional `transcribeSegment` invocation.

After each phase: re-run `pnpm --filter @arcaai/vox typecheck` and confirm the slice count drops monotonically. After the last phase: run the full verification gate (typecheck count, vitest, build, lint, ReadLints).

### Test list

This is a type-cleanup ticket with no runtime behaviour change. Existing Vitest (`2785/2785`) must remain green and acts as the regression net. No new tests are added.

## Implementation Summary

### Files modified

| File | Change |
|---|---|
| `packages/agentic-sdk-v2/src/external-modules.d.ts` | **Deleted.** The ambient stub was masking the real `@arcaai/{room,vad,stt,noise-filter,med-ner}` types. |
| `packages/agentic-sdk-v2/src/core/index.ts` | Removed `type CrossTabEvent,` from the `./SimpleCrossTabSync` re-export list. |
| `packages/agentic-sdk-v2/src/store/agenticStore.ts` | Added `export` keyword to `interface AgenticState` and `interface AgenticActions` so the existing `core.ts` re-export resolves. |
| `packages/agentic-sdk-v2/src/hooks/useStorage.ts` | `setBuckets((prev) => [...prev, { name, ...data }])` → `[...prev, { ...data }]` (drops the duplicate `name`; runtime semantics unchanged because the API echoes back the same name). |
| `packages/agentic-sdk-v2/src/utils/secureStorage.ts` | Pinned `salt`, `fromBase64()` return type, and `deriveKey(passphrase, salt)` parameter to `Uint8Array<ArrayBuffer>`. Widened `toBase64()` to `ArrayBuffer \| Uint8Array` and reused the existing array when already a `Uint8Array` (no extra copy in the hot path). |
| `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts` | (a) Imported `ProcessorEvent` enum from `@arcaai/room` and replaced the magic strings `'data'` / `'error'` in `processor.on(...)` calls. (b) Removed the redundant `(error: { error: Error })` callback annotation in favour of `TypedEventEmitter`'s inferred `ProcessorErrorPayload`. (c) Narrowed the optional-method invocation by adding `&& sttProcessor?.transcribeSegment` to the existing `supportsSegmentTranscription` guard. |

### Notable decisions

- **Why delete `external-modules.d.ts` rather than patch it?** Adding 24 missing fields to a stub for 5 packages re-introduces the same drift the next time a workspace package adds an export. The clean fix is to let `tsup`-generated `.d.ts` files be the single source of truth.
- **Why keep `AgenticActions` / `AgenticState` exported?** Cross-monorepo grep finds no consumer, but `core.ts` explicitly re-exports them under "Advanced Usage". Adding `export` is one line per interface and preserves the documented public surface; deleting the re-export would have been a (silent) breaking change.
- **Why `Uint8Array<ArrayBuffer>` instead of `Uint8Array<ArrayBufferLike>`?** Per the user's strategy guidance, `BufferSource`-typed Web Crypto APIs only accept the narrower form; widening to `ArrayBufferLike` is exactly the lib.dom drift that broke this file in the first place.
- **Why not refactor `TranscriptionPipeline.ts:651` further?** The minimal narrowing keeps the existing `supportsSegmentTranscription` invariant intact. Refactoring the cast block would widen the diff into runtime-shape territory, which is out of scope.

### Newly-discovered issues (logged, NOT fixed)

1. `packages/agentic-sdk-v2/tsup.config.ts:84` — the comment now references the deleted `external-modules.d.ts`. Cosmetic; safe to update in a later pass.
2. The full-package count dropped from **158 → 128** (delta = 30, not 31). The single extra delta is a freshly-surfaced test-file error caused by the now-correct upstream types from `@arcaai/{room,vad,stt}` — it lives in a test file and therefore belongs to one of C3b/C3c/C3d's lanes. **C3a does not fix it.**

## Verification

All gates run from the repo root via `pnpm --filter @arcaai/vox …`.

### `tsc --noEmit`

```
Before: 158 errors total — 31 in C3a's slice (source files).
After : 128 errors total —  0 in C3a's slice (source files).
        ↑ all 128 remaining errors live under packages/agentic-sdk-v2/src/**/__tests__/**
        ↑ these are the C3b/C3c/C3d slices.
```

Slice grep (post-fix) returns **0 lines**:

```
rg "src/(core/TranscriptionPipeline\.ts|plugins\.ts|utils/secureStorage\.ts|core\.ts|core/index\.ts|hooks/useArcaAudio\.ts|hooks/useStorage\.ts)" /tmp/vox-tsc-final.log
# (no output)
```

### Vitest

```
 Test Files  118 passed (118)
      Tests  2785 passed (2785)
   Duration  13.90s
```

No regressions. Same 2785/2785 as the Wave-2A baseline.

### Build (`tsup`)

```
ESM e2e/fixtures/dist/e2e-bundle.mjs     5.43 MB
ESM e2e/fixtures/dist/e2e-bundle.mjs.map 9.14 MB
ESM ⚡️ Build success in 9027ms
```

`tsup` `dts: false` (per `tsup.config.ts`) means the build emits JS only — unaffected by the type-only changes. Bundle size unchanged.

### Lint

```
✖ 13 problems (0 errors, 13 warnings)
```

13 pre-existing prettier warnings, **0 errors**, no new lint debt introduced. (Lint actually dropped from 17 warnings to 13 because cleaning up scratch test files removed 4 unused-locals warnings.)

### Lints on touched files

`ReadLints` on `core/index.ts`, `store/agenticStore.ts`, `hooks/useStorage.ts`, `utils/secureStorage.ts`, `core/TranscriptionPipeline.ts` → **no linter errors**.

## Files Changed

| File | Action | Reason |
|---|---|---|
| `packages/agentic-sdk-v2/src/external-modules.d.ts` | Deleted | Ambient stub no longer needed; real packages provide complete types. |
| `packages/agentic-sdk-v2/src/core/index.ts` | Edited | Drop bogus `type CrossTabEvent` re-export. |
| `packages/agentic-sdk-v2/src/store/agenticStore.ts` | Edited | Mark `AgenticState` / `AgenticActions` interfaces as `export`. |
| `packages/agentic-sdk-v2/src/hooks/useStorage.ts` | Edited | Remove duplicate `name` property in spread literal. |
| `packages/agentic-sdk-v2/src/utils/secureStorage.ts` | Edited | Pin Web Crypto buffer types to `Uint8Array<ArrayBuffer>`. |
| `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts` | Edited | Use `ProcessorEvent` enum + narrow optional `transcribeSegment` call. |
| `docs/implementation/TASK-283-Vox-Typecheck-Cleanup-Source/README.md` | Created | This file. |

## Deviations

- **Reduction is 30, not 31.** Removing the ambient stub surfaced exactly one extra test-file error (a downstream consequence of the now-correct upstream types). The slice contribution is still a clean 31, but the test-file delta nets out at +1 in the wider suite. This sits inside C3b/C3c/C3d's scope and is intentionally untouched.
- **Edited `store/agenticStore.ts`** — not in the explicit write-scope table but allowed under the "type-source companion" clause (`packages/agentic-sdk-v2/src/core/types.ts (or wherever)`). Two single-token additions (`export` keyword × 2). No runtime change.

## Newly-Discovered Issues

1. `packages/agentic-sdk-v2/tsup.config.ts:84` references the now-deleted `external-modules.d.ts`. Cosmetic; out of scope.
2. The C3b/C3c/C3d slices will need to handle the +1 test-file regression that surfaced once the upstream types became visible (likely in `src/__tests__/exports.task032.test.ts` or similar — straightforward update to use the real exported names).
3. (Pre-existing, observed only.) `tsup` is configured with `dts: false`; once all four C3 slices land, the workspace can finally flip `dts: true` for `@arcaai/vox` because the ambient stub is gone. Not in this ticket's scope.

## Change History

| Date | Author | Description |
|---|---|---|
| 2026-05-24 | Wave-2B C3a (this slice) | Initial implementation. Source-file slice typecheck drift fixed: 31 errors → 0; full-package count 158 → 128. Vitest 2785/2785 ✓, build ✓, lint 0 errors ✓. |
