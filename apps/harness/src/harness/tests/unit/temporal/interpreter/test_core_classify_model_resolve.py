"""F11 — `core.classify` against the model-resolve route as it now exists.

`ApiClient.resolve_model` was coded against a route that had never been built:
`apps/api/route-manifest.json` carried `/internal/agents/resolve` and
`/internal/harness/prompt-templates/{id}/resolved` and nothing that resolves a
registry model by slug, so every `core.classify` node degraded at model
resolution (terminally, since J5-F7 made a non-408/429 4xx non-retryable).

Two things are pinned here:

1. **The wire contract.** `GET {internal_prefix}/models/resolve?tenantId=&slug=`
   with `X-Service-Token`, `taskType` present only when the caller supplies one.
2. **No task pin at the call site.** `core.classify`'s own config schema accepts
   a TEXT_CLASSIFICATION *or* TOKEN_CLASSIFICATION slug, and BOTH
   classification-capable rows the platform seeds
   (`gliner2-guardrails-pii-multi`, `medical-ner`) are TOKEN_CLASSIFICATION — so
   the former hardcoded ``task_type="TEXT_CLASSIFICATION"`` would 404 the very
   models the node is authored against. The gateway answers with the row's own
   `taskType`; the node does not dictate it.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from harness.services.api_client import ApiClient
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"

_ROW = {
    "slug": "gliner2-guardrails-pii-multi",
    "taskType": "TOKEN_CLASSIFICATION",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "sourceUri": "fastino/GLiNER2-Guardrails-PII-Multi",
    "sourceRevision": "main",
    "localPath": "/mnt/models-bucket/nlp/gliner2-guardrails-pii-multi/",
    "wireModelId": None,
    "servedBy": "nlp",
    "provider": "built-in",
    "format": "SAFETENSOR",
    "computeType": "float32",
    "labelTaxonomy": {"threshold": 0.5, "labels": ["person", "email"]},
}


class TestResolveModelWireContract:
    @pytest.mark.asyncio
    async def test_it_calls_the_harness_internal_models_resolve_route(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=_ROW)

        client = ApiClient(
            "http://gw:8868/api/v1",
            service_token="tok",
            transport=httpx.MockTransport(handler),
        )

        answer = await client.resolve_model(slug=_ROW["slug"], tenant_id=_TENANT)

        assert answer["sourceUri"] == _ROW["sourceUri"]
        assert seen[0].url.path == "/api/v1/internal/harness/models/resolve"
        assert dict(seen[0].url.params) == {"tenantId": _TENANT, "slug": _ROW["slug"]}
        assert seen[0].headers["X-Service-Token"] == "tok"

    @pytest.mark.asyncio
    async def test_task_type_rides_on_the_query_only_when_supplied(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=_ROW)

        client = ApiClient("http://gw:8868/api/v1", transport=httpx.MockTransport(handler))

        await client.resolve_model(
            slug=_ROW["slug"], tenant_id=_TENANT, task_type="TOKEN_CLASSIFICATION"
        )

        assert dict(seen[0].url.params)["taskType"] == "TOKEN_CLASSIFICATION"


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer
        self.calls: list[dict[str, Any]] = []

    async def resolve_model(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return self.answer


class _StubNlp:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def classify_text(self, text: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append({"text": text, **kwargs})
        return {
            "predicted_label": "person",
            "confidence": 0.91,
            "probabilities": {"person": 0.91, "email": 0.02},
        }


@pytest.fixture
def stubs(monkeypatch: pytest.MonkeyPatch) -> tuple[_StubApi, _StubNlp]:
    api = _StubApi(_ROW)
    nlp = _StubNlp()
    monkeypatch.setattr(core, "_api_client", lambda _settings: api)
    monkeypatch.setattr(core, "_nlp_client", lambda _settings: nlp)

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)
    return api, nlp


def _payload(**config: Any) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="classify1",
        node_type="core.classify",
        config=config,
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={"in": "Call me on 555-0100."},
        run_payload={},
        run_id=_RUN,
    )


class TestCoreClassifyResolution:
    @pytest.mark.asyncio
    async def test_it_does_not_pin_a_task_type_the_seeded_rows_do_not_carry(
        self, stubs: tuple[_StubApi, _StubNlp]
    ) -> None:
        api, nlp = stubs

        result = await core.interpreter_core_classify(
            _payload(
                modelSlug=_ROW["slug"],
                classes=[{"key": "pii", "label": "PII", "labels": ["person", "email"]}],
            )
        )

        assert api.calls == [{"slug": _ROW["slug"], "tenant_id": _TENANT}]
        assert result.status == "SUCCEEDED"
        assert result.taken_handle == "pii"
        # The registry facts the gateway resolved reach the NLP call unaltered.
        assert nlp.calls[0]["model_name"] == _ROW["sourceUri"]
        assert nlp.calls[0]["model_path"] == _ROW["localPath"]
