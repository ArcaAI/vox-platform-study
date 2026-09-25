"""TASK-1006 — a ``ResolvedAsrSpec`` wire dict for tests.

The gateway-resolved spec is the ONLY selector apps/stt accepts, so any test that opens
a streaming session or runs a batch job needs one. ``resolved_spec()`` returns a fresh
copy of the committed contract fixture's platform default
(``tests/contracts/resolved-asr-spec.fixture.json``), optionally with its runtime keys
renamed to whatever the test asserts on:

* ``primary`` — the primary chain's ``runtimeKey`` (the session's key);
* ``fallback`` — the fallback chain's ``runtimeKey``; ``None`` strips the fallback
  entirely (``kind: "none"``), the default keeps the fixture's.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

_KEEP: Any = object()


def _platform_default() -> dict[str, Any]:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            data = json.loads(candidate.read_text(encoding="utf-8"))
            return dict(data["platformDefault"]["expected"])
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


_PLATFORM_DEFAULT = _platform_default()

#: The fixture's own keys, for tests that do not rename them.
PRIMARY_KEY: str = _PLATFORM_DEFAULT["runtimeKey"]
FALLBACK_KEY: str = _PLATFORM_DEFAULT["fallback"]["chain"][0]["runtimeKey"]


def resolved_spec(primary: str | None = None, fallback: Any = _KEEP) -> dict[str, Any]:
    """A fresh ``ResolvedAsrSpec`` wire dict (see the module docstring)."""
    spec = copy.deepcopy(_PLATFORM_DEFAULT)
    if primary is not None:
        spec["runtimeKey"] = primary
    chain = spec["fallback"]
    if fallback is None:
        spec["fallback"] = {
            "kind": "none",
            "autoSwitch": chain["autoSwitch"],
            "switchAfterConsecutiveFailures": chain["switchAfterConsecutiveFailures"],
            "chain": [],
            "spec": None,
        }
    elif fallback is not _KEEP:
        chain["chain"][0]["runtimeKey"] = fallback
        chain["spec"]["runtimeKey"] = fallback
    return spec
