"""Generate promptfoo test cases from the PINNED synthetic golden set.

Self-contained (stdlib only, no ``harness`` import) so the promptfoo lane needs
only Python + Node. Reads the packaged synthetic fixture by path; override with
``HARNESS_GOLDEN_SET_PATH`` to pin a different/real golden-set version.

.. note::
   The shipped fixture is SYNTHETIC. The real clinician-authored golden set
   (HLD §7.5 #1/#3) must replace it before this gate backs any clinical claim.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
# apps/harness/eval/promptfoo -> apps/harness == parents[1]
_DEFAULT_FIXTURE = (
    _HERE.parents[1] / "src" / "harness" / "eval" / "golden" / "fixtures" / "synthetic_v0.json"
)


def _fixture_path() -> Path:
    override = os.environ.get("HARNESS_GOLDEN_SET_PATH")
    return Path(override) if override else _DEFAULT_FIXTURE


def generate_tests(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
    """Yield one promptfoo test per golden case (vars + pinned version label)."""
    data = json.loads(_fixture_path().read_text(encoding="utf-8"))
    version = data.get("version", "unknown")
    tests: list[dict[str, Any]] = []
    for case in data["cases"]:
        source = "\n\n".join(case["source_documents"])
        tests.append(
            {
                "vars": {
                    "case_id": case["case_id"],
                    "specialty": case.get("target_specialty", "General Medicine"),
                    "source": source,
                    "note": case["generated_note"],
                    # The offline mock provider echoes these clinician scores so the
                    # contract gate is schema-valid without a live model.
                    "_mock_pdsqi": json.dumps(case.get("clinician_pdsqi", {})),
                },
                "description": f"{version} :: {case['case_id']}",
            }
        )
    return tests
