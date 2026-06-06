"""Registry of the Phase-1 computational sensors for the harness loop.

The durable loop (Lane I) calls :func:`computational_sensors` once to instantiate
the deterministic gate sensors (in canonical order), runs each as a Temporal
activity, then folds the results via :func:`harness.sensors.aggregator.aggregate`.
"""

from __future__ import annotations

from harness.sensors.base import Sensor
from harness.sensors.computational.citation_presence import CitationPresenceSensor
from harness.sensors.computational.coverage_omission import CoverageOmissionSensor
from harness.sensors.computational.entity_faithfulness import EntityFaithfulnessSensor
from harness.sensors.computational.numeric_dose import NumericDoseSensor
from harness.sensors.computational.schema_validity import SchemaValiditySensor
from harness.sensors.config import SensorThresholds

# Canonical order the loop runs / reports the sensors in.
COMPUTATIONAL_SENSOR_NAMES: tuple[str, ...] = (
    EntityFaithfulnessSensor.name,
    CoverageOmissionSensor.name,
    SchemaValiditySensor.name,
    CitationPresenceSensor.name,
    NumericDoseSensor.name,
)


def computational_sensors(thresholds: SensorThresholds | None = None) -> list[Sensor]:
    """Instantiate the five computational sensors, wired with ``thresholds``."""
    config = thresholds or SensorThresholds()
    return [
        EntityFaithfulnessSensor(threshold=config.entity_faithfulness_threshold),
        CoverageOmissionSensor(threshold=config.coverage_threshold),
        SchemaValiditySensor(),
        CitationPresenceSensor(threshold=config.citation_presence_threshold),
        NumericDoseSensor(threshold=config.numeric_dose_threshold),
    ]
