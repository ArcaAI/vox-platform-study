"""TASK-980 — the Sortformer diarization backend is RETIRED, not hidden.

Owner decision 2026-09-16 (Option C): the NeMo Streaming Sortformer backend loaded a
checkpoint literal no agent could choose, pin or veto, and the production image carries no
NeMo, so wherever it was selected it only ever degraded to "no labels". What this locks:

* the wire key ``audioFrontEnd.diarization.backend`` stays (both contract halves are
  ``extra='forbid'``), but ``embedding`` is its only legal value — a spec that still names
  the retired backend FAILS validation, it is never coerced to embedding;
* ``DiarizationConfig`` carries no checkpoint / revision / threshold / frame-shift knobs;
* the runtime module is gone and nothing under ``src/`` still names the backend.

The deprecated YAML refusal lives in ``test_diarization_config.py``; the crash-recovery
posture for a spec persisted before the retirement lives in
``tests/unit/streaming/test_task980_retired_backend_recovery.py``.
"""

from __future__ import annotations

import copy
import dataclasses
import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from stt.pipeline.dto import VALID_DIARIZATION_BACKENDS, DiarizationConfig
from stt.pipeline.spec import ResolvedAsrSpec

RETIRED = "sortformer"

# tests/unit/diarization/<this file> → apps/stt. The provenance guard in
# tests/conftest.py already pins `stt` to this tree; scanning relative to the test
# file keeps the source check on the same tree.
_SRC_ROOT = Path(__file__).resolve().parents[3] / "src"


def _platform_default_spec() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            fixture = json.loads(candidate.read_text(encoding="utf-8"))
            return copy.deepcopy(fixture["platformDefault"]["expected"])
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


def test_a_resolved_spec_naming_the_retired_backend_fails_validation() -> None:
    spec = _platform_default_spec()
    # Control: the committed fixture (backend = embedding) is legal as-is.
    ResolvedAsrSpec.model_validate(spec)

    spec["audioFrontEnd"]["diarization"]["backend"] = RETIRED
    with pytest.raises(ValidationError) as excinfo:
        ResolvedAsrSpec.model_validate(spec)
    assert "backend" in str(excinfo.value)


def test_embedding_is_the_only_diarization_backend() -> None:
    assert VALID_DIARIZATION_BACKENDS == ["embedding"]
    assert DiarizationConfig().backend == "embedding"


def test_diarization_config_carries_no_retired_knobs() -> None:
    field_names = {f.name for f in dataclasses.fields(DiarizationConfig)}
    assert {name for name in field_names if RETIRED in name} == set()
    config = DiarizationConfig()
    for name in (
        "sortformer_model_id",
        "sortformer_revision",
        "sortformer_threshold",
        "sortformer_frame_shift_s",
    ):
        assert not hasattr(config, name), name


def test_the_runtime_module_and_its_exports_are_gone() -> None:
    import stt.diarization as diarization

    assert importlib.util.find_spec("stt.diarization.streaming_sortformer") is None
    assert [name for name in diarization.__all__ if RETIRED in name.lower()] == []


def test_nothing_under_src_names_the_retired_backend() -> None:
    """The one exemption is a ``#`` comment recording the retirement itself."""
    assert _SRC_ROOT.is_dir(), _SRC_ROOT
    offenders: list[str] = []
    for path in sorted(_SRC_ROOT.rglob("*")):
        # Build output is not source: an editable install leaves a gitignored
        # `stt.egg-info/SOURCES.txt` that still lists deleted modules until the
        # next reinstall, which made this test depend on the checkout it ran in.
        if (
            not path.is_file()
            or "__pycache__" in path.parts
            or any(part.endswith(".egg-info") for part in path.parts)
        ):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if RETIRED not in line.lower():
                continue
            stripped = line.strip()
            if (
                stripped.startswith("#")
                and "TASK-980" in stripped
                and "retired" in stripped.lower()
            ):
                continue
            offenders.append(f"{path.relative_to(_SRC_ROOT)}:{lineno}: {stripped}")
    assert offenders == []
