# TASK-850 — Workflow Invocation Surfaces

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `feature` |
| **Branch** | `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track D |
| **Tier / Effort** | `opus` / high (auth + idempotency); `haiku` (SDK artifact regeneration) |
| **Depends on** | TASK-848, TASK-849 |
| **Blocked by** | TASK-848 and TASK-849 |

## 1. Requirement Analysis

A published workflow invocable four ways: webhook with streaming, REST + API key, SDK Vox (API key), SDK Vox-node (API key or service account). One handler; all four converge on it. **Idempotency uses Temporal natively** — `Idempotency-Key` → Workflow ID with `WorkflowIdConflictPolicy: UseExisting`, so a retried webhook JOINS the existing run rather than double-billing an LLM run. **Client disconnect never cancels the run.**

## 2. Current State Evaluation

Program finding **F-14**. **1 of 4 surfaces exists**, off by default, and `EXPOSURE_ALLOWED_PALETTES = new Set(['summarization'])` (`exposure-palette-policy.ts:61`) **explicitly refuses the `consultation` palette** — a consultation workflow cannot be REST-invoked today at all.

**⚠ Read TASK-852 §5 before touching that allow-list.** The refusal is finding C-8, a real vulnerability: the exposure route forwards caller-controlled `dto.input` verbatim with `sandbox: false`, and the interpreter's external-write suppression fires only in sandbox. **F-24** shows the palette has grown to 31 descriptors with **11** `externalWrite` — the constraint is STRONGER than its own comment claims. A realtime consultation does **not** need this plane; it has a session-bound entry point that breaks every link of the chain. Verified **false**: the claim that TASK-806 widened palettes.

## 3. Implementation Plan

The authoritative step-by-step plan is **[TASK-837 §4 → TASK-850 — Workflow Invocation Surfaces](../TASK-837-AI-Platform-Consolidation-Program/README.md)**,
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
