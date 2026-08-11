# TASK-669 — Remove the deprecated `apps/ui-playground`

**Status:** Completed
**Type:** refactor / infrastructure cleanup
**Base commit:** `b3d3fe590` (`merge(TASK-657): vision content-parts support across SMR providers`, branch `dev-2.1`)

## Requirement Analysis

`apps/ui-playground` (React 19 / Vite / TanStack Router SDK playground + legacy admin
console) has been marked DEPRECATED with no development/maintenance plan since it was
superseded by `apps/admin-console` (Next.js 16, TASK-415). The owner confirmed it is safe
to delete completely. Scope: delete the app directory and every reference to it across
config, CI, source, and currently-authoritative documentation, leaving the monorepo green,
without touching `packages/agentic-sdk-v2/src/compat/**` (owner exclusion) and without
merging/pushing/opening an MR.

## Current State Evaluation

`apps/ui-playground` was a full pnpm workspace member (`apps/*` glob in
`pnpm-workspace.yaml`) with its own `package.json`, Dockerfile, e2e suite, and ~500 tracked
files. It was already excluded from the root `vitest.config.ts` workspace project and was
never part of `pnpm test:unit`'s explicit `--filter` chain, but it still had a CI branch/
pipeline type (`release-playground` / `PIPELINE_TYPE=release_playground`) wired into six
`.gitlab/ci/*.yml` files, and dozens of source-comment / doc references across the repo
pointing at it as an example consumer, a deprecation notice, or (in a few cases) load-bearing
algorithmic/behavioral documentation.

## Implementation Plan

1. Inventory every reference via repo-wide grep, re-verifying the ticket's seed list rather
   than trusting it.
2. Triage each reference: does removing/rewording it change runtime behavior for another
   consumer, or is it a comment/doc that merely needs to stop describing a deleted app?
3. Remove references in a first commit (config, CI, source comments, currently-authoritative
   docs, rules), leaving historical/archival material untouched.
4. Delete `apps/ui-playground` in a second commit.
5. Run the full gate list, fixing any downstream drift the deletion surfaces (there was one:
   `turbo.json#globalEnv` needed regenerating).
6. Document everything here.

## Implementation Summary

### Inventory of references removed, by category

**Config / CI / test infrastructure**
- `pnpm-workspace.yaml` — no change needed; the `apps/*` glob already drops the app
  automatically once the directory is gone (no `!apps/ui-playground` exclusion existed to
  remove).
- `.gitlab-ci.yml` — removed the `release-playground` branch rule (`PIPELINE_TYPE:
  "release_playground"`) and its two comment mentions.
- `.gitlab/ci/build.yml`, `publish.yml`, `rules.yml`, `scan.yml`, `test.yml` — removed
  every `|| $PIPELINE_TYPE == "release_playground"` clause (13 occurrences). All of these
  were shared boilerplate lists ("skip / include this job for these pipeline types") used by
  every per-service build/scan/publish job — none of them built ui-playground's own Docker
  image directly (no `build-ui-playground` job, no `SERVICE_NAME: ui-playground`, ever
  existed in `build.yml`). Also removed the standalone `- if: $PIPELINE_TYPE ==
  "release_playground"` rule in `scan.yml`'s gitleaks job.
- `.gitlab/ci/templates.yml` — removed the `release-playground) TAGS="playground-..."` case
  arm from the shared docker-tag-computation script. This arm was already dead code before
  my change (no job with `.build-common-rules` ever ran for `PIPELINE_TYPE ==
  "release_playground"` — that pipeline type was in the shared `when: never` list), so
  removing it changes nothing observable; it's cleanup of an unreachable branch.
