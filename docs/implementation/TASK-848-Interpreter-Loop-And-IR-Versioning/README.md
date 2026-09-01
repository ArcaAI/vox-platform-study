# TASK-848 — Interpreter Loop Support & IR Versioning

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track D |
| **Tier / Effort** | `opus` / xhigh (consider `fable` for the determinism design stage) |
| **Depends on** | TASK-847 |
| **Blocked by** | TASK-847 (node contract must land first) |

## 1. Requirement Analysis

The Loop node runs an agentic loop: a master/orchestrator agent plus sub-agents under its instruction, bounded by iteration, time **and cost**.

**Architecture — settled, do not re-litigate.** One generic versioned interpreter workflow type per IR major version, receiving a compiled immutable graph IR as workflow input; interpreter *code* changes handled by Worker Versioning `Pinned`; child workflows only for LOOP sub-agents. Temporal's constraint is on workflow **code**, not **data** — passing the graph as input puts it in history, so replay is safe. **A tenant edit becomes a data change, not a code change**; every alternative turns a tenant edit into a deploy. **"The graph cannot change mid-run" is a FEATURE** — for clinical work an auditable frozen pipeline is correct.

## 2. Current State Evaluation

Program finding **F-11**. `WorkflowInterpreter` (`interpreter/workflow.py:87`) already walks `config.stages` and dispatches through `NODE_REGISTRY`. Its own docstring bounds it: *"Linear stage walk + single-level fan-out with an all-settled join. Nothing else (v1)"*. Task queue `harness-task-queue`; replay-compat fixtures at `tests/unit/temporal/test_replay_compat.py`. TASK-852 items 3–4 have already added a config-driven skip branch to `_dispatch_node`, so the pattern for extending it safely is established.

## 3. Implementation Plan

The authoritative step-by-step plan is **[TASK-837 §4 → TASK-848 — Interpreter Loop Support & IR Versioning](../TASK-837-AI-Platform-Consolidation-Program/README.md)**,
which carries the numbered steps, the traps, and the per-step evidence requirements. It is reproduced here by
reference rather than copied, so the two cannot drift while this ticket is unstarted.

**Expand this section into the full step list at the moment work starts**, per
`01-development-workflow.md` Phase 3 — and get owner approval before any code is written.

## 4. Verification Criteria

See TASK-837 §4 for this ticket's verification block. Program-wide gates in TASK-837 §3.5 apply regardless.

## 5. Implementation Summary

Not started.

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Ticket document created and aligned to TASK-837 §4. Not started. |
