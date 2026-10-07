"""TASK-1050 W2c — what TEXT sends guardrail, and what it reads back.

* correlation: ``X-Request-Id`` and every ``X-Hope-*`` header the caller sent ride on
  the screen and validate calls (guardrail stamps them on the evaluation record);
* ``locality``: the provider actually called, on all three calls;
* ``include_pii_spans``: only when the caller asks (cloud) — never on LOCAL (F8);
* region ``items``: passed through when the caller supplied them;
* the new ScreenResponse (W2a2): ``decision`` may be ``warn`` / ``unverified`` (not a
  block), ``notices`` and ``evaluation_id`` are lifted onto the verdict.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
import structlog

from text.core.guardrail_posture import GuardrailPosture
from text.services import guardrail_notices as gn
from text.services.external_guardrail import ExternalGuardrailClient

_REGIONS = [
    {
        "key": "transcript",
        "text": "Patient reports a cough.",
        "trust": "data",
        "items": [{"itemId": "item-1", "itemVersion": 3}],
    }
]
_SCREENED = ["transcript"]


class _Resp:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _Http:
    def __init__(self, payloads: dict[str, dict[str, Any]]) -> None:
        self.payloads = payloads
        self.calls: list[dict[str, Any]] = []

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
        self.calls.append({"url": url, "json": json, "headers": dict(headers or {})})
        for suffix, payload in self.payloads.items():
            if url.endswith(suffix):
                return _Resp(payload)
        raise AssertionError(url)


def _client(http: _Http) -> ExternalGuardrailClient:
    state = SimpleNamespace(guardrail_posture=GuardrailPosture(retry_backoff_ms=0), redis=None)
    return ExternalGuardrailClient(
        base_url="http://g", http_client=http, service_token="s", app_state=state
    )


@pytest.fixture(autouse=True)
def _correlation():
    token = gn.bind_guardrail_correlation(
        {"X-Hope-Consultation-Id": "c-1", "X-Hope-Run-Id": "r-1", "X-Hope-Node-Id": "n-1"}
    )
    structlog.contextvars.bind_contextvars(requestId="req-1")
    yield
    structlog.contextvars.unbind_contextvars("requestId")
    gn.reset_guardrail_correlation(token)


def _notice(direction: str = "inbound") -> dict[str, Any]:
    return gn.unverified_notice(direction, ["prompt_safety"])


async def test_every_call_forwards_the_request_id_and_the_correlation_headers() -> None:
    http = _Http(
        {
            "/screen/inbound": {
                "decision": "allow",
                "pii_spans": [],
                "screened_regions": _SCREENED,
            },
            "/medical/validate": {"is_medical": True, "screened_regions": _SCREENED},
            "/screen/outbound": {"decision": "allow", "screened_regions": _SCREENED},
        }
    )
    client = _client(http)

    await client.screen_inbound(regions=_REGIONS, tenant_id="t")
    await client.validate(regions=_REGIONS, tenant_id="t")
    await client.screen_output("note", source_regions=_REGIONS, tenant_id="t")

    for call in http.calls:
        headers = call["headers"]
        assert headers["X-Request-Id"] == "req-1"
        assert headers["X-Tenant-Id"] == "t"
        assert headers["X-Hope-Consultation-Id"] == "c-1"
        assert headers["X-Hope-Run-Id"] == "r-1"
        assert headers["X-Hope-Node-Id"] == "n-1"
        assert "X-Hope-Item-Id" not in headers


async def test_locality_spans_flag_and_region_items_are_on_the_wire() -> None:
    http = _Http(
        {
            "/screen/inbound": {
                "decision": "allow",
                "pii_spans": [],
                "screened_regions": _SCREENED,
            },
            "/medical/validate": {"is_medical": True, "screened_regions": _SCREENED},
            "/screen/outbound": {"decision": "allow", "screened_regions": _SCREENED},
        }
    )
    client = _client(http)

    await client.screen_inbound(
        regions=_REGIONS, tenant_id="t", include_pii_spans=False, locality="local"
    )
    await client.validate(regions=_REGIONS, tenant_id="t", locality="local")
    await client.screen_output("note", source_regions=_REGIONS, tenant_id="t", locality="local")

    inbound, medical, outbound = (call["json"] for call in http.calls)
    assert inbound["include_pii_spans"] is False
    assert inbound["locality"] == medical["locality"] == outbound["locality"] == "local"
    assert inbound["regions"][0]["items"] == [{"itemId": "item-1", "itemVersion": 3}]
    assert medical["regions"][0]["items"] == [{"itemId": "item-1", "itemVersion": 3}]
    assert outbound["source_regions"][0]["items"] == [{"itemId": "item-1", "itemVersion": 3}]


async def test_spans_are_requested_by_default_and_locality_absent_when_unknown() -> None:
    http = _Http(
        {"/screen/inbound": {"decision": "allow", "pii_spans": [], "screened_regions": _SCREENED}}
    )

    await _client(http).screen_inbound(regions=_REGIONS, tenant_id="t")

    body = http.calls[0]["json"]
    assert body["include_pii_spans"] is True
    assert "locality" not in body


@pytest.mark.parametrize("decision", ["warn", "unverified"])
async def test_warn_and_unverified_decisions_are_allowed_and_carry_notices(decision: str) -> None:
    notice = _notice()
    http = _Http(
        {
            "/screen/inbound": {
                "decision": decision,
                "pii_spans": [],
                "screened_regions": _SCREENED,
                "notices": [notice, {"bad": True}],
                "evaluation_id": "ev-in",
            },
            "/screen/outbound": {
                "decision": decision,
                "screened_regions": _SCREENED,
                "notices": [_notice("outbound")],
                "evaluation_id": "ev-out",
            },
        }
    )
    client = _client(http)

    inbound = await client.screen_inbound(regions=_REGIONS, tenant_id="t")
    outbound = await client.screen_output("note", source_regions=_REGIONS, tenant_id="t")

    assert inbound["allowed"] is True and inbound["decision"] == decision
    assert inbound["notices"] == [notice]
    assert inbound["evaluation_id"] == "ev-in"
    assert outbound["allowed"] is True and outbound["decision"] == decision
    assert outbound["evaluation_id"] == "ev-out"


async def test_a_block_decision_is_not_allowed_and_keeps_its_notice_and_id() -> None:
    blocked = gn.blocked_notice(
        "inbound", "guardrail.blocked.inbound", [{"checkId": "prompt_safety", "severity": "high"}]
    )
    http = _Http(
        {
            "/screen/inbound": {
                "decision": "block",
                "reasons": ["prompt_safety"],
                "pii_spans": [],
                "screened_regions": _SCREENED,
                "notices": [blocked],
                "evaluation_id": "ev-1",
            }
        }
    )

    verdict = await _client(http).screen_inbound(regions=_REGIONS, tenant_id="t")

    assert verdict["allowed"] is False
    assert verdict["decision"] == "block"
    assert verdict["notices"] == [blocked]
    assert verdict["evaluation_id"] == "ev-1"


async def test_the_medical_verdict_reads_a_decision_when_guardrail_sends_one() -> None:
    http = _Http(
        {
            "/medical/validate": {
                "is_medical": False,
                "decision": "unverified",
                "screened_regions": _SCREENED,
                "notices": [_notice()],
                "evaluation_id": "ev-med",
            }
        }
    )

    verdict = await _client(http).validate(regions=_REGIONS, tenant_id="t")

    assert verdict["allowed"] is True
    assert verdict["decision"] == "unverified"
    assert verdict["evaluation_id"] == "ev-med"
    assert len(verdict["notices"]) == 1


# ── round 2: guardrail's actual W2a2 wire ────────────────────────────────────


@pytest.mark.parametrize(
    ("binary", "four_way", "expected", "allowed"),
    [
        ("allow", "warn", "warn", True),
        ("allow", "unverified", "unverified", True),
        ("block", "block", "block", False),
        ("allow", None, "allow", True),  # an older guardrail: binary only
        ("block", None, "block", False),
        ("allow", "nonsense", "allow", True),  # unreadable four-way: the binary stands
    ],
)
async def test_the_four_way_guardrail_decision_wins_over_the_binary_decision(
    binary: str, four_way: str | None, expected: str, allowed: bool
) -> None:
    payload: dict[str, Any] = {"decision": binary, "pii_spans": [], "screened_regions": _SCREENED}
    if four_way is not None:
        payload["guardrail_decision"] = four_way
    http = _Http(
        {
            "/screen/inbound": payload,
            "/screen/outbound": {k: v for k, v in payload.items() if k != "pii_spans"},
            "/medical/validate": {**payload, "is_medical": binary == "allow"},
        }
    )
    client = _client(http)

    for verdict in (
        await client.screen_inbound(regions=_REGIONS, tenant_id="t"),
        await client.screen_output("note", source_regions=_REGIONS, tenant_id="t"),
        await client.validate(regions=_REGIONS, tenant_id="t"),
    ):
        assert verdict["decision"] == expected
        assert verdict["allowed"] is allowed


async def test_inbound_sends_caller_agent_exemption_and_the_injected_connection() -> None:
    http = _Http(
        {"/screen/inbound": {"decision": "allow", "pii_spans": [], "screened_regions": _SCREENED}}
    )
    overrides = {"openai": {"api_key": "k", "base_url": "https://x"}}

    await _client(http).screen_inbound(
        regions=_REGIONS,
        tenant_id="t",
        caller="text.generate",
        agent_slug="soap-writer",
        exempt="medical_internal",
        provider_overrides=overrides,
    )

    body = http.calls[0]["json"]
    assert body["caller"] == "text.generate"
    assert body["agent_slug"] == "soap-writer"
    assert body["exempt"] == "medical_internal"
    assert body["provider_overrides"] == overrides


async def test_outbound_sends_response_items_caller_agent_prompt_and_the_connection() -> None:
    http = _Http({"/screen/outbound": {"decision": "allow", "screened_regions": _SCREENED}})
    overrides = {"openai": {"api_key": "k"}}

    await _client(http).screen_output(
        "note",
        source_regions=_REGIONS,
        tenant_id="t",
        caller="text.generate",
        agent_slug="soap-writer",
        response_items=[{"itemId": "note-1", "itemVersion": 1}],
        prompt_context="Write the note.",
        provider_overrides=overrides,
    )

    body = http.calls[0]["json"]
    assert body["caller"] == "text.generate"
    assert body["agent_slug"] == "soap-writer"
    assert body["response_items"] == [{"itemId": "note-1", "itemVersion": 1}]
    assert body["prompt_context"] == "Write the note."
    assert body["provider_overrides"] == overrides


async def test_the_new_request_fields_are_absent_when_unknown() -> None:
    http = _Http(
        {
            "/screen/inbound": {
                "decision": "allow",
                "pii_spans": [],
                "screened_regions": _SCREENED,
            },
            "/screen/outbound": {"decision": "allow", "screened_regions": _SCREENED},
        }
    )
    client = _client(http)

    await client.screen_inbound(regions=_REGIONS, tenant_id="t")
    await client.screen_output("note", source_regions=_REGIONS, tenant_id="t")

    inbound, outbound = (call["json"] for call in http.calls)
    for key in ("caller", "agent_slug", "exempt", "provider_overrides"):
        assert key not in inbound
    for key in ("caller", "agent_slug", "response_items", "prompt_context", "provider_overrides"):
        assert key not in outbound


async def test_the_override_header_received_is_forwarded() -> None:
    token = gn.bind_guardrail_correlation({"x-hope-guardrail-override": "notice-9"})
    try:
        http = _Http(
            {
                "/screen/inbound": {
                    "decision": "allow",
                    "pii_spans": [],
                    "screened_regions": _SCREENED,
                }
            }
        )
        await _client(http).screen_inbound(regions=_REGIONS, tenant_id="t")
    finally:
        gn.reset_guardrail_correlation(token)

    assert http.calls[0]["headers"][gn.GUARDRAIL_OVERRIDE_HEADER] == "notice-9"
