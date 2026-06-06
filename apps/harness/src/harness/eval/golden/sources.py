"""Pluggable golden-set sources.

The golden set is read through a small :class:`GoldenSetSource` interface so the
source is swappable: today a synthetic JSON fixture ships with the package;
tomorrow a clinician-authored set (DB/S3/Git) can be dropped in by implementing
``load()`` — no runner changes required.

.. note::
   **OPEN PREREQUISITE (HLD §7.5 #1 / #3, implementation-plan §0).** The shipped
   fixture is *synthetic* and exists only to exercise the harness end-to-end and
   keep CI hermetic. The Phase-0 exit gate ("golden set ≥50 cases scored; judge
   ICC ≥0.8") requires the **REAL clinician-authored golden set** — transcript→note
   cases across specialties/tenants, owned + versioned by a clinical SME. That
   set is an outstanding prerequisite and MUST replace this fixture before any
   eval result is used to gate a clinical claim.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Protocol, runtime_checkable

from harness.eval.models import GoldenSet

FIXTURES_DIR = Path(__file__).parent / "fixtures"
DEFAULT_FIXTURE = FIXTURES_DIR / "synthetic_v0.json"


@runtime_checkable
class GoldenSetSource(Protocol):
    """Anything that can produce a :class:`GoldenSet`."""

    def load(self) -> GoldenSet: ...


class InMemoryGoldenSetSource:
    """Wraps an already-constructed golden set (tests / programmatic use)."""

    def __init__(self, golden_set: GoldenSet) -> None:
        self._golden_set = golden_set

    def load(self) -> GoldenSet:
        return self._golden_set


class JSONFileGoldenSetSource:
    """Loads a golden set from a JSON file on disk."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> GoldenSet:
        if not self._path.is_file():
            raise FileNotFoundError(f"golden set file not found: {self._path}")
        data = json.loads(self._path.read_text(encoding="utf-8"))
        return GoldenSet.model_validate(data)


def default_golden_set_source() -> JSONFileGoldenSetSource:
    """The packaged synthetic golden set (see the module note / TODO)."""
    return JSONFileGoldenSetSource(DEFAULT_FIXTURE)
