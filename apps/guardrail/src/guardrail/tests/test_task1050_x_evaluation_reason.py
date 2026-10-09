"""TASK-1050 follow-up H (owner, 2026-10-08) — a skipped check is explainable from the record.

Evaluation records dropped a check's `reason`, so "skipped" could not be explained from the DB
or the console. A check entry now carries an optional `reason` (additive contract change,
`GuardrailEvaluationCheck.reason?`) when it was `skipped`, `undetermined`, or recorded as a
finding (a flag taken at `ignore`). A check that passed, warned or blocked carries none.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from guardrail.core.availability import GuardrailAvailability
from guardrail.core.errors import REASON_ENGINE_ERROR, GuardrailUndeterminedError
from guardrail.services.evaluation_outbox import build_evaluation_record
from guardrail.services.notices import GuardrailCorrelation
from guardrail.services.screening import Screener

_REPO = Path(__file__).parents[5]
FIXTURE = json.loads(
    (_REPO / "tests" / "contracts" / "guardrail-evaluation.fixture.json").read_text()
)
TENANT = "50000000-0000-0000-0000-000000000000"


class _Analyzer:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail

    async def classify_tasks(self, task_names: Any, text: str) -> dict[str, Any]:
        if self.fail:
            raise GuardrailUndeterminedError(REASON_ENGINE_ERROR, "down")
        return dict.fromkeys(task_names, "unsafe" if "BAD" in text else "benign")

    async def extract_pii_entities(self, text: str) -> list[Any]:
        return []

    def model_for(self, check: str) -> str:
        return "gliguard"


def _record(decision: Any) -> dict[str, dict[str, Any]]:
    record = build_evaluation_record(
        decision,
        tenant_id=TENANT,
        correlation=GuardrailCorrelation(request_id="req-1"),
        caller="text.generate",
        notices=[],
        occurred_at="t",
    )
    return {check["checkId"]: check for check in record["checks"]}


@pytest.mark.asyncio
async def test_skipped_checks_name_their_reason() -> None:
    screener = Screener(
        analyzer=_Analyzer(),
        tenant_id=TENANT,
        availability=GuardrailAvailability.from_tiers(
            system_blob={"checks": {"prompt_toxicity": {"enabled": False}}}, tenant_blob=None
        ),
    )
    checks = _record(await screener.screen_inbound("hello"))
    assert checks["prompt_toxicity"]["verdict"] == "skipped"
    assert checks["prompt_toxicity"]["reason"] == "not_selected_for_tenant"
    # A check the screen never produced (an inbound judge that is off) is synthesised skipped.
    assert checks["injection_judge"]["reason"] == "not_selected_for_tenant"
    # A pass carries no reason.
    assert "reason" not in checks["prompt_safety"]


@pytest.mark.asyncio
async def test_outbound_skips_name_theirs() -> None:
    checks = _record(
        await Screener(analyzer=_Analyzer(), tenant_id=TENANT).screen_outbound("a note")
    )
    assert checks["pii_leak"]["reason"] == "no_source_context"
    assert checks["containment_echo"]["reason"] == "no_nonce"


@pytest.mark.asyncio
async def test_an_undetermined_check_names_the_outage() -> None:
    checks = _record(
        await Screener(analyzer=_Analyzer(fail=True), tenant_id=TENANT).screen_inbound("x")
    )
    assert checks["prompt_safety"]["verdict"] == "undetermined"
    assert checks["prompt_safety"]["reason"] == REASON_ENGINE_ERROR


@pytest.mark.asyncio
async def test_a_flag_taken_at_ignore_is_recorded_as_a_finding() -> None:
    screener = Screener(analyzer=_Analyzer(), tenant_id=TENANT)
    decision = await screener.screen_inbound_regions(
        [("system", "rules", "instruction"), ("transcript", "BAD words", "data")]
    )
    checks = _record(decision)
    assert (checks["prompt_safety"]["verdict"], checks["prompt_safety"]["actionTaken"]) == (
        "flag",
        "ignore",
    )
    assert checks["prompt_safety"]["reason"] == "recorded_as_finding"


@pytest.mark.asyncio
async def test_a_block_carries_no_reason() -> None:
    # TASK-1053: prompt_safety warns by platform default; pin an explicit stored block.
    screener = Screener(
        analyzer=_Analyzer(),
        tenant_id=TENANT,
        availability=GuardrailAvailability.from_tiers(
            system_blob={"checks": {"prompt_safety": {"enabled": True, "action": "block"}}},
            tenant_blob=None,
        ),
    )
    checks = _record(await screener.screen_inbound("BAD"))
    assert checks["prompt_safety"]["actionTaken"] == "block"
    assert "reason" not in checks["prompt_safety"]


def test_the_fixture_explains_its_skipped_and_undetermined_checks() -> None:
    for record in FIXTURE["batch"]["evaluations"]:
        for check in record["checks"]:
            explained = check["verdict"] in ("skipped", "undetermined") or (
                check["verdict"] == "flag" and check["actionTaken"] == "ignore"
            )
            assert ("reason" in check) == explained, check
            if explained:
                assert isinstance(check["reason"], str) and check["reason"]
