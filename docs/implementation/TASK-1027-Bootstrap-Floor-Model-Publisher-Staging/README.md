# TASK-1027: Model-publisher staging keys are not the bootstrap floor (env-sync floor size test)

**Status:** Review — merged into `dev-2.2` (`6f31d9c2e`), post-merge gates green; not pushed
**Type:** bugfix (config classification + regenerated env samples)
**Branch:** `agent/jovial-sinoussi-9321d5` (worktree `sharp-hopper-96900a`), on top of TASK-1026 (`06c1ce322`), based on `dev-2.2` @ `ad3ffdaea`; target `dev-2.2`
**Related:** TASK-1019 (declared the keys), TASK-1026 (found this while proving `pnpm test:unit`)

## Requirement Analysis

`scripts/__tests__/env-sync.test.ts > env:sync — the bootstrap floor (.env.sample first section) carries only the floor > stays within the size target (≤ 60 lines)`
failed with `expected 64 to be less than or equal to 60`. It also fails when run alone. Because root
`pnpm test:unit` is `vitest run … && pnpm --filter @arcaai/vox --filter @arcaai/admin-console test`,
this one failure also stopped the vox/admin-console half from running. Rule 09 §Configuration Tiers:
the bootstrap floor is ONLY what a process needs to reach the database or authenticate to Vault.
Either the extra lines don't belong in the floor (move them out through the generator), or they do
(raise the limit, with a reason).

## Current State Evaluation

- The brief blamed TASK-1024 (`14b7eb776`). **That was wrong**: it only *removed* the
  `MODEL_STORE_PUBLISHER_*` pair, which sat in the API section, not the floor.
- The four extra lines are two keys, both added to `BOOTSTRAP_ENV_SETTINGS` with category `'Bootstrap'`
  by **TASK-1019**:
  - `303d5d559` (2026-09-29) — `modelPublisher.stagingDir` → `MODEL_PUBLISHER_STAGING_DIR` (+2 lines → 62)
  - `55900ba1e` (2026-09-29) — `modelPublisher.stagingMaxBytes` → `MODEL_PUBLISHER_STAGING_MAX_BYTES` (+2 lines → 64)
- `scripts/env-sync.mts:321` builds the floor as `category === 'Bootstrap'` from the registry, and
  the floor test asserts it equals **all** of `BOOTSTRAP_ENV_SETTINGS`. So a descriptor can't stay in
  that array under another category. It has to leave the array.
- **Classification:** both keys are correctly `tier: 'env'`. One is a path on the model-publisher
  worker's own filesystem, the other the size of its staging emptyDir (topology, fixed for the
  process lifetime, no admin write path). Neither is needed to reach the DB or authenticate to Vault,
  so they are **not** the floor. Raising the limit would be the wrong fix.
- Their only reader is the model-publisher worker (`packages/applications/src/services/ai-model/publish/model-staging.ts`),
  which starts from `apps/api/src/model-publisher.main.ts` and does not run the gateway's startup env
  check. The gateway's check (`API_ENV_DESCRIPTORS`) covers them only because it includes the whole
  floor. That coverage should survive the move ("one shared env file, one shared contract", as for
  `HARNESS_CLAIM_CHECK_ENABLED`).

## Implementation Plan

1. RED — `env-sync.test.ts`: the floor must not contain either key, and `apps/api/.env.sample` must declare both.
2. Move both descriptors verbatim (same key, tier, dataType, failMode, label, description) from
   `bootstrap-env.descriptors.ts` to a new `MODEL_PUBLISHER_STAGING_SETTINGS` in
   `service-runtime.descriptors.ts`, category `'Service Runtime'`. That file already holds the
   single-worker env key `HARNESS_CLAIM_CHECK_ENABLED`.
3. Register in `registry.ts`, add a named re-export to the barrel, and spread into `API_ENV_DESCRIPTORS`
   (`apps/api/src/config/env.schema.ts`) so gateway startup validation stays the same.
4. `pnpm env:sync` (never hand-edit the generated samples); `pnpm env:sync --check`.
5. GREEN — targeted suites, then full root `pnpm test:unit` exit 0.

## Implementation Summary

