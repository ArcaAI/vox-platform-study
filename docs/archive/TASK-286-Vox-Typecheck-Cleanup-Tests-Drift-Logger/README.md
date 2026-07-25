# TASK-286 — Vox Typecheck Cleanup: Tests (NodeNext Extension Drift + Logger Transport Fixtures)

| Field | Value |
|---|---|
| Ticket | TASK-286 |
| Created | 2026-05-24 |
| Updated | 2026-05-24 |
| Status | Completed |
| Parent | [TASK-262](../TASK-262-Vox-SDK-Deep-Assessment/README.md) — Vox SDK Deep Assessment |
| Sibling (predecessor, source) | [TASK-283](../TASK-283-Vox-Typecheck-Cleanup-Source/README.md) — Source `.js`/`.ts` drift cleanup (C3a) |
| Sibling (Wave-2B parallel — store/core) | TASK-284 — C3b |
| Sibling (Wave-2B parallel — hooks) | TASK-285 — C3c |
| Sibling (transport gating contract) | [TASK-278](../TASK-278-Logger-Transport-Gating/README.md) — B5 added `static isAllowedToActivate` + `permanentlyDisabled` |
| Owner | Implementer Agent C3d |
| Branch | `fix/2605-review` |

## 1. Requirement Analysis

### 1.1 Description

Wave-2B continuation of the `@arcaai/vox` typecheck-cleanup effort kicked off by TASK-262. C3a (TASK-283) closed the source-side `.js`/`.ts` NodeNext extension drift, leaving 127 typecheck errors entirely in test files. This ticket (C3d) addresses two of those buckets — 52 errors total — split across two clean clusters:

- **Bucket A — NodeNext `.js`/`.ts` extension drift in tests** (22 errors, TS2834/TS2835)
- **Bucket B — Logger transport test-fixture drift** (30 errors, TS2353/TS2554/TS2559/TS2345/TS2578) caused by TASK-278 (B5) changing the three transport contracts.

### 1.2 Business Context

`pnpm typecheck` is required to pass before TASK-262 can be marked complete. Type-only drift in tests does not break runtime (Vitest goes through esbuild and ignores most TS semantic errors), but the CI typecheck job gates merge of the Wave-2 SDK cleanup branch into `master`.

### 1.3 Acceptance Criteria

- All 22 TS2834/TS2835 errors in the C3d-owned test files resolved by appending the correct `.js` extension to the relative ESM imports.
- All 30 logger-transport test-fixture errors resolved by updating fixtures to match the post-B5 contract (or by narrowly widening the local config type), **without touching the transport sources themselves**.
- Vitest stays 2785/2785 green.
- `pnpm --filter @arcaai/vox build` green.
- `pnpm --filter @arcaai/vox lint` 0 errors.
- No changes outside the agreed write-scope.

## 2. Current State Evaluation

### 2.1 Bucket A — root cause

The SDK package is configured with `--moduleResolution nodenext`. Under NodeNext, ESM-style relative imports **must** carry an explicit file extension, and the convention even for TypeScript sources is the post-emit name (`.js`), not `.ts`. The original test files predated the switch and used extensionless imports such as `await import('../hooks/index')`. Vitest still ran them fine because the esbuild-based pipeline performs its own resolution, but `tsc --noEmit` rejects them.

Errors are mechanically uniform — only the import path needs `.js` appended. The TypeScript diagnostic itself even suggests the correct rewrite ("Did you mean `'../hooks/index.js'`?").

### 2.2 Bucket B — root cause

TASK-278 (B5, see [TASK-278/README.md](../TASK-278-Logger-Transport-Gating/README.md)) hardened the three SaaS-bound logger transports — `HighlightTransport`, `LokiTransport`, `OTelTransport` — with a defence-in-depth gating layer:

```ts
static isAllowedToActivate(config): boolean
private permanentlyDisabled: boolean
```

In doing so it also dropped the `level?: LogLevel` field from each of `HighlightTransportConfig`, `LokiTransportConfig`, `OTelTransportConfig`. The transports still read `config.level` at runtime via an untyped cast (kept verbatim from the original transport contract):

```ts
this.level = (config as XxxTransportConfig & { level?: LogLevel }).level || 'info';
```

The tests, on the other hand, still set `level` as a typed property on the config literal. Under the post-B5 types this triggers TS2353 ("Object literal may only specify known properties").

Other Bucket B errors:

- `loki.transport.test.ts(328, 346)` — two `ResourceInfo` literals were missing the now-required `sdkName` and `sdkVersion` fields.
- `highlight.transport.test.ts(113)` — a stale `@ts-expect-error` directive (TS2578) covering a `globalThis.window = origWindow` assignment that now type-checks cleanly.
- `utils.test.ts(98)` — `new Error('msg', { cause })` is ES2022 and the package `lib` doesn't include the cause-aware Error constructor, so TS2554 fires (Expected 0–1 arguments). The runtime always supports it (modern V8 / jsdom).
- `utils.test.ts(340/348/365)` — `deepMerge<T>(target, ...sources: Partial<T>[])` inferred `T` from the target literal, making `Partial<T>` reject sources with disjoint key sets.

