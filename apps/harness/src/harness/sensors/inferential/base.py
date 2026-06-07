"""Inferential-sensor contracts — async, model-backed gate sensors (Phase 2).

The Phase-1 :class:`~harness.sensors.base.Sensor` protocol is pure and **sync**
(``run(ctx)``, no model calls). Inferential sensors (groundedness via the LM Studio
judge, safety via Granite Guardian over Ollama) are **async + model-calling**, so
they need a distinct protocol — :class:`InferentialSensor` — while reusing the
exact same :class:`~harness.sensors.base.SensorContext` / :class:`SensorResult`
value objects so the aggregator and the durable loop consume both kinds unchanged.

Design (mirrors the sync framework):

* ``judge`` — the shared :class:`~harness.eval.judge.base.JudgeClient` (the
  calibrated LM Studio judge, reused for groundedness/reasoning) — is passed to
  every ``arun`` so the Temporal activity builds it once and fans it out.
* **Backend-specific** clients (e.g. the Granite Guardian HTTP client used by the
  safety sensor) are injected at construction time — exactly as the computational
  sensors take their ``threshold`` in ``__init__`` — keeping ``arun`` uniform.
* :func:`degraded_result` builds the reduced-assurance result a sensor returns
  when its backend is unavailable: ``degraded=True`` and ``passed=False`` so an
  unverifiable inferential pass **never** silently auto-PASSes.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from harness.eval.judge.base import JudgeClient
from harness.sensors.base import SensorContext, SensorResult


def degraded_result(
    name: str,
    reason: str,
    *,
    score: float = 0.0,
    claims_flagged: list[str] | None = None,
) -> SensorResult:
    """Build a degraded :class:`SensorResult` for the reduced-assurance path.

    Returned when an inferential sensor structurally cannot verify its inputs
    (judge/Granite backend unreachable). ``degraded=True`` + ``passed=False`` mean
    the aggregator must treat it as unverified — never an auto-PASS.
    """
    return SensorResult(
        name=name,
        score=score,
        passed=False,
        claims_flagged=list(claims_flagged or []),
        details={"degraded": True, "reason": reason},
    )


@runtime_checkable
class InferentialSensor(Protocol):
    """An inferential (async, model-backed) gate sensor.

    Conformance (``isinstance``) requires a ``name`` attribute and an ``arun``
    coroutine. Implementations return a :class:`SensorResult` named after the
    sensor (``"groundedness"`` / ``"safety"``), and on backend failure should
    return :func:`degraded_result` rather than raising into the loop.
    """

    name: str

    async def arun(self, ctx: SensorContext, *, judge: JudgeClient) -> SensorResult:
        """Score ``ctx`` (async, may call models) and return a :class:`SensorResult`.

        ``judge`` is the shared judge client; sensors that screen via a different
        backend (e.g. Granite Guardian) accept it for a uniform call site and use
        their constructor-injected client instead.
        """
        ...