- Validated all seven touched `.gitlab/ci/*.yml` + `.gitlab-ci.yml` files still parse as
  valid YAML (PyYAML with a tag-tolerant loader for GitLab's `!reference`).
- `vitest.config.ts` — removed `'apps/ui-playground/**'` from `SHARED_EXCLUDE` (a no-op
  exclusion once the directory doesn't exist, but an explicit stale reference).
- `tests/contracts/dockerfile-build-info.test.ts` — updated the "deliberately excluded"
  Dockerfile-list comment.
- `scripts/env-sync.mts` — updated the comment listing Vite demos exempt from env-var schema
  validation.
- `.gitignore` — updated the comment listing consumers of the `.example`-fixture allowlist.

**Source (non-compat) — comments/docstrings only, no behavior change**
- `packages/ui/src/sortable.tsx`, `packages/agentic-sdk-v2/src/core.ts`,
  `src/types/config.ts`, `src/providers/AgenticProvider.tsx`,
  `src/core/__tests__/constants.task323.test.ts`,
  `src/providers/__tests__/AgenticProvider.tokenRefresh.test.tsx` — generalized comments
  that named ui-playground as an example consumer/precedent to neutral language ("a
  consumer's `useAutoRefresh`", "consuming apps"). None of these are compat files.
- `apps/api/src/modules/pstudio/pstudio.html.ts` — the "keep in lock-step with
  @prisma/studio-core" comment named ui-playground as a second real consumer of that
  version; verified it's gone (`apps/ui-playground/package.json` was the only other
  `@prisma/studio-core` dependent — `admin-console`'s `db-studio` feature only embeds the
  server-rendered HTML shell, it doesn't depend on the npm package). Comment now names only
  the real remaining consumer, `packages/applications`.
- `apps/api/src/modules/prompt-management/prompt-template.controller.ts` — the class
  docstring named "Pre-Summary/Summary in the ui-playground" as the reason this doctor-facing
  route exists. Verified the route (`GET /prompt-templates/available`) is still live and
  consumed today via `@arcaai/vox`'s `usePrompts` hook
  (`packages/agentic-sdk-v2/src/core/constants.ts` `AVAILABLE:
  '/prompt-templates/available'`) — reworded to name the real current consumer path instead
  of the deleted app.
- `apps/api/src/modules/auth/__tests__/auth.controller.task307-w2.test.ts` — a bug-symptom
  comment ("impersonation from ui-playground fails...") generalized to "a client app" since
  the underlying JWT-TTL regression the test locks is app-agnostic.
- `apps/api/tests/e2e/admin-fetchall-cross-tenant.spec.ts` — dropped a `(see apps/
  ui-playground roles.ts)` pointer to a file that no longer exists; kept the substantive
  `pageSize` vs `limit` comment (still true, verified the `pageSize` RBAC concept lives on in
  `apps/admin-console/src/features/rbac/**`).
- `apps/admin-console/vitest.config.ts`, `.../harness-ops/components/eval-runs-panel.tsx` —
  dropped attribution mentions of ui-playground as design precedent for the app's own
  `@/` resolver and a fallback-projection heuristic; the app's logic is self-contained and
  doesn't need the pointer.
- `apps/stt/tests/integration/streaming_quality.py` — the one line with a concrete path
  (`apps/ui-playground/e2e/helpers/wer.ts`) reworded to "historically shipped in the
  now-removed `apps/ui-playground/e2e/helpers/`"; left the other bare `wer.ts` mentions
  throughout the docstring alone (algorithm-lineage shorthand, not path references —
  rewriting all of them was judged unnecessary churn for a Python-only reference file).

**Docs (currently-authoritative — kept in sync with reality)**
- `README.md`, `tests/README.md` — dropped the app row / exclusion mention.
- `docs/architecture/overview.md` — dropped the app's row from the service table and its
  parenthetical in the (already-stale, pre-existing, out of scope) k3s Kustomize-base bullet.
- `docs/traceability-matrix.md`, `docs/traceability/sdk.md` — dropped "honest notes" bullets
  that said ui-playground was still consuming admin/SDK surfaces.
- `docs/development-guide.md` — dropped the port-table row, the "start it explicitly"
  clause, and the test-exclusion mention (3 spots).
- `docs/operations/testing/test-execution.md` — dropped the exclusion mention and an entire
  "heavy concurrent builds" gotcha bullet that was specific to ui-playground's Vite build
  (no longer applicable to any current app).
- `docs/operations/testing/test-strategy.md` — dropped the "except the deprecated
  apps/ui-playground" scope carve-out (now simply "all apps under `apps/*`").
- `docs/development-patterns-and-standards.md` — the biggest structural change: §3.3
  "TanStack Router" described a pattern (`__root.tsx`, layout groups, `createFileRoute`)
  whose **only consumer in the entire repo was ui-playground** (verified: grep for
  `@tanstack/react-router` in every `apps/*/package.json` returns only ui-playground). With
  that app gone, the pattern no longer exists anywhere in the codebase, so the subsection was
  removed rather than reworded, and §§3.4–3.8 renumbered to §§3.3–3.7 (verified no other doc
  cross-references these section numbers). Also updated the §3 intro line and left the §7
  "known internal inconsistencies" historical remediation entry alone (see below).

**Rules — the explicit CLAUDE.md requirement**
- `.claude/rules/00-project-context.md`, `07-react-ui.md`, `12-design-workflow.md` — per the
  task's explicit instruction, rewrote the "DEPRECATED" descriptions (not just deleted the
  monorepo-map line) to state the app was removed, and repointed the two functional examples
  (Tailwind `@source` scanning, TanStack Router legacy note) at reality.
- Mirrored the same edits into `.cursor/rules/{00-project-context,07-react-ui,
  12-design-workflow}.mdc`. Note: `.cursor/rules` was already independently stale relative to
  `.claude/rules` on unrelated content before this change (confirmed via diff — e.g. it's
  missing `vox-node`, has an outdated package count, a shorter env-files section); it is the
  pre-migration source kept for legacy Cursor-IDE users, not actively kept in lockstep. I
  applied the same mechanical ui-playground-only edits without attempting to resync the rest
  of the file (out of scope, would be unrelated churn).
- `.claude/rules/README.md` / `.cursor/rules/README.md` — the two remaining hits are inside
  the `## Changelog` sections (dated entries describing past rule-file edits); left as
  historical record, same treatment as archived docs.

### Deliberately untouched (compat exclusion)

Per the explicit owner exclusion, `packages/agentic-sdk-v2/src/compat.ts` and everything
under `src/compat/**` were not edited. Three files there reference `apps/ui-playground` and
were left exactly as they are:
- `packages/agentic-sdk-v2/src/compat/config-adapter.ts`
- `packages/agentic-sdk-v2/src/compat/useArcaBatchTranscription.ts`
- `packages/agentic-sdk-v2/src/compat/__tests__/useArcaBatchTranscription.test.ts`

These are dead comments / a `localhost:5175` default now (the app they describe is gone),
which is acceptable residue per the ticket's own instruction. Verified with a build of
`apps/compat-playground` (which imports `@arcaai/vox` including the compat surface) — it
built clean (see Gate Results).

I was also careful with the other `packages/agentic-sdk-v2` files compat imports from
(`src/types/config.ts`, `src/core.ts`, `src/providers/AgenticProvider.tsx`,
`src/core/__tests__/constants.task323.test.ts`,
`src/providers/__tests__/AgenticProvider.tokenRefresh.test.tsx`): every edit there is a
comment/docstring wording change only — no type shape, export, or behavior changed. The
`@arcaai/vox` build (`pnpm --filter @arcaai/vox build`) and its full test suite (4131 tests)
both pass, which exercises `compat.ts`'s imports from these files.

### Deliberately untouched (historical record — same treatment as `docs/archive/`)

These categories still reference `ui-playground` after this change, by design:

- **`docs/archive/**`** (140+ files) — completed-ticket historical record. Per
  `01-development-workflow.md`, archived tickets document what was true when they were
  written; rewriting them to erase a since-deleted app would misrepresent history, not
  correct an error.
- **`docs/implementation/**` for *other* tickets** (SOTA-Track, TASK-533, 604, 616, 634, 635,
  645, 656, etc.) — these are historical implementation records for unrelated, mostly
  already-completed tickets that happen to mention ui-playground in passing. Bulk-editing
  dozens of unrelated ticket READMEs is out of scope for TASK-669 and would violate the
  surgical-changes principle; only `docs/implementation/TASK-558-.../env-surface.generated.md`
  was touched, and only because it's a build artifact regenerated by `pnpm env:sync` (see
  Gate Results).
- **`docs/research/**`** (3 files: two STT SOTA-assessment notes, one streaming-timeout
  audit) — dated, point-in-time research snapshots with specific file:line citations into
  ui-playground as it existed when the research was conducted. These are analogous to
  `docs/archive/` (a record of what was analyzed at the time), not living documentation.
- **`CHANGELOG.md` files** (`apps/api/CHANGELOG.md`, `packages/agentic-sdk-v2/CHANGELOG.md`)
  — append-only historical logs; edited only forward, never rewritten.
- **`packages/database/scripts/backfill-context-item-media-id.ts`** — its docstring explains
  that the corrupted `ContextItem.mediaId` rows this script repairs were corrupted by (among
  other things) "three `apps/ui-playground` call sites sending `key` instead of `mediaId`"
  (TASK-656). That's a real, historical cause of real, still-corrupted database rows —
  deleting the app doesn't un-corrupt the rows or change why they're corrupted, so the
  reference stays.
- **`apps/admin-console/.../consultation-review-screen.tsx` and
  `.../use-live-stt-session.ts`** — both already say the app was "deprecated" or is being
  ported *from*, in the past tense, as accurate design-provenance notes for a live feature.
  They don't claim ui-playground still exists, so no edit was needed.
- **`docs/development-patterns-and-standards.md` §7 item 7** ("the `.gitlab-ci.yml` header
  now marks ui-playground as deprecated") — a dated, strikethrough "remediated in TASK-414"
  entry in the doc's own historical-inconsistencies changelog section; left alone for the
  same reason as the CHANGELOGs above.

### Judgment calls explicitly recorded

1. **`docs/development-patterns-and-standards.md` §3.3 TanStack Router** — removed entirely
   (not reworded) because its only consumer in the repo was ui-playground; renumbered
   §§3.4–3.8 → §§3.3–3.7. Verified no other file in `docs/` cross-references these section
   numbers by their old numbers.
2. **`.gitlab/ci/*.yml` `release_playground` pipeline type** — removed as a unit (branch
   rule + every `when: never`/inclusion list it appeared in + the dead docker-tag case arm)
   rather than leaving inert dead conditionals, since the branch that could ever set
   `PIPELINE_TYPE=release_playground` no longer exists after this change — leaving the
   references would be dead code my own edit introduced.
3. **Example-consumer rewrites** (`packages/ui/README.md`, `packages/agentic-sdk-v2/
   README.md`, `packages/room/README.md`, `apps/example/README.md`,
   `packages/config-tailwind/README.md`) — where a doc said "X does this (see
   ui-playground)", I verified the CURRENT real consumer (`apps/admin-console` and/or `apps/
   compat-playground`, checked via `package.json` dependency + actual usage grep) before
   repointing the reference, rather than just deleting the example. Where no clear/verified
   replacement existed, I removed the specific claim rather than guess.
4. **`.cursor/rules/*.mdc` mirrors** — kept in sync for the ui-playground-specific lines
   only; not resynced with unrelated pre-existing drift from `.claude/rules/*.md` (out of
   scope).
5. **`packages/database/scripts/backfill-context-item-media-id.ts`** and the STT
   `streaming_quality.py` `wer.ts` provenance comment — treated as historical/factual
   (left largely as-is, with only the one concrete now-dead path reference in the Python file
   reworded), not as "the app still exists" claims.

## Test-Count Delta

`pnpm test:unit` = `dotenv -e .env.test -- vitest run --exclude '**/integration/**' --exclude
'**/e2e/**'` (the root "workspace" vitest project) **followed by** `pnpm --filter
@arcaai/ui --filter @arcaai/vox --filter @arcaai/compat-playground --filter
@arcaai/admin-console test`.

**`apps/ui-playground` was never part of this command's scope, before or after this
change**: `vitest.config.ts`'s `SHARED_EXCLUDE` already listed `'apps/ui-playground/**'`
(now removed as dead config, see above) inside the root project, and the explicit
`--filter` chain names only `ui`, `vox`, `compat-playground`, `admin-console` — never
`ui-playground`. So there is **no test-count delta attributable to `pnpm test:unit` losing
ui-playground's own suite** — it was already outside that command's scope.

Results after this change (all commands run with a placeholder `DATABASE_URL`/`DIRECT_URL`
— no live Postgres needed for these gates; see Gate Results below):

| Project | Files | Tests |
|---|---:|---:|
| root workspace | 959 passed, 2 skipped | 16,358 passed, 10 skipped, 9 todo |
| `@arcaai/ui` | 242 passed | 656 passed |
| `@arcaai/vox` | 255 passed | 4,131 passed |
| `@arcaai/compat-playground` | 21 passed | 223 passed |
| `@arcaai/admin-console` | 172 passed | 1,339 passed |

Baseline attribution check (both are subsets of the root workspace run above, not separate
commands):
- `@arcaai/applications` standalone: 454 passed / 1 skipped (455 files), 8,605 passed / 4
  skipped (8,609 tests) — matches the stated baseline "≈ 8,608 passing" (the 3-test
  difference is normal run-to-run noise in an approximate baseline, not a regression; no
  ui-playground reference existed in this package to begin with).
- `@arcaai/database` standalone: 47 files / 1,159 tests — **exact match** to the stated
  baseline.

If instead you mean the broader `pnpm test` (`turbo run test`, which *would* have picked up
`apps/ui-playground`'s own `test` script as a workspace member before deletion): that command
needs live infra (Postgres/Redis/Vault, the harness eval gate, etc.) well beyond this
worktree's scope and was not run as part of this gate list — the task's explicit required
gate is `pnpm test:unit`, which is unaffected as shown above.

## Gate Results

All commands run from the worktree root with `DATABASE_URL`/`DIRECT_URL` set to a
placeholder Postgres URL (no live DB needed for prisma-generate/build/test:unit — a fresh
worktree needs `pnpm db:generate` + package builds before `test:unit` can resolve
`@arcaai/domains`/`@arcaai/applications`/`@arcaai/room`/etc.; this is a pre-existing
worktree-bootstrap requirement, unrelated to this change).

```
$ pnpm install
Scope: all 27 workspace projects   # was 28 before deletion
Done in 6.8s using pnpm v10.31.0

$ pnpm test:unit
 Test Files  959 passed | 2 skipped (961)
      Tests  16358 passed | 10 skipped | 9 todo (16377)
packages/ui test:     Test Files  242 passed (242) | Tests  656 passed (656)
packages/agentic-sdk-v2 test:     Test Files  255 passed (255) | Tests  4131 passed (4131)
apps/compat-playground test:      Test Files  21 passed (21)  | Tests  223 passed (223)
apps/admin-console test:          Test Files  172 passed (172) | Tests  1339 passed (1339)
$ echo $?
0

$ pnpm lint
 Tasks:    31 successful, 31 total
$ echo $?
0
(65 pre-existing warnings in apps/api — eslint-comments/require-description, 0 errors,
 unrelated to this change)

$ pnpm --filter @arcaai/vox build
DTS Build start ... (success)
$ echo $?
0

$ pnpm --filter compat-playground build
✓ built in 16.68s
$ echo $?
0

$ pnpm --filter @arcaai/admin-console build
✓ Compiled successfully — full route manifest printed, no errors
$ echo $?
0

$ pnpm api:build
 Tasks:    9 successful, 9 total
$ echo $?
0

$ pnpm turbo run build --dry-run=json
44 tasks across 26 packages resolved cleanly; "ui-playground" appears in 0 package names.
```

Additionally: `pnpm env:sync` was re-run after the deletion (required — see Change History)
and `pnpm --filter @arcaai/database test` / `pnpm --filter @arcaai/applications test` were
run standalone to produce the baseline-attribution numbers above.

## Commits

1. `05071023b` — `refactor(TASK-669): remove references to deprecated apps/ui-playground`
   (47 files changed — config, CI, source comments, docs, rules)
2. `7fc31f8a7` — `refactor(TASK-669): delete apps/ui-playground` (517 files changed, the app
   directory + `pnpm-lock.yaml` regeneration)
3. `5f03911f7` — `chore(TASK-669): regenerate turbo.json globalEnv after ui-playground
   removal` (gate-driven follow-up: `pnpm env:sync` drift caught by `pnpm test:unit`)

None of these were merged to `dev-2.1`, pushed, or opened as a merge request, per
instruction.

## Change History

- 2026-08-11 — Initial implementation and verification (this document).
