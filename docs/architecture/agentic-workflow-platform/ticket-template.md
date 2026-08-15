# Ticket Template — Agentic Workflow Platform program

Every program ticket lives at `docs/implementation/TASK-7XX-<Short-Name>/README.md` and follows the
structure below **exactly** — section names and order included. Tickets are written to be executed
by tier-assigned agents that do NOT share the authoring session's context: every task must be
self-contained (paths, exemplars, commands spelled out).

## Authoring rules (for ticket writers)

1. **Verify before you cite.** Evidence lines from the assessment may have drifted — re-derive
   every `file:line` against the live tree before writing it into a ticket. Never copy a citation
   unverified.
2. **New sprint.** Do not cite pre-sprint ticket numbers or read `docs/archive/**`. (This program's
   own TASK-700+ ids are new-sprint ids; the identically-numbered archive folders are unrelated —
   see the note in [backlog.md](./backlog.md).)
3. **Search exclusions:** `.claude/worktrees/**`, `**/dist/**`, `**/node_modules/**`,
   `**/.venv/**`, `**/__pycache__/**`.
4. **Repo law binds.** Cite the specific `.claude/rules/*.md` sections that constrain each task
   (layer gates, generated-code discipline — never `gen:mapper` — DTO rules, 404-over-403,
   env-file contract, script taxonomy). Commands you reference must exist in root `package.json`.
5. **TDD ordering.** Plan tasks so a failing test precedes implementation wherever testable.
6. **Sizes:** S ≤ half a day · M ≤ 2 days · L ≤ a week · XL = needs its own design task first.

## Execution-agent tiers (assign one per task)

| Tier | Model | Effort | Used for |
|---|---|---|---|
| T1 | haiku-4-5 | default | Extraction, formatting, mechanical rewrites, lookups |
| T2 | sonnet-5 | low–max | Standard coding, data transformation, test writing |
| T3 | sonnet-5 / opus-4-8 | low–max | Multi-file changes, tradeoff analysis, agentic tool use |
| T4 | opus-4-8 / opus-5 | low–xhigh | Architecture, re-design, security audit, long-horizon work |

Also state **effort** (e.g. `T2 · sonnet-5 · medium`) and, where a task benefits from fan-out,
the multi-agent shape (e.g. `T2 ×3 parallel, one per service`).

---

## Required structure

```markdown
# TASK-7XX — <Title>

| | |
|---|---|
| **Status** | Pending |
| **Wave** | <0–4> · **Size** | <S/M/L/XL> |
| **Epic slug** | `<slug>` |
| **Depends on** | TASK-7XX, … (or —) |
| **Design refs** | D<１–8> from [design.md](../../architecture/agentic-workflow-platform/design.md) |
| **Findings closed** | <assessment ids, e.g. A-06, F-13> (or —) |

## 1. Requirement Analysis
What this ticket delivers and why, in this program's terms. Link the invariants
(register ids) and/or user stories it satisfies. State what is explicitly OUT of scope.

## 2. Current State Evaluation
The verified facts: what the code does today, with re-derived `file:line` evidence.
What already exists that this ticket must REUSE (exemplars, services, models, patterns).
What the assessment found, restated only after verification.

## 3. Knowledge & Best Practices
The specific repo rules that bind this work (cite rule file + section). The SOTA/base
practices the implementation follows, with a one-line justification each. Known pitfalls
and anti-patterns for THIS ticket (e.g. "never run gen:mapper", OCC traps, seed-vs-code
default divergence).

## 4. Implementation Plan
Phased, TDD-ordered. Every task:

### Task N — <imperative title>
- **Agent:** T<tier> · <model> · <effort> [· fan-out shape if any]
- **Files:** exact paths to create/modify
- **Approach:** precise enough to execute without asking; name the exemplar file to
  imitate where one exists
- **Verify:** the command(s) that prove it (must exist in root package.json) + expected
  outcome

## 5. Acceptance Criteria
Checkbox list. Must include the layer-gate commands for affected packages, lint/typecheck,
and the evidence rule: paste actual output before claiming done.

## 6. Risks & Open Questions
What could invalidate the plan; what needs a human decision (mark HUMAN-GATED).

## 7. Implementation Summary
(Empty at authoring — filled during execution.)

## 8. Change History
| Date | Change | By |
|---|---|---|
| <date> | Ticket authored | <writer agent> |
```
