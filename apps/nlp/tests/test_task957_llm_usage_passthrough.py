"""TASK-957 F-7b — the delegated LLM spend of `/classify/{topic,intent}` reaches the gateway.

`nlp.topic` / `nlp.intent` run NO local model: both build a prompt and hand it to `apps/text`'s
`/generate`, which answers with the same `usage_detail` (and `guardrail_usage`) block every other
TEXT caller bills from. `ExternalTextClient` read `content` and threw the rest away, so the ONLY
consumer of those two routes — the gateway's `/text-analyses/{topic,intent}` proxy — had nothing
to record, and every classification through them was LLM spend nobody was charged for.

The blocks are carried VERBATIM under `llm_usage` / `llm_guardrail_usage`. `apps/nlp` does not
reshape them: the gateway already owns one parser for that wire shape
(`parseTextUsageDetail`), and a second interpretation here is a second place for the cache /
reasoning split to be lost.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from nlp.api.v1 import rest_api_router_v1
from nlp.core.config import ExternalTextConfig
from nlp.dependencies import get_external_text_client
from nlp.services.external_text_client import ExternalTextClient

USAGE_DETAIL = {
    "task_id": "text-task-1",
    "request_id": "corr-1",
    "provider": "lm-studio",
    "model": "qwen3-32b",
    "endpoint_kind": "openai.chat",
    "byok": False,
    "prompt_tokens": 120,
    "completion_tokens": 3,
    "total_ms": 800,
}
GUARDRAIL_USAGE = {**USAGE_DETAIL, "task_id": "guard-1", "prompt_tokens": 40}


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _RecordingClient:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
        return _FakeResponse(self.payload)


def _client(payload: dict[str, Any]) -> ExternalTextClient:
    return ExternalTextClient(
        settings=ExternalTextConfig(base_url="http://text.local"),
        http_client=_RecordingClient(payload),
        service_token=None,
    )


class TestExternalTextClientUsage:
    @pytest.mark.asyncio
    async def test_carries_both_usage_blocks_verbatim(self) -> None:
        client = _client(
            {"content": "billing", "usage_detail": USAGE_DETAIL, "guardrail_usage": GUARDRAIL_USAGE}
        )

        result = await client.generate_label_with_usage("prompt", tenant_id="tenant-abc")

        assert result.label == "billing"
        # Verbatim — not reshaped, not re-keyed. The gateway owns the one parser.
        assert result.usage_detail == USAGE_DETAIL
        assert result.guardrail_usage == GUARDRAIL_USAGE

    @pytest.mark.asyncio
    async def test_absent_blocks_stay_none_never_an_empty_dict(self) -> None:
        # An empty dict would parse as "measured, and it was nothing"; `None` is
        # "the service reported none", which is a different fact.
        result = await _client({"content": "billing"}).generate_label_with_usage(
            "prompt", tenant_id="tenant-abc"
        )
        assert result.usage_detail is None
        assert result.guardrail_usage is None

    @pytest.mark.asyncio
    async def test_a_non_object_block_is_dropped_rather_than_forwarded(self) -> None:
        # The gateway's parser is shape-checked, but a scalar here would reach a
        # `forbidNonWhitelisted` DTO on some future route. Refuse it at the source.
        result = await _client(
            {"content": "billing", "usage_detail": "nope"}
        ).generate_label_with_usage("prompt", tenant_id="tenant-abc")
        assert result.usage_detail is None

    @pytest.mark.asyncio
    async def test_generate_label_still_returns_the_bare_label(self) -> None:
        # The narrow accessor stays — one implementation, two shapes.
        assert (
            await _client({"content": "billing"}).generate_label("prompt", tenant_id="tenant-abc")
            == "billing"
        )


class _FakeExternalTextClient:
    def __init__(self, usage: Any = USAGE_DETAIL, guardrail: Any = GUARDRAIL_USAGE) -> None:
        self.usage = usage
        self.guardrail = guardrail

    async def generate_label_with_usage(
        self, prompt: str, system_prompt: str | None = None, *, tenant_id: str
    ):
        from nlp.services.external_text_client import GeneratedLabel

        return GeneratedLabel(
            label="billing", usage_detail=self.usage, guardrail_usage=self.guardrail
        )


@pytest.fixture()
def app_and_client():
    app = FastAPI()
    app.include_router(rest_api_router_v1)
    fake = _FakeExternalTextClient()
    app.dependency_overrides[get_external_text_client] = lambda: fake
    return TestClient(app), fake


BODY = {
    "text": "I have a billing question",
    "instructions": ["billing", "clinical"],
    "tenant_id": "t1",
}


class TestRoutesCarryLlmUsage:
    @pytest.mark.parametrize(
        ("path", "label_field"), [("topic", "predicted_topic"), ("intent", "predicted_intent")]
    )
    def test_both_blocks_ride_the_response(self, app_and_client, path, label_field) -> None:
        client, _ = app_and_client
        resp = client.post(f"/api/v1/classify/{path}", json=BODY)
        assert resp.status_code == 200
        body = resp.json()
        assert body[label_field] == "billing"
        assert body["llm_usage"] == USAGE_DETAIL
        assert body["llm_guardrail_usage"] == GUARDRAIL_USAGE

    @pytest.mark.parametrize("path", ["topic", "intent"])
    def test_both_keys_are_OMITTED_when_text_reported_none(self, app_and_client, path) -> None:
        # Omitted-when-absent, never `null` — the TASK-959 §10.2 wire convention, so an
        # older gateway sees exactly the shape it saw before.
        client, fake = app_and_client
        fake.usage = None
        fake.guardrail = None
        body = client.post(f"/api/v1/classify/{path}", json=BODY).json()
        assert "llm_usage" not in body
        assert "llm_guardrail_usage" not in body

    @pytest.mark.parametrize("path", ["topic", "intent"])
    def test_the_guardrail_key_alone_is_omitted_when_only_the_generation_was_reported(
        self, app_and_client, path
    ) -> None:
        client, fake = app_and_client
        fake.guardrail = None
        body = client.post(f"/api/v1/classify/{path}", json=BODY).json()
        assert body["llm_usage"] == USAGE_DETAIL
        assert "llm_guardrail_usage" not in body
