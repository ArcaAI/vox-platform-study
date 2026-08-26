# TASK-812 — Workflow Endpoint Stage

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |
| **Architecture** | <https://claude.ai/code/artifact/b6b68b73-3cb9-4cec-89f3-8afd1553c13b> |
| **Master** | [TASK-806](../TASK-806-Consultation-Workflow-Substrate-Unification/README.md) |
| **Depends on** | TASK-811 |
| **Blocks** | — |
| **Agent** | `general-purpose` · `sonnet` · effort `high` · **worktree** |

> Tier note: mostly additive against contracts 809/811 already fixed. **Escalate to `opus`** if the
> Temporal replay-compat tests surface trouble — workflow code changes must stay replay-compatible.

## 1. Requirement Analysis & Scope

### In scope
- Replace the hardcoded `endingActionsBase` literal with an **admin-ordered, persisted** action list.
- `session.timeout`, `summary.finalize`, `feedback.capture` node types + activities.
- Timeout expiry **runs** the endpoint sequence (D-12).
- `summary.finalize` locks **every** document (DD-3).
- `feedback.capture` promotes advisory transcript corrections (DD-8).
- Studio UI for ordering; vox-node regeneration.

### Out of scope — the compat fence (owner: "Do NOT touch the compat things")

Reproduced in full so this ticket is self-contained. **Do not read, edit, refactor, rename, or
"tidy" anything below.** If a change appears to require touching one of these, make it **additively**
instead and report the constraint rather than editing.

```
apps/compat-playground/**                        apps/quick-compat-app/**
apps/api/src/modules/text-compat/**              apps/api/src/modules/stt-compat/**          (OD-8)
apps/api/src/global-prefix.config.ts             apps/api/src/main.ts:109-111
packages/vox-node/src/resources/summarization.ts packages/vox-node/src/types/summarization.ts
packages/vox-node/src/core/url.ts                (PREFIX_EXEMPT_PATHS)
packages/agentic-sdk-v2/src/compat.ts            packages/agentic-sdk-v2/src/compat/**
packages/agentic-sdk-v2/src/types/consultation.ts:117-122   (the @deprecated `department` field ONLY)
packages/agentic-sdk-v2/src/types/context.ts:172-179        (AddContextInput.structuredData ONLY)
```


## 2. Current State Evaluation

| Defect | Evidence |
|---|---|
| **D-10** — endpoint sequence hardcoded; `neverActions` can only subtract | `loop-config.service.ts:322-330` |
| **D-11** — no feedback-capture node/activity exists anywhere | absence across `node-registry.ts`, `registry.py` |
| **D-12** — idle timeout deliberately does **not** run ending actions, so a timed-out consultation never finalizes | `harness-loop.descriptors.ts:41` |


## 2a. Findings this ticket closes

| # | Finding | Evidence |
|---|---|---|
| **D-10** | Endpoint sequence is a hardcoded literal; `neverActions` can only **subtract** from it | `loop-config.service.ts:322-330` — `endingActionsBase = hasStreamAudio ? ['livedoc.stop','harness.finalize'] : ['harness.finalize']` |
| **D-11** | No feedback-capture node or activity exists anywhere | absent from `node-registry.ts` and `registry.py` |
| **D-12** | Idle timeout deliberately does **not** run ending actions on expiry — a timed-out consultation never finalizes | `harness-loop.descriptors.ts:41` |

**Related decisions implemented here:** DD-3 (`summary.finalize` locks **every** document, not just
the SOAP note) and DD-8 (`feedback.capture` is the **only** path that promotes an advisory transcript
correction over the raw channel).

**Node types to add** (contract defined by TASK-809): `session.timeout`, `summary.finalize`,
`feedback.capture` — all `trigger: on-end`, `lane: durable`, and therefore all **must be
`idempotent`**.

## 3. Implementation Plan (TDD)

