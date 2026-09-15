# TASK-976 — README template refresh across the code-facing surfaces

| Field | Value |
|---|---|
| Status | Completed |
| Type | docs |
| Branch | dev-2.2 |
| Opened | 2026-09-15 |

## Requirement Analysis

Rewrite every code-facing `README.md` in the monorepo to one shared template, correcting
factual drift against the code as it stands today.

Scope decisions taken with the owner before work started:

| Decision | Value |
|---|---|
| Scope | The 94 code-facing READMEs: `apps/**`, `packages/**`, `infrastructure/**`, `scripts/`, `tests/`, `docs/**` outside `docs/implementation/`, the repo-root `README.md`, and the two rule indexes. |
| Explicitly OUT of scope | The 110+ `docs/implementation/TASK-*/README.md` ticket records. Those are per-ticket history; the workflow appends a Change History entry to the owning ticket rather than sweeping them in bulk. `docs/archive/**` is off-limits this sprint. |
| Depth | Full rewrite to a common template PLUS drift correction — not a link-fix pass. |
| Excluded by orchestrator judgment | The 19 vendored `packages/ui/src/components/registries/tool-ui/*/README.md` stubs (upstream registry docs, re-pulled by the shadcn CLI — imposing a local template on them would be reverted on the next registry sync) and `.changeset/README.md` (tool boilerplate). Stated here rather than silently dropped. |

## Current State Evaluation

94 in-scope files, 18,409 lines. The tree had drifted through the TASK-859, 870, 890, 930,
958, 959 and 974 waves without a documentation sweep: retired features still described as
live (guardrail engine prefixes, the in-repo `deployment/k3s/` tree, DB-driven STT pipeline
selection), dead `pnpm` aliases, and paths that no longer exist.

Existing READMEs already shared a loose family (title, position in the stack, directory
structure, commands, related). The template codifies that shape rather than inventing a new one.

## Implementation Plan

Contract written first, then seven parallel lanes, one git worktree per writer
(`.claude/rules/14-multi-agent-worktrees.md` Section 3).

| Lane | Worktree branch | Files | Surface |
|---|---|---|---|
| L1 | `docs/task-976-readme-l1` | 6 | TS apps: api, admin-console, example, compat playgrounds |
| L2 | `docs/task-976-readme-l2` | 7 | Python stt, text, nlp, tts |
| L3 | `docs/task-976-readme-l3` | 5 | Python guardrail, harness |
| L4 | `docs/task-976-readme-l4` | 33 | Backend packages: database, domains, applications, config, py-* |
| L5 | `docs/task-976-readme-l5` | 15 | SDK and browser packages, packages/ui |
| L6 | `docs/task-976-readme-l6` | 13 | infrastructure, scripts, tests, root, rule indexes |
| L7 | `docs/task-976-readme-l7` | 15 | docs/operations, docs/research, docs/architecture |

Every lane ran on Sonnet 5 (owner's instruction; a docs restructure against a fixed contract
is a moderate-complexity transform, which is the tier the rule table names for it).

Shared artifacts, written before any lane was spawned:

- The template contract: required section order, per-section rules, hard rules (verify every
  claim, delete rather than guess, no aspirational content, preserve traps, ASCII only).
- A verification script every lane must run to an empty result: relative links resolve, no
  `docs/archive` references, ASCII only, no placeholders, required sections present.

Lanes were forbidden from running `pnpm install`, any `db:*` or `gen:*` command, any docker or
infra command, and any build or test suite. The pass is read-only against code.

## Implementation Summary

All 94 in-scope READMEs were rewritten to the template and merged into `dev-2.2`.
Total change: **95 files, 8,617 insertions, 15,290 deletions** — the corpus shrank by roughly
40 percent because so much of it was stale, duplicated or aspirational.

**No non-README file was modified by any lane.** Verified with
`git diff --name-only 6b1db72d0..HEAD | grep -v 'README.md$'` (empty).

### Merge record

| Lane | Branch | Lane commit | Merge commit | Files |
|---|---|---|---|---|
| L1 | `docs/task-976-readme-l1` | `84a736cab` (+ `7c39705e1` orchestrator fix) | `7ecf5d3e6` | 6 |
| L2 | `docs/task-976-readme-l2` | `0c1176d58` | `9439f837c` | 7 |
| L3 | `docs/task-976-readme-l3` | `7a7235756` | `e63f98708` | 5 |
| L4 | `docs/task-976-readme-l4` | `5c6f7e95e` (+ `4ec5db478` orchestrator fix) | `220ce7167` | 33 |
| L5 | `docs/task-976-readme-l5` | `1d5311a61` | `9d3b44147` | 15 |
| L6 | `docs/task-976-readme-l6` | `be9a6a4f8` (+ `e73f61b18` orchestrator fix) | `854491d25` | 13 |
| L7 | `docs/task-976-readme-l7` | `5dab4a7c2` (+ `d6e500492` orchestrator fix) | `dc8d729e6` | 15 |

Post-merge: `115682638` normalized the six lane-2 files onto the template section set.
All seven merges were clean; no lane touched another lane's files.

