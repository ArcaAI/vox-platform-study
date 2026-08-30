"""TASK-816 Phase 2 — `HarnessPolicy.safetyProvider` / `.safetyModel` have NO behavioural reader.

Phase 4 may only drop what is PROVEN to have no reader, so this is the proof rather than the
assertion. Both columns are persisted, threaded faithfully through entity → factory → mapper →
DTO → this pydantic model, and rendered in the admin console — and then read by nothing that
decides which guardrail backend or model is actually invoked.

The real safety screen is built from ``settings.guardrail_base_url`` alone
(``activities.py::_safety_screen_client``) and ``GuardrailClient.analyze`` POSTs only
``{text, guardrail_type, request_id}``. ``apps/guardrail`` resolves its own provider and model
tenant-first through its own SQL resolver — which is the correct home for it since TASK-735/736
removed the engine config from that service, and is precisely why these two columns have nothing
left to do. They are the ``AiTaskDefault.configJson`` of this model.

They are ALSO the clearest instance of the hardcoded-configuration rule
(``00-project-context.md`` §Configuration Principles rule 1) still standing in this schema: the
column defaults are the literal engine name ``lm-studio`` and the literal model id
``granite-guardian-4.1-8b``, mirrored again as pydantic defaults. Dropping them is a Phase 4
decision; pinning that nothing READS them is this phase's job, so the drop can be justified by
evidence and so a future edit cannot quietly give them a reader without turning this red.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_HARNESS_SRC = Path(__file__).resolve().parents[2]

#: A read of the POLICY object's field — `policy.safety_provider`, `self.safety_provider`,
#: `payload.safety_model`, … — as opposed to the declaration/mapping lines in `models.py`.
_POLICY_FIELD_READ = re.compile(r"\.(safety_provider|safety_model)\b")

#: The two files that legitimately mention the fields: the pydantic DECLARATION and the
#: `from_api` MAPPING both live in `temporal/models.py`; `guards/phi/egress.py` takes a
#: `safety_provider` PARAMETER whose only call site passes a hardcoded `None`, never the policy.
_DECLARATION_SITES = {"temporal/models.py"}


def _python_sources() -> list[Path]:
    return [
        p
        for p in _HARNESS_SRC.rglob("*.py")
        if "/tests/" not in p.as_posix() and p.name != "__init__.py"
    ]


def test_no_module_reads_the_safety_selection_off_the_policy() -> None:
    offenders: list[str] = []
    for path in _python_sources():
        rel = path.relative_to(_HARNESS_SRC).as_posix()
        if rel in _DECLARATION_SITES:
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), start=1):
            stripped = line.strip()
            if stripped.startswith("#") or not _POLICY_FIELD_READ.search(line):
                continue
            # `safety_provider=None` at the PHI-egress call site is a hardcoded argument, not a
            # policy read; it is the one occurrence outside the declaration file.
            if re.search(r"safety_provider\s*=\s*None", line):
                continue
            offenders.append(f"{rel}:{lineno}: {stripped}")

    assert offenders == [], (
        "HarnessPolicy.safetyProvider/safetyModel acquired a reader. They were proven dead in "
        "TASK-816 Phase 2 and are Phase 4 drop candidates on that basis — if this is a deliberate "
        "wiring, delete this test WITH the ticket that justifies it:\n  " + "\n  ".join(offenders)
    )


@pytest.mark.parametrize("field", ["safety_provider", "safety_model"])
def test_the_field_is_still_parsed_so_replay_and_the_admin_echo_keep_working(field: str) -> None:
    """The counterpart assertion: proving "no reader" must not be confused with "removed".

    Nothing is deleted in this phase. The column is still parsed onto the model, so recorded
    Temporal histories still decode and the admin console still round-trips what it displays.
    """
    from harness.temporal.models import HarnessPolicy

    assert field in HarnessPolicy.model_fields
