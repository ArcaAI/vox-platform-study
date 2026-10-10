"""TASK-1059 lane D — the output gate tells guardrail WHERE the response was generated (C-2).

Guardrail takes a LOCAL provider's ``pii_leak``-only block at ``warn`` (owner OD-3), so the
gate must put the provider locality it already decides with on the outbound screen's wire —
through the real :class:`ExternalGuardrailClient`, not a mock of it. A local ``warn`` is
released with guardrail's ``guardrail.warning`` notice; text keeps its own detect-only
reading of a local ``pii_leak`` block from a guardrail that predates C-2.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from text.core.guardrail_posture import GuardrailPosture
from text.core.locality import CLOUD, LOCAL
from text.services import guardrail_notices as gn
from text.services.external_guardrail import ExternalGuardrailClient
from text.services.output_gate import OutputRejectedError, gate_completion

_REGIONS = [{"key": "encounter_1", "text": "Patient reports a cough."}]


class _Resp:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _Http:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.bodies: list[dict[str, Any]] = []

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
        assert url.endswith("/api/v1/guardrail/screen/outbound"), url
        self.bodies.append(json)
        return _Resp(self.payload)


def _client(http: _Http) -> ExternalGuardrailClient:
    state = SimpleNamespace(guardrail_posture=GuardrailPosture(retry_backoff_ms=0), redis=None)
    return ExternalGuardrailClient(
        base_url="http://g", http_client=http, service_token="s", app_state=state
    )


@pytest.fixture(autouse=True)
def _no_correlation():
    token = gn.bind_guardrail_correlation({})
    yield
    gn.reset_guardrail_correlation(token)


async def _gate(http: _Http, *, locality: str, outcome: gn.GuardrailOutcome | None = None):
    return await gate_completion(
        _client(http),
        completion="Seen today [encounter_1].",
        source_regions=_REGIONS,
        tenant_id="t",
        tenant_policy=None,
        app_state=None,
        where="test",
        locality=locality,
        outcome=outcome,
    )


def _verdict(decision: str, reasons: list[str], notices: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "decision": "block" if decision == "block" else "allow",
        "guardrail_decision": decision,
        "reasons": reasons,
        "notices": notices,
        "screened_regions": ["encounter_1"],
        "evaluation_id": "ev-1",
    }


@pytest.mark.parametrize("locality", [LOCAL, CLOUD])
async def test_the_gate_puts_the_provider_locality_on_the_outbound_wire(locality: str) -> None:
    http = _Http(_verdict("allow", [], []))

    await _gate(http, locality=locality)

    (body,) = http.bodies
    assert body["locality"] == locality


async def test_a_local_pii_leak_warning_is_released_with_its_notice() -> None:
    warning = {
        **gn.unverified_notice("outbound", ["pii_leak"]),
        "type": "guardrail.warning",
        "action": "warn",
        "messageKey": "guardrail.warning.generic",
        "defaultMessage": gn.DEFAULT_MESSAGES["guardrail.warning.generic"],
    }
    outcome = gn.GuardrailOutcome()
    http = _Http(_verdict("warn", [], [warning]))

    await _gate(http, locality=LOCAL, outcome=outcome)

    assert [notice["type"] for notice in outcome.notices] == ["guardrail.warning"]
    assert outcome.evaluation_ids == ["ev-1"]


async def test_a_local_pii_leak_block_from_an_older_guardrail_stays_detect_only() -> None:
    http = _Http(_verdict("block", ["pii_leak"], []))

    assert await _gate(http, locality=LOCAL) is None


async def test_a_cloud_pii_leak_block_still_rejects() -> None:
    http = _Http(_verdict("block", ["pii_leak"], []))

    with pytest.raises(OutputRejectedError) as raised:
        await _gate(http, locality=CLOUD)
    assert raised.value.pii_leak is True
