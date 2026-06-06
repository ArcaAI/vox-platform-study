"""Phase-2 *inferential* sensors — extension point (NOT implemented in Phase 1).

Phase 1 ships only the pure/deterministic computational sensors
(:mod:`harness.sensors.computational`). The model-backed sensors below are a
Phase-2 extension and are intentionally left unimplemented here.

When implemented, each will satisfy the **same** :class:`harness.sensors.base.Sensor`
protocol (``name`` + ``run(ctx) -> SensorResult``) and reuse the model-agnostic
provider plumbing already built for the eval judge
(:mod:`harness.sensors`/:mod:`harness.eval.judge` — see
:class:`harness.eval.judge.base.JudgeClient` and
``harness.eval.judge.providers.build_judge_client``), so the harness loop and the
aggregator consume them unchanged.

Planned Phase-2 sensors:

* ``groundedness`` — Bespoke-MiniCheck-7B (or HHEM/NLI) per-claim entailment of
  the note against the transcript/evidence.
* ``safety`` — Llama Guard 3 content-safety screen on the generated note.
* ``reasoning_judge`` — an LLM-as-judge (PDSQI-9 style, reusing
  :class:`harness.eval.judge.pdsqi.PDSQI9Judge`) for holistic quality.

These are model calls and therefore live in Temporal *activities*, not in the
deterministic workflow path.
"""

from __future__ import annotations

# TODO(TASK-330 Phase 2): implement GroundednessSensor (MiniCheck), SafetySensor
# (Llama Guard 3), and ReasoningJudgeSensor (PDSQI-9) against the Sensor protocol,
# reusing harness.eval.judge providers. Left as a stub by design in Phase 1.
__all__: list[str] = []
