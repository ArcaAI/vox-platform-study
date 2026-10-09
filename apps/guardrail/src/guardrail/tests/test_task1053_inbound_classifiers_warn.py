"""TASK-1053 — the inbound safety/toxicity classifiers warn by platform default.

Owner 2026-10-09: prompt_safety / prompt_toxicity false-flag clinical notes, so under the
catalogue default an instruction-region hit warns (with a notice) instead of blocking.
An explicitly stored `block` is admin-owned and still blocks; data regions stay record-only.
"""

from __future__ import annotations

from typing import Any

import pytest

from guardrail.core.availability import (
    CATALOGUE_DEFAULTS,
    PLATFORM_DEFAULT_AVAILABILITY,
    GuardrailAvailability,
)
from guardrail.services.screening import Screener
from guardrail.tests.test_task1050_screen_decisions import _Analyzer

TENANT = "tenant-a"
CHECKS = ("prompt_safety", "prompt_toxicity")


def _screener(analyzer: Any, availability: GuardrailAvailability | None = None) -> Screener:
    return Screener(
        analyzer=analyzer, tenant_id=TENANT, availability=availability, policy_version="pv-1"
    )


def _by_name(decision: Any) -> dict[str, Any]:
    return {check.name: check for check in decision.checks}


@pytest.mark.parametrize("check", CHECKS)
def test_catalogue_default_is_warn(check: str) -> None:
    assert CATALOGUE_DEFAULTS[check].action == "warn"
    assert PLATFORM_DEFAULT_AVAILABILITY.action_for(check, "inbound") == "warn"
    assert PLATFORM_DEFAULT_AVAILABILITY.action_for(check, "inbound", trust="data") == "ignore"


@pytest.mark.asyncio
@pytest.mark.parametrize("check", CHECKS)
async def test_instruction_flag_under_the_default_warns_with_a_notice(check: str) -> None:
    decision = await _screener(_Analyzer(triggers={check: "BAD"})).screen_inbound_regions(
        [("system", "BAD rules", "instruction")]
    )
    result = _by_name(decision)[check]
    assert (result.verdict, result.action_taken) == ("flag", "warn")
    assert decision.guardrail_decision == "warn"
    assert decision.decision == "allow"
    assert result.flagged_regions == ("system",)  # the notice target


@pytest.mark.asyncio
@pytest.mark.parametrize("check", CHECKS)
async def test_an_explicitly_stored_block_still_blocks(check: str) -> None:
    availability = GuardrailAvailability.from_tiers(
        system_blob={"checks": {check: {"enabled": True, "action": "block"}}},
        tenant_blob=None,
        source_tenant_id=TENANT,
    )
    decision = await _screener(
        _Analyzer(triggers={check: "BAD"}), availability
    ).screen_inbound_regions([("system", "BAD rules", "instruction")])
    assert _by_name(decision)[check].action_taken == "block"
    assert decision.guardrail_decision == "block"


@pytest.mark.asyncio
@pytest.mark.parametrize("check", CHECKS)
async def test_data_region_flags_stay_record_only(check: str) -> None:
    decision = await _screener(_Analyzer(triggers={check: "BAD"})).screen_inbound_regions(
        [("transcript", "BAD words", "data")]
    )
    result = _by_name(decision)[check]
    assert (result.verdict, result.action_taken) == ("flag", "ignore")
    assert decision.guardrail_decision == "allow"
