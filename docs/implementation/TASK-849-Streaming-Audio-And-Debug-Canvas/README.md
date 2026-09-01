# TASK-849 — Two-Lane Streaming, Binary Audio & Realtime Debug Canvas

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track D |
| **Tier / Effort** | `opus` / xhigh |
| **Depends on** | TASK-847, TASK-848 |
| **Blocked by** | TASK-847 and TASK-848 |

## 1. Requirement Analysis

Realtime debug on the canvas, plus streaming for the node types that need it. **OD-4 kept STT and TTS nodes in the day-1 slice**, which makes binary audio transport part of this ticket and makes it the largest in the program.

## 2. Current State Evaluation

Program findings **F-13** and **F-21**. There is no streaming producer for workflow RUNS — `/workflows/:slug/runs/:runId/stream` is a disclosed **2-second poll bridge**; run detail polls at 5s. **But realtime consultation streaming is already shipped** (F-21): six ticket-scoped SSE planes over Redis pub/sub, each `@TenantOwnedResource` with its own `@StreamScope`. Reuse that, do not invent a second mechanism. **Do not route token streams through Temporal** — Signals land in history and the ceiling is 51,200 events / 50 MB per run. Two-lane split: token/STT/TTS deltas → **Redis Streams**; control events → Temporal.

## 3. Implementation Plan

The authoritative step-by-step plan is **[TASK-837 §4 → TASK-849 — Two-Lane Streaming, Binary Audio & Realtime Debug Canvas](../TASK-837-AI-Platform-Consolidation-Program/README.md)**,
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
