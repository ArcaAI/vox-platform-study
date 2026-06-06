"""Computational gate sensors for the clinical-documentation harness loop.

Phase-1 ships five **pure, deterministic** sensors (no model calls) plus a
fail-safe verdict aggregator. See :mod:`harness.sensors.base` for the
``Sensor`` / ``SensorResult`` / ``SensorContext`` contracts and
:mod:`harness.sensors.aggregator` for the PASS / REGEN / FLAG decision. Inferential
(model-backed) sensors are a Phase-2 extension in :mod:`harness.sensors.inferential`.
"""

from __future__ import annotations

from harness.sensors.aggregator import (
    DEFAULT_SOAP_SECTIONS,
    HIGHEST_HARM_SENSORS,
    REGEN_FIXABLE_SENSORS,
    GateDecision,
    Verdict,
    aggregate,
)
from harness.sensors.base import (
    NEREntity,
    Sensor,
    SensorContext,
    SensorResult,
    dedupe,
    normalize_text,
)
from harness.sensors.computational.citation_presence import CitationPresenceSensor
from harness.sensors.computational.coverage_omission import CoverageOmissionSensor
from harness.sensors.computational.entity_faithfulness import EntityFaithfulnessSensor
from harness.sensors.computational.numeric_dose import NumericDoseSensor
from harness.sensors.computational.schema_validity import SchemaValiditySensor
from harness.sensors.config import SensorThresholds
from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES, computational_sensors

__all__ = [
    "COMPUTATIONAL_SENSOR_NAMES",
    "DEFAULT_SOAP_SECTIONS",
    "HIGHEST_HARM_SENSORS",
    "REGEN_FIXABLE_SENSORS",
    "CitationPresenceSensor",
    "CoverageOmissionSensor",
    "EntityFaithfulnessSensor",
    "GateDecision",
    "NEREntity",
    "NumericDoseSensor",
    "SchemaValiditySensor",
    "Sensor",
    "SensorContext",
    "SensorResult",
    "SensorThresholds",
    "Verdict",
    "aggregate",
    "computational_sensors",
    "dedupe",
    "normalize_text",
]
