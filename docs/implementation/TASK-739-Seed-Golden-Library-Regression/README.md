# TASK-739 — Seed Pipeline Dropped `seedAgentGoldenLibrary` (TASK-686 Regression)

| | |
|---|---|
| **Status** | Completed |
| **Type** | Bugfix |
| **Depends on** | — (regression in [TASK-686](../../archive/TASK-686-Day-1-Default-Schema-And-Agent-Config/README.md), which is archived and off-limits this sprint, hence the new ticket number rather than an append to that README) |

## 1. Requirement Analysis

`packages/database/src/prisma/db_main/seed/index.ts` imports `seedAgentGoldenLibrary` (line 17)
but never invokes it. Every fresh seed (`RUN_SEED=all` or `safe`) therefore produced **zero**
SYSTEM-tenant golden `Department` / `PromptTemplate` / `DepartmentAgent` rows.

Effect: `TenantService.provisionTenantAgentCatalog` clones from an empty source, so newly
created tenants get no default agents, and `POST /admin/department-agents/resync` always reports
`added:0 / skipped:0` — a reconciler that looks idempotent only because it has nothing to
reconcile. This was the root cause of 2 of the 10 originally-reported failures in
`apps/api/tests/e2e/department-agent-resync.spec.ts`:
- *"a global admin sweeps every tenant and the sweep is idempotent"*
- *"creating a tenant provisions golden agents; resyncing it is then a no-op"*

**Out of scope:** the other 8 originally-reported e2e failures (unrelated causes — not
investigated here). A pre-existing, unrelated local-only flake in the same spec file is also out
of scope — see §5.

## 2. Current State Evaluation

Root-caused to commit `1174c7b51` ("feat(TASK-686): seed the day-1 context schema and agent loop
configuration"). Its diff on `index.ts`:

```diff
-    await seedAgentGoldenLibrary(client);
+    // Day-1 consultation context schema (TASK-686): ...
+    await seedConsultationLoopDefaults(client);
```

TASK-686 added a new phase (`seedConsultationLoopDefaults`) by **replacing** the existing call
instead of adding the new one alongside it. The import stayed (so no compiler/lint error), the
comment above the call site stayed (still describing `seedAgentGoldenLibrary`'s golden-library
work, now attached to a call that doesn't do that work), and the invocation silently disappeared.

Verified directly against the file before any change — `seedAgentGoldenLibrary` appears once
(the `import`) and is never called in `seed()`. Confirmed live: reset + reseed the isolated test
DB (`hope_test`, port 5433) pre-fix produced `0` SYSTEM-tenant `Department` / `PromptTemplate` /
`DepartmentAgent` rows.

`packages/database/src/prisma/db_main/seed/__tests__/task-686-loop-defaults-idempotency.test.ts`
did not catch this: it calls `seedAgentGoldenLibrary` and `seedConsultationLoopDefaults` directly
against a fake Prisma client, bypassing `index.ts`'s pipeline entirely (documented in its own
header: *"no seed test in this repo touches a live database"*). No existing test asserted that
the real pipeline invokes every phase it imports.

## 3. Implementation Plan

1. Restore `await seedAgentGoldenLibrary(client);` in `index.ts`, positioned before
   `await seedConsultationLoopDefaults(client);` per the original ordering and the comment that
   already describes the dependency (`seedConsultationLoopDefaults`'s own comment references
   "the loop configuration seedAgentGoldenLibrary just wrote onto the default agents").
2. Add a static regression test, following this directory's established convention (no seed test
   touches a live DB — see `seed-idempotency.test.ts`): parse `index.ts`'s source, collect every
   `seed*`/`provision*` identifier imported from a numbered phase file, and assert each appears
   as a call, not just an import. This generalizes past this one instance — it catches the whole
   bug *class* ("import kept, call dropped") for any of the ~35 phases, not just this one.
3. Verify live: reset + reseed the isolated test DB, confirm non-zero golden rows, then re-run
   `department-agent-resync.spec.ts` and confirm the two previously-failing assertions pass.

## 4. Implementation Summary

