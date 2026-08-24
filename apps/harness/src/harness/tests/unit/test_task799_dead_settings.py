"""TASK-799 A.2 — declared-but-never-read settings fields are deleted, and stay deleted.

Plan §3.2/§3.3: *"~95 dead fields exist because nothing catches them; every one would
have been caught by a static check."* A knob that is advertised in `.env.sample`, declared
in `turbo.json`, and read by NOTHING is worse than no knob at all — an operator sets it,
observes no effect, and cannot tell a dead field from a bug.

Each field below was verified to have ZERO readers across `apps/harness` (src AND tests)
before removal. The interesting cases, recorded so the next reader does not "restore" them:

* `activity_start_to_close_s` / `activity_max_attempts` / `generate_max_attempts` — the
  workflow uses MODULE-LEVEL constants (`_INFERENTIAL_TIMEOUT`, `_INFERENTIAL_RETRY`,
  `_GENERATE_RETRY` in `temporal/workflows.py`), and it must: a workflow body may not
  read env, because that is exactly the non-determinism rule 06 forbids. These knobs
  could therefore never take effect. Deleting them is the honest fix; wiring them would
  break replay.
* `llm_request_timeout_s` — a DUPLICATE declaration. The live reader is
  `core/llm_concurrency.py:95`, which reads `HARNESS_LLM_REQUEST_TIMEOUT_S` from the
  environment directly. The env var stays; only the second, unread declaration goes.
* `atomic_fact_model_file` — self-documented as "provenance only". Its sibling
  `atomic_fact_model_id` IS read (`temporal/activities.py`), so only the file name goes.
* `httpx_max_connections` / `httpx_max_keepalive` — commented "used by the loop's httpx
  tool clients", but no `httpx.Limits` is constructed anywhere in the service.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from pydantic_settings import BaseSettings

from harness.core.config import Settings
from harness.eval.config import EvalConfig

_HARNESS_SRC = Path(__file__).resolve().parents[3]

DELETED_FIELDS = [
    (Settings, "activity_start_to_close_s"),
    (Settings, "activity_max_attempts"),
    (Settings, "generate_max_attempts"),
    (Settings, "atomic_fact_model_file"),
    (Settings, "httpx_max_connections"),
    (Settings, "httpx_max_keepalive"),
    (Settings, "llm_request_timeout_s"),
    (EvalConfig, "golden_set_path"),
]


@pytest.mark.parametrize(
    ("model", "field"), DELETED_FIELDS, ids=lambda v: getattr(v, "__name__", v)
)
def test_field_is_gone(model: type[BaseSettings], field: str) -> None:
    assert field not in model.model_fields


@pytest.mark.parametrize(
    ("model", "field"), DELETED_FIELDS, ids=lambda v: getattr(v, "__name__", v)
)
def test_field_has_no_reader_left_behind(model: type[BaseSettings], field: str) -> None:
    """The static check the plan asks for, applied to the fields it already caught.

    A reader is any non-comment mention outside the settings declaration modules. If one
    appears, the field was NOT dead and the deletion is a bug — that is the failure this
    test exists to produce, loudly, instead of at runtime.
    """
    word = re.compile(rf"\b{re.escape(field)}\b")
    offenders = [
        f"{path}:{i}"
        for path in _HARNESS_SRC.rglob("*.py")
        for i, line in enumerate(path.read_text().splitlines(), 1)
        if word.search(line)
        and not line.lstrip().startswith("#")
        and path.name != Path(__file__).name
    ]
    assert offenders == []
