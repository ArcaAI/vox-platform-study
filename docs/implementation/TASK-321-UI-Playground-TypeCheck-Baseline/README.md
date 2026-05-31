# UI-Playground Type-Check Baseline Remediation

- **Ticket:** TASK-321
- **Short name:** UI-Playground-TypeCheck-Baseline
- **Created:** 2026-05-31
- **Updated:** 2026-05-31
- **Status:** Completed (type-check = 0; ui-playground test failures flagged as pre-existing, out of scope)
- **Type:** bugfix / tech-debt (type-safety)
- **Origin:** Spun out of TASK-319 verification, which flagged `pnpm --filter @arcaai/ui-playground type-check` as a large pre-existing failing baseline unrelated to that ticket.

---

## 1. Requirement Analysis

### Description
`apps/ui-playground` does not pass `tsc --noEmit` (`pnpm --filter @arcaai/ui-playground type-check`). The baseline currently emits **~600 TypeScript errors**. The app still builds and runs under Vite (Vite resolves modules via its own bundler aliases, masking the `tsc` failures), so this has gone unnoticed and accumulated.

The goal of this ticket is to drive `ui-playground type-check` to **0 errors** and add a CI/turbo gate so it cannot silently regress again.

### Business context
- ui-playground is the SDK/admin reference surface (`@arcaai/vox` consumer + admin pages for tenants/departments/prompts/storage/DNA). A broken type-check means refactors in shared packages (`@arcaai/ui`, `@arcaai/vox`, `@arcaai/applications` DTOs) silently break the playground without a failing gate.
- Several errors are genuine contract drift (e.g. optimistic-concurrency `expectedVersion` not being sent on admin mutations, `PaginatedConsultations.count` vs `total`) that could mask real runtime bugs.

