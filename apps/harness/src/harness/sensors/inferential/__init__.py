"""Phase-2 *inferential* sensors — async, model-backed gate sensors.

Unlike the pure/deterministic computational sensors
(:mod:`harness.sensors.computational`), these call models: ``groundedness`` does
per-claim entailment via the calibrated LM Studio judge, and ``safety`` screens
the note through IBM Granite Guardian over a selectable engine (LM Studio by
default; Azure/Bedrock optional). They implement the async
:class:`~harness.sensors.inferential.base.InferentialSensor` protocol
(``arun(ctx, *, judge)``) and run inside the ``run_inferential_sensors`` Temporal
activity (model calls never run in the deterministic workflow body).

This package re-exports the sensors, the Granite client, and each sensor's
``NAME`` (aliased ``GROUNDEDNESS_NAME`` / ``SAFETY_NAME``) as the stable surface
the activity wires together.
"""

from __future__ import annotations

from harness.sensors.inferential.atomic_fact import NAME as ATOMIC_FACT_NAME
from harness.sensors.inferential.atomic_fact import (
    AtomicFactSensor,
    DeterministicOverlapEntailer,
    NliEntailer,
)
from harness.sensors.inferential.citation_verify import NAME as CITATION_VERIFY_NAME
from harness.sensors.inferential.citation_verify import CitationVerifySensor
from harness.sensors.inferential.granite_client import (
    GraniteGroundednessJudge,
    GraniteGuardianClient,
)
from harness.sensors.inferential.groundedness import NAME as GROUNDEDNESS_NAME
from harness.sensors.inferential.groundedness import GroundednessSensor
from harness.sensors.inferential.safety import NAME as SAFETY_NAME
from harness.sensors.inferential.safety import SafetySensor

__all__ = [
    "GroundednessSensor",
    "GROUNDEDNESS_NAME",
    "SafetySensor",
    "SAFETY_NAME",
    "CitationVerifySensor",
    "CITATION_VERIFY_NAME",
    "AtomicFactSensor",
    "ATOMIC_FACT_NAME",
    "NliEntailer",
    "DeterministicOverlapEntailer",
    "GraniteGuardianClient",
    "GraniteGroundednessJudge",
]
