"""TASK-1035 — the guardrail client after the opt-out and the kill switch were removed.

* No platform switch and no tenant opt-out: `validate` always calls guardrail.
* `screen_inbound` asks for PII spans and returns them.
* The medical-judge verdict is NOT cached here any more (TASK-1047): guardrail
  judges per window and caches each window's verdict under a tenant-keyed HMAC with
  the policy version (FC-7). The whole-text cache this file used to pin missed on
  every live flush (the transcript grows) and keyed Redis on a bare sha256 of PHI.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import fakeredis.aioredis as fakeasync

from text.core.guardrail_posture import GuardrailPosture
from text.models.requests import GuardrailPolicyOverride
from text.services.external_guardrail import ExternalGuardrailClient


class _Resp:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _Http:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
        self.calls.append({"url": url, "json": json, "headers": headers})
        if url.endswith("/screen/inbound"):
            return _Resp(
                {
                    "decision": "allow",
                    "reasons": [],
                    "pii_spans": [
                        {"label": "person", "start": 0, "end": 4, "text": "John", "score": 0.9}
                    ],
                }
            )
        return _Resp({"is_medical": True, "confidence": 0.9, "reasoning": "clinical"})


def _client(http: _Http, *, redis: Any = None) -> ExternalGuardrailClient:
    state = SimpleNamespace(guardrail_posture=GuardrailPosture(retry_backoff_ms=0), redis=redis)
    return ExternalGuardrailClient(
        base_url="http://guardrail", http_client=http, service_token="t", app_state=state
    )


def test_the_posture_has_no_switch_and_no_medical_toggle() -> None:
    fields = set(GuardrailPosture.__dataclass_fields__)
    assert "enabled" not in fields
    assert "opted_out" not in fields
    assert "require_medical" not in fields
    assert set(GuardrailPolicyOverride.model_fields) == {"include_reasoning"}


async def test_validate_always_calls_guardrail_whatever_the_request_says() -> None:
    http = _Http()
    client = _client(http)

    verdict = await client.validate(
        "chest pain",
        tenant_id="t1",
        tenant_policy=GuardrailPolicyOverride.model_validate(
            {"enabled": False, "require_medical": False}
        ),
    )

    assert verdict["allowed"] is True
    assert [c["url"] for c in http.calls] == ["http://guardrail/api/medical/validate"]


async def test_screen_inbound_requests_and_returns_pii_spans() -> None:
    http = _Http()
    regions = [{"key": "transcript", "text": "John has a cough"}]
    verdict = await _client(http).screen_inbound(regions=regions, tenant_id="t1")

    call = http.calls[0]
    assert call["url"] == "http://guardrail/api/v1/guardrail/screen/inbound"
    assert call["json"]["include_pii_spans"] is True
    assert call["json"]["regions"] == regions and call["json"]["text"] == ""
    assert call["headers"]["X-Tenant-Id"] == "t1"
    assert verdict["allowed"] is True
    assert verdict["pii_spans"][0]["label"] == "person"


async def test_every_judgement_goes_to_guardrail_and_redis_holds_no_verdict() -> None:
    redis = fakeasync.FakeRedis(decode_responses=True)
    http = _Http()

    await _client(http, redis=redis).validate("chest pain", tenant_id="t1")
    await _client(http, redis=redis).validate("chest pain", tenant_id="t1")

    assert len(http.calls) == 2
    assert await redis.keys("text:medjudge:*") == []
    await redis.aclose()