| # | Task | Test first |
|---|---|---|
| 1 | Persisted, admin-ordered endpoint action list replacing `endingActionsBase` | ordering test |
| 2 | `session.timeout` node + activity | node test |
| 3 | `summary.finalize` node + activity; locks **every** document | multi-document lock test |
| 4 | `feedback.capture` node + activity | node test |
| 5 | **D-12**: timeout expiry runs the sequence | test: timed-out consultation finalizes |
| 6 | Advisory-correction promotion path (DD-8) | test: only feedback promotes a correction over raw |
| 7 | Activities idempotent + bounded `RetryPolicy` (Temporal retries) | activity tests |
| 8 | Replay compatibility preserved | `test_replay_compat` |
| 9 | Studio UI for sequence ordering | component + axe |
| 10 | Regenerate the five artifacts | `gen:admin:check` |

## 4. Verification
```bash
pnpm --filter @arcaai/applications build test
pnpm harness:test          # includes replay-compat; keep new tests hermetic
pnpm --filter @arcaai/admin-console build lint test
pnpm --filter @arcaai/vox-node gen:admin:check
```

## 5. Definition of Done
- [ ] Endpoint sequence admin-ordered and extensible, not a literal
- [ ] Timeout finalizes; every document locks
- [ ] Feedback capture exists and is the only promotion path
- [ ] Replay-compat green

## Best Practices — apply to every task here

- **Temporal workflows are deterministic.** No I/O, no network, no `random`, no wall-clock, no env
  reads inside `@workflow.defn`. All side effects live in activities.
- **Activities are idempotent and carry a bounded `RetryPolicy`** — they *will* retry.
- **Replay compatibility is a hard gate.** Run the replay-compat tests before shipping any change
  to `workflows.py`.
- **Keep new harness tests hermetic** — the CI harness suite stubs Temporal/LLM/reranker, runs
  Qdrant in memory, and has no DB or Redis. A test needing live infra breaks the job.
- **Timeout must finalize.** A timed-out consultation that never finalizes loses clinical work;
  that is the defect (D-12), not a design choice.
- **`neverActions` could only subtract.** The replacement must let an admin *order and extend*,
  not merely veto.

## Standing instructions (every task in this ticket)

- **Evidence, not assertion.** "Tests pass" with nothing pasted is not a result. Paste actual
  command output (`01-development-workflow.md` §Phase 5).
- **TDD:** failing test first, and you must *see it fail*. A test that never failed verifies nothing.
- **Branch is `dev-2.2`**, never `dev`.
- **Never `git stash` in a worktree** — the stash stack is shared repo-wide. Commit, then
  `git checkout HEAD~1 -- <path>` for a baseline.
- **Orchestrator owns shared surfaces:** merges, `pnpm install`, `db:push`/`db:migrate`/
  `test:db:reset`, Docker/infra, and every `gen:*` invocation. Do not run them.
- **Lint warnings in `packages/*` are errors.** `eslint-plugin-only-warn` downgrades them; treat
  them as hard failures anyway.
- **Do not run** the test suites of `apps/compat-playground`, `apps/quick-compat-app`, or
  `packages/ui` unless your change lands inside that package (owner directive).

### The five-artifact rule (this ticket changes an admin route)

`.claude/rules/05-nestjs-api.md:155` still says **four** artifacts and omits the fifth. That
omission turned TASK-805's pipeline #990 red. The real rule:

```bash
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal \
  && pnpm --filter @arcaai/vox-node gen:admin
```
Verify with `pnpm api:openapi:check`, `pnpm api:portal:check`, `pnpm --filter @arcaai/vox-node gen:admin:check`.
**`packages/vox-node/src/resources/admin/**` is GENERATED — never hand-edit.** Only
`admin-resource.ts` is hand-authored.

### Finishing protocol — land it on `dev-2.2`, leave no worktree behind (owner directive, 2026-08-25)

**No work is "done" while it sits in a worktree.** When your gates are green, you MUST complete
this sequence. It is not optional and its order is not negotiable.

1. **Bring the target in first.** `git merge dev-2.2` INTO your branch and resolve any conflicts
   **in your own worktree**, never in the primary checkout.
2. **Re-run every gate AFTER that merge.** A clean merge is not a passing build. Paste the output.
3. **Merge your branch into `dev-2.2`** — the target is always `dev-2.2`, never `dev`.
4. **Only once step 3 is committed:** remove your worktree (`git worktree remove <path>`) and delete
   your branch.

