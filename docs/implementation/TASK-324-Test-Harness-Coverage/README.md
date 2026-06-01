# Fix Test-Harness Coverage Gaps and Make the Suite Green

- **Ticket:** TASK-324
- **Name:** Test Harness Coverage Green
- **Created:** 2026-06-01
- **Updated:** 2026-06-01
- **Status:** Completed

---

## 1. Requirement Analysis

### Description

The monorepo test harness had drifted: a developer running the local test command
did **not** exercise the same set of tests that CI runs, several packages' tests were
silently undiscovered, and a number of suites were red but hidden because nothing ran
them. The goal is a single source of truth — `pnpm test` (Turbo fan-out) runs the exact
same per-package suites that CI runs — with the whole suite green.

### Business context

Hidden/undiscovered tests give false confidence: regressions in `ui-playground`,
`@arcaai/vox`, and `@arcaai/ui` could merge without any suite failing locally **or** in
CI. Making local == CI and turning every discovered suite green restores the safety net.

### Acceptance criteria

- [x] Dead Vitest config removed (Vitest 4 no longer supports `vitest.workspace.ts`).
- [x] `@arcaai/vox` runs a single authoritative config that discovers both `.test.ts` and `.test.tsx`.
- [x] `apps/ui-playground` discovered and green (was 92 failing).
- [x] `packages/ui` Vitest (`*.vitest.*`) and Playwright-CT (`*.test.tsx`) suites green.
- [x] One aggregate (`pnpm test` = `turbo run test`) fans out to the same package suites CI runs.
- [x] CI runs `@arcaai/applications` and `apps/ui-playground`; a gated, non-blocking Playwright-CT job exists.
- [x] Local fan-out set == CI fan-out set (14 unit packages), evidence captured.

---

## 2. Current State Evaluation (evidence at start)

Discovery facts (verified with `vitest list`, Vitest `4.1.1`):

- `pnpm test:unit` ran the **root** `vitest.config.ts` across the repo: `include` was
  `**/*.test.ts` (no `.tsx`) and it excluded `apps/ui-playground/**`. Repo-wide `.tsx`
  discovered by `test:unit` = **0**.
- `vitest.workspace.ts` was **dead** — Vitest 4 dropped workspace files (replaced by
  `test.projects`); its per-project `environment`/`setupFiles`/tsx-`include` were ignored.
- CI (`.gitlab/ci/test.yml`) did **not** use the root config — it ran `turbo test` per
  package. So local `test:unit` and CI discovered different sets (local-green ≠ CI-green).

Coverage gaps (files on disk vs. who ran them):

| Area | On disk | Ran by |
|---|---|---|
| `apps/ui-playground` | 61 files / 687 tests | **neither** root config nor CI → 92 failing, hidden |
| `@arcaai/vox` | 143 `.test.ts` + 5 `.test.tsx` | the `.tsx` were orphaned; richer `vitest.config.mts` was dead config |
| `@arcaai/applications` | 180 files | green via root `test:unit`, but **absent from CI** |
| `packages/ui` | 215 `*.vitest.*` + 84 `*.test.tsx` (CT) | `.vitest.*` in CI; **84 CT specs ran nowhere in CI** |

Root causes behind the hidden `ui-playground` / `ui` failures:

- `processing-config-panel` read `availableAsrModels.length` on `undefined` (store field
  drift) — one missing default cascaded into ~50 failures; plus stale language/size/desc assertions.
- `all-reports-panel.test.tsx` — globally stubbed `@arcaai/ui/*` left `MultiColumnLayout`/`Switch` undefined.
- `use-file-transcription.test.ts` — service API drift (`uploadAndTranscribeWithProgress`) + `localStorage` leak between tests.
- `use-auto-refresh.impersonation.test.ts` — re-impersonation fallback returned `false` (logout) instead of `true`.
- `api-key-form` — tenant-id Zod rule did not enforce UUID.
- `master-detail-layout` CT (3) + `calendar` CT (1) — see Phase 4.

---

## 3. Implementation Plan (approach A — Turbo fan-out)

`pnpm test` and CI both fan out via `turbo run test`, so they cannot diverge again. Each
package stays authoritative for its own Vitest/Playwright config. The root
`test:unit`/`test:integration`/`test:e2e` remain for the infra-dependent api/integration/e2e flows.

