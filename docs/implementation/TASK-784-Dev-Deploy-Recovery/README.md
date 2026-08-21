# TASK-784 — Dev Deploy Recovery: image runtime packaging + wedged migration ledger

| Field | Value |
|---|---|
| Status | `Completed` (code); dev cluster awaiting a rebuilt image |
| Type | `bugfix` + `infrastructure` |
| Branch | `dev-2.2` |
| Opened | 2026-08-21 |
| Trigger | `hope-v2-dev` Argo Application `Degraded`; sync stuck on `batch/Job/hope-db-migrate` |

## Requirement Analysis

Review the last `promote-dev` run and re-run it if needed, then reset and reseed the dev database.

**`promote-dev` did not need re-running.** Job [13891](https://git.taphuynh.dev/arca/hope-v2/-/jobs/13891)
(pipeline [956](https://git.taphuynh.dev/arca/hope-v2/-/pipelines/956), `dev-2.2` @ `1c410d31`)
succeeded: it retagged all 13 images `sha-1c410d31` → `dev-1c410d31` and committed `8eaf997d`
to `arca/hope-v2-deployment`, correctly adding the previously-absent `hope-v2/text` entry
(15 insertions / 12 deletions in `overlays/dev/kustomization.yaml`). The two later commits
(`b95b4cc1` TASK-730 Temporal, `706e0ca8` AWS EKS docs) landed cleanly on top; Argo is
`Synced` to `706e0ca8`. `1c410d31` is still HEAD of both `dev-2.2` and `feat/loop`, so there was
nothing newer to promote.

Re-running it would have re-promoted the same broken images. The digests reached the cluster
exactly as designed — **the images themselves were defective**. Three independent faults:

| # | Symptom | Root cause |
|---|---|---|
| 1 | `hope-api` CrashLoopBackOff, 750 restarts | `@arcaai/workflow-contract` / `@arcaai/async-contract` dist never copied into the api production stage |
| 2 | `hope-admin-console` CrashLoopBackOff, 786 restarts | Next standalone traced 3 of `@swc/helpers`' 441 files; the `esm/` tree it loads at runtime was absent |
| 3 | `hope-db-migrate` P3009, 4 failed pods | Dev DB carried the pre-squash migration lineage; the `20260817000000_init` squash failed on `type "AgentSessionKind" already exists` |

## Current State Evaluation

### 1. api — manifest presence ≠ dist presence

`479c06bdf` repaired the Dockerfile's `COPY packages/<pkg>/package.json` list so
`pnpm install` stopped aborting with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`, and
`dockerfile-workspace-manifests.test.ts` was added to guard it. That fixed the **build**
and left the **runtime** short: `pnpm install --prod` links
`packages/applications/node_modules/@arcaai/workflow-contract → ../../workflow-contract`
and is perfectly happy when the target holds only a `package.json`. The failure moved from
install time to boot time:

```
Error: Cannot find module
  '/app/packages/applications/node_modules/@arcaai/workflow-contract/dist/index.js'
```

Computing the runtime (`dependencies`-only) workspace closure of `@arcaai/api` against the
production stage's `COPY --from=builder` lines gave exactly two gaps — `async-contract` and
`workflow-contract` — both `main: ./dist/index.js`. Every other runtime member was already
covered. `@arcaai/tools` is a devDep and correctly out of scope.

### 2. admin-console — a wildcard subpath export defeats static tracing

Inspected the shipped image directly (debug pod on
`admin-console@sha256:30f9ecf1…`):

```
/app/node_modules/.pnpm/next@16.3.1_…/node_modules/@swc/helpers
  → ../../../@swc+helpers@0.5.23/node_modules/@swc/helpers
     cjs/_interop_require_default.cjs
     cjs/_interop_require_wildcard.cjs
     package.json          ← 3 files total; source has 441
```

`@swc/helpers` declares `"./esm/*": "./esm/*"` — a wildcard subpath export. Next's
`dist/server/require-hook.js` loads through it dynamically, so file tracing never sees those
paths and all 108 `esm/` files were dropped.

### 3. Database — a squash applied onto the pre-squash lineage

`vox-dev` @ `10.10.1.250:5000`. The image ships 12 migrations beginning with the squash
`20260817000000_init`; `_prisma_migrations` held **88** rows — the entire pre-squash history —
so the squash re-issued DDL for objects that already existed:

```
Database error code: 42710
ERROR: type "AgentSessionKind" already exists
```

Neither non-destructive recovery works. `migrate resolve --rolled-back` re-fails on the same
object. `--applied` skips the DDL, leaving the DB on the old physical shape while Prisma
believes it is on the squash — the 11 unapplied follow-ups would then run against a schema
they do not match. Reset was the correct remedy, and was the requested one.

Blast radius checked before acting: `vox-dev` is a distinct database on a server that also hosts
`hope`, `hope-staging`, `vox_staging`, `temporal`, `langfuse`; its only live connections were 9
from `10.10.1.200` (the hope-v2-dev node).

## Implementation Plan

1. api: copy the two missing dists into the production stage → verify by recomputing the closure.
2. api: add `dockerfile-runtime-dist.test.ts` — a source sweep over the runtime closure. Must go
   RED against the Dockerfile that shipped `dev-1c410d31`.
3. admin-console: `outputFileTracingIncludes` for `@swc/helpers` → verify by building standalone
   and asserting the previously-missing file is present.
4. DB: `migrate reset --force`, then seed `RUN_SEED=all` / `NODE_ENV=development`.

## Implementation Summary

### Files changed

| File | Change |
|---|---|
| `apps/api/Dockerfile` | +12 lines: `dist` + `package.json` for `async-contract` and `workflow-contract` in the production stage |
| `apps/api/src/__tests__/dockerfile-runtime-dist.test.ts` | **new** — runtime-dist closure sweep |
| `apps/admin-console/next.config.ts` | +33 lines: `outputFileTracingIncludes` for `@swc/helpers` |

### Evidence

Guard test RED against the Dockerfile that shipped `dev-1c410d31`:

```
× copies the build output of every runtime workspace dependency
AssertionError: apps/api/Dockerfile production stage links 2 workspace package(s) whose
dist it never copies. pnpm install --prod succeeds; the container then dies at boot with
MODULE_NOT_FOUND. Add for each: COPY --from=builder --chown=api:hope
/app/packages/async-contract/dist ./packages/async-contract/dist (+ its package.json)
COPY --from=builder --chown=api:hope /app/packages/workflow-contract/dist
./packages/workflow-contract/dist (+ its package.json)
      Tests  1 failed | 3 passed (4)
```

GREEN after the fix, alongside the existing manifest sweep:

```
Test Files  2 passed (2)
     Tests  9 passed (9)
```

admin-console standalone, before → after (same glob, real build output):

```
@swc/helpers total files : 3   → 438
@swc/helpers esm/ files  : 0   → 108
esm/_interop_require_default.js : MISSING → PRESENT
apps/admin-console/server.js    : PRESENT (CMD target unchanged)
```

```
pnpm turbo run typecheck lint --filter=@arcaai/admin-console
 Tasks:    10 successful, 10 total
```

Database, after reset + seed:

```
failed/pending migrations: []
migration rows: 12   (was 88)
core tables:   104   (was 95)
Tenant 3 · User 32 · Role 7 · Department 27 · DepartmentAgent 23 · PromptTemplate 66
ApiKey 10 · Consultation 11 · AuditLog 15 · AiModel 135 · AiTaskDefault 12 · ServiceAccount 1
```

### Notes and residuals

- **`outputFileTracingRoot` deliberately left inferred.** The inferred root already produces the
  monorepo-shaped layout that `CMD ["node", "apps/admin-console/server.js"]` depends on; pinning
  it risks relocating `server.js` for no gain.
- **Glob scope is `@swc/helpers/**`, not the whole `.pnpm` entry.** Widening it to
  `@swc+helpers@*/node_modules/**` makes the glob match the sibling `tslib` symlink, which
  Turbopack then reads as a file and dies with
  `reading file ".../node_modules/tslib" - Is a directory (os error 21)`. Verified: that widening
  fails the build.
- **Known residual — tslib.** 7 of the 108 helpers (`_ts_decorate`, `_ts_metadata`, `_ts_param`,
  `_ts_values`, `_ts_dispose_resources`, `_ts_add_disposable_resource`,
  `_ts_rewrite_relative_import_extension`) import `tslib`, which is not traced in. They are the
  TypeScript decorator/`using` helpers; this app emits neither, and the observed crash was
  `_interop_require_default` only. Copying tslib in would not help — resolution runs through that
  same sibling symlink, so it would ship unreachable. If a `_ts_*` helper ever appears in a
  MODULE_NOT_FOUND, the fix is a real `tslib` dependency in the app's `package.json`.
- **Local-only obstacle, not shipped.** `packages/domains/dist/dist` was a self-referential
  symlink (→ its own parent), created 2026-05-27 in gitignored build output. Any recursive glob
  walks it forever; it failed the first local build with
  `Too many levels of symbolic links (os error 62)`. Removed locally. It does not exist in CI
  (fresh checkout), and nothing tracked references it.

### Not done here

`hope-api` and `hope-admin-console` keep serving their previous pods (`1/2` ready each) and stay
Degraded until a pipeline builds images containing these fixes and `promote-dev` publishes them.
The DB and migration ledger are already clean, so `hope-db-migrate` will pass on its next run.

## Change History

| Date | Change |
|---|---|
| 2026-08-21 | Diagnosed the three faults; established `promote-dev` had already succeeded and needed no re-run. Fixed the api runtime dist closure and added its guard sweep; fixed admin-console standalone tracing for `@swc/helpers`. Reset `vox-dev` (88 → 12 migration rows) and reseeded with `RUN_SEED=all`. |
