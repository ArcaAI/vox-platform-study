# TASK-976 — README template refresh across the code-facing surfaces

| Field | Value |
|---|---|
| Status | In Progress |
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

Pending — filled in after all seven lanes merge into `dev-2.2` and the post-merge verification
runs from the primary checkout.

## Change History

| Date | Change |
|---|---|
| 2026-09-15 | Ticket opened. Scope and depth confirmed with the owner; template contract and verification script written; seven worktrees created off `dev-2.2` and seven Sonnet 5 lanes spawned. |
