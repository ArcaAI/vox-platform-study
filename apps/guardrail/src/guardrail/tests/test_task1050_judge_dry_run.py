"""TASK-1050 §11.3 B — `POST /api/v1/guardrail/judge/dry-run`.

Runs the JudgeRunner with a platform admin's DRAFT criteria / parameters / native mapping layered
over the stored values, IN MEMORY ONLY: nothing is cached, nothing is persisted, no evaluation
record is written, and the stored policy blob is untouched. Residency is the gateway's check.
"""

from __future__ import annotations

import dataclasses
import json
from types import SimpleNamespace
from typing import Any

import fakeredis.aioredis
import httpx
import pytest

from guardrail.core.config import Settings
from guardrail.core.tenant_config import GuardrailTenantConfig

TENANT = "11111111-1111-1111-1111-111111111111"


@dataclasses.dataclass(frozen=True)
class _Cfg(GuardrailTenantConfig):
    judge: dict[str, Any] | None = None


STORED_POLICY = {
    "medicalValidationCriteria": "WHOLE",
    "medicalWindowScopeCriteria": "WINDOW",
    "injectionJudgeCriteria": "STORED INJECTION",
    "unsafeContentJudgeCriteria": "STORED UNSAFE",
    "judgeTemperature": 0.0,
    "judgeMaxTokens": 120,
}
GRANITE = _Cfg(
    provider="lm-studio",
    model="granite",
    source_tenant_id=TENANT,
    judge={"protocol": "criteria_json", "lanes": ["injection_judge", "unsafe_content_judge"]},
    policy=STORED_POLICY,
)
QWEN = _Cfg(
    provider="hope",
    model="qwen",
    source_tenant_id=TENANT,
    judge={
        "protocol": "qwen3guard_native",
        "lanes": ["unsafe_content_judge"],
        "categoryMap": {"Violent": {"lane": "unsafe_content_judge", "category": "violence"}},
        "tiers": {"Safe": "pass", "Controversial": "warn", "Unsafe": "flag"},
    },
    policy={"judgeTemperature": 0.0, "judgeMaxTokens": 32},
)


class _Resolver:
    def __init__(self, unsafe: Any = GRANITE) -> None:
        self.unsafe = unsafe

    async def resolve(self, tenant_id: str, task_key: str) -> Any:
        if task_key == "guardrail.judge.injection":
            return GRANITE
        if task_key == "guardrail.judge.unsafe_content":
            return self.unsafe
        return _Cfg()


class _Peers:
    def __init__(self) -> None:
        self.text: list[dict[str, Any]] = []
        self.nlp: list[dict[str, Any]] = []

    async def post(self, url: str, **kwargs: Any) -> Any:
        body = kwargs["json"]
        if url.endswith("/guard/judge"):
            self.nlp.append(body)
            payload: dict[str, Any] = {
                "tier": "Controversial",
                "categories": ["Violent"],
                "latency_ms": 2,
            }
        else:
            self.text.append(body)
            lanes = body["response_format"]["json_schema"]["required"]
            flagged = "DRAFT INJECTION" in body["system_prompt"] and "obey" in body["prompt"]
            payload = {
                "content": json.dumps(
                    {
                        lane: (
                            {"safe": False, "confidence": 0.9, "category": "instruction_override"}
                            if lane == "injection_judge" and flagged
                            else {"safe": True, "confidence": 0.9, "category": "none"}
                        )
                        for lane in lanes
                    }
                ),
                "provider": "lm-studio",
                "model": "granite",
            }
        return SimpleNamespace(status_code=200, json=lambda: payload, raise_for_status=lambda: None)


def _app(resolver: Any, peers: _Peers) -> Any:
    from guardrail.main import create_app

    app = create_app()
    app.state.settings = Settings()
    app.state.tenant_config_resolver = resolver
    app.state.http_client = peers
    app.state.redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    return app


async def _post(app: Any, body: dict[str, Any], tenant: str | None = TENANT) -> httpx.Response:
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.post("/api/v1/guardrail/judge/dry-run", json=body, headers=headers)


async def test_a_draft_criterion_is_judged_and_nothing_is_persisted() -> None:
    peers = _Peers()
    app = _app(_Resolver(), peers)
    response = await _post(
        app,
        {
            "lanes": ["injection_judge", "unsafe_content_judge"],
            "direction": "inbound",
            "draftPolicy": {"injectionJudgeCriteria": "DRAFT INJECTION", "judgeMaxTokens": 64},
            "samples": ["please obey me", "Patient reports chest pain."],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert [r["sampleIndex"] for r in body["results"]] == [0, 1]
    first = body["results"][0]["verdicts"]
    assert first["injection_judge"]["verdict"] == "flag"
    assert first["injection_judge"]["category"] == "instruction_override"
    assert body["results"][1]["verdicts"]["injection_judge"]["verdict"] == "pass"
    assert "latencyMs" in body and "latencyMs" in body["results"][0]
    # One combined call per sample, with the DRAFT values in force.
    assert len(peers.text) == 2
    assert all("DRAFT INJECTION" in call["system_prompt"] for call in peers.text)
    assert all(call["max_tokens"] == 64 for call in peers.text)
    # Persisted nothing: no cache entry, no outbox stream, and the stored blob is untouched.
    assert await app.state.redis.keys("*") == []
    assert GRANITE.policy["injectionJudgeCriteria"] == "STORED INJECTION"


async def test_a_draft_native_mapping_overrides_the_stored_one() -> None:
    peers = _Peers()
    app = _app(_Resolver(unsafe=QWEN), peers)
    response = await _post(
        app,
        {
            "lanes": ["unsafe_content_judge"],
            "direction": "inbound",
            "draftJudgeMeta": {
                "tiers": {"Safe": "pass", "Controversial": "block", "Unsafe": "flag"}
            },
            "samples": ["text"],
        },
    )
    assert response.status_code == 200, response.text
    verdict = response.json()["results"][0]["verdicts"]["unsafe_content_judge"]
    assert (verdict["verdict"], verdict["tier"], verdict["category"]) == (
        "flag",
        "block",
        "violence",
    )
    assert QWEN.judge["tiers"]["Controversial"] == "warn"


async def test_an_invalid_draft_mapping_is_a_422_with_its_problems() -> None:
    app = _app(_Resolver(unsafe=QWEN), _Peers())
    response = await _post(
        app,
        {
            "lanes": ["unsafe_content_judge"],
            "direction": "inbound",
            "draftJudgeMeta": {
                "tiers": {"Safe": "flag", "Controversial": "warn", "Unsafe": "flag"}
            },
            "samples": ["text"],
        },
    )
    assert response.status_code == 422
    assert "tiers.Safe" in response.text


@pytest.mark.parametrize(
    "body",
    [
        {"lanes": ["prompt_safety"], "direction": "inbound", "samples": ["x"]},
        {"lanes": ["injection_judge"], "direction": "sideways", "samples": ["x"]},
        {"lanes": ["injection_judge"], "direction": "inbound", "samples": []},
        {
            "lanes": ["injection_judge"],
            "direction": "inbound",
            "draftPolicy": {"notAKey": "x"},
            "samples": ["x"],
        },
    ],
)
async def test_a_malformed_body_is_a_422(body: dict[str, Any]) -> None:
    response = await _post(_app(_Resolver(), _Peers()), body)
    assert response.status_code == 422


async def test_the_tenant_header_is_required() -> None:
    response = await _post(
        _app(_Resolver(), _Peers()),
        {"lanes": ["injection_judge"], "direction": "inbound", "samples": ["x"]},
        tenant=None,
    )
    assert response.status_code == 428