**Before step 4, prove there is nothing left to lose:**
```bash
git log <your-branch> --not dev-2.2 --oneline   # MUST be empty
```
If it is not empty, stop — you have unmerged commits. Never use `git worktree remove --force`,
never `git worktree prune` "to tidy up", and never delete the directory by hand. An abandoned
worktree is recoverable; a removed one is not.

**If you cannot complete the merge** — conflicts you cannot resolve, a failing gate, an ambiguous
call — **LEAVE THE WORKTREE IN PLACE** and report it at the TOP of your final message with its path
and branch. Never bury an un-merged worktree in the body of a report.

**Concurrency note:** when several lanes run at once, the orchestrator may tell you to stop after
step 2 and hand off, so the final merges are serialized and lanes do not race each other into
`dev-2.2`. Follow that instruction if you receive it; otherwise complete all four steps yourself.

## Close-out protocol — MANDATORY (owner directive 2026-08-26, amended by measurement)

**Which path applies depends on where you work. Read the right one.**

### If you work in a WORKTREE

You **cannot** merge into `dev-2.2` yourself, and you must not try. `dev-2.2` is checked out in the
primary checkout, so git refuses every route into it — `git push . HEAD:dev-2.2` returns
*"refusing to update checked out branch"*, and it is right to: the primary's index and work tree
would desync from HEAD. This was measured, not assumed.

1. **Verify your base FIRST — before any other work.** Worktrees have been created off **`dev`**,
   where `packages/workflow-contract` does not exist at all; two of two agents hit this.
   Run `git merge-base --is-ancestor $(git rev-parse dev-2.2) HEAD`. Non-zero ⇒ confirm your tree
   is clean, then `git reset --hard dev-2.2`. Report which you found.
2. Gates green on your branch, with output pasted.
3. Commit everything. Leave the worktree and branch **intact**.
4. Report your branch name, commit SHA, and that the merge is pending. The orchestrator merges from
   the primary checkout, re-runs the gates there, and only then destroys the worktree and branch.

### If you work in the MAIN CHECKOUT

1. Gates green on your branch, output pasted.
2. **Merge into `dev-2.2`.** Never `dev`.
3. **Re-run the affected gates AFTER the merge** — a clean merge is not a passing build; a sibling
   lane may have moved the base underneath you.
4. **Delete your branch**, only after confirming the merge is on `dev-2.2`
   (`git log dev-2.2 --oneline | grep <your-sha>`).

### Stop conditions — never force past these

- A merge that conflicts in a way you cannot resolve with confidence ⇒ **STOP and report**, leaving
  the branch intact. An abandoned branch is recoverable; a bad merge or a deleted branch is not.
- Gates failing after a merge ⇒ **STOP and report**. Delete nothing.
- Never `git worktree remove --force`, never `git worktree prune`, never delete a branch holding
  commits absent from `dev-2.2`.
- Never `git stash` — the stash stack is shared repo-wide across every worktree.

## Agent Brief (self-contained — copy verbatim when dispatching)

**Ticket:** TASK-812 · **Branch:** `dev-2.2` · **Tree:** worktree `../hope-v2-task-812` off `dev-2.2`
**Agent:** `general-purpose` · **Model:** `sonnet` · **Effort:** `high`
**Escalation rule:** if the replay-compat tests surface trouble, **stop and escalate this stage to
`opus`** — replay incompatibility is not a thing to iterate on blindly.

**Note on the Python tree:** conda `arcaenv` editable installs point at the PRIMARY checkout, so
Python work generally belongs in the main tree. Coordinate with the orchestrator before running
harness tests from a worktree.

**You own:** the endpoint action list, the three new node types + activities, the timeout semantics,
and the Studio ordering UI.
**You must not touch:** the compat fence; the realtime executor (TASK-811).
**Return contract:** `NODES` (types + activities), `TIMEOUT` (test proving finalization on expiry),
`LOCK` (multi-document lock test), `REPLAY` (replay-compat output pasted), `ARTIFACTS`.

**Rules to read before starting:** `.claude/rules/` files 00, 01, 04, 05, 06. A subagent inherits NONE of the orchestrator's context — read them.

## 6. Implementation Summary
_Not started._

## 7. Change History
| Date | Change |
|---|---|
| 2026-08-25 | Opened from TASK-806 §7. |