1. **Config hygiene** — delete dead `vitest.workspace.ts`; merge `@arcaai/vox` `.mts` into `.ts`, delete `.mts`.
2. **Fix orphaned `@arcaai/vox` `.tsx` tests** — repair stale store mocks.
3. **Fix the 92 `ui-playground` failures** — root-cause each, fix component or test as appropriate.
4. **`packages/ui`** — confirm `*.vitest.*` green; fix the Playwright-CT specs.
5. **Aggregate scripts** — add root `test` / `test:e2e:all`; confirm per-package config-bound `test` scripts.
6. **CI parity** — add `@arcaai/applications` + `ui-playground` to CI; add a gated, non-blocking CT job.
7. **Verify & document** — run the fan-out green; capture evidence; write this README.

---

## 4. Implementation Summary

### Phase 1 — Config hygiene
- Deleted `vitest.workspace.ts` (dead under Vitest 4).
- Merged the former `vitest.config.mts` into `packages/agentic-sdk-v2/vitest.config.ts`:
  `include: ['src/**/*.test.{ts,tsx}', ...]`, `deps.inline`, and the `alias` block
  (`highlight.run`, `@opentelemetry/api`, `eventemitter3`, `@arcaai/med-ner`, `@arcaai/room`).
  Deleted the `.mts`. Updated `knowledge/03_QUALITY_CONTROL.md` to reference the single `.ts` config.

### Phase 2 — `@arcaai/vox` `.tsx` tests
- `useArcaConfig.test.tsx` / `useArca.test.tsx`: the hooks use **discrete selectors**
  (`useAgenticStore(selectX)`), but the mocks used `mockReturnValue(store)`. Switched to
  `mockImplementation((selector) => selector(store))` and added the missing store members
  (`configReady`, `incrementModelRegistryVersion`, `setActiveStream`, `setActiveAudioContext`,
  `setAudioLanguage`, `addTranscriptSegment`).

### Phase 3 — `apps/ui-playground` (92 → 0)
- `processing-config-panel.tsx`: render `model.size` and `pipeline.description` in the
  `SelectItem`s (matching test expectations / available data).
- `processing-config-panel.test.tsx`: fixed store field name (`availableAsrModels`),
  refreshed language assertions to `SUPPORTED_LANGUAGES`, corrected the `local_ai`
  `select-root` count, and added `localStorage.clear()` in `beforeEach`.