### 2.3 Dependencies & impact areas

- Read-only dependency on the three transport source files (to confirm the post-B5 contract).
- No source or runtime changes — fixtures only.
- Coordinated with C3b (store/core tests) and C3c (hooks tests) running in parallel on `fix/2605-review`; write-scopes are non-overlapping.

## 3. Implementation Plan

### 3.1 Bucket A — mechanical extension additions

For each of the 22 TS2834/TS2835 errors:

1. Open the file.
2. Locate the offending relative import.
3. Append `.js` to the path. Where the import resolved to a directory (e.g. `'../hooks'`), use the explicit `'../hooks/index.js'` suggested by `tsc`.

### 3.2 Bucket B — fixture realignment

Strategy (chosen over rewriting tests, per the surgical-changes rule):

1. Introduce a local widened-config type alias at the top of each transport test:

   ```ts
   type TestHighlightConfig = HighlightTransportConfig & { level?: LogLevel };
   ```

   …and use it for the shared `let config` declaration so the `beforeEach` fixture still typechecks with `level: 'debug'`.

2. For inline `new XxxTransport({ ... level: ... })` literals — where the constructor parameter is typed as the narrow `XxxTransportConfig` and excess-property check fires regardless of `satisfies` — cast the literal `as XxxTransportConfig`. This matches the runtime contract: the transports themselves read the extra `level` property via untyped cast (`(config as XxxTransportConfig & { level?: LogLevel }).level || 'info'`).

3. Add the missing `sdkName` / `sdkVersion` fields to the two `ResourceInfo` literals in `loki.transport.test.ts`.

4. Remove the now-unused `@ts-expect-error` directive on the `globalThis.window = origWindow` restore line in `highlight.transport.test.ts`.

5. `utils.test.ts(98)` — replace `new Error('msg', { cause })` with an explicit constructor cast that accepts the ES2022 cause-options shape:

   ```ts
   const error = new (Error as new (msg: string, options?: { cause?: unknown }) => Error)(
     'Wrapper error',
     { cause },
   );
   ```

6. `utils.test.ts(340/348/365)` — pass an explicit type parameter to `deepMerge<Record<string, unknown>>(target, source)` so source literals with disjoint keys satisfy `Partial<Record<string, unknown>>`.

### 3.3 Verification

- `pnpm typecheck` (after each bucket) and inspect the slice errors → 0.
- `pnpm --filter @arcaai/vox test --run` stays 2785/2785.
- `pnpm --filter @arcaai/vox build` stays green.
- `pnpm --filter @arcaai/vox lint` stays at 0 errors.
- `ReadLints` on every modified test file.

## 4. Implementation Summary

### 4.1 Files modified

| # | File | Bucket | Errors closed |
|---|---|---|---|
| 1 | `packages/agentic-sdk-v2/src/__tests__/exports.task032.test.ts` | A | 7 |
| 2 | `packages/agentic-sdk-v2/src/__tests__/exports.task279.test.ts` | A | 4 |
| 3 | `packages/agentic-sdk-v2/src/core/__tests__/plugins.exports.test.ts` | A | 6 |
| 4 | `packages/agentic-sdk-v2/src/core/__tests__/plugins-med-ner.exports.test.ts` | A | 2 |
| 5 | `packages/agentic-sdk-v2/src/types/__tests__/stream-e-types.test.ts` | A | 1 |
| 6 | `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.api.test.ts` | A | 2 |
| 7 | `packages/agentic-sdk-v2/src/core/logger/__tests__/highlight.transport.test.ts` | B | 9 |
| 8 | `packages/agentic-sdk-v2/src/core/logger/__tests__/loki.transport.test.ts` | B | 9 |
| 9 | `packages/agentic-sdk-v2/src/core/logger/__tests__/otel.transport.test.ts` | B | 8 |
| 10 | `packages/agentic-sdk-v2/src/core/logger/__tests__/utils.test.ts` | B | 4 |
| 11 | `docs/implementation/TASK-286-Vox-Typecheck-Cleanup-Tests-Drift-Logger/README.md` | — | (new ticket doc) |

### 4.2 Per-file error counts (before → after)

| File | Before | After |
|---|---:|---:|
| `exports.task032.test.ts` | 7 | 0 |
| `exports.task279.test.ts` | 4 | 0 |
| `plugins.exports.test.ts` | 6 | 0 |
| `plugins-med-ner.exports.test.ts` | 2 | 0 |
| `stream-e-types.test.ts` | 1 | 0 |
| `useArca.api.test.ts` | 2 | 0 |
| `highlight.transport.test.ts` | 9 | 0 |
| `loki.transport.test.ts` | 9 | 0 |
| `otel.transport.test.ts` | 8 | 0 |
| `utils.test.ts` | 4 | 0 |
| **Slice total** | **52** | **0** |

