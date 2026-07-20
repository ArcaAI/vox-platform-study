# TASK-453 — Harness: Sign-off Guard During Assurance Window (C1-01)

- **Status**: Closed — Won't-fix (Option C "accept as-is" chosen by product owner, 2026-07-09). No code change.
- **Type**: documented no-change (product decision)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Wave 1 (P0)
- **Finding**: C1-01 (High, CONFIRMED ✓C ✓H) — see [TASK-448 register](../TASK-448-Harness-Loop-Quality-Review/README.md)
- **Branch**: `fix/task-453-assurance-signoff-guard` (cut from `main`)
- **Size**: M
- **Suggested agent**: general-purpose (Temporal + NestJS) — assign ONLY after the decision gate clears

## ✅ Decision resolved — Option C (accept as-is), 2026-07-09

**The product owner chose Option C: accept the current behavior as-is. No code change is made.** The "RELAXED sign-off governance" (Q2a early-sign with a `SIGNED_BEFORE_ASSURANCE` annotation, Q2b `POST_SIGN_FLAG` amendment path) is confirmed intentional and accepted. C1-01 is closed Won't-fix. The existing Q2a/Q2b tests stand unchanged.

**Consequence for other tickets**: this removes the coordination concern with [TASK-463](../TASK-463-NamedEntity-Persistence-Contract/README.md) — since TASK-453 makes NO code change, TASK-463 has clean, sole ownership of `summary.service.ts`'s `extractEntities` mapping.

**Residual risk accepted**: a safety FLAG can still land on an already-SIGNED note during the optimistic window; it is surfaced only via the post-sign `POST_SIGN_FLAG` WORM annotation + amendment alert, not blocked. If this is ever revisited, Option B (safety-only sensor before "ready") is the recommended path — the analysis below is retained for that purpose.

---

## ⚠️ Decision gate (RESOLVED — Option C; retained for reference)

The scout confirmed C1-01's mechanism exactly — but also found the behavior is **coded as an intentional product decision**, not an accidental race:

- `summary.service.ts` documents it as "RELAXED sign-off governance (clinician autonomy + full audit, doc 08 §7.1)" — **Q2a**: signing before assurance settles is *allowed with no acknowledgement*, stamped `SIGNED_BEFORE_ASSURANCE`; **Q2b**: a late adverse verdict appends a `POST_SIGN_FLAG` WORM annotation + amendment alert, and the signed note **stands**.
- An existing test **asserts this as desired**: [summary.service.test.ts:1639](packages/applications/src/services/consultation/summary/__tests__/summary.service.test.ts) — *"Q2a — ALLOWS sign-off while assurance is pending … records a SIGNED_BEFORE_ASSURANCE annotation"*.

So this is not a mechanical fix — it reverses (or deliberately keeps) a governance decision. **The product/clinical owner must choose the target behavior before any code is written.** The three options:

