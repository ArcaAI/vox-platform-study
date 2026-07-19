# TASK-517 — Critique-informed regen

**Status:** Completed
**Type:** feature
**Parent program:** TASK-508 Phase 6 (Accuracy wave)
**Depends on:** TASK-511 (`regenFeedbackEnabled` policy knob + `CORRECTIVE_RETRY` seed),
TASK-515 (`assemble_generation_prompt` stable-prefix)

## Requirement Analysis

When the sensor gate returns **REGEN**, the next generation attempt must be *told what
failed*: the regen iteration's `generate` input carries the prior iteration's
failed-sensor findings (sensor **names + failing claims + expected fixes**), and the
prompt gains a corrective suffix. This is gated by the `regenFeedbackEnabled` policy
knob (default **ON**) and must be **command-neutral** for Temporal replay.

## Current State Evaluation

The bounded-regen loop re-ran `generate` with byte-identical inputs each iteration —
no signal about *why* the draft was rejected, so regen was a blind retry.

## Implementation Plan (TDD)

1. **RED**
   - `test_regen_feedback.py` (helpers): `build_regen_feedback`,
     `render_regen_feedback_block`, `assemble_generation_prompt` with feedback
     (drives a failing `numeric_dose` finding).
   - `test_doc_workflow.py` (workflow): the 2nd `generate` input carries the prior
     iteration's failed-sensor findings; and a policy-disabled variant sends none.
2. **GREEN** — additive activity input + prompt suffix + workflow threading, gated by
   the policy knob.
3. **REFACTOR** — keep the suffix a pure render; keep the new field optional/defaulted
   so existing histories deserialize.

## Implementation Summary

### Additive activity input (replay-safe)
- `apps/harness/src/harness/temporal/models.py` — new `RegenFinding`
  (`sensor`, `failing_claims`, `expected_fix`) and `RegenFeedback` (`findings`);
  `GenerateInput.regen_feedback: RegenFeedback | None = None`. Optional + defaulted so
  prior workflow histories replay unchanged.

### Prompt assembly
- `apps/harness/src/harness/temporal/prompt_cache.py`:
  - `CORRECTIVE_RETRY_PREAMBLE` — a local constant mirroring the intent of the seeded
    `CORRECTIVE_RETRY` template (`07-prompt-template.ts`). Kept **in-process** rather
    than fetched from the DB so the workflow stays replay-safe and free of a cross-service
    template lookup on the regen path.
  - `_EXPECTED_FIX` — per-sensor corrective instruction map (+ `_GENERIC_FIX` fallback).
  - `build_regen_feedback(results, *, enabled)` — filters failed sensors into
    `RegenFeedback`; returns `None` when disabled or nothing failed.
  - `render_regen_feedback_block(regen_feedback)` — renders the structured findings.
  - `assemble_generation_prompt(user_prompt, prompt_block, regen_feedback=None)` — appends
    the corrective suffix **after** the stable prefix, so iteration 1 (no feedback) stays
    byte-identical to the previous behaviour.

### Activity + workflow threading
- `temporal/activities.py` — `generate` passes `payload.regen_feedback` into
  `assemble_generation_prompt`.
- `temporal/workflows.py`:
  - `regen_feedback_enabled = policy.regen_feedback_enabled is not False` (default ON when
    no policy).
  - workflow var `regen_feedback: RegenFeedback | None = None`, passed into every
    `GenerateInput`.
  - On each **REGEN** decision (computational branch, full-verdict branch, and the
    optimistic `_regen_compute` / Q1 path) it calls `build_regen_feedback(...)` from the
    just-failed sensor results *before* incrementing the budget and continuing — so the
    *next* `generate` sees the *prior* iteration's critique.

## Verification (actual)

- `conda run -n arcaenv … pytest src/harness/tests/unit/temporal/ -q` → **167 passed**
  (includes the Temporal **replay-compat** suite — command sequence unchanged).
- New workflow tests pass:
  - `test_regen_iteration_receives_prior_failed_sensor_findings` — iteration 1
    `regen_feedback is None`; regen iteration carries `coverage_omission` with
    `failing_claims == ["omitted-dx"]` and a non-empty `expected_fix`.
  - `test_regen_feedback_disabled_by_policy_sends_no_critique` — `regen_feedback is None`
    on the regen iteration when `regenFeedbackEnabled=False`.
- `conda run -n arcaenv … pytest src/harness/tests/ -q` → **820 passed**.
- `ruff check` on changed temporal surfaces → All checks passed.

### Replay-compatibility argument

The only wire change is a **new optional field** (`GenerateInput.regen_feedback`,
default `None`). No activity was added/removed/reordered; the corrective suffix is
appended *after* the existing stable prefix and is empty on iteration 1. Existing
histories therefore deserialize and replay with an identical command sequence — proven
by the green replay suite.

## Deviations

- The corrective preamble is an **in-process constant** (`CORRECTIVE_RETRY_PREAMBLE`)
  mirroring the seeded `CORRECTIVE_RETRY` template rather than a runtime DB fetch — a DB
  read on the regen path would be a non-deterministic side effect inside the workflow.
  The findings block itself is fully data-driven from the aggregator verdict.
- The RED "one failing `numeric_dose`" fixture is exercised at the **helper** level
  (`build_regen_feedback` / render); the **workflow**-level test drives a regen-fixable
  sensor (`coverage_omission`) because `numeric_dose` is HIGHEST_HARM → it FLAGs rather
  than REGENs, so it cannot on its own trigger a second generation. Both the numeric-dose
  finding rendering and the end-to-end regen threading are covered.

### Eval evidence

`harness-eval` regen-success delta on golden fixtures is **owner-run on tier hardware**
(requires live SMR + rated golden set); not runnable in this environment. The engineering
path (feedback threading + gate knob) is unit-proven above.

## Change History

- 2026-07-19 — Initial implementation (RED→GREEN): additive `RegenFeedback` activity
  input, corrective prompt suffix, policy-gated workflow threading. Replay suite green.