### 4.3 Package-level typecheck

| Snapshot | Errors |
|---|---:|
| Baseline (start of C3d) | 127 |
| After C3d Bucket A | 99 |
| After C3d Bucket B (final) | **0** |

The package-level reduction is larger than C3d's 52-error slice because C3b and C3c landed in parallel on `fix/2605-review` during the same window; the remaining 75 errors they owned closed on their merge. C3d's confirmed contribution is the 52 slice errors plus the cascading TS2834/TS2835 follow-ups inside the same files.

### 4.4 Vitest / build / lint evidence

```text
# pnpm --filter @arcaai/vox test --run
 Test Files  118 passed (118)
      Tests  2785 passed (2785)
   Duration  13.66s
```

```text
# pnpm --filter @arcaai/vox build
ESM dist/index.mjs     5.43 MB
ESM dist/plugins.mjs   5.09 MB
CJS dist/plugins.js    5.09 MB
CJS dist/index.js      5.44 MB
ESM e2e/fixtures/dist/e2e-bundle.mjs  5.43 MB
ESM ⚡️ Build success in 8632ms
```

```text
# pnpm --filter @arcaai/vox lint
✖ 13 problems (0 errors, 13 warnings)
```

All 13 warnings are pre-existing prettier nits in non-C3d files (`core/SttWebSocketClient.ts`, `types/dna.ts`, `types/index.ts`).

### 4.5 Bucket A details — NodeNext `.js` extension additions

22 dynamic `import(...)` calls in test files had `.js` appended, e.g.:

```diff
- const hooks = await import('../hooks/index');
+ const hooks = await import('../hooks/index.js');
```

Two `useArca.api.test.ts` imports resolved through a barrel directory; `tsc` flagged them as TS2834 (no suggestion). They were rewritten to the explicit barrel path:

```diff
- const { AgenticError } = await import('../../types');
+ const { AgenticError } = await import('../../types/index.js');
```

### 4.6 Bucket B details — fixture realignment

#### `highlight.transport.test.ts`

- Added local `type TestHighlightConfig = HighlightTransportConfig & { level?: LogLevel };` and used it for the shared `let config` declaration.
- Cast inline `new HighlightTransport({ ... level: ... })` literals `as HighlightTransportConfig` (six sites). This is the same pattern the transport source itself uses: `(config as HighlightTransportConfig & { level?: LogLevel }).level`.
- Removed the now-unused `// @ts-expect-error restore` directive above `globalThis.window = origWindow` (TS2578).

#### `loki.transport.test.ts`

- Added `type TestLokiConfig = LokiTransportConfig & { level?: LogLevel };` and used it for the shared config.
- Cast six inline `new LokiTransport({ ... level: ... })` literals `as LokiTransportConfig`.
- Filled the two truncated `ResourceInfo` literals with the now-required `sdkName: '@arcaai/vox'` and `sdkVersion: '0.0.0-test'` fields (test fixtures only; values do not affect assertions).

#### `otel.transport.test.ts`

- Added `type TestOTelConfig = OTelTransportConfig & { level?: LogLevel };` and used it for the shared config.
- Cast seven inline `new OTelTransport({ ... level: ... })` literals `as OTelTransportConfig`.

#### `utils.test.ts`

- `serializeError` cause-chain test (line 98): rewrote the `Error` constructor call with a typed cast to a constructor that accepts the ES2022 `ErrorOptions` shape. No behavioural change.
- `deepMerge` tests (lines 340/348/365): added explicit `<Record<string, unknown>>` type parameter so the disjoint-key source literals satisfy `Partial<T>`.

### 4.7 Deviations from the plan

None. `satisfies TestXxxConfig` was tried first for the inline constructor calls but it does not suppress TypeScript's excess-property check at the call site (the constructor parameter is still typed as the narrow `XxxTransportConfig`). Switched to `as XxxTransportConfig` casts, which matches the existing source-side convention.

### 4.8 Newly discovered issues — log only

- `highlight.transport.test.ts:73` retains its `// @ts-expect-error simulating non-browser` on `delete globalThis.window`. That directive is still required (TS would complain about deleting a non-optional global). No change made.
- The `level` field on logger transport configs is a runtime contract carried via untyped cast in the transport sources. A follow-up could canonicalise it onto the public config types (would require a one-line addition to each of `HighlightTransportConfig`/`LokiTransportConfig`/`OTelTransportConfig`) and let tests drop the local casts. Out of scope for this ticket.

## 5. Change History

| Date | Change | Files |
|---|---|---|
| 2026-05-24 | Initial implementation: closed 52 typecheck errors across 10 test files (Bucket A NodeNext drift + Bucket B logger transport fixture realignment). Package typecheck went 127 → 0 (with C3b/C3c parallel contributions). Vitest 2785/2785, build green, lint 0 errors. | All 10 files listed in §4.1 |