- [packages/database/src/prisma/db_main/seed/index.ts](../../../packages/database/src/prisma/db_main/seed/index.ts) —
  restored `await seedAgentGoldenLibrary(client);` immediately before
  `await seedConsultationLoopDefaults(client);`, keeping the original golden-library comment on
  the restored call and the TASK-686 comment on the loop-defaults call.
- [packages/database/src/prisma/db_main/seed/__tests__/seed-pipeline-completeness.test.ts](../../../packages/database/src/prisma/db_main/seed/__tests__/seed-pipeline-completeness.test.ts) (new) —
  static regression guard: every `seed*`/`provision*` function imported from a numbered phase
  file must appear as a call in `index.ts`. Confirmed RED against the pre-fix source (failed on
  exactly `seedAgentGoldenLibrary`, 1 of 35), GREEN after.

## 5. Verification Evidence

**Regression test — RED before / GREEN after** (`packages/database` test suite,
`seed-pipeline-completeness.test.ts`, 36 assertions: 1 sanity check + 35 phase functions):
- Reverted the `index.ts` fix only (test file kept) → `seedAgentGoldenLibrary is called in the
  seed() pipeline, not just imported` failed: `expected false to be true`. All other 34 phase
  assertions passed.
- Restored the fix → all 36 pass.

**Full package suite**: `pnpm --filter @arcaai/database test` → 1262/1262 passed (51 files).
`pnpm --filter @arcaai/database build` → clean (`tsc`).

**Live DB, before/after** (isolated test DB, `hope_test`, port 5433 — destructive reset done
with explicit user consent per the Prisma AI-agent safety gate):
- Before the fix: `0` SYSTEM-tenant (`00000000-0000-0000-0000-000000000000`) `Department` /
  `PromptTemplate` / `DepartmentAgent` rows (this was the state going into this ticket).
- After `pnpm test:db:reset` + `RUN_SEED=all NODE_ENV=test pnpm test:db:seed`: `18` / `16` / `18`
  respectively — matching `07a-agent-golden-library.ts`'s documented golden-set shape (18
  departments, 18 default agents; the 16 templates split 3 `SYSTEM` + 12 `SUMMARY` + 1 `CUSTOM`
  by category, consistent with the golden templates plus the other SYSTEM-tenant prompt phases
  seeded earlier in the pipeline).

**`apps/api/tests/e2e/department-agent-resync.spec.ts`**, run directly (`RESET_DB=false` — DB
already correctly seeded above) with `--workers=1` (matches `playwright.config.ts`'s
`workers: isCI ? 1 : undefined` — CI always runs this file serially):

```
Running 3 tests using 1 worker
  ✓ resyncing the SYSTEM tenant against itself is rejected (400)
  ✓ a global admin sweeps every tenant and the sweep is idempotent
  ✓ creating a tenant provisions golden agents; resyncing it is then a no-op
3 passed (1.2s)
```

Both previously-failing assertions named in this ticket's requirement now pass.

**Known, pre-existing, out-of-scope flake**: running this same spec file locally with Playwright's
default (unset → auto multi-worker) concurrency reproduces a *different* failure — the second
sweep's `added` count is `1`, not `0` — because the "sweep every tenant" test and the "create a
throwaway tenant" test both mutate the same cross-tenant resync surface and race when scheduled
on different workers simultaneously. `playwright.config.ts` already pins `workers: isCI ? 1 :
undefined`, so CI (which always sets `CI=true`) never hits this; it only reproduces when a
developer explicitly runs this file locally with multiple workers. Not fixed here — orthogonal to
the seed-pipeline bug this ticket addresses, and fixing test-isolation for concurrent local runs
is a separate, non-trivial change to the spec itself (e.g. `test.describe.configure({ mode:
'serial' })`) that deserves its own review rather than riding along on this fix.

## 6. Change History

- 2026-08-17 — Initial fix: restored the dropped `seedAgentGoldenLibrary` call, added the
  seed-pipeline-completeness regression test, verified live against a reset+reseeded isolated
  test DB and the `department-agent-resync.spec.ts` e2e suite. Status: Completed.