| Option | Behavior | Code impact |
|---|---|---|
| **A — Block sign-off during the window** (finding's implied fix) | `approveSummary` rejects while status is `DRAFT_PENDING_SENSORS` / `assuranceCompletedAt == null`, unless an explicit override | Rewrite Q2a test to assert rejection; add a guard; UI must handle the new 409 |
| **B — Keep autonomy, harden the safety-only gap** | Sign-off stays allowed, BUT the SAFETY verdict specifically is computed (or a fast pre-check runs) BEFORE the "ready" stage, so the one hard-block at [summary.service.ts:473] is reachable | Reorder/添加 a safety-only sensor pass before `_deliver_early`; keep Q2a for non-safety dims |
| **C — Accept as-is** | No behavior change; strengthen only the post-sign amendment surfacing | Close C1-01 as won't-fix with rationale; possibly minor UI/alert work |

The scout's judgment: the genuine gap is narrow — **only the SAFETY dimension**. Late groundedness/RAG/REGEN verdicts are explicitly not safety stops by design; the real problem is that safety-FLAG is computed only in the inferential pass, which by design runs *after* the draft becomes signable, making the safety hard-block structurally unreachable during the optimistic window. That points at **Option B** as the smallest correct change, but the decision is the owner's.

**This ticket is scaffolded for Option B** (documented below) as the recommended path; if A or C is chosen, the plan section is rewritten before assignment.

## File-ownership manifest (exclusive — binding, Option B)

| File | Change |
|---|---|
| `apps/harness/src/harness/temporal/workflows.py` | Run a safety-only sensor pass before emitting `HARNESS_PROGRESS_TERMINAL_STAGE` (optimistic path) |
| `apps/harness/src/harness/temporal/activities.py` | If a distinct safety-only activity is needed |
| `packages/applications/src/services/consultation/summary/summary.service.ts` | Ensure the safety hard-block is reachable pre-sign (verdict present) |
| Corresponding `__tests__` for the three above | Reproduce + guard |
| `apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py` + fixtures | New patch marker → new replay fixture |

**Do NOT touch** `models.py` enum values without adding a `workflow.patched()` marker (replay safety), the `finalizeAssurance` post-sign path (that mitigation stays), or `harness-progress.service.ts` fold logic. Any workflow reorder MUST be gated by a new `workflow.patched("task-453-...")` marker and covered by a replay fixture. Anything outside the manifest → STOP and report.

## Requirement Analysis

The optimistic two-phase delivery path emits the terminal "Draft ready for review" stage and closes the progress SSE ([workflows.py:664](apps/harness/src/harness/temporal/workflows.py)) **before** the inferential sensors (groundedness / citation-verify / Granite Guardian safety) run (loop starts [workflows.py:681]). During that window the consultation is `DRAFT_PENDING_SENSORS` with `guardrailDecisions = NULL`, so `approveSummary`'s only hard-block (`hasSafetyFlag`, [summary.service.ts:473]) cannot fire — the safety verdict does not exist yet. Sign-off flips the consultation to `SIGNED` unconditionally ([summary.service.ts:582]). A later safety FLAG then lands via `finalizeAssurance` as a `POST_SIGN_FLAG` on an already-signed note.

### Acceptance criteria (Option B — recommended)

- [ ] **AC-1 (red)**: a harness test proves the current order emits `HARNESS_PROGRESS_TERMINAL_STAGE` before any safety verdict exists (draft persisted with `guardrail_decisions is None`). This already has partial coverage at [test_doc_workflow.py:687-690]; extend it to assert the safety verdict is *absent at ready-time*.
- [ ] **AC-2**: the SAFETY sensor verdict is computed and persisted BEFORE the optimistic path emits the terminal "ready" stage — so at ready-time `guardrailDecisions.safety` is populated (PASS or FLAG). Non-safety dimensions (groundedness/RAG/REGEN) may still settle later under the existing autonomy model.
- [ ] **AC-3**: a safety FLAG computed pre-ready blocks the "ready" stage (or emits a distinct non-signable label) so sign-off cannot occur on a safety-flagged draft; the existing hard-block at [summary.service.ts:473] becomes reachable in the window.
- [ ] **AC-4 (governance preserved)**: the Q2a `SIGNED_BEFORE_ASSURANCE` autonomy path remains for non-safety dimensions; the Q2b `POST_SIGN_FLAG` amendment path is unchanged (defense in depth for anything that still slips through).
- [ ] **AC-5 (replay safety — mandatory)**: the reorder is gated behind a new `workflow.patched("task-453-...")` marker; `test_replay_compat.py` gains a fixture proving pre-453 histories replay on the new definition AND the new order replays. `pnpm py:harness:test` including `test_replay_compat` passes.
- [ ] **AC-6**: verification gate green, output pasted into §Implementation Summary.

### Non-goals

- `continue_as_new` / uncapped re-run / terminal-abandon (C1-02 → TASK-458).
- Idempotency keys on callbacks / SMR generate (C1-03/04 → TASK-458).
- `escalate_gate` no-op (C1-05), policy-degrade flagging (C1-06) → TASK-458.
- Any change to the two-tier architecture or the general optimistic-delivery concept.

## Current State Evaluation (code-verified 2026-07-09 by read-only scout)

**Emission order** ([workflows.py:656-664](apps/harness/src/harness/temporal/workflows.py)):

```python
self._phase = "PERSIST"
await self._report_progress(inp, "finalizing_draft")
draft = await _deliver_early(generated, sensors, assembled, reduced_assurance)  # phase=DRAFT_PENDING_SENSORS, verdict withheld
# The draft is readable NOW — fold the feed to completed + close the SSE.
await self._report_progress(inp, HARNESS_PROGRESS_TERMINAL_STAGE)   # ← "ready" + closed:true, BEFORE sensors
```

Inferential sensors run only after, in the assurance loop ([workflows.py:681-718]); `finalize_assurance` stamps the verdict ([workflows.py:779-800]). Optimistic gate is two-key: `gate.optimistic_delivery_enabled and workflow.patched("task-355-optimistic-delivery")` ([workflows.py:379-381]); config default OFF ([config.py:220]). Early phase constant `HARNESS_DRAFT_PHASE_EARLY = "DRAFT_PENDING_SENSORS"` ([models.py:397]); terminal stage `HARNESS_PROGRESS_TERMINAL_STAGE = "completed"`, label "Draft ready for review" ([models.py:512-513]).

**Sign-off has no window guard** ([summary.service.ts:470-477, 579-582](packages/applications/src/services/consultation/summary/summary.service.ts)): pre-sign checks are tenant scope, `isFinalSummary`, idempotency, and the safety-flag override — **no `consultation.status` check**. `signedBeforeAssurance` is computed but used only to annotate (563-577), not block. During the window `guardrailDecisions` is NULL so `hasSafetyFlag` returns false and the hard-block cannot fire.

**Post-sign mitigation (keep)** ([harness-internal.service.ts:485-594](packages/applications/src/services/consultation/harness/harness-internal.service.ts)): `alreadySigned && lateAdverseVerdict` → `POST_SIGN_FLAG` WORM annotation + `postSignAlert` on the assurance SSE; signed note stands.

**Two SSE channels (do not conflate)**: the *progress/stage* feed closes at [workflows.py:664] (`closed:true`); a separate *assurance* feed (`assurance_complete`) stays open until `finalizeAssurance` and carries `postSignAlert`.

**Replay fixtures**: [test_replay_compat.py](apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py) — `test_post_task355_optimistic_history_replays_on_current_definition` (:93) asserts the current command order; a reorder needs a new marker + fixture.

## Implementation Plan (Option B — TDD; finalize only after decision gate clears)

> Context pack for the implementing agent: this README (incl. the decision outcome) · TASK-449 §Architecture preamble (this is the **durable harness**, the system of record — its determinism/replay rules are strict) · `.claude/rules/06-python-services.md` (Temporal determinism, replay-compat).

1. **RED** (AC-1): extend the optimistic test to assert no safety verdict exists at ready-time. Commit.
2. **GREEN** (AC-2/AC-3): add a safety-only sensor pass before `_deliver_early`/terminal emit, gated by `workflow.patched("task-453-...")`; on safety FLAG, withhold "ready"/emit a non-signable label. Keep it latency-appropriate (safety-only, not the full inferential loop).
3. Ensure `summary.service.ts` sees a populated safety verdict in the window so [summary.service.ts:473] blocks; keep Q2a for non-safety dims. Update tests.
4. **Replay** (AC-5): capture a new fixture; prove forward + backward replay. Run `test_replay_compat`.
5. Regression: Q2b `POST_SIGN_FLAG` path and the assurance SSE terminal event unchanged.

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm py:harness:test           # MUST include test_replay_compat
pnpm py:harness:lint && pnpm py:harness:typecheck
pnpm --filter @arcaai/applications build test   # summary.service + harness-internal suites
pnpm lint
```

Adversarial review focus (reviewer agent): (a) is there still ANY window where a safety-flagged draft is signable? (b) does the reorder break replay for pre-453 histories (run the fixtures)? (c) is the safety-only pass genuinely lighter than the full inferential loop (latency)? (d) is the Q2a autonomy path for non-safety dims intact? (e) zero diff outside the manifest; every enum/order change carries a patch marker.

## Implementation Summary

**No code changed. Closed Won't-fix (Option C).** The product owner accepted the current optimistic-delivery sign-off behavior as intentional. C1-01 is recorded as an accepted, documented product decision with the residual risk noted above. No branch, no tests, no merge.

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket scaffolded from TASK-448 finding C1-01; mechanism, sign-off guard absence, dual-SSE detail, and replay-fixture setup re-verified against code by read-only scout. Scout surfaced that the behavior is coded as intentional (Q2a "RELAXED sign-off governance") → added a blocking decision gate with three options; scaffolded for the recommended Option B. Status → Blocked pending decision. No implementation started. |
| 2026-07-09 | Product owner chose **Option C (accept as-is)**. Closed Won't-fix; no code change. Residual risk documented; Option B analysis retained if ever revisited. Frees TASK-463's ownership of `summary.service.ts`. |
