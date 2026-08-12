# TASK-674 — Wire the entity-grounding escalation into the durable loop

**Note:** This ticket number is shared with another, unrelated TASK-674 doc
(`TASK-674-Console-Deferred-Tails`) — a numbering collision. See that doc separately; the
two are not related.

**Status:** Pending

**Type:** feature · **Depends on:** TASK-671 (merged; the sensor + aggregator half are built,
tested, and calibrated)

**Origin:** TASK-671 built and calibrated the inference-aware entity sensors and taught the
aggregator to combine them, but deliberately stopped short of constructing them inside
`run_inferential_sensors`. This is that remaining step, raised separately because the
blocking prerequisite is a change to a **PHI egress guard** and deserves its own review
rather than being appended to the ticket that discovered it.

---

## 1. Requirement Analysis

### 1.1 State inherited from TASK-671

Built, green, and calibrated (50% recovery / 100% retention, zero unsafe flips — TASK-671
§5.1):

- `harness/sensors/inferential/entity_grounding.py` — the sensor.
- `harness/sensors/aggregator.py` — `SUPERSEDED_BY` + severity registration.
- `harness/eval/entity_grounding_corpus.py`, `entity_grounding_parity.py` — the two-arm
  corpus and its calibration runner.

**Not done:** nothing in `run_inferential_sensors` constructs the sensors, so the aggregator's
supersede is a no-op in production and the gate behaves exactly as it did before TASK-671
(locked by `test_no_escalation_leaves_the_incumbent_behaviour_untouched`).

### 1.2 The blocker — entity text is an unguarded egress path

`ensure_inferential_egress_safe` (`harness/guards/phi/egress.py:124`) redacts every
cloud-bound field of the inferential pass: `note_text` against the safety provider, and
`transcript_text`, the `citations_map` claim texts + evidence quotes, and `knowledge_chunks`
against the judge provider.

**It takes no entity arguments.** The entity-grounding sensor builds a hypothesis from each
entity's raw `text` and sends it to the judge. Wiring it as-is would send unscreened NER spans
to a cloud judge — and NER spans are precisely the identifying clinical detail the guard
exists to catch. That is a new PHI egress path, not a refactor.

This is the whole reason for a separate ticket. Everything else here is small.

---

## 2. Implementation Plan

| # | Item | Notes |
|---|---|---|
| **W1** | Extend `ensure_inferential_egress_safe` to take `note_entities` / `transcript_entities` and gate each entity's `text` through the existing `_gate(..., judge_provider)`. | Symmetric with the transcript, which is the same premise the same consumer already receives. Return redacted copies; never mutate in place (mirrors `_redact_citations_map`). |
| **W2** | Guard tests: all-local ⇒ identity pass-through; cloud judge ⇒ entity text redacted; a redactor failure ⇒ `PhiEgressBlocked` under `phi_fail_closed`. | The identity case matters most — it is the default deployment and must stay byte-identical so replay is unaffected. |
| **W3** | Add `note_entities` / `transcript_entities` / `entity_grounding_enabled` to `RunInferentialSensorsInput` as additive-optional fields. | The established replay-safe pattern in that model (see `prior_verdicts`, `judge_provider`: "additive-optional ⇒ replay-safe"). |
| **W4** | Construct both sensors in `run_inferential_sensors` behind a kill-switch defaulting **OFF**, using the redacted entities from W1 and the same injected backend selection as `atomic_fact`. | Resolve the flag inside the activity, as `_resolve_flag(payload.atomic_fact_enabled, …)` already does, so `workflows.py` gains no new command. |
| **W5** | Pass the entity lists at the `RunInferentialSensorsInput(...)` call sites in `workflows.py`. | Both call sites (the optimistic-delivery path and the in-loop path). The workflow already holds these — it builds `RunSensorsInput` from them. |
| **W6** | Add a `guardrail_decisions` entry for each new sensor, mirroring `_atomic_fact_decision`. | Keeps the trajectory/UI surface consistent; include the `escalated` and `recovered_by_entailment` counts so a recovery is auditable in the WORM record. |

### 2.1 Backend selection

TASK-671 §2.7: MiniCheck weights are unstaged and `HARNESS_ATOMIC_FACT_ENABLED=false`, so the
only reachable backend today is the LLM judge — which the `NliEntailer` protocol's determinism
clause does not sanction for production use. Two acceptable resolutions, in order:

1. **Stage MiniCheck** and inject it (preferred — deterministic, self-hosted, no new egress).
   The calibration gate `verify_calibration` must pass on the target host.
2. Ship with the judge-backed adapter promoted out of `eval/`, **only** with the determinism
   caveat recorded in the ticket and the kill-switch left OFF by default.

Do not silently fall back to `DeterministicOverlapEntailer` — it is a token-overlap check, so
an "entailment" from it is a lexical match by another name (TASK-671 proved it recovers
nothing, and `test_the_default_overlap_entailer_never_loosens` locks that).

---

## 3. Verification Criteria

- [ ] `pnpm harness:test` green against the TASK-671 baseline (1156 passed / 4 pre-existing
      failures — `test_otel_tracing_task636` ×3 + `test_qdrant_api_key`, all `.env.dev`).
- [ ] `pnpm harness:lint` + `pnpm harness:typecheck` clean.
- [ ] **Replay-compat green** — new payload fields are additive-optional and `workflows.py`
      gains no new command.
- [ ] Egress guard tests prove entity text is redacted for a cloud judge and untouched for an
      all-local deployment.
- [ ] Kill-switch OFF reproduces today's gate exactly.
- [ ] Kill-switch ON reproduces the TASK-671 §5.1 recovery/retention figures end to end
      through the activity, not just the sensor in isolation.
- [ ] `test_adjudication_penalty_task664.py` still passes unchanged.

---

## 4. Open Questions

1. **Cost.** The residue is per-entity and the coverage direction iterates *transcript*
   entities, which is the larger set. TASK-671 §6 Q4 flagged this as unmeasured. Measure
   before enabling by default.
2. **Framing ablation** (TASK-671 §6 Q2) — `frame_entity` is a single pure function precisely
   so alternatives can be measured. Four of TASK-671's eight misses were judge
   under-recovery, so framing is a live lever.
3. **Corpus fix** — TASK-671 §5.2 found `pneumonia`/`bronchitis` are entailed by the
   *specialists' views*, not the transcript. Those two cases need a specialist-view premise
   before the recovery ceiling is meaningful.

---

## 5. Implementation Summary

_(to be completed during implementation)_

---

## 6. Change History

- **2026-08-12** — Ticket opened from TASK-671 §5.6. No code written.
