"""TASK-1047 L4 — a regions verdict counts only if guardrail screened EVERY region sent.

Guardrail (L5) answers ``screened_regions: [keys]`` on ``/screen/inbound``,
``/screen/outbound`` and ``/api/medical/validate`` whenever it was called with
``regions`` / ``source_regions``. A guardrail that predates the regions API ignores
the unknown field and screens an empty ``text`` — an "allow" that inspected
nothing. So: field absent, or any key sent but not echoed ⇒ the verdict is
UNDETERMINED and fails closed exactly like an outage (same reason, same 503), logged
as ``text.egress.screen_coverage_missing`` with the missing COUNT only, and counted.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from prometheus_client import REGISTRY
from structlog.testing import capture_logs

from text.core.exceptions import GuardrailUnavailableError
from text.core.guardrail_posture import GuardrailPosture
from text.services.egress import run_inbound_gate
from text.services.external_guardrail import (
    GUARDRAIL_UNAVAILABLE_REASON,
    ExternalGuardrailClient,
)
from text.services.output_gate import OutputRejectedError, gate_completion

pytestmark = pytest.mark.usefixtures("capturable_module_loggers")

_REGIONS = [
    {"key": "transcript", "text": "Patient John Doe reports a cough."},
    {"key": "user", "text": "Summarise."},
]
_ABSENT = object()


class _Resp:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _Http:
    """Guardrail answering ``allow`` with a configurable ``screened_regions``."""

    def __init__(self, screened: Any = _ABSENT) -> None:
        self.screened = screened
        self.calls: list[dict[str, Any]] = []

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
        self.calls.append({"url": url, "json": json})
        if url.endswith("/screen/inbound"):
            payload: dict[str, Any] = {"decision": "allow", "reasons": [], "pii_spans": []}
        elif url.endswith("/screen/outbound"):
            payload = {"decision": "allow", "reasons": []}
        else:
            payload = {"is_medical": True, "confidence": 0.9}
        if self.screened is not _ABSENT:
            payload["screened_regions"] = self.screened
        return _Resp(payload)


def _client(http: _Http) -> ExternalGuardrailClient:
    state = SimpleNamespace(guardrail_posture=GuardrailPosture(retry_backoff_ms=0), redis=None)
    return ExternalGuardrailClient(
        base_url="http://g", http_client=http, service_token="s", app_state=state
    )


async def _all_three(http: _Http, regions: list[dict[str, str]]) -> list[dict[str, Any]]:
    client = _client(http)
    return [
        await client.screen_inbound(regions=regions, tenant_id="t"),
        await client.validate(regions=regions, tenant_id="t"),
        await client.screen_output("note", source_regions=regions, tenant_id="t"),
    ]


def _missing_total(call: str) -> float:
    value = REGISTRY.get_sample_value("text_egress_screen_coverage_missing_total", {"call": call})
    return value or 0.0


# ── the client ───────────────────────────────────────────────────────────────


async def test_an_absent_screened_regions_is_an_outage_on_every_call() -> None:
    before = {c: _missing_total(c) for c in ("inbound", "medical", "outbound")}

    with capture_logs() as logs:
        verdicts = await _all_three(_Http(), _REGIONS)

    for verdict in verdicts:
        assert verdict["allowed"] is False
        assert verdict["reason"] == GUARDRAIL_UNAVAILABLE_REASON
    coverage = [e for e in logs if e["event"] == "text.egress.screen_coverage_missing"]
    assert [(e["call"], e["missing"]) for e in coverage] == [
        ("inbound", 2),
        ("medical", 2),
        ("outbound", 2),
    ]
    assert "John Doe" not in repr(logs)
    for call in ("inbound", "medical", "outbound"):
        assert _missing_total(call) == before[call] + 1


async def test_one_missing_key_is_an_outage() -> None:
    with capture_logs() as logs:
        verdicts = await _all_three(_Http(screened=["transcript"]), _REGIONS)

    for verdict in verdicts:
        assert verdict["allowed"] is False
        assert verdict["reason"] == GUARDRAIL_UNAVAILABLE_REASON
    coverage = [e for e in logs if e["event"] == "text.egress.screen_coverage_missing"]
    assert {e["missing"] for e in coverage} == {1}


async def test_every_key_echoed_proceeds() -> None:
    verdicts = await _all_three(_Http(screened=["user", "transcript", "extra"]), _REGIONS)

    assert all(verdict["allowed"] is True for verdict in verdicts)


async def test_an_empty_regions_list_with_an_empty_echo_proceeds() -> None:
    verdicts = await _all_three(_Http(screened=[]), [])

    assert all(verdict["allowed"] is True for verdict in verdicts)


async def test_a_malformed_screened_regions_is_an_outage() -> None:
    verdicts = await _all_three(_Http(screened="transcript,user"), _REGIONS)

    assert all(verdict["reason"] == GUARDRAIL_UNAVAILABLE_REASON for verdict in verdicts)


async def test_legacy_calls_without_regions_are_not_coverage_checked() -> None:
    client = _client(_Http())

    assert (await client.validate("patient note", tenant_id="t"))["allowed"] is True
    assert (await client.screen_output("note", tenant_id="t"))["allowed"] is True


# ── the gates map it exactly like an outage ──────────────────────────────────


async def test_the_inbound_gate_fails_closed_as_unavailable() -> None:
    client = _client(_Http(screened=["transcript"]))

    with pytest.raises(GuardrailUnavailableError):
        await run_inbound_gate(
            client,
            segments=["Rules.", "Patient John Doe reports a cough."],
            prompt="Patient John Doe reports a cough.",
            system="untrusted",
            tenant_id="t",
        )


async def test_the_output_gate_fails_closed_as_retryable_unavailable() -> None:
    client = _client(_Http())

    with pytest.raises(OutputRejectedError) as rejected:
        await gate_completion(
            client,
            completion="note",
            source_regions=_REGIONS,
            tenant_id="t",
            tenant_policy=None,
            app_state=None,
            where="test",
            locality="local",
        )

    assert rejected.value.retryable is True
    assert rejected.value.status_code == 503
    assert rejected.value.code == "GUARDRAIL_UNAVAILABLE"
