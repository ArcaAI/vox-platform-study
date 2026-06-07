"""Golden-set abstraction: pluggable sources + a scoring runner."""

from __future__ import annotations

from harness.eval.golden.runner import GoldenSetRunner
from harness.eval.golden.sources import (
    CLINICAL_FIXTURE,
    CLINICAL_SCHEMA,
    CLINICAL_TEMPLATE_FIXTURE,
    DEFAULT_FIXTURE,
    FIXTURES_DIR,
    ClinicalGoldenSetSource,
    GoldenSetSource,
    InMemoryGoldenSetSource,
    JSONFileGoldenSetSource,
    clinical_golden_set_source,
    default_golden_set_source,
    project_clinical_case,
)

__all__ = [
    "CLINICAL_FIXTURE",
    "CLINICAL_SCHEMA",
    "CLINICAL_TEMPLATE_FIXTURE",
    "DEFAULT_FIXTURE",
    "FIXTURES_DIR",
    "ClinicalGoldenSetSource",
    "GoldenSetRunner",
    "GoldenSetSource",
    "InMemoryGoldenSetSource",
    "JSONFileGoldenSetSource",
    "clinical_golden_set_source",
    "default_golden_set_source",
    "project_clinical_case",
]