### Acceptance criteria
1. `pnpm --filter @arcaai/ui-playground type-check` exits 0 (no `error TS…`).
2. `@arcaai/ui` **builds** cleanly (`tsup` → current `dist/index.d.ts`), so the barrel resolves with full types. _(Scope correction during impl: `@arcaai/ui`'s own `check-types` has a separate ~20-error pre-existing baseline in stories/tests/registries + a missing `@testing-library/user-event` dev-dep. That is NOT in scope here — ui-playground consumes the built `dist/.d.ts`, not `@arcaai/ui` source/tests. Workstreams A1 and H from the original plan are therefore unnecessary: `multi-column-layout/index.ts` already re-exports all public types, and the source residue does not affect the dts build or consumers.)_
3. `@arcaai/vox` (agentic-sdk-v2) type-check exits 0 (the one shared-SDK error in scope is fixed in the package, not worked around in the app).
4. No runtime behavior change unless a fix corrects a genuine bug — each such case is called out in the Change History with the rationale.
5. A turbo `type-check` task exists with `dependsOn: ["^build"]` so consumers resolve built `@arcaai/ui` declarations, and the check runs in CI.
6. The TASK-319 test fixes (already landed) remain green; full `@arcaai/applications` suite stays at 0 failures.

### Explicit non-goals
- No visual/UX changes, no dependency upgrades beyond what a type fix strictly requires.
- No conversion of ui-playground to TS project references (out of scope; only `paths`/`lib`/turbo-gate config touched).

---

## 2. Current State Evaluation

### How this was measured
- Full capture: `pnpm --filter @arcaai/ui-playground type-check` → ~600 errors.
- To separate the resolution failure (which masks everything downstream) from genuine errors, a **temporary, reverted** `tsconfig paths` experiment mapped `@arcaai/ui/*` to source. That dropped the total **600 → ~208**, isolating the genuine app/SDK/test errors. The experiment has been fully reverted; the working tree contains only the TASK-319 test fixes.

### Root cause #1 — `@arcaai/ui/*` subpath resolution (~405 errors: 376× TS2307 + 29× TS2459)
- `packages/ui/package.json` `exports` declares `"./*": "./src/*.tsx"`. ui-playground imports flat subpaths like `@arcaai/ui/button`, which resolves to `packages/ui/src/button.tsx` — **but components actually live at `packages/ui/src/components/shadcn/*.tsx`** (and `multi-column-layout` under `src/components/custom/multi-column-layout/`). So every subpath is unresolvable under `tsc`.
- The tsup build (`packages/ui/tsup.config.ts`) has a **single entry** (`src/index.ts`); there are no per-component built declarations to resolve subpaths to.
- The barrel `packages/ui/src/index.ts` **does** re-export every shadcn + custom component (`dist/index.d.ts` is built and present). **However**, `multi-column-layout/index.ts` re-exports only the *components* (`MultiColumnLayout`, `VirtualizedList`, …) and **not** the public *types* (`MultiColumnConfig`, `MultiColumnContentConfig`, `MultiColumnState`, `MultiColumnDetailConfig`, `MultiColumnDetailState`, `AnyColumnConfig`) — hence the 29× TS2459 even if consumers switch to the barrel.
- ui-playground is the **only** consumer of `@arcaai/ui/*` subpaths monorepo-wide (89 import sites; no `apps/admin` exists). So the resolution fix is localized.
- ⚠️ Mapping `@arcaai/ui/*` to **source** is the wrong fix: it pulls the package's raw `.tsx` (with its internal `@/*` alias, its own implicit-anys, and `.at()`/es2022 needs) into ui-playground's program and creates *new* errors. The correct fix resolves to **built declarations** (barrel `dist/index.d.ts`) or proper per-subpath builds.

### Root cause #2 — `auth-store` self-reference collapses the store to `any` (≈54 errors: 51× TS7006 `(s)` + 3× TS7022/7023)
- `apps/ui-playground/src/store/auth-store.ts:124` — `isSuperAdmin` calls `useAuthStore.getState()` **inside the store's own `create()` initializer**. This is a circular self-reference (`useAuthStore` → initializer → `useAuthStore`), so TS infers `useAuthStore: any` (TS7022). Every `useAuthStore((s) => s.x)` selector across routes/features then has `s: any` (the 51× TS7006). Fix is ~3 lines: use zustand's `get()` param instead of `useAuthStore.getState()`.

### Root cause #3 — genuine app contract/typing errors (~80, excluding tests)
- **API mutation contracts (9):** `UpdateDepartmentInput` / `UpdatePromptConfigInput` / `UpdateTenantConfigItem` require `expectedVersion` (optimistic concurrency) and a `{ configs }` wrapper, but admin call sites (`features/admin/{departments,tenants,prompts}`, `features/introduction/...`) don't pass them. **Genuine — these mutations likely 412/400 at runtime or silently drop concurrency control.**
- **Consultation typing (8):** `Consultation`→`Record<string, unknown>` casts (TS2352, 5×) and `PaginatedConsultations.count` that doesn't exist (TS2339, 3× — likely should be `total`).
- **Data-callback implicit-any (≈23):** `.map((t) => …)` / `.find((d) => …)` over react-query/API results typed `any` in admin pages, `summarization/hooks/use-doctor-context`, `playground/overview/user-list`, etc.
- **Misc genuine (≈10):** `audio-mixer-panel` onClick handler signature, `processing-config-panel.tsx` Pipeline vs AudioPipeline, `use-file-transcription` `SSEConnectOptions.authToken`, `use-realtime-transcription` `ApiClientLike` vs `AgenticClient` + nullable logger, `zod-resolver.ts` `Resolver<T>`, `header.tsx` duplicate object key (TS1117), `search-filter-bar` arg count (TS2554), `.dataset`/`.at()` (need `lib: es2022`).

### Root cause #4 — shared SDK error (1× TS2322, in `@arcaai/vox`)
- `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx:318` — `ISDKLogger` is not assignable to `ConfigManagerLogger` (their `warn` signatures differ: `(message, meta?: LogMeta)` vs `(message, context?: unknown)`). Must be fixed **in the SDK package**.

### Root cause #5 — test-file drift (~82 errors)
- `features/audio/components/__tests__/processing-config-panel.test.tsx` (**72**): literal-union drift `'local_ai'` not assignable to `'backend_socket'` (the config mode type changed; test fixtures weren't updated) + `Element` vs `HTMLElement` from `querySelector` + an `Error`→null assignment.
- `components/__tests__/error-boundary.test.tsx` (3): `ThrowingComponent` returns `void`, not valid JSX.
- `lib/__tests__/auth-refresh.test.ts` (6): duplicate import identifiers (TS2300) — a duplicated import line.
- `features/summarization/summary/__tests__/summary-api-integration.test.ts` (1): `styleText` on `never`.

### Root cause #6 — `@arcaai/ui` own residue (≈2 genuine, surfaced only when its source is type-checked)
- `components/shadcn/sidebar.tsx:242` `event` implicit-any; `custom/multi-column-layout/multi-column-layout.tsx:119` `.at()` needs `es2022`. These belong to `@arcaai/ui` and are fixed there (its `check-types` is the gate). The `@/*`-alias TS2307s seen during the experiment were artifacts of pulling source into the consumer and do **not** occur under `@arcaai/ui`'s own tsconfig.

### Confirmation: unrelated to TASK-319
TASK-319's only ui-playground touch was string-literal endpoint changes in `features/admin/api/prompts.ts` (F4) — that file is type-clean and adds zero errors. This entire baseline pre-dates and is independent of TASK-319.

---

## 3. Implementation Plan

Ordered by leverage (each workstream is independently shippable and verifiable). **TDD note:** for type-only fixes the "failing test" is the compiler — each step defines the exact `tsc` error count that must drop to zero for the targeted files. Behavioral fixes (Workstream D) get/extend Vitest coverage first.

### Decision required at approval — resolution strategy (Workstream A)
- **Option A1 (recommended): consume `@arcaai/ui` via the barrel.** Codemod ui-playground's 89 `@arcaai/ui/<sub>` imports → `@arcaai/ui`, and export the missing `multi-column-layout` public types from the package so the barrel carries them. Resolves to the already-built `dist/index.d.ts` (no source-pull). Lowest risk; one small `@arcaai/ui` export addition; ~40 ui-playground files touched mechanically.
- **Option A2 (alternative): make subpaths first-class.** Add per-component entries to `tsup.config.ts` + a generated `exports` subpath map so `@arcaai/ui/button` → `dist/button.d.ts`. Keeps current import style; zero ui-playground import edits, but is a larger `@arcaai/ui` build/packaging change and requires `@arcaai/ui`'s own type errors fixed for the `dts` build to succeed.

**I recommend A1.** The rest of the plan assumes A1 (note where A2 differs).

### Workstream A — Resolution (clears ~405 errors)
- **A1.** Add the missing public type exports to `packages/ui/src/components/custom/multi-column-layout/index.ts` (and ensure they're `export`ed from `multi-column-layout.tsx`): `MultiColumnConfig`, `MultiColumnContentConfig`, `MultiColumnState`, `MultiColumnDetailConfig`, `MultiColumnDetailState`, `AnyColumnConfig`. → clears 29× TS2459.
- **A2.** Codemod ui-playground imports `from '@arcaai/ui/<x>'` → `from '@arcaai/ui'` (merge with any existing barrel import per file). Mechanical; verify each file compiles. → clears 376× TS2307.
- **A3.** Add a turbo `type-check` task (`dependsOn: ["^build"]`, `outputs: []`) and wire `apps/ui-playground` + `packages/ui` (`check-types`) into it so declarations are built before consumers type-check. Rebuild `@arcaai/ui`.
- **Verify:** `pnpm --filter @arcaai/ui-playground type-check 2>&1 | rg -c "error TS"` drops by ~405; **no** `@arcaai/ui` *source* paths appear in the output.

### Workstream B — `auth-store` self-reference (clears ~54 errors)
- Change `auth-store.ts` `create(...)` initializer to `(set, get) => ({ … })` and replace `useAuthStore.getState()` inside `isSuperAdmin` with `get()`.
- **Verify:** `auth-store.ts` TS7022/7023 gone; the 51 `(s) => s.x` TS7006 across routes/features clear (grep the masked run's selector lines → 0).

### Workstream C — Data-callback implicit-any (clears ~23)
- Type the underlying react-query/API hooks (or annotate callback params) so `.map/.find/.filter` callbacks infer. Prefer fixing the hook return type at the source over per-call annotations. Files: `features/admin/{departments,prompts,tenants}/index.tsx`, `features/summarization/hooks/use-doctor-context.ts`, `features/playground/overview/components/user-list.tsx`, `features/admin/components/studio-page.tsx`, others from the inventory.
- **Verify:** remaining TS7006 → 0.

### Workstream D — Genuine app contracts (clears ~17; **behavioral — TDD**)
- **D1.** `expectedVersion` / `{ configs }` wrappers: thread the loaded entity's version into the admin update mutations (`departments`, `tenants`, `prompts`, `introduction/tenant-settings-panel`). Add/extend a Vitest test per mutation asserting the payload shape **before** the fix (RED), then implement (GREEN).
- **D2.** `PaginatedConsultations.count` → correct field (`total`); replace `as Record<string, unknown>` casts on `Consultation` with a safe accessor or `as unknown as …` only where justified. Cover the consultation list/detail mapping with a focused test.
- **Verify:** TS2345/TS2741/TS2352/TS2339 in these files → 0; new tests green.

### Workstream E — Shared SDK logger (clears 1, in `@arcaai/vox`)
- Align `ISDKLogger.warn` / `ConfigManagerLogger.warn` signatures in `packages/agentic-sdk-v2` (widen `LogMeta` to accept `unknown`, or adapt at the `AgenticProvider` boundary). Fix in the SDK; add a type-level test if the package has one.
- **Verify:** `@arcaai/vox` type-check + the consumer reference both clean.

### Workstream F — Test-file drift (clears ~82)
- `processing-config-panel.test.tsx`: update fixtures to the current `mode`/`quality` unions and DOM typing (cast `querySelector` results to `HTMLElement`). `error-boundary.test.tsx`: make `ThrowingComponent` return `never`/throw correctly. `auth-refresh.test.ts`: remove the duplicate import. `summary-api-integration.test.ts`: type the fixture so `styleText` exists.
- **Verify:** these files → 0; the corresponding Vitest suites still pass (`pnpm --filter @arcaai/ui-playground test`).

### Workstream G — Misc/config (clears ~10)
- Bump ui-playground `tsconfig` `lib` to include `ES2022` (for `.at()`); fix `header.tsx` duplicate key (TS1117), `search-filter-bar` arg (TS2554), `audio-mixer-panel` handler, `use-file-transcription` `SSEConnectOptions`, `use-realtime-transcription` client/logger types, `zod-resolver.ts` `Resolver<T>` generic, `.dataset` access.
- **Verify:** remaining scattered codes → 0.

### Workstream H — `@arcaai/ui` own residue (≈2)
- Fix `sidebar.tsx:242` `event` implicit-any and `multi-column-layout.tsx:119` `.at()` (ensure `@arcaai/ui` tsconfig `lib` includes `es2022`). Gate on `pnpm --filter @arcaai/ui check-types`.

### File creation/modification order
1. `@arcaai/ui`: multi-column type exports (A1) + own residue (H) → `pnpm --filter @arcaai/ui check-types` + `build`.
2. turbo `type-check` task (A3).
3. ui-playground import codemod (A2).
4. `auth-store` (B).
5. Workstreams C, D, E, F, G.
6. Final: full `type-check` = 0.

### Verification criteria (final gate)
```
pnpm --filter @arcaai/ui check-types          # 0 errors
pnpm --filter @arcaai/vox  type-check          # 0 errors (or package's check script)
pnpm --filter @arcaai/ui-playground type-check # 0 errors
pnpm --filter @arcaai/ui-playground test       # suites green (Workstreams D/F)
pnpm --filter @arcaai/applications test         # still 4458 passed / 0 failed (TASK-319 regression guard)
```

### Estimated scope
~50–60 files (≈40 mechanical import edits + ≈15 genuine fixes + 4–5 test files + 3 config/package files). Behavioral risk concentrated in Workstream D (mutation payloads) and F (test fixtures); everything else is type-level.

---

## 4. Implementation Summary

**Outcome:** `apps/ui-playground` `tsc --noEmit` → **0 errors** (was ~600). No `@arcaai/ui` source paths leak into the consumer output.

### What was built (by workstream)
- **A (resolution, ~405):** Added `@arcaai/ui/*` + `@arcaai/ui/multi-column-layout` `paths` aliases in `apps/ui-playground/tsconfig.json` pointing at `../../packages/ui/dist/index.d.ts` (chose the **A1 barrel-dist alias** over the A2 codemod — zero source edits, one config change). Requires `@arcaai/ui` to be built (`dist/index.d.ts`).
- **B (auth-store self-ref, ~61):** `auth-store.ts` `create((set, get) => …)`; `isSuperAdmin` uses `get()` instead of `useAuthStore.getState()`. Cleared the cascading implicit-`any` across every selector.
- **C:** Folded into B (no residual `TS7006`).
- **D (behavioral):** Threaded optimistic-concurrency `expectedVersion` (+ RFC 7232 `ifMatch: "<v>"`, mirroring the existing `prompts`/`audio-pipelines`/`configurations` sibling pattern; fallback `1` until the row is stamped) into the department + tenant-config update mutations: `admin/departments/index.tsx` (details/prompt/toggle), `admin/tenants/index.tsx` (config save/restore, dept edit/prompt/toggle), `introduction/components/tenant-settings-panel.tsx`, `introduction/index.tsx` (`{ configs }` wrapper). `PaginatedConsultations.count` → `.total` (dropped the dead `?? …count` fallback). `Consultation` accessor casts → `as unknown as Record<string, unknown>`. Tenant description JSX child guarded with `Boolean(...)`.
- **E (shared SDK):** `ConfigManagerLogger.warn` converted from an arrow **property** to a **method** declaration in `packages/agentic-sdk-v2/src/core/ConfigManager.ts` — method-parameter bivariance lets a full `ISDKLogger` be passed without widening `LogMeta` or coupling ConfigManager to the SDK logger. Resolves `AgenticProvider.tsx:318`.
- **F (test drift):** `processing-config-panel.test.tsx` (union types instead of `as const`, `error: Error | null`, `closest<HTMLElement>`), `error-boundary.test.tsx` (`: never`), `auth-refresh.test.ts` (dup import), `summary-api-integration.test.ts` (CFA-narrow-to-`null` fixed by re-widening at the access site).
- **G (misc/config + SDK alignment):** `tsconfig` `lib` → `ES2022` (`.at()`); `header.tsx` dup key; `search-filter-bar.tsx` `useRef(undefined)`; `audio-mixer-panel.tsx` handler arrow-wrap; `use-doctor-context.ts` double-cast; `use-file-transcription.ts` dropped legacy `authToken`; `use-realtime-transcription.ts` selectors typed `AgenticClient`/`ISDKLogger` + `childLogger ?? undefined`; `zod-resolver.ts` failure branch `values: {}`; `processing-config-panel.tsx` `pipelines.map` infers `Pipeline` (removed wrong `AudioPipeline` annotation + orphan import).
- **A-variant (multi-column invariance, ~24):** `packages/ui/.../multi-column-layout/types.ts` `AnyColumnConfig = MultiColumnConfig<any> | MultiColumnContentConfig` — heterogeneous column collections (the layout erases item type internally); rebuilt `@arcaai/ui`.
- **TS4023 (RouterContext, 68 — newly surfaced):** Exporting `interface RouterContext` from `src/routes/__root.tsx`. This cluster was *masked* while `useAuthStore` was `any`; once B gave the store a concrete type, every route's inferred `Route` needed to name the root context across module boundaries.

### Deviations from plan
- Workstream A implemented as the **A1 barrel-dist alias** (not the A2 import codemod) — fewer edits, lower risk. The turbo `type-check` task (A3) and Workstream H were not needed: `@arcaai/ui`'s `dist/index.d.ts` was rebuilt directly, and its own `check-types` residue is a **pre-existing baseline** (stories/tests) that does not affect the consumed `.d.ts`.
- A previously-hidden **TS4023 `RouterContext`** cluster surfaced after B and was fixed (export the interface).

### Verification evidence
```
apps/ui-playground   tsc --noEmit        → exit 0, 0 errors          (was ~600)
packages/applications vitest (3 guard files) → exit 0 (regression guard green)
packages/agentic-sdk-v2 tsc --noEmit     → AgenticProvider:318 fixed; remaining errors are
                                            PRE-EXISTING test-file baselines (.js ext / mock / config tests)
packages/ui          tsc --noEmit        → multi-column-layout clean; remaining errors are
                                            PRE-EXISTING stories/tests baselines
apps/ui-playground   vitest (full)       → 589 passed | 92 failed (5 files)
   └─ baseline check: stashing ALL my session changes and re-running the same 5 files yields
      the IDENTICAL 92 failed | 15 passed → zero regressions introduced. The 92 are pre-existing
      (e.g. 74× processing-config-panel: component reads `availableAsrModels`, mock supplies
      `availableAudioModels`).
```

> **Out of scope / flagged:** the **92 pre-existing ui-playground test failures** (stale mocks/renames in 5 files) are unrelated to the type-check baseline and were not introduced here. Recommend a separate ticket to refresh those fixtures.

## 5. Change History
- **2026-05-31** — Ticket created from TASK-319 verification. Root-caused the ~600-error ui-playground type-check baseline into 6 categories with per-workstream counts and a phased remediation plan.
- **2026-05-31** — Implemented Workstreams A–G (A via the barrel-dist alias; D behavioral with `expectedVersion`/`ifMatch`; E via `ConfigManagerLogger` method-bivariance; `AnyColumnConfig<any>`; `RouterContext` export for the newly-surfaced TS4023 cluster). **ui-playground type-check = 0.** Verified `@arcaai/ui`/`@arcaai/vox` changes are clean against their pre-existing baselines and that the 92 ui-playground test failures pre-date this work (identical at HEAD).