- `all-reports-panel.test.tsx`: added mocks for `@arcaai/ui/switch` and
  `@arcaai/ui/multi-column-layout` (the package is globally stubbed in this app's Vitest config).
- `use-file-transcription.test.ts`: mock `uploadAndTranscribeWithProgress` + `localStorage.clear()` for isolation.
- `use-auto-refresh.ts`: re-impersonation `catch` now returns `true` (successful fallback to admin token) instead of `false` (forced logout).
- `api-key-form.tsx`: `tenantId` schema now `z.string().uuid('Must be a valid tenant UUID')`.

### Phase 4 — `packages/ui`
- Vitest (`*.vitest.*`): **215 files / 365 tests** — green, no change required.
- Playwright-CT — 4 failures root-caused and fixed:
  - **`master-detail-layout` (3)**: Playwright CT proxies function props as async RPC to
    Node, so render-prop callbacks (`renderItem`/`keyExtractor`) cannot return values
    synchronously in the browser (items rendered as empty buttons). Added
    `__tests__/fixtures/shadcn/master-detail-layout-fixtures.tsx` (encapsulating those
    functions in browser-bundled code) and rewired the 3 tests to mount the fixtures.
  - **`calendar` (1)**: react-day-picker v9 keeps outside-day cells in the DOM but applies
    the `hidden` modifier (Tailwind `invisible`); the test now asserts no `.rdp-outside:visible`
    rather than zero in the DOM.

### Phase 5 — Aggregate scripts
- `package.json`: added `"test": "turbo run test"` and `"test:e2e:all": "turbo run test:e2e"`.
  Existing `test:unit`/`test:integration`/`test:e2e` retained for infra flows.
- Confirmed the Turbo fan-out runs `test` in **14 packages**: `api, applications, domains,
  logger, med-ner, noise-filter, pipeline, room, stt, ui, ui-playground, utils, vad, vox`.
  (`@arcaai/ui`'s `test` runs the `.vitest.*` specs; CT stays under `test:ct`.)

### Phase 6 — CI parity (`.gitlab/ci/test.yml`)
- `test-packages`: added `--filter=@arcaai/applications`.
- New `test-apps` job: runs `turbo test --filter=@arcaai/ui-playground` (gated by the existing `.rules-ui-playground`).
- New `test-ui-ct` job: Playwright image, `allow_failure: true` (non-blocking), gated on
  `packages/ui` changes, runs the 84 CT specs (Chromium+Firefox+WebKit in CI).
- Updated the `SKIP_TESTS_TS` doc comments to list the new jobs.

### Files changed

**Added**
- `packages/ui/src/components/__tests__/fixtures/shadcn/master-detail-layout-fixtures.tsx`
- `docs/implementation/TASK-324-Test-Harness-Coverage/README.md`

**Deleted**
- `vitest.workspace.ts`
- `packages/agentic-sdk-v2/vitest.config.mts`

**Modified**
- `package.json` (root aggregate scripts)
- `.gitlab-ci.yml`, `.gitlab/ci/test.yml` (CI parity)
- `knowledge/03_QUALITY_CONTROL.md`
- `packages/agentic-sdk-v2/vitest.config.ts`
- `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.test.tsx`
- `packages/agentic-sdk-v2/src/hooks/__tests__/useArcaConfig.test.tsx`
- `apps/ui-playground/src/features/audio/components/processing-config-panel.tsx`
- `apps/ui-playground/src/features/audio/components/__tests__/processing-config-panel.test.tsx`
- `apps/ui-playground/src/features/dna-writing-style/__tests__/all-reports-panel.test.tsx`
- `apps/ui-playground/src/features/auth/login/components/api-key-form.tsx`
- `apps/ui-playground/src/hooks/use-auto-refresh.ts`
- `apps/ui-playground/src/hooks/__tests__/use-file-transcription.test.ts`
- `packages/ui/src/components/__tests__/shadcn/master-detail-layout.test.tsx`
- `packages/ui/src/components/__tests__/shadcn/calendar.test.tsx`

### Verification evidence (local, 2026-06-01)

| Suite | Result |
|---|---|
| `@arcaai/vox` | **148 files / 3103 tests** passed |
| `apps/ui-playground` | **61 files / 687 tests** passed (was 92 failing) |
| `packages/ui` Vitest | **215 files / 365 tests** passed |
| `packages/ui` Playwright-CT | **84 files / 1729 tests** passed (was 4 failing) |
| `apps/api` unit (integration excluded) | **81 files / 1481 tests** passed |
| `turbo run test --filter='!@arcaai/api'` | **31 tasks, 31 successful** |

**Local == CI set:** local `pnpm test` fans out to 14 unit packages; after the CI changes,
CI runs the same 14 across `test-api` + `test-packages` (+applications) + `test-sdk` +
`test-apps` (ui-playground), plus the non-blocking `test-ui-ct` for extra CT coverage.

### Deviations / out of scope

- `@arcaai/database` and `@arcaai/exceptions` have unit tests but no per-package Vitest
  config/`test` script, so they are **not** in the Turbo fan-out (kept out so local == CI,
  since the plan's CI parity covers only `applications` + `ui-playground`). They remain
  covered by the root `test:unit`; `database` also has dedicated CI rigs
  (`test-pgbouncer-validation`) and infra-gated integration suites. Bringing them into the
  fan-out needs net-new configs that carefully exclude their integration/pgbouncer/postgres
  suites — a separate follow-up.
- `apps/api`'s `test` script also includes `tests/integration/**/*.spec.ts`, which require a
  seeded test DB (CI handles via `prepare-test-db`; locally via `pnpm test:setup`). Per the
  DB-safety rule, the destructive schema reset/seed was **not** run in this pass; the api
  **unit** layer was verified green (1481 tests) with integration excluded.
- The 9 package-level Playwright **e2e** suites and broader app e2e remain run-locally /
  CI-gated follow-ups; only the `@arcaai/ui` CT job was added (non-blocking) this pass.
- Turbo `test` task still `dependsOn: ["build"]` (with `build` cache-disabled), so a cold
  `pnpm test` rebuilds packages first. Tightening `inputs`/`dependsOn` was left as the
  plan's optional item to avoid risking suites that import built `dist`.

---

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-01 | Initial implementation of TASK-324 (Phases 1–7): config hygiene, vox/ui-playground/ui fixes, aggregate scripts, CI parity, verification. | See "Files changed" above |