| File | Change |
|---|---|
| `packages/applications/src/services/settings-registry/descriptors/bootstrap-env.descriptors.ts` | removed the two staging descriptors |
| `packages/applications/src/services/settings-registry/descriptors/service-runtime.descriptors.ts` | **new** `MODEL_PUBLISHER_STAGING_SETTINGS` (same two descriptors, category `Service Runtime`, doc comment says why they are not the floor) |
| `packages/applications/src/services/settings-registry/registry.ts` | registers `...MODEL_PUBLISHER_STAGING_SETTINGS` |
| `packages/applications/src/services/settings-registry/index.ts` | named re-export beside `HARNESS_CLAIM_CHECK_ENABLED` |
| `apps/api/src/config/env.schema.ts` | spreads it into `API_ENV_DESCRIPTORS` (startup validation unchanged) |
| `packages/applications/src/services/settings-registry/__tests__/fail-mode.governance.test.ts` | the two key→name map entries moved out of the "bootstrap floor" comment group (same assertions) |
| `scripts/__tests__/env-sync.test.ts` | new regression test (floor excludes, API sample declares) |
| `.env.sample`, `apps/api/.env.sample` | **regenerated** by `pnpm env:sync`: the keys leave the floor and appear, with full descriptions, after `HARNESS_CLAIM_CHECK_ENABLED` in the API section |

Nothing changes at runtime: the env var names, their reader, defaults and failMode are the same;
`turbo.json#globalEnv` and `env-surface.generated.md` are unchanged (the generator reported only the
two samples as updated). There are no migrations, no API changes, and no deployment-repo change,
because the names are the same.

### Evidence

RED (before the move):

```
× … keeps worker-only runtime keys out of the floor, in the platform surface (TASK-1027)
× … stays within the size target (≤ 60 lines)
AssertionError: MODEL_PUBLISHER_STAGING_DIR: expected [ 'NODE_ENV', 'PORT', …(16) ] to not include 'MODEL_PUBLISHER_STAGING_DIR'
AssertionError: expected 64 to be less than or equal to 60
      Tests  2 failed | 53 passed (55)
```

Generator:

```
pnpm env:sync        → updated apps/api/.env.sample, updated .env.sample · bootstrap floor 60 lines
pnpm env:sync --check → OK — 13 artifacts match their declarations (144 TS keys + 311 Python fields · 519 globalEnv entries); no unread keys in 8 operator-facing files.
```

Targeted (env-sync, settings-registry, `apps/api/src/config`, `ai-model/publish`, env-port-standardization):

```
 Test Files  75 passed (75)
      Tests  881 passed | 2 skipped (883)
```

Full root `pnpm test:unit` (worktree, after `db:generate` + `build:packages`) — **exit 0**:

```
 Test Files  1947 passed | 2 skipped (1949)
      Tests  28596 passed | 7 skipped | 9 todo (28612)
packages/agentic-sdk-v2 test:  Tests  3298 passed (3298)
apps/admin-console test:       Tests  3821 passed (3821)
```

Build / lint / types: `pnpm --filter @arcaai/applications build` ✓, `pnpm --filter @arcaai/api typecheck` ✓,
ESLint 0 problems on the changed source files, Prettier clean on every changed source file.
`env-sync.test.ts` already failed Prettier at HEAD and was not reformatted.

## Change History

| Date | Change |
|---|---|
| 2026-09-30 | Found the real cause (TASK-1019's staging keys in the floor, not TASK-1024); moved to service runtime; samples regenerated; status Review |
| 2026-09-30 | Merged into `dev-2.2` from the primary checkout (`6f31d9c2e`, `--no-ff`, with TASK-1026/1027 together). Post-merge gates in the primary: `pnpm --filter @arcaai/applications build` ✓, `pnpm --filter @arcaai/api typecheck` ✓, `pnpm env:sync --check` OK (after rebuilding `@arcaai/applications` dist; the first run used the primary's stale dist without the new export). full root `pnpm test:unit` **exit 0** — root 1947 files / 28598 tests passed (0 logging failures), vox 3298/3298, admin-console 3821/3821. Worktree `sharp-hopper-96900a` and branch `agent/jovial-sinoussi-9321d5` removed after the merge. Not pushed. |