### Verification

- Link/ASCII/placeholder/required-section check across all 94 files: clean. The single
  remaining hit is a false positive in the checker itself — the real filename
  `docs/backlog/2026-07-21-TODO-HARVEST.md` contains the substring `TODO`.
- Template section conformance: **0 of 94 non-conforming**.
- Every lane report was independently re-verified against the tree by the orchestrator rather
  than accepted as written. Four lane claims did not survive and were corrected (below).

### Orchestrator corrections to lane output

| Lane | Claim | Reality |
|---|---|---|
| L1 | admin-console nav inventory "58 + 3" | 57 `NAV_ENTRIES` + 2 `USER_MENU_ENTRIES` |
| L4 | `TENANT_SCOPED_MODELS` = 88 | **90** (the README had 44; the per-file comment totals inside `tenant-scope.ts` sum to 59 and are themselves stale) |
| L6, L7, L4, L2 | extra or misordered top-level sections in 21 files | normalized onto the five-section set |
| L7 | `## SLO definitions - placeholder` with a table of empty cells | deleted; the template forbids placeholders. Replaced with the fact that no SLOs are defined |

### The drift that mattered most

| Where | What the README claimed | Reality |
|---|---|---|
| `apps/api` | generic NestJS boilerplate: TS 5.4, Node 18+, Prisma 6.8.2, `.eslintrc.js`, Helm/systemd deploys, guard names that no longer exist | rewritten from the real `main.ts` / `app.module.ts`; 749 routes counted from `route-manifest.json` |
| `apps/nlp` | three named HuggingFace models as the models in use | the service compiles in **no default model id**; identity is gateway-injected and fail-closed |
| `apps/stt` | live DB-driven `AsrPipeline` / `AiModel` lookup | gateway-resolved `ResolvedAsrSpec`; `STT_DATABASE_ENABLED` defaults `false`; the VAD/worker/diarization "env vars" carry a dead `moved_alias` |
| `apps/guardrail` | resident GLiNER / MiniCheck weights, six engine env prefixes | zero resident weights; engines and weights moved to `apps/nlp`; `db_config_enabled` removed (tests assert `not hasattr`) |
| `apps/text` | an "optional worker pool" and `pnpm text:worker:dev` | neither the module nor the script exists |
| `packages/domains` | `gen:mapper` listed as an ordinary generator | it is DESTRUCTIVE - it strips the `_version` OCC guard from mappers and then crashes. The single most safety-critical omission found |
| `packages/tools/src/gen-dev-token` | `-u admin` / `-u user` examples "match the seed" | neither username exists in `91-user.ts`; every worked example signed a token for a nonexistent user |
| `packages/vox-node` | 52 admin areas, 384 routes, five absent controllers; "manifest still reads 3.1.0" | 49 areas, 425 routes, ten absent controllers; package is at 3.5.0 |
| `docs/operations/observability` | "alerting coverage is effectively nonexistent"; Grafana on NodePort 30300 | `base/alertmanager.yaml` + `base/alert-rules.yaml` are deployed; Grafana is routed at `grafana.taphuynh.dev` |
| `docs/operations/temporal` | harness->Temporal patch "written but not applied" | `deployment/k8s/base/config/harness.env:55` already sets `TEMPORAL_ADDRESS=hope-temporal:7233` |
| six browser packages | `test:unit:cov`, `clean:all` | the real scripts are `test:cov`, `nuke` |

### Findings outside this ticket's scope

1. **`deployment/` does not exist in this repo** - deleted in `1de5b8c1c`, and
   `deployment/vault-agent/` is absent from the `hope-v2-deployment` checkout as well.
   `.claude/rules/09-infrastructure-devops.md` still describes this repo as holding the
   pod-level Vault-injection contract that the deployment repo consumes. Three lanes hit this
   independently. The rule file needs an owner decision, and the contract may need a home.
2. **Harness interpreter contract docs are only in `docs/archive/**`** - the execution-semantics
   and versioning contracts (TASK-718) and the eval-gate rationale (TASK-713) have no reachable
   home outside the archive, which is off-limits this sprint.
3. **`apps/quick-compat-app/Archive.zip`** - a 42 KB committed archive nothing references.
   Flagged, not acted on.
4. **`tenant-scope.ts` per-file comment counts are stale** - they sum to 59 against 90 real
   entries.
5. Two `packages/applications/.../storage/s3/` docs (`MINIO.md`, `SETUP.md`) still contain code
   samples calling the retired `getPublicBucketName()` / `getPrivateBucketName()`. They are not
   READMEs, so they were out of scope; the s3 README now warns against trusting them.

## Change History

| Date | Change |
|---|---|
| 2026-09-15 | Completed. All 94 READMEs rewritten and merged into `dev-2.2` across seven lanes; four lane claims corrected after independent verification; five out-of-scope findings recorded. |
| 2026-09-15 | Ticket opened. Scope and depth confirmed with the owner; template contract and verification script written; seven worktrees created off `dev-2.2` and seven Sonnet 5 lanes spawned. |
