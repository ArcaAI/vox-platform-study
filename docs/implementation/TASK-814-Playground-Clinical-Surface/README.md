# TASK-814 — Playground Clinical Surface

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `feature` + `bugfix` |
| **Branch** | `dev-2.2` |
| **Architecture** | <https://claude.ai/code/artifact/b6b68b73-3cb9-4cec-89f3-8afd1553c13b> |
| **Master** | [TASK-806](../TASK-806-Consultation-Workflow-Substrate-Unification/README.md) |
| **Depends on** | TASK-811 (payload shape). **The D-25 impersonation wiring is independent — start it immediately.** |
| **Agent** | `ui-ux-designer` · `sonnet` · effort `medium` · **worktree** |

> **Re-scoped by OD-2.** There is no clinical app and no RBAC widening. `(tenant)` stays an admin
> tier gate — **D-16 is not a defect**. Clinical usage is a tenant admin impersonating a clinician
> in the playground.

## 1. Requirement Analysis & Scope

### In scope
- **D-25**: wire tenant-admin → clinician impersonation (blocks OD-2's premise today).
- Add-details-during-consultation affordance (D-17).
- Stream status/error surfacing (D-18) + the contradictory empty-first-flush state.
- Render **N documents** per TASK-811's payload (DD-3).
- `error.tsx` for the five playground routes that lack one.
- Patient lookup replacing free-text patient-ID entry.

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
| **D-25** | BFF calls only `admin/users/:id/impersonate` (`@Authorize(['manage','all'])` — SUPER_ADMIN). A tenant admin sees *"Impersonation requires super admin"* (`persona-control.tsx:82-92`). The gateway **already has** `POST /auth/impersonate` allowing `TENANT_ADMIN` own-tenant impersonation (`auth.controller.ts:589-618,634-636`) — nothing wires it. The comment at `persona-control.tsx:29-30` claiming no such endpoint exists is **stale**. |
| **D-17** | The screen destructures only `{ session, audio }` from `useArca()` (`consultation-demo-screen.tsx:208`); `context` is never destructured anywhere in the feature. Zero `addCaseNote`/`addAttachment`/`addContext` call sites. |
| **D-18** | `useArcaLiveSummary()` returns `{snapshot,status,error,...}`; the screen reads only `snapshot`, `start`, `stop`. `live.status`/`live.error` are never read. (STT socket status *is* surfaced — the live-summary SSE stream's is not.) |
| **D-26** | `/agents` nav gate requires `manage:PromptTemplate` but the screen CRUDs `DepartmentAgent`. Already decoupled; resolved by TASK-815. |

**Six playground screens**, not five — Workbench (TASK-721) is gated on `manage:WorkflowDefinition`
+ `manage:WorkflowRun`; the other five carry `required: []`.


## 2a. Findings this ticket closes

| # | Finding | Evidence |
|---|---|---|
| **D-25** | The BFF calls only `admin/users/:id/impersonate` (`@Authorize(['manage','all'])` — SUPER_ADMIN). A tenant admin sees *"Impersonation requires super admin"*. The gateway **already has** `POST /auth/impersonate` allowing `TENANT_ADMIN` own-tenant impersonation — nothing wires it | `app/api/auth/impersonate/route.ts:38-40,53`; `persona-control.tsx:82-92`; `auth.controller.ts:589-618,634-636` |
| **D-25b** | The comment at `persona-control.tsx:29-30` claiming *"no tenant-scoped impersonation endpoint exists yet"* is **stale** | verified against the gateway |
| **D-17** | The screen destructures only `{ session, audio }` from `useArca()`; `context` is never destructured anywhere in the feature; zero `addCaseNote`/`addAttachment`/`addContext` call sites | `consultation-demo-screen.tsx:208` |
| **D-18** | `useArcaLiveSummary()` returns `{snapshot,status,error,start,stop}`; the screen reads only `snapshot`/`start`/`stop`. `live.status` and `live.error` are **never read** | `consultation-demo-screen.tsx:293,345,346,426,619` |
| **D-16** | *(WITHDRAWN — not a defect.)* Per OD-2 the `(tenant)` tier gate is correct. There is no clinical app and no RBAC widening | owner decision |

**Six playground screens, not five** — `consultation`, `live-transcription`, `voice-profiles`,
`dna-writing-style`, `llm` (all `required: []`, role-gated) plus **`workbench`** (TASK-721), gated on
`manage:WorkflowDefinition` + `manage:WorkflowRun` because it executes real definitions
(`nav-config.ts:762-823`). Only `workbench` has an `error.tsx`.

**Session open today:** `sdkSession.open({ patientId, ...(department ? { departmentId: department } : {}) })`
(`consultation-demo-screen.tsx:367`); existing rows load via `sdkSession.load(row.id)` (`:351`).
Entities render from a local `useNamedEntities` NLP query (`:276`), not the SDK's `context.entities`.
STT socket status **is** surfaced (`:607`) — the live-summary SSE stream's status is not.

## 3. Implementation Plan (TDD)

| # | Task | Test first |
|---|---|---|
| 1 | **D-25**: BFF route for tenant-admin own-tenant impersonation via `POST /auth/impersonate`; `PersonaControl` shows the picker for a tenant admin | RBAC + component tests |
| 2 | Correct the stale comment at `persona-control.tsx:29-30` | — |
| 3 | **D-17**: destructure `context`; add-detail affordance (`addCaseNote`/`addWorknote`/`addAttachment` or schema-validated `addContext`) | component test |
| 4 | **D-18**: pass `live.status`/`live.error` into the columns; distinct error state | component test |
| 5 | Resolve the contradictory empty-first-flush state (header "assistant unavailable" + body skeleton simultaneously) | component test |
| 6 | Render **N documents** per TASK-811's `section.patch` payload | multi-document render test |
| 7 | Per-section state affordances (`provisional` vs `confirmed`); clinician edit → `confirmed` | component test |
| 8 | `error.tsx` for the five playground routes lacking one | route tests |
| 9 | Patient lookup scoped to the clinician replacing free-text entry | component test |
| 10 | axe scan 0 violations; both themes; Playwright e2e for the impersonated-clinician path | a11y + e2e |

## 4. Verification
```bash
pnpm --filter @arcaai/admin-console build lint test
pnpm test:up:api && pnpm test:e2e
```
Runtime behaviour verified in a running app (prefer the `next-dev-loop` skill) — compiling ≠ working.

## 5. Definition of Done
- [ ] A tenant admin can impersonate a clinician and run a consultation end to end
- [ ] Details can be added mid-consultation
- [ ] Stream failure is visible and unambiguous — never an indefinite skeleton
- [ ] N documents render and fill progressively
- [ ] axe 0 violations, both themes, e2e green

## Best Practices — apply to every task here

- **Skeletons, never spinners,** for data-fetching states; `<Spinner />` only inside a button for an
  in-flight action. Skeleton shapes mirror the loaded layout.
- **Every action gives visible feedback within 100ms**; `toast.success()` / `toast.error()` —
  never silently succeed or fail.
- **`ScreenTemplate` owns the page frame**; `DetailDrawer` is the one console-wide record surface.
  Do not hand-roll a feature-specific `Sheet`.
- **Semantic tokens only** (`bg-primary`, `text-muted-foreground`). Never hardcode colors. Verify
  BOTH themes.
- **WCAG 2.2 AA, verified per screen:** axe scan 0 violations, plus the manual keyboard and
  200%-zoom pass — automation catches barely half.
- **Never fetch in `useEffect`** — TanStack Query v5.
- **Runtime verification is required.** Compiling is not working; prefer the `next-dev-loop` skill.
- **An empty state is not an error state.** The current screen shows "assistant unavailable" and a
  loading skeleton simultaneously — resolve that contradiction rather than reproducing it.
- **`packages/ui` tests run ONLY if your change lands inside it** (owner directive).

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

**Ticket:** TASK-814 · **Branch:** `dev-2.2` · **Tree:** worktree `../hope-v2-task-814` off `dev-2.2`
**Agent:** `ui-ux-designer` · **Model:** `sonnet` · **Effort:** `medium`

**Two independent lanes — the first does NOT wait for TASK-811:**
- **Lane A (start now):** D-25 impersonation wiring + the stale comment. Until this lands, a tenant
  admin cannot impersonate a clinician at all, so OD-2's premise does not hold.
- **Lane B (after TASK-811):** N-document rendering against the `section.patch` payload.

**You own:** `apps/admin-console/src/features/playground-consultation/**`, the playground routes,
and `src/app/api/auth/impersonate/route.ts`.
**You must not touch:** the compat fence; `packages/ui` unless the canvas itself must change.
**Do not widen the `(tenant)` tier gate** — per OD-2 it is correct, and D-16 is withdrawn as a defect.
**Return contract:** `IMPERSONATION` (route + component, tests pasted), `ADD_DETAIL`,
`STREAM_STATUS`, `MULTIDOC`, `A11Y` (axe output, both themes), `E2E`.

**Rules to read before starting:** `.claude/rules/` files 00, 01, 07, 10, 11, 13. A subagent inherits NONE of the orchestrator's context — read them.

## 6. Implementation Summary
_Not started._

## 7. Change History
| Date | Change |
|---|---|
| 2026-08-25 | Opened from TASK-806 §7. Re-scoped by OD-2; D-16 withdrawn as a defect. |
