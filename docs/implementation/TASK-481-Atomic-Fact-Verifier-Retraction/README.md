# TASK-481 — Reference-free Atomic-Fact Verifier + Optimistic-Delivery Retraction Contract (Theme E2 · SOTA S3-F2)

- **Status**: Review
- **Type**: feature (safety gate — a deterministic reference-free verifier + an explicit retraction net for optimistically-delivered drafts)
- **Track**: [SOTA Enhancement Track](../SOTA-Track/README.md) · Theme **E2** (reference-free atomic-fact verifier + retraction contract)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · strategic SOTA track (post-Wave-3)
- **Source finding**: [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md) §SOTA **S3** — the RAGAS-faithfulness row ("present, LLM-based → **add reference-free NLI atomic-fact check (MiniCheck/AlignScore) as a deterministic gate**", effort S) + verdict (c) "the verify-then-deliver loop is genuinely SOTA-aligned … harden it with a **reference-free atomic-fact verifier and an explicit optimistic-delivery retraction contract**" (**S3-F2**)
- **Safety net for**: [TASK-453](../TASK-453-Harness-Assurance-Before-Ready/README.md) (C1-01 — **accepted as-is / Won't-fix**: early sign-off in the pre-assurance window is intentional, `SIGNED_BEFORE_ASSURANCE` + `POST_SIGN_FLAG`). Because that window is accepted, an **explicit retraction contract** is the safety net for a provisionally-delivered draft that later fails assurance.
- **Adds alongside (does not replace)**: the harness `sensors/inferential/groundedness.py` — an **LLM-JudgeClient** groundedness sensor (at-par). E2 adds a **deterministic, reference-free NLI** verifier next to it — a second, model-cheap, non-LLM gate.
- **Theme**: E2 · **Size**: M · **Value**: High (safety gate) · **Risk**: Med (touches the durable Temporal workflow's delivery path — must stay replay-safe)
- **Depends on**: **—** (independent — a safety-gate / deterministic-verifier addition, **not** an ASR/NER quality claim; mirrors [TASK-478](../TASK-478-SMR-Input-Fail-Closed/README.md)'s independence from the measurement gate). **Measure-first note**: measure-first applies to the **verifier's own** precision/recall (AC-6), not TASK-470's ASR scorecard (orthogonal — E2 is a summary-output safety gate).
- **Suggested agent**: general-purpose / security-auditor (`apps/harness` Temporal Python + the inferential sensor stack — a safety-gate lens; run the harness gates + the replay-compat suite).
- **Hard guardrail (track-level)**: **self-hosted NLI only** (MiniCheck / AlignScore / HHEM-class) — no cloud PHI. The **durable harness stays the clinical authority**; the retraction contract is a **safety net**, not a new authority, and does NOT re-open the TASK-453 sign-off decision.

## File-ownership manifest (best-effort exclusive — binding)

Two deliverables: (1) a new deterministic reference-free verifier sensor, and (2) the retraction contract wired into the optimistic-delivery path.

| File | Change | Deliverable |
|---|---|---|
| `apps/harness/src/harness/sensors/inferential/atomic_fact.py` (new) | The **reference-free atomic-fact verifier**: decompose the note into atomic claims + entail each against the transcript with a **self-hosted deterministic NLI** model (MiniCheck / AlignScore / HHEM-class) — **NOT** the LLM `JudgeClient`. Emits a `SensorResult` (`name`/`score`/`passed`/`claims_flagged`/`details`), a deterministic gate signal. | (1) |
| `apps/harness/src/harness/sensors/inferential/__init__.py` · `apps/harness/src/harness/sensors/registry.py` | Register the sensor so the inferential pass / aggregation can consume it. | (1) |
| `apps/harness/src/harness/sensors/config.py` | An `AtomicFactConfig` (threshold, NLI model id, `enabled`) alongside the existing sensor config. | (1) |
| `apps/harness/src/harness/temporal/activities.py` | Wire the verifier into `run_inferential_sensors` (or the gate aggregation) as an additional deterministic signal; add a `retract_draft` activity (via apps/api) that marks a delivered draft **RETRACTED** + WORM audit. | (1)(2) |
| `apps/harness/src/harness/temporal/workflows.py` | The **retraction contract**: after `_deliver_early` (`:558-596`) delivers a `DRAFT_PENDING_SENSORS` draft and the post-delivery assurance pass FLAGs (or the atomic-fact gate fails), execute the retraction branch (mark the delivered draft retracted + surface a retraction event) instead of `finalize_assurance` silently backfilling a FLAG verdict (`:805-826`). **Patch-gated** (`workflow.patched`) so pre-E2 histories replay unchanged. | (2) |
| `apps/harness/src/harness/services/api_client.py` | The retraction write path the `retract_draft` activity calls (mirrors the existing `finalize_assurance` / `record_gate_decision` clients). | (2) |
| apps/api internal endpoint (retraction) | Mark the `DRAFT_PENDING_SENSORS` (or delivered) draft `RETRACTED` + WORM audit; idempotent (mirrors `finalize_assurance`'s idempotency). | (2) |
| `apps/harness/**/tests/**` | RED-first: (a) the verifier marks a grounded note grounded and a hallucinated claim ungrounded **deterministically**; (b) a delivered draft that later fails assurance is **retracted** (RED proves today's finalize-only, no-retraction path); (c) **replay-compat** — a pre-E2 history replays unchanged. | (1)(2) |
| `uv.lock` (root) | If a self-hosted NLI runtime/model package is added — edit `apps/harness` `pyproject.toml`, then `uv lock` at root (per `06-python-services.md`). | infra |
| `turbo.json` · `apps/harness/.env.example` · `.env.example` | Register any new `HARNESS_*` atomic-fact / retraction knobs. | infra |

**Read-only reference (do NOT modify)**: `apps/harness/src/harness/sensors/inferential/groundedness.py` (the LLM-Judge groundedness sensor — stays as-is; E2 adds **alongside** it), `apps/harness/src/harness/eval/metrics/faithfulness.py` (the **offline golden-eval** faithfulness metric — judge-based claim-decomposition; E2's live gate is a separate, deterministic verifier; do NOT repurpose the eval metric into the gate), `apps/harness/src/harness/sensors/base.py` (`SensorResult` `:112-128`, `NEREntity` `:55` — the contract the verifier emits), `apps/harness/src/harness/temporal/activities.py::finalize_assurance` (`:698-726` — the existing backfill path; E2 adds the retraction branch, does not delete finalize).

**Manifest-growth guard (STOP-and-report)**: E2 is a **durable-harness** safety gate. Do NOT **replace** the LLM-Judge groundedness sensor (add alongside), re-open the **C1-01 sign-off** decision ([TASK-453](../TASK-453-Harness-Assurance-Before-Ready/README.md) accepted-as-is — E2 adds the retraction net, it does not change the sign-off governance), build the **live-surface** output gate (that is D2 [TASK-479](../TASK-479-Live-Output-Groundedness-Gate/README.md) — a different surface), touch **warm-start / NER priors** ([TASK-480](../TASK-480-Harness-Warmstart-NER-Priors/README.md)), or wire the offline **eval faithfulness** metric into the live gate. Anything outside the manifest → STOP.

## Requirement Analysis

The harness verify-then-deliver loop is genuinely SOTA-aligned (mirrors AgenticSum/SCRPO/VTG). Two hardening gaps remain, and E2 closes both:

1. **The verifier is LLM-judge-based — add a reference-free deterministic gate.** The current groundedness verification (`sensors/inferential/groundedness.py`) is an **LLM `JudgeClient`** per-claim entailment — high-quality but non-deterministic (model-in-the-loop) and expensive. The SOTA recommendation (S3, effort S) is to **add** a **reference-free NLI atomic-fact check** (MiniCheck / AlignScore-class) as a **deterministic gate** — a cheap, self-hosted, repeatable second signal that does not depend on an LLM judgement. E2 adds it **alongside** the judge sensor (defense-in-depth), not as a replacement.
2. **Optimistic delivery has no retraction — add an explicit retraction contract.** In the optimistic two-phase path, `_deliver_early` persists a readable draft (`DRAFT_PENDING_SENSORS`) and closes the SSE **before** the assurance pass; the clinician can start reading (and, per TASK-453, can sign) in that window. If assurance later FLAGs, `finalize_assurance` simply backfills the FLAG verdict and flips to `PENDING_REVIEW` — the delivered draft is **never retracted**. Since C1-01 (sign-off in the pre-assurance window) is **accepted as-is** ([TASK-453](../TASK-453-Harness-Assurance-Before-Ready/README.md), Won't-fix), an **explicit retraction contract** is the safety net: a provisionally-delivered draft that later fails assurance is cleanly retracted (marked `RETRACTED` + WORM audit + a clinician-facing retraction event).

### Current-state framing (verified — the premise holds, with two refinements)

- **The "MiniCheck" naming already appears, but nothing deterministic is wired.** `sensors/base.py:8` aspirationally calls the inferential stack "MiniCheck groundedness", and the offline eval `eval/metrics/faithfulness.py:11` explicitly names "a tiny NLI verifier like MiniCheck/HHEM swapped in later" — but **both are judge-backed today** and the eval metric is **offline golden-set only**, not the live gate. So there is genuinely **no** reference-free deterministic NLI verifier in the gate. E2 builds the real one.
- **Retraction is genuinely absent.** The optimistic path's `finalize_assurance` backfills the verdict (even a FLAG) and flips state — there is no code path that retracts a delivered draft. This is the real gap the retraction contract fills.

### Acceptance criteria

- [ ] **AC-1 (reference-free atomic-fact verifier — hermetic RED→GREEN)** — `atomic_fact.py` decomposes the note into atomic claims + entails each against the transcript with a **self-hosted deterministic** NLI (a tiny/stub model in tests — **no LLM `JudgeClient`, no network, no cloud**); a grounded note passes, a note with a hallucinated claim fails; emits a `SensorResult`. RED: verifier absent.
- [ ] **AC-2 (deterministic gate)** — same input → **byte-identical** verdict (no temperature / LLM nondeterminism); the sensor is wired into the inferential/gate aggregation as an additional signal, and a degraded backend **degrades** (never auto-PASS), consistent with the existing sensor stack.
- [ ] **AC-3 (retraction contract — RED→GREEN)** — a delivered `DRAFT_PENDING_SENSORS` draft whose post-delivery assurance FLAGs (or whose atomic-fact gate fails) triggers a `retract_draft` activity that marks it `RETRACTED` + writes the WORM audit + surfaces a clinician-facing retraction event; RED proves today's path only backfills the verdict (`finalize_assurance`, no retraction). Idempotent on the apps/api side.
- [ ] **AC-4 (C1-01 safety net — relates to TASK-453)** — §Implementation Summary states the combined posture: TASK-453 **accepts** early sign-off in the pre-assurance window (`SIGNED_BEFORE_ASSURANCE`/`POST_SIGN_FLAG`); E2 **retracts** a delivered draft that later fails assurance — the explicit net that makes the accepted window safe. E2 does **not** change the sign-off governance.
- [ ] **AC-5 (replay-safe)** — the verifier signal + the retraction branch are **patch-gated** (`workflow.patched`) so a pre-E2 optimistic history replays unchanged; the harness **replay-compat** tests (`test_replay_compat`) pass. No wall-clock/RNG/IO inside `@workflow.defn`; the retraction activity carries a bounded `RetryPolicy` and is idempotent.
- [ ] **AC-6 (measure-first — verifier-owned metric; TASK-470 orthogonal)** — record the atomic-fact verifier's **precision/recall** on a small **self-hosted, de-identified** labelled grounded/ungrounded sample. TASK-470's ASR scorecard is orthogonal (E2 is a summary-output safety gate, not ASR/NER quality) — E2 is **independent of the measurement gate** (mirrors TASK-478), and this metric is E2-owned. (Full MEDCON/UMLS concept-F1 is [TASK-482](../SOTA-Track/README.md)/E3 — not this ticket.)
- [ ] **AC-gate** — `pnpm py:harness:test` (hermetic — Temporal/LLM/NLP stubbed) + `py:harness:lint` + `py:harness:typecheck` green; harness **replay-compat** green; `uv lock` re-run if deps changed; new knobs in `turbo.json#globalEnv` + `.env.example`; self-hosted (no cloud egress); output pasted.

### Non-goals

- **Replacing the LLM-Judge groundedness sensor** — E2 adds a deterministic verifier **alongside** it (defense-in-depth), not instead of it.
- **Re-opening the C1-01 sign-off governance** — [TASK-453](../TASK-453-Harness-Assurance-Before-Ready/README.md) accepted it as-is; E2 adds the retraction net only.
- **The live-surface output/groundedness gate** — that is D2 ([TASK-479](../TASK-479-Live-Output-Groundedness-Gate/README.md)); E2 hardens the **durable** harness delivery path.
- **Warm-start / NER priors** — that is E1 ([TASK-480](../TASK-480-Harness-Warmstart-NER-Priors/README.md)).
- **Wiring the offline eval faithfulness metric into the gate** — the eval metric (`eval/metrics/faithfulness.py`) stays offline golden-eval; the gate verifier is a separate deterministic sensor.
- **MEDCON / UMLS concept-F1** — [TASK-482](../SOTA-Track/README.md) (E3).
- **A cloud NLI vendor** — self-hosted only (track guardrail).

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review` @ `87199e33`)

**The verifier is LLM-judge-based; no reference-free deterministic NLI gate exists:**
- `sensors/inferential/groundedness.py` — `GroundednessSensor.arun` (`:161-185`) runs per-claim entailment via the injected **LLM `JudgeClient`** (`_verdicts_per_claim`, `:187-243`: `judge.complete(_entailment_messages(...), json_mode=True, temperature=0.0)`) against transcript ∪ evidence, threshold-gated. High-quality but LLM-in-the-loop.
- `eval/metrics/faithfulness.py` (`:1-60`) does atomic-claim decomposition (`LLMClaimExtractor`) + per-claim verify — but via a `JudgeClient` and for **offline golden-set eval** (`GoldenCase`), not the live gate; `:9-12` explicitly frames "a tiny NLI verifier like MiniCheck/HHEM swapped in later" as the never-wired future option.
- `sensors/base.py:8` aspirationally names the inferential stack "MiniCheck groundedness, Llama-Guard safety" — a naming aspiration; the actual sensor is judge-backed. **`SensorResult`** (`:112-128`): `name` / `score∈[0,1]` / `passed` / `claims_flagged` / `details` — the contract the new deterministic verifier emits.

**Optimistic delivery has no retraction:**
- `workflows.py::_deliver_early` (`:558-596`) persists `phase=HARNESS_DRAFT_PHASE_EARLY` (`DRAFT_PENDING_SENSORS`), verdict + RAG-triad **withheld** (`gate_decision=None`, `rag_triad_score=None`).
- `:673-677` — the draft is delivered NOW, then `_report_progress(inp, HARNESS_PROGRESS_TERMINAL_STAGE)` "fold the feed to completed + close the SSE" — the clinician can start reading (and, per TASK-453, sign) here.
- `:679-796` — the assurance loop (inferential pass) runs **AFTER** delivery; `:805-826` — `finalize_assurance` backfills the verdict (**including a FLAG** `gate_decision=decision`, `:819`) and flips `DRAFT_PENDING_SENSORS → PENDING_REVIEW`. `activities.py::finalize_assurance` (`:698-726`) is **backfill only** — there is **no** code path that **retracts** a delivered draft that failed assurance.
- C1-01 accepted as-is: [TASK-453](../TASK-453-Harness-Assurance-Before-Ready/README.md) is **Closed — Won't-fix (Option C, 2026-07-09)**; early sign-off (`SIGNED_BEFORE_ASSURANCE`) + the `POST_SIGN_FLAG` amendment path are intentional — so an explicit **retraction contract** is the sanctioned safety net for a later-failed delivered draft.

**Replay discipline is already load-bearing here** — the optimistic delivery + assurance signals are already `workflow.patched`-gated (`:392` `task-355-optimistic-delivery`, `:691` `task-355-assurance-signals`, `:881` `task-458-gate-terminal-abandon`), so E2's verifier signal + retraction branch **must** be patch-gated the same way to preserve replay compatibility.

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-448 §SOTA S3 (reference-free NLI atomic-fact check as a deterministic gate; retraction contract) · TASK-453 (C1-01 accepted-as-is — the retraction net's rationale) · TASK-449 §Architecture preamble (harness authoritative; the sensor stack is correct) · `.claude/rules/06-python-services.md` (harness — Temporal determinism, `workflow.patched`, replay-compat, idempotent activities, hermetic CI, `uv lock`).

1. **Atomic-fact verifier (RED→GREEN, hermetic)** — write `atomic_fact.py`: decompose into atomic claims + entail each against the transcript with a **self-hosted deterministic** NLI (injectable → a tiny/stub NLI in tests). RED: verifier absent → a grounded vs hallucinated pair. GREEN: emits a `SensorResult`.
2. **Register + gate** — register the sensor; wire it into `run_inferential_sensors` / the gate aggregation as an additional deterministic signal; a degraded backend degrades (never auto-PASS).
3. **Retraction activity + contract (RED→GREEN)** — add `retract_draft` (activity + `api_client` + apps/api endpoint, idempotent + WORM); in `workflows.py`, add the FLAG-after-delivery retraction branch. RED proves today's finalize-only path (no retraction). **Patch-gate** the branch (`workflow.patched`).
4. **Replay-compat** — run `test_replay_compat`; assert a pre-E2 optimistic history replays unchanged (the new signal + retraction are patch-gated).
5. **Measure (verifier-owned)** — record the verifier's precision/recall on a self-hosted de-identified labelled sample; note TASK-470 is orthogonal and E3 owns concept-F1.

### Verification gate (paste output into §Implementation Summary)

```bash
# harness (verifier + retraction; hermetic — Temporal/LLM/NLP stubbed)
pnpm py:harness:test && pnpm py:harness:lint && pnpm py:harness:typecheck
# replay compatibility (Temporal determinism)
pnpm py:harness:test -k replay_compat
```

Adversarial review focus (reviewer agent): (a) is the verifier genuinely **reference-free + deterministic** (self-hosted NLI, byte-identical verdict on repeat, **no `JudgeClient`**, no network)? (b) does a delivered draft that later FLAGs get **retracted** (marked `RETRACTED` + WORM) — proven by a RED that failed on today's finalize-only path? (c) is the retraction branch + verifier signal **patch-gated** so a pre-E2 history replays unchanged (`test_replay_compat` green)? (d) is `retract_draft` **idempotent** with a bounded `RetryPolicy` (a retried retraction does not double-write)? (e) does E2 **add alongside** the LLM-Judge sensor (not replace it) and **not** re-open the TASK-453 sign-off governance? (f) zero diff outside the manifest — no live gate (D2/479), no warm-start (E1/480), no eval-metric repurposing.

## Implementation Summary

Implemented against `fix/2605-review` (base `9e46a1a1a`, on top of the merged TASK-480 warm-start). TDD, RED→GREEN, strictly replay-safe. Two halves — the deterministic verifier + retraction net are built fully and hermetically; the self-hosted-NLI *model* and the apps/api *retraction endpoint* are explicit staging dependencies (below).

**Deliverable 1 — reference-free deterministic atomic-fact verifier (built fully, hermetic):**
- `sensors/inferential/atomic_fact.py` (new) — `decompose_claims()` (deterministic, model-free SOAP-JSON/prose → atomic sentence claims), an injectable `NliEntailer` protocol (a **self-hosted deterministic NLI**, explicitly **NOT** the LLM `JudgeClient`), the model-free `DeterministicOverlapEntailer` (hermetic default — salient-token overlap, no model/network), and `AtomicFactSensor.arun(ctx)` (grounded fraction → `SensorResult`; **fail-safe**: no-transcript or entailer error ⇒ `degraded` (`passed=False`), never auto-PASS; no-claims ⇒ vacuous pass).
- `sensors/config.py` — `SensorThresholds.atomic_fact_threshold` (`HARNESS_SENSOR_ATOMIC_FACT_THRESHOLD`, default 0.8).
- `sensors/inferential/__init__.py` — exports `AtomicFactSensor` / `ATOMIC_FACT_NAME` / `NliEntailer` / `DeterministicOverlapEntailer`.
- `sensors/aggregator.py` — `"atomic_fact"` added to `REGEN_FIXABLE_SENSORS` (required by AC-2 "wired into the gate aggregation" — an ungrounded atomic claim REGENs, FLAGs on budget exhaustion, mirroring groundedness).
- `core/config.py` — `Settings.atomic_fact_enabled` (`HARNESS_ATOMIC_FACT_ENABLED`, **default OFF**) ops kill-switch, read at runtime **inside the activity** (not the workflow) ⇒ no snapshot/patch.
- `temporal/activities.py` — `_atomic_fact_entailer()` factory + `_run_atomic_fact_sensor()` (degrade-safe) wire the verifier into `run_inferential_sensors` ALONGSIDE the judge sensors (gated by the kill-switch); `_atomic_fact_decision()` folds it into `guardrailDecisions`. **Data-only through the activity output ⇒ no new workflow command, no `workflow.patched()` (mirrors TASK-480 Half-B) — an old replay history's recorded inferential result has no `atomic_fact`, so the aggregate is byte-identical, replay-safe.**

**Deliverable 2 — optimistic-delivery retraction contract (harness side built fully):**
- `temporal/models.py` — `RetractDraftInput` + additive-optional `HarnessDocWorkflowResult.retracted` (⇒ replay-safe).
- `services/api_client.py` — `retract_draft()` write path + `RetractDraftResponse` (mirrors `finalize_assurance`; carries the FLAG verdict + offending claim refs for the WORM audit).
- `temporal/activities.py` — `retract_draft` activity (idempotent via `_idempotency_key`, bounded `_API_RETRY`), registered in `DOCUMENT_ACTIVITIES`.
- `temporal/workflows.py` — the **patch-gated** retraction branch: after the assurance loop, `if workflow.patched("task-481-optimistic-retraction") and verdict.decision == FLAG:` → `retract_draft` (mark RETRACTED + WORM + clinician event) **INSTEAD of** the finalize-backfill, then terminate `retracted=True` (a withdrawn draft does not wait at the gate). A non-FLAG verdict finalizes exactly as before. **This is the one genuine new command → `workflow.patched()` gate (unavoidable); a pre-E2 history returns `patched()==False` and replays the legacy finalize-only sequence unchanged.**

**Fail-safe posture (AC-2/AC-3):** the verifier never affirms on uncertainty — `test_backend_error_degrades_never_auto_passes` + `test_no_transcript_degrades_never_auto_passes` (sensor), `test_atomic_fact_backend_error_degrades_never_auto_passes` (activity). A degraded atomic-fact backend ⇒ reduced-assurance (excluded from `expected`), never a silent auto-PASS. Without the apps/api endpoint a FLAG retraction 404s → the workflow FAILS (draft stays `DRAFT_PENDING_SENSORS`, never affirmed to `PENDING_REVIEW`) — fail-safe.

**Replay-compat (AC-5):** the deterministic verifier signal adds NO workflow command (activity-side, data-only). The retraction branch is `workflow.patched`-gated. All **7 pre-E2 fixtures replay unchanged**, and a new `--retract` forward-guard fixture (`doc_workflow_post_task481_retraction_history.json`) + replay test capture the `task-481-optimistic-retraction` marker + the `persist_draft → run_inferential_sensors(FLAG) → retract_draft` sequence.

**Tests (RED→GREEN):** verifier decomposition/grounded/hallucinated/degrade/deterministic (`test_atomic_fact.py`); aggregator REGEN→FLAG (`test_aggregator.py`); activity wiring + degrade (`test_activities_inferential.py`); api_client `retract_draft` (`test_api_client.py`); `retract_draft` activity (`test_activities.py`); the 3 optimistic-FLAG workflow tests REWRITTEN finalize→retract + `retracted=True` (`test_doc_workflow.py`, RED proved today's finalize-only path); replay forward-guard (`test_replay_compat.py`).

**Gate evidence:**
- `pnpm py:harness:test` → **728 passed** (706 TASK-480 baseline + 22 new; incl. `test_replay_compat` **8 fixtures GREEN** — 7 pre-E2 unchanged + the new task-481 retraction guard).
- `py:harness:lint` (ruff) → All checks passed. `py:harness:typecheck` (mypy) → no issues found in 82 source files.
- No new deps (`uv.lock` untouched — the verifier uses stdlib + existing harness modules). New knobs `HARNESS_ATOMIC_FACT_ENABLED` (+ `HARNESS_SENSOR_ATOMIC_FACT_THRESHOLD`) registered in `turbo.json#globalEnv` + both `.env.example`s.

**Boundary / STOP-and-report (staging dependencies — enable together, after both land):**
1. **Self-hosted NLI model** (MiniCheck / AlignScore / HHEM-class): the verifier is complete behind the `NliEntailer` interface with a hermetic model-free default (`DeterministicOverlapEntailer`, over-flags rather than under-flags — fail-safe). Provisioning the real self-hosted NLI + recording its precision/recall on a de-identified labelled sample (AC-6) is the enablement gate; slot it into `_atomic_fact_entailer()`. `HARNESS_ATOMIC_FACT_ENABLED` stays OFF until then.
2. **apps/api `POST /internal/harness/consultations/:id/retraction`** (mark draft `RETRACTED` + WORM + clinician retraction event, idempotent like `finalizeAssurance`): a coordinated follow-up out of this ticket's hermetic gate (mirrors the TASK-458 `record_escalation` precedent). Until it lands, a retraction 404s → the workflow fails fail-safe (draft never affirmed). Enable it BEFORE enabling optimistic delivery in production (itself default-OFF).

**Not done / out of scope (honored):** LLM-Judge groundedness sensor untouched (added alongside); TASK-453 C1-01 sign-off governance unchanged (E2 only adds the retraction net); no live-surface gate (D2/479); no warm-start/NER-priors change (E1/480); the offline eval faithfulness metric not wired into the live gate.

## Change History

| Date | Change |
|---|---|
| 2026-07-11 | **Implemented (Review).** Deliverable 1 — deterministic reference-free atomic-fact verifier (`sensors/inferential/atomic_fact.py` + `NliEntailer`/`DeterministicOverlapEntailer`; threshold in `SensorThresholds`; `atomic_fact_enabled` kill-switch in `Settings`, default OFF; wired into `run_inferential_sensors` + `REGEN_FIXABLE_SENSORS`; **no workflow command, replay-safe by data-only à la TASK-480**). Deliverable 2 — optimistic-delivery retraction contract (`RetractDraftInput` + `retracted` result field; `api_client.retract_draft`; `retract_draft` activity; **patch-gated** `workflow.patched("task-481-optimistic-retraction")` retraction branch that retracts-instead-of-finalizes a FLAGged delivered draft + terminates). Fail-safe throughout (never affirms on uncertainty/error). RED→GREEN; the 3 optimistic-FLAG workflow tests rewritten finalize→retract. Gates: `py:harness:test` **728 passed** incl. `test_replay_compat` **8 fixtures** (7 pre-E2 unchanged + new task-481 `--retract` forward-guard); ruff + mypy clean; no new deps. **Staging asks (STOP-and-report):** provision the self-hosted NLI model + AC-6 precision/recall (verifier is default-OFF behind the hermetic overlap entailer until then); build the apps/api `/retraction` endpoint (coordinated follow-up, TASK-458 precedent) before enabling optimistic delivery. See Implementation Summary. |
| 2026-07-10 | Detail-scaffolded from [SOTA-Track](../SOTA-Track/README.md) Theme **E2** into an execution-ready ticket. Current state code-verified against `fix/2605-review` @ `87199e33`: the harness verifier is **LLM-`JudgeClient`-based** (`sensors/inferential/groundedness.py:161-243`) with **no reference-free deterministic NLI gate** (the "MiniCheck" naming is aspirational — `sensors/base.py:8`; the atomic-claim decomposition in `eval/metrics/faithfulness.py:1-60` is judge-based **offline golden-eval only**, `:9-12` names MiniCheck/HHEM as a never-wired future); and optimistic delivery has **no retraction** — `_deliver_early` (`workflows.py:558-596`) delivers `DRAFT_PENDING_SENSORS` + closes the SSE (`:673-677`), assurance runs after, and `finalize_assurance` (`:805-826`, `activities.py:698-726`) **backfills even a FLAG verdict** and flips to `PENDING_REVIEW` with no path that retracts a delivered draft. C1-01 (sign-off in that window) is accepted-as-is (TASK-453 Won't-fix, Option C), so E2 adds (1) a **self-hosted reference-free atomic-fact NLI verifier** as a deterministic gate **alongside** the judge sensor and (2) an explicit **optimistic-delivery retraction contract** (`retract_draft` + WORM), both **patch-gated** for replay safety. Independent of the measurement gate (mirrors TASK-478); verifier precision/recall is the E2-owned metric, concept-F1 deferred to TASK-482 (E3). No implementation; documentation only. |
