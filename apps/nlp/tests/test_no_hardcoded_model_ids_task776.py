"""TASK-776 — model ids are CONFIG, never Python literals.

`apps/nlp` is the EXECUTOR of the safety plane. Every weight identity arrives
per request, resolved by the caller from `AiTaskDefault` ⋈ `AiModel`
(tenant → SYSTEM, fail-closed). A model id that appears in shipped Python — in
code OR in a docstring — is a config surface that no admin can change, and the
docstring form is the one that rots silently.

Tests may name ids freely: a test's whole job is to pin a contract with a
concrete value. This guard therefore covers `apps/nlp/src/**` only.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"

# The vendor/org prefixes of the SAFETY-PLANE roster this ticket governs:
# `fastino/*` (the three GLiNER2 models), `nvhf/*` (the MiniCheck GGUF) and
# `hivetrace/*` (the GLiNER detector guardrail used before TASK-735). Extend
# this tuple when a new vendor enters the roster — never the source.
#
# DELIBERATELY NOT COVERED: `blaze999/Medical-NER` and
# `shanover/symps_disease_bert_v3_c41`, which are `pydantic-settings` DEFAULTS
# on `TokenClassificationConfig` / `MedicalSuggesterConfig`
# (`nlp/core/config.py:298,301,351,353`). Those are real config-rule violations
# — a settings field with a live model default is a hardcoded value wearing a
# config costume — but they belong to the NER/diagnosis plane, not the safety
# plane, and removing them changes how the singleton NER model loads. Recorded
# in the TASK-776 README §2.2 as a pre-existing finding rather than silently
# widened into this ticket.
FORBIDDEN_MODEL_ID = re.compile(r"(?<![\w/-])(?:fastino|nvhf|hivetrace)/[A-Za-z0-9._-]+")


def _python_sources() -> list[Path]:
    return sorted(SRC.rglob("*.py"))


def test_the_guard_actually_sees_files() -> None:
    """A vacuous grep test passes forever — pin that it has a corpus."""
    assert len(_python_sources()) > 20


@pytest.mark.parametrize("path", _python_sources(), ids=lambda p: str(p))
def test_no_model_id_literal_in_shipped_python(path: Path) -> None:
    hits = FORBIDDEN_MODEL_ID.findall(path.read_text(encoding="utf-8"))
    assert not hits, (
        f"{path} names model id(s) {sorted(set(hits))} in shipped Python. "
        "Model identity is configuration (AiModel.sourceUri), resolved by the "
        "caller and sent per request — it is never a literal here, not even in "
        "a docstring."
    )
