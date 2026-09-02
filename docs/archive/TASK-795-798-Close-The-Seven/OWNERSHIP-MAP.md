# TASK-795..798 — Ownership Map (BINDING)

Goal: make all seven owner requirements true. Four tickets, four worktrees, one writer per tree.
**A file has exactly one owner. If you need a file you do not own, STOP and report it — do not edit
it, and do not "just add one line".** (A two-line fix blocked by a boundary is what left R7 half
done last round; the answer is to report it, not to reach across.)

| Surface | Owner |
|---|---|
| `packages/applications/src/services/consultation/**` | **795** |
| `packages/applications/src/services/gate-edit-mining/**` | **795** |
| `apps/harness/**` | **796** |
| `apps/admin-console/**`, `packages/agentic-sdk-v2/**` | **797** |
| `packages/database/**` (schema, migrations, seeds) | **798** |
| `packages/domains/**`, `packages/workflow-contract/**`, `apps/api/**` | **NOBODY** — request via the orchestrator |

## Sequencing constraint that outranks everything

**795's exclusivity gate MUST exist before any WorkflowAssignment row is created.** Substrate B's
`consultation.persistDraft` calls the SAME `persist_draft` activity Substrate A uses. With an
assignment present and no gate, both engines write one `ContextItem` — two writers, one document.

798 therefore ships its assignment row behind a guard test asserting the gate exists. If the gate
is absent, the assignment stays disabled and 798 says so. Do not "temporarily" enable it.

## Two boundaries you must not widen

1. **The loop event is not a PHI transport.** `EmitLoopEventInput` is `extra="forbid"` and its
   docstring says it carries "ids/keys/labels only, NEVER note or transcript text". Realtime
   summary TEXT must not be added to it. Use the existing `live-summary` SSE plane
   (`consultations/:id/live-summary/stream`, `LiveSummarySnapshot` with `sections`/`runningSummary`),
   which the playground already consumes.
2. **R6 must not gain a second path.** Exactly one site transitions a consultation to SIGNED, gated
   on a human user id + ownership + `If-Match`. The machine must never finalize.

## Non-negotiables

1. **TDD, and see RED.** Paste the failing output before the fix.
2. **Evidence, not assertion.** "Tests pass" with nothing pasted is not a result.
3. **Do not trust a code comment over the code.** Four TASK-789 findings were struck for exactly
   this — including two of the orchestrator's own. Verify against source, including claims in your
   own brief.
4. **No hardcoded config** — model/engine/endpoint/threshold resolve tenant → SYSTEM, selection
   fails CLOSED.
5. **Never** `pnpm db:*`, `pnpm gen:mapper` (destructive), Docker, or infra commands. `pnpm install`
   in YOUR worktree only.
6. **Never `git stash`** — the stash stack is shared repo-wide across worktrees.
7. Do not read `docs/archive/**`.
8. Do not merge, do not remove your worktree.
