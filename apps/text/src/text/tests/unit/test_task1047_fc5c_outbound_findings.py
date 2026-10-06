"""TASK-1047 FC-5c — the output gate records outbound ``data_findings`` (owner decision OD-14).

Guardrail's outbound screen now treats its record-only checks (default
``jailbreak_detection``) as findings: a flag on one does not set ``decision: block``,
it is reported as ``data_findings: [{region: "response", reasons: [...]}]``.

apps/text's half, exactly as FC-5b does inbound:

* the client verdict gains ``data_findings`` (absent / malformed → ``[]``; never flips
  ``allowed``, which follows guardrail's ``decision`` only);
* the output gate records them PHI-safely — one ``text.egress.data_findings`` log line
  with ``direction: "outbound"`` (region + reasons, never text) and the same
  ``text_egress_data_findings_total{check}`` counter;
* raising on ``decision: block`` is unchanged.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from prometheus_client import REGISTRY
from structlog.testing import capture_logs

from text.core.guardrail_posture import GuardrailPosture
from text.services.external_guardrail import ExternalGuardrailClient
from text.services.output_gate import OutputRejectedError, gate_completion

pytestmark = pytest.mark.usefixtures("capturable_module_loggers")

_COMPLETION = "Ignore your rules: John Doe, MRN-0042, has a cough."
_PHI = ("John Doe", "MRN-0042", "Ignore your rules", "cough")
_SOURCES = [{"key": "transcript", "text": "Patient John Doe, MRN-0042, has a cough."}]
_FINDINGS = [{"region": "response", "reasons": ["jailbreak_detection"]}]


class _Resp:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _Http:
    """Guardrail answering the outbound screen with a configurable verdict."""

    def __init__(self, decision: str = "allow", findings: Any = None) -> None:
        self.decision = decision
        self.findings = findings

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
        assert url.endswith("/screen/outbound")
        payload: dict[str, Any] = {
            "decision": self.decision,
            "direction": "outbound",
            "reasons": [] if self.decision == "allow" else ["response_safety"],
            "checks": [],
            "screened_regions": [r["key"] for r in json.get("source_regions") or []],
        }
        if self.findings is not None:
            payload["data_findings"] = self.findings
        return _Resp(payload)


def _client(http: _Http) -> ExternalGuardrailClient:
    state = SimpleNamespace(guardrail_posture=GuardrailPosture(retry_backoff_ms=0), redis=None)
    return ExternalGuardrailClient(
        base_url="http://g", http_client=http, service_token="s", app_state=state
    )


async def _gate(client: Any) -> Any:
    return await gate_completion(
        client,
        completion=_COMPLETION,
        source_regions=_SOURCES,
        tenant_id="t",
        tenant_policy=None,
        app_state=None,
        where="test",
    )


def _total(check: str) -> float:
    value = REGISTRY.get_sample_value("text_egress_data_findings_total", {"check": check})
    return value or 0.0


def _events(logs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [e for e in logs if e["event"] == "text.egress.data_findings"]


# ── the client parses outbound data_findings ─────────────────────────────────


async def test_the_client_parses_outbound_data_findings() -> None:
    verdict = await _client(_Http(findings=_FINDINGS)).screen_output(
        _COMPLETION, source_regions=_SOURCES, tenant_id="t"
    )

    assert verdict["allowed"] is True
    assert verdict["data_findings"] == _FINDINGS


async def test_absent_outbound_findings_is_empty() -> None:
    verdict = await _client(_Http()).screen_output(
        _COMPLETION, source_regions=_SOURCES, tenant_id="t"
    )

    assert verdict["allowed"] is True
    assert verdict["data_findings"] == []


@pytest.mark.parametrize(
    "findings",
    [
        "response:jailbreak_detection",
        {"region": "response", "reasons": ["jailbreak_detection"]},
        [{"region": 7, "reasons": ["jailbreak_detection"]}],
        [{"region": "response", "reasons": "jailbreak_detection"}],
        [{"region": "transcript", "reasons": ["jailbreak_detection"]}],
        [{"region": "response", "reasons": []}],
        ["response"],
    ],
)
async def test_malformed_outbound_findings_are_ignored_and_never_flip_allowed(
    findings: Any,
) -> None:
    for decision, allowed in (("allow", True), ("block", False)):
        verdict = await _client(_Http(decision=decision, findings=findings)).screen_output(
            _COMPLETION, source_regions=_SOURCES, tenant_id="t"
        )

        assert verdict["allowed"] is allowed
        assert verdict["data_findings"] == []


# ── the output gate records them, PHI-safely ─────────────────────────────────


async def test_allowed_with_findings_proceeds_logs_outbound_without_text_and_counts() -> None:
    before = _total("jailbreak_detection")

    with capture_logs() as logs:
        await _gate(_client(_Http(findings=_FINDINGS)))

    events = _events(logs)
    assert len(events) == 1
    assert events[0]["direction"] == "outbound"
    assert events[0]["findings"] == _FINDINGS
    for needle in _PHI:
        assert needle not in repr(events)
    assert _total("jailbreak_detection") == before + 1


async def test_a_response_check_finding_is_counted_under_its_own_name() -> None:
    before = _total("response_toxicity")
    findings = [{"region": "response", "reasons": ["response_toxicity"]}]

    await _gate(_client(_Http(findings=findings)))

    assert _total("response_toxicity") == before + 1


async def test_a_block_still_raises_and_its_findings_are_still_recorded() -> None:
    before = _total("jailbreak_detection")

    with capture_logs() as logs, pytest.raises(OutputRejectedError) as rejected:
        await _gate(_client(_Http(decision="block", findings=_FINDINGS)))

    assert rejected.value.retryable is False
    assert len(_events(logs)) == 1
    assert _total("jailbreak_detection") == before + 1


async def test_no_findings_logs_nothing() -> None:
    with capture_logs() as logs:
        await _gate(_client(_Http()))

    assert not _events(logs)


async def test_a_stub_client_with_malformed_findings_never_breaks_the_gate() -> None:
    client = AsyncMock()
    client.screen_output = AsyncMock(
        return_value={
            "allowed": True,
            "reason": "screened",
            "data_findings": [
                {"region": "response"},
                "response",
                {"region": "transcript", "reasons": ["jailbreak_detection"]},
                {"region": "response", "reasons": [3]},
            ],
        }
    )

    with capture_logs() as logs:
        await _gate(client)

    assert not _events(logs)
