"""Phase-1 computational sensors — pure, deterministic, no model calls.

Each module exposes a ``NAME`` constant and a ``Sensor``-protocol class:

* :mod:`~harness.sensors.computational.entity_faithfulness` — note entities must
  be grounded in the transcript (anti-fabrication).
* :mod:`~harness.sensors.computational.coverage_omission` — transcript entities
  must appear in the note (anti-omission, the #1 clinical error).
* :mod:`~harness.sensors.computational.schema_validity` — the SOAP note must
  conform to its activated JSON Schema.
* :mod:`~harness.sensors.computational.citation_presence` — every provenance
  claim must carry >= 1 evidence span.
* :mod:`~harness.sensors.computational.numeric_dose` — numbers/doses in the note
  must cross-check against the transcript.
"""

from __future__ import annotations
