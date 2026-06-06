"""Golden-set abstraction: pluggable sources + a scoring runner."""

from __future__ import annotations

from harness.eval.golden.runner import GoldenSetRunner
from harness.eval.golden.sources import (
    DEFAULT_FIXTURE,
    FIXTURES_DIR,
    GoldenSetSource,
    InMemoryGoldenSetSource,
    JSONFileGoldenSetSource,
    default_golden_set_source,
)

__all__ = [
    "DEFAULT_FIXTURE",
    "FIXTURES_DIR",
    "GoldenSetRunner",
    "GoldenSetSource",
    "InMemoryGoldenSetSource",
    "JSONFileGoldenSetSource",
    "default_golden_set_source",
]
