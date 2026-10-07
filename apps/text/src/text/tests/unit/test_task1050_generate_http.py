"""TASK-1050 W2c — the guardrail result on the HTTP surface of `/generate` and `/translate`.

* 200 bodies gain ``guardrail_notices`` (GuardrailNotice v1) and
  ``guardrail_evaluation_ids`` (inbound + outbound);
* a block keeps its 422 + ``error_code`` and adds ``type`` / ``guardrailNotice`` /
  ``guardrailEvaluationIds`` inside the house envelope;
* an outage continues with a ``guardrail.unverified`` notice — except a CLOUD call
  without PII spans: 503 ``EGRESS_REDACTION_UNAVAILABLE``, the provider never called;
* the caller's ``X-Hope-*`` correlation and ``region_items`` reach guardrail.

Hermetic: guardrail is a recording stub, the provider a spy.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.models.requests import GenerateRequest
from text.services import guardrail_notices as gn
from text.services.external_guardrail import GUARDRAIL_UNAVAILABLE_REASON

_TENANT = "11111111-1111-1111-1111-111111111111"
_TRANSCRIPT = (
    '<<<EXTERNAL_DATA section="transcript">>>\n'
    "--- Consultation transcript ---\n"
    "Patient reports a cough.\n"
    "<<<END_EXTERNAL_DATA>>>"
)
_OUTAGE = {"allowed": False, "reason": GUARDRAIL_UNAVAILABLE_REASON}


def _warning(direction: str = "inbound") -> dict[str, Any]:
    return {
        **gn.unverified_notice(direction, ["unsafe_content_judge"]),
        "type": "guardrail.warning",
        "messageKey": "guardrail.warning.generic",
        "defaultMessage": gn.DEFAULT_MESSAGES["guardrail.warning.generic"],
    }


class _Guardrail:
    def __init__(
        self,
        *,
        screen: dict[str, Any] | None = None,
        medical: dict[str, Any] | None = None,
        output: dict[str, Any] | None = None,
    ) -> None:
        self.screen = screen or {"allowed": True, "decision": "allow", "pii_spans": []}
        self.medical = medical or {"allowed": True, "decision": "allow", "is_medical": True}
        self.output = output or {"allowed": True, "decision": "allow", "reason": "ok"}
        self.calls: list[tuple[str, dict[str, Any], dict[str, str]]] = []

    async def screen_inbound(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("inbound", kwargs, gn.correlation_headers()))
        return self.screen

    async def validate(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("medical", kwargs, gn.correlation_headers()))
        return self.medical

    async def screen_output(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("outbound", kwargs, gn.correlation_headers()))
        return self.output


class _SpyProvider:
    def __init__(self) -> None:
        self.requests: list[GenerateRequest] = []
        self.generate_stream = None

    async def generate(self, request: GenerateRequest):
        self.requests.append(request)
        return "A note.", "", {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}


class _Translator:
    model = "sarvam-translate"

    def __init__(self) -> None:
        self.calls = 0

    async def translate(self, texts: list[str], **_: Any) -> list[str]:
        self.calls += 1
        return [f"T:{t}" for t in texts]


def _task_manager() -> AsyncMock:
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "task-1"
    tm.create_task = AsyncMock(return_value=task_state)
    return tm


@pytest_asyncio.fixture
async def make_client():
    clients: list[AsyncClient] = []

    async def _build(guardrail: Any, provider: Any = None, translator: Any = None) -> AsyncClient:
        from text.main import create_app

        app = create_app()
        registry = MagicMock()
        registry.get.return_value = provider or _SpyProvider()
        registry.list_providers.return_value = ["lm-studio", "openai"]
        app.state.provider_registry = registry
        app.state.task_manager = _task_manager()
        app.state.guardrail_client = guardrail
        if translator is not None:
            translate_registry = MagicMock()
            translate_registry.get.return_value = translator
            app.state.translate_registry = translate_registry
        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        clients.append(client)
        return client

    yield _build
    for c in clients:
        await c.aclose()


def _body(provider: str = "lm-studio", **extra: Any) -> dict[str, Any]:
    return {
        "provider": provider,
        "model": "m",
        "prompt": f"Summarise.\n\n{_TRANSCRIPT}",
        **extra,
    }


_HEADERS = {"X-Tenant-Id": _TENANT}


# ── 200: notices and evaluation ids ──────────────────────────────────────────


async def test_warn_and_an_outbound_outage_both_continue_and_ride_on_the_body(make_client) -> None:
    warning = _warning()
    guardrail = _Guardrail(
        screen={
            "allowed": True,
            "decision": "warn",
            "pii_spans": [],
            "notices": [warning],
            "evaluation_id": "ev-in",
        },
        medical={
            "allowed": True,
            "decision": "allow",
            "is_medical": True,
            "evaluation_id": "ev-med",
        },
        output=_OUTAGE,
    )
    provider = _SpyProvider()
    client = await make_client(guardrail, provider)

    resp = await client.post("/api/v1/generate", json=_body(), headers=_HEADERS)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(provider.requests) == 1
    assert body["content"] == "A note."
    assert [n["type"] for n in body["guardrail_notices"]] == [
        "guardrail.warning",
        "guardrail.unverified",
    ]
    assert body["guardrail_notices"][0] == warning
    assert body["guardrail_notices"][1]["direction"] == "outbound"
    assert body["guardrail_evaluation_ids"] == ["ev-in", "ev-med"]


async def test_a_clean_generation_carries_empty_lists(make_client) -> None:
    client = await make_client(_Guardrail())

    body = (await client.post("/api/v1/generate", json=_body(), headers=_HEADERS)).json()

    assert body["guardrail_notices"] == []
    assert body["guardrail_evaluation_ids"] == []


async def test_a_local_screen_outage_continues_with_an_unverified_notice(make_client) -> None:
    provider = _SpyProvider()
    client = await make_client(_Guardrail(screen=_OUTAGE), provider)

    resp = await client.post("/api/v1/generate", json=_body(), headers=_HEADERS)

    assert resp.status_code == 200, resp.text
    assert len(provider.requests) == 1
    (notice,) = resp.json()["guardrail_notices"]
    assert notice["type"] == "guardrail.unverified" and notice["direction"] == "inbound"


# ── 422 / 503 ────────────────────────────────────────────────────────────────


async def test_a_block_keeps_the_422_and_its_code_and_adds_the_notice(make_client) -> None:
    blocked = gn.blocked_notice(
        "inbound", "guardrail.blocked.inbound", [{"checkId": "injection_judge", "severity": "high"}]
    )
    guardrail = _Guardrail(
        screen={
            "allowed": False,
            "decision": "block",
            "reason": "injection_judge",
            "pii_spans": [],
            "notices": [blocked],
            "evaluation_id": "ev-in",
        },
    )
    provider = _SpyProvider()
    client = await make_client(guardrail, provider)

    resp = await client.post("/api/v1/generate", json=_body(), headers=_HEADERS)

    assert resp.status_code == 422
    body = resp.json()
    assert body["error_code"] == "CONTENT_BLOCKED"
    assert body["detail"] == "Content was blocked by the safety guardrail."
    assert body["type"] == "urn:hope:problem:guardrail-blocked"
    assert body["status"] == 422
    assert body["guardrailNotice"] == blocked
    assert body["guardrailEvaluationIds"] == ["ev-in"]
    assert provider.requests == []


async def test_a_cloud_screen_outage_is_the_redaction_hold_and_never_calls_the_provider(
    make_client,
) -> None:
    provider = _SpyProvider()
    client = await make_client(_Guardrail(screen=_OUTAGE), provider)

    resp = await client.post("/api/v1/generate", json=_body("openai"), headers=_HEADERS)

    assert resp.status_code == 503
    body = resp.json()
    assert body["error_code"] == "EGRESS_REDACTION_UNAVAILABLE"
    assert body["processing_reason"] == "EGRESS_REDACTION_UNAVAILABLE"
    assert body["guardrailNotice"]["messageKey"] == "guardrail.blocked.redaction_unavailable"
    assert provider.requests == []


# ── correlation, locality, items ─────────────────────────────────────────────


async def test_correlation_locality_and_region_items_reach_every_guardrail_call(
    make_client,
) -> None:
    guardrail = _Guardrail()
    client = await make_client(guardrail)
    headers = {
        **_HEADERS,
        "X-Hope-Consultation-Id": "c-1",
        "X-Hope-Run-Id": "r-1",
        "X-Hope-Node-Id": "n-1",
        "X-Hope-Run-Key": "rk-1",
    }
    items = {"transcript": [{"itemId": "seg-1", "itemVersion": 4}]}

    resp = await client.post("/api/v1/generate", json=_body(region_items=items), headers=headers)

    assert resp.status_code == 200, resp.text
    assert [name for name, *_ in guardrail.calls] == ["inbound", "medical", "outbound"]
    for _, kwargs, correlation in guardrail.calls:
        assert correlation == {
            "X-Hope-Consultation-Id": "c-1",
            "X-Hope-Run-Id": "r-1",
            "X-Hope-Node-Id": "n-1",
            "X-Hope-Run-Key": "rk-1",
        }
        assert kwargs["locality"] == "local"
    inbound = guardrail.calls[0][1]
    assert inbound["include_pii_spans"] is False
    regions = {r["key"]: r for r in inbound["regions"]}
    assert regions["transcript"]["items"] == [{"itemId": "seg-1", "itemVersion": 4}]
    outbound_regions = {r["key"]: r for r in guardrail.calls[2][1]["source_regions"]}
    assert outbound_regions["transcript"]["items"] == [{"itemId": "seg-1", "itemVersion": 4}]


async def test_region_items_accept_the_snake_case_names_too(make_client) -> None:
    guardrail = _Guardrail()
    client = await make_client(guardrail)
    items = {"transcript": [{"item_id": "seg-9", "item_version": 1}]}

    resp = await client.post("/api/v1/generate", json=_body(region_items=items), headers=_HEADERS)

    assert resp.status_code == 200, resp.text
    regions = {r["key"]: r for r in guardrail.calls[0][1]["regions"]}
    assert regions["transcript"]["items"] == [{"itemId": "seg-9", "itemVersion": 1}]


# ── /translate ───────────────────────────────────────────────────────────────


async def test_translate_screens_its_texts_as_data_and_returns_the_guardrail_result(
    make_client,
) -> None:
    warning = _warning()
    guardrail = _Guardrail(
        screen={
            "allowed": True,
            "decision": "warn",
            "pii_spans": [],
            "notices": [warning],
            "evaluation_id": "ev-in",
        },
        output={"allowed": True, "decision": "allow", "reason": "ok", "evaluation_id": "ev-out"},
    )
    translator = _Translator()
    client = await make_client(guardrail, translator=translator)

    resp = await client.post(
        "/api/v1/translate",
        json={"texts": ["Patient has fever."], "provider_locality": {"sarvam": "local"}},
        headers={**_HEADERS, "X-Hope-Consultation-Id": "c-7"},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["guardrail_notices"] == [warning]
    assert body["guardrail_evaluation_ids"] == ["ev-in", "ev-out"]
    inbound = guardrail.calls[0]
    assert [r["trust"] for r in inbound[1]["regions"]] == ["data"]
    assert inbound[2] == {"X-Hope-Consultation-Id": "c-7"}


async def test_translate_on_a_cloud_provider_holds_on_a_screen_outage(make_client) -> None:
    translator = _Translator()
    client = await make_client(_Guardrail(screen=_OUTAGE), translator=translator)

    resp = await client.post(
        "/api/v1/translate", json={"texts": ["Patient has fever."]}, headers=_HEADERS
    )

    assert resp.status_code == 503
    assert resp.json()["error_code"] == "EGRESS_REDACTION_UNAVAILABLE"
    assert translator.calls == 0


# ── round 2: the request fields guardrail now takes ──────────────────────────


async def test_generate_sends_caller_agent_items_prompt_and_the_override_header(
    make_client,
) -> None:
    guardrail = _Guardrail()
    client = await make_client(guardrail)

    resp = await client.post(
        "/api/v1/generate",
        json=_body(
            agent_slug="soap-writer",
            response_items=[{"itemId": "note-1", "itemVersion": 3}],
            provider_overrides={"lm-studio": {"base_url": "http://lms"}},
        ),
        headers={**_HEADERS, "X-Hope-Guardrail-Override": "notice-7"},
    )

    assert resp.status_code == 200, resp.text
    (_, inbound, inbound_headers), _, (_, outbound, _) = guardrail.calls
    assert inbound["caller"] == "text.generate"
    assert inbound["agent_slug"] == "soap-writer"
    assert inbound["exempt"] is None
    assert inbound["provider_overrides"] == {
        "lm-studio": {"base_url": "http://lms", "funding": "tenant"}
    }
    assert inbound_headers["X-Hope-Guardrail-Override"] == "notice-7"
    assert outbound["caller"] == "text.generate"
    assert outbound["agent_slug"] == "soap-writer"
    assert outbound["response_items"] == [{"itemId": "note-1", "itemVersion": 3}]
    assert outbound["prompt_context"] == f"Summarise.\n\n{_TRANSCRIPT}"
    assert outbound["provider_overrides"] == inbound["provider_overrides"]


async def test_generate_marks_the_internal_medical_exemption(make_client) -> None:
    guardrail = _Guardrail()
    client = await make_client(guardrail)

    resp = await client.post(
        "/api/v1/generate", json=_body(medical_exempt="internal"), headers=_HEADERS
    )

    assert resp.status_code == 200, resp.text
    assert [name for name, *_ in guardrail.calls] == ["inbound", "outbound"]
    assert guardrail.calls[0][1]["exempt"] == "medical_internal"


async def test_translate_is_the_text_translate_caller(make_client) -> None:
    guardrail = _Guardrail()
    client = await make_client(guardrail, translator=_Translator())

    resp = await client.post(
        "/api/v1/translate",
        json={
            "texts": ["Patient has fever."],
            "provider_locality": {"sarvam": "local"},
            "agent_slug": "translator",
        },
        headers=_HEADERS,
    )

    assert resp.status_code == 200, resp.text
    inbound, outbound = guardrail.calls[0][1], guardrail.calls[-1][1]
    assert inbound["caller"] == outbound["caller"] == "text.translate"
    assert inbound["agent_slug"] == outbound["agent_slug"] == "translator"
    assert outbound["prompt_context"] == "Patient has fever."
