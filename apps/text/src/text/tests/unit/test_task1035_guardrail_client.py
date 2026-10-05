"""TASK-1035 — the guardrail client after the opt-out and the kill switch were removed.

* No platform switch and no tenant opt-out: `validate` always calls guardrail.
* `screen_inbound` asks for PII spans and returns them.
* The medical-judge verdict is cached per tenant: live flushes repeat the same
  prefix, and a ~50 s judgement should not be paid twice for the same text. The
  tenant is part of the key, so one tenant's verdict is never served to another.
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
    verdict = await _client(http).screen_inbound("John has a cough", tenant_id="t1")

    call = http.calls[0]
    assert call["url"] == "http://guardrail/api/v1/guardrail/screen/inbound"
    assert call["json"]["include_pii_spans"] is True
    assert call["json"]["text"] == "John has a cough"
    assert call["headers"]["X-Tenant-Id"] == "t1"
    assert verdict["allowed"] is True
    assert verdict["pii_spans"][0]["label"] == "person"


async def test_the_medical_verdict_is_cached_per_tenant() -> None:
    http = _Http()
    client = _client(http)

    await client.validate("chest   pain", system_prompt="sys", tenant_id="t1")
    await client.validate("chest pain", system_prompt="sys", tenant_id="t1")
    assert len(http.calls) == 1  # normalized whitespace hit the cache

    await client.validate("chest pain", system_prompt="sys", tenant_id="t2")
    assert len(http.calls) == 2  # another tenant never reads t1's verdict


async def test_the_medical_verdict_cache_uses_redis_without_storing_text() -> None:
    redis = fakeasync.FakeRedis(decode_responses=True)
    http = _Http()

    await _client(http, redis=redis).validate("chest pain", tenant_id="t1")
    # A second client (another pod) reads the same verdict.
    await _client(http, redis=redis).validate("chest pain", tenant_id="t1")

    assert len(http.calls) == 1
    keys = await redis.keys("text:medjudge:*")
    assert len(keys) == 1
    stored = await redis.get(keys[0])
    assert "chest pain" not in stored and "clinical" not in stored
    assert await redis.ttl(keys[0]) > 0
    await redis.aclose()
