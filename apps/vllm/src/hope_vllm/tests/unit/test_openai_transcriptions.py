"""C-3: `POST /v1/audio/transcriptions` and `GET /v1/models` — the OpenAI-compatible surface.

The route is HOPE's own thin implementation of the OpenAI transcription schema over the
spike's `VllmWhisperEngine` (D-8), NOT vLLM's upstream handler: upstream 0.30.0 prefixes
prior text with `<|prev|>` (not a Whisper token) and caps generation at 16 tokens.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import numpy as np
import pytest
from httpx import ASGITransport, AsyncClient

from hope_vllm.core.config import Settings
from hope_vllm.engine.base import EngineBuildRefused
from hope_vllm.main import create_app
from hope_vllm.tests.conftest import (
    HEADERS,
    RUNTIME_KEY,
    SLUG,
    SYSTEM_TENANT_ID,
    TENANT_ID,
    serving_spec_payload,
    transcription_form,
    wav_bytes,
)
from hope_vllm.tests.fakes import FakeEngineFactory, FakeSpecResolver

ROUTE = "/v1/audio/transcriptions"


async def post(client: AsyncClient, *, headers: dict[str, str] | None = None, **form: Any) -> Any:
    data, files = transcription_form(**form)
    return await client.post(
        ROUTE, data=data, files=files, headers=HEADERS if headers is None else headers
    )


def openai_error(response: Any) -> dict[str, Any]:
    body = response.json()
    assert set(body) == {"error"}, body
    error: dict[str, Any] = body["error"]
    assert set(error) == {"message", "type", "param", "code"}, error
    assert isinstance(error["message"], str) and error["message"]
    return error


# ── the three response formats, byte-shape exact to C-3 ─────────────────────


async def test_json_is_exactly_text(client) -> None:  # type: ignore[no-untyped-def]
    response = await post(client)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.content == b'{"text":"hello world from the fake engine"}'


async def test_json_is_the_default_format(client) -> None:  # type: ignore[no-untyped-def]
    assert (await post(client, response_format=None)).json() == {
        "text": "hello world from the fake engine"
    }


async def test_text_is_the_plain_transcript(client) -> None:  # type: ignore[no-untyped-def]
    response = await post(client, response_format="text")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert response.text == "hello world from the fake engine"


async def test_verbose_json_carries_duration_and_the_x_hope_extension(  # type: ignore[no-untyped-def]
    client, factory
) -> None:
    factory.engine_queue_ms = 3.14159
    response = await post(client, response_format="verbose_json", language="ml")
    assert response.status_code == 200
    body = response.json()
    assert list(body) == ["task", "language", "duration", "text", "segments", "x_hope"]
    assert body["task"] == "transcribe"
    assert body["language"] == "ml"
    assert body["duration"] == 7.0
    assert body["text"] == "hello world from the fake engine"
    assert body["segments"] == []
    x_hope = body["x_hope"]
    assert list(x_hope) == ["finish_reason", "decode_ms", "engine_queue_ms", "truncation"]
    assert x_hope["finish_reason"] == "stop"
    assert x_hope["decode_ms"] == 1.0
    assert x_hope["engine_queue_ms"] == 3.1
    assert list(x_hope["truncation"]) == ["suspected", "reason", "voiced_seconds", "chars"]
    assert x_hope["truncation"]["suspected"] is False
    assert x_hope["truncation"]["reason"] is None
    assert x_hope["truncation"]["voiced_seconds"] == pytest.approx(7.0, abs=0.05)
    assert x_hope["truncation"]["chars"] == len("helloworldfromthefakeengine")
    # Compact, in C-3's order — what a byte-level client (or a golden file) sees.
    assert response.content.startswith(b'{"task":"transcribe","language":"ml","duration":7.0,')


async def test_verbose_json_flags_truncation_when_the_token_budget_ran_out(client, factory) -> None:  # type: ignore[no-untyped-def]
    factory.engine_finish_reason = "length"
    body = (await post(client, response_format="verbose_json")).json()
    assert body["x_hope"]["finish_reason"] == "length"
    assert body["x_hope"]["truncation"]["suspected"] is True
    assert body["x_hope"]["truncation"]["reason"] == "token_budget_exhausted"


# ── what reaches the engine ─────────────────────────────────────────────────


async def test_the_engine_gets_16k_float32_audio_and_the_decode_params(  # type: ignore[no-untyped-def]
    client, factory
) -> None:
    await post(client, prompt="previous words", temperature="0.2", language="en")
    (request,) = factory.engines[RUNTIME_KEY].requests
    assert request.audio.dtype == np.float32
    assert request.audio.shape == (7 * 16_000,)
    assert request.language == "en"
    assert request.prompt == "previous words"
    assert request.temperature == pytest.approx(0.2)
    assert request.max_tokens is None  # the whole remaining decoder context, never 16
    assert request.request_id


async def test_any_sample_rate_is_resampled_to_16k(client, factory) -> None:  # type: ignore[no-untyped-def]
    response = await post(client, audio=wav_bytes(2.0, rate=8_000), response_format="verbose_json")
    assert response.status_code == 200
    assert response.json()["duration"] == 2.0
    (request,) = factory.engines[RUNTIME_KEY].requests
    assert request.audio.shape == (32_000,)


async def test_the_model_is_resolved_for_the_calling_tenant(client, resolver) -> None:  # type: ignore[no-untyped-def]
    await post(client)
    assert resolver.calls == [(SLUG, TENANT_ID)]


# ── 400: the request ────────────────────────────────────────────────────────


async def test_31_seconds_is_audio_too_long(client, factory) -> None:  # type: ignore[no-untyped-def]
    response = await post(client, audio=wav_bytes(31.0))
    assert response.status_code == 400
    error = openai_error(response)
    assert error == {
        **error,
        "type": "invalid_request_error",
        "code": "audio_too_long",
        "param": "file",
    }
    assert factory.builds == []


@pytest.mark.parametrize(
    "audio",
    [
        b"definitely not a wav file",
        b"",
        wav_bytes(1.0, sampwidth=1),  # 8-bit PCM
        wav_bytes(1.0, sampwidth=4),  # 32-bit PCM
        wav_bytes(1.0, channels=2),  # stereo
        wav_bytes(0.0),  # zero frames
    ],
)
async def test_anything_but_pcm16_mono_wav_is_unsupported_audio(client, audio: bytes) -> None:  # type: ignore[no-untyped-def]
    response = await post(client, audio=audio)
    assert response.status_code == 400
    error = openai_error(response)
    assert (error["type"], error["code"], error["param"]) == (
        "invalid_request_error",
        "unsupported_audio",
        "file",
    )


@pytest.mark.parametrize("language", [None, ""])
async def test_no_language_is_language_required(client, language: str | None) -> None:  # type: ignore[no-untyped-def]
    response = await post(client, language=language)
    assert response.status_code == 400
    error = openai_error(response)
    assert (error["type"], error["code"], error["param"]) == (
        "invalid_request_error",
        "language_required",
        "language",
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("response_format", "srt"),
        ("temperature", "2"),
        ("temperature", "hot"),
        ("language", "Malayalam"),
    ],
)
async def test_an_invalid_field_is_an_openai_400(client, field: str, value: str) -> None:  # type: ignore[no-untyped-def]
    response = await post(client, **{field: value})
    assert response.status_code == 400
    error = openai_error(response)
    assert error["type"] == "invalid_request_error" and error["param"] == field


async def test_a_missing_model_is_an_openai_400(client) -> None:  # type: ignore[no-untyped-def]
    response = await post(client, model=None)
    assert response.status_code == 400
    error = openai_error(response)
    assert (error["type"], error["param"]) == ("invalid_request_error", "model")


async def test_no_tenant_is_400(client) -> None:  # type: ignore[no-untyped-def]
    response = await post(client, headers={})
    assert response.status_code == 400
    error = openai_error(response)
    assert (error["type"], error["code"]) == ("invalid_request_error", "tenant_id_required")


# ── 401: auth — X-Service-Token or Authorization: Bearer ────────────────────


@pytest.fixture
def secured_app(monkeypatch: pytest.MonkeyPatch, factory, resolver):  # type: ignore[no-untyped-def]
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "secret-token")
    return create_app(Settings(), engine_factory=factory, serving_spec_client=resolver)


@pytest.mark.parametrize(
    "auth",
    [
        {},
        {"X-Service-Token": "nope"},
        {"Authorization": "Bearer nope"},
        {"Authorization": "secret-token"},  # not a Bearer credential
        {"Authorization": "Basic secret-token"},
    ],
)
async def test_no_or_a_wrong_token_is_an_openai_401(secured_app, auth: dict[str, str]) -> None:  # type: ignore[no-untyped-def]
    async with AsyncClient(transport=ASGITransport(app=secured_app), base_url="http://t") as c:
        response = await post(c, headers={**HEADERS, **auth})
    assert response.status_code == 401
    assert openai_error(response)["type"] == "authentication_error"


@pytest.mark.parametrize(
    "auth", [{"X-Service-Token": "secret-token"}, {"Authorization": "Bearer secret-token"}]
)
async def test_bearer_and_service_token_are_both_accepted(secured_app, auth: dict[str, str]) -> None:  # type: ignore[no-untyped-def]
    async with AsyncClient(transport=ASGITransport(app=secured_app), base_url="http://t") as c:
        response = await post(c, headers={**HEADERS, **auth})
    assert response.status_code == 200


# ── 404 / 409: the model ────────────────────────────────────────────────────


async def test_an_unknown_model_is_model_not_found(client, resolver, factory) -> None:  # type: ignore[no-untyped-def]
    resolver.missing.add("nope")
    response = await post(client, model="nope")
    assert response.status_code == 404
    error = openai_error(response)
    assert (error["type"], error["code"], error["param"]) == (
        "invalid_request_error",
        "model_not_found",
        "model",
    )
    assert factory.builds == []


@pytest.mark.parametrize("reason", ["SERVING_FACTS_MISSING", "DISABLED", "FORMAT_UNSUPPORTED"])
async def test_a_model_the_gateway_will_not_serve_is_model_not_servable(  # type: ignore[no-untyped-def]
    client, resolver, reason: str
) -> None:
    resolver.not_servable[SLUG] = reason
    response = await post(client)
    assert response.status_code == 409
    error = openai_error(response)
    assert (error["type"], error["code"]) == ("invalid_request_error", "model_not_servable")
    assert reason in error["message"]


async def test_a_kind_this_pool_does_not_take_is_model_not_servable(client, resolver, factory) -> None:  # type: ignore[no-untyped-def]
    resolver.specs[SLUG] = serving_spec_payload(kind="llm")
    response = await post(client)
    assert response.status_code == 409
    assert "KIND_NOT_ACCEPTED" in openai_error(response)["message"]
    assert factory.builds == []


async def test_a_gateway_fault_is_a_503_with_retry_after(client, resolver) -> None:  # type: ignore[no-untyped-def]
    resolver.fail = True
    response = await post(client)
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "1"
    error = openai_error(response)
    assert (error["type"], error["code"]) == ("server_error", "serving_spec_unavailable")


# ── 429 / 503: the engine ───────────────────────────────────────────────────


async def test_capacity_is_503_engine_capacity_with_retry_after(client, factory, resolver) -> None:  # type: ignore[no-untyped-def]
    """The default pool holds ONE engine: a second model while the first decodes is refused."""
    factory.engine_delay_s = 0.3
    first = asyncio.create_task(post(client))
    await asyncio.sleep(0.05)
    response = await post(client, model="another-model")
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "1"
    error = openai_error(response)
    assert (error["type"], error["code"]) == ("server_error", "engine_capacity")
    assert (await first).status_code == 200


async def test_saturation_is_429_engine_saturated_with_retry_after(client, factory, resolver) -> None:  # type: ignore[no-untyped-def]
    """A lease beyond maxNumSeqs × inflightFactor (1 × 2 here) is refused, not queued."""
    resolver.specs[SLUG] = serving_spec_payload(maxNumSeqs=1)
    factory.engine_delay_s = 0.3
    held = [asyncio.create_task(post(client)) for _ in range(2)]
    await asyncio.sleep(0.05)
    response = await post(client)
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "1"
    error = openai_error(response)
    assert (error["type"], error["code"]) == ("rate_limit_error", "engine_saturated")
    assert [r.status_code for r in await asyncio.gather(*held)] == [200, 200]


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (RuntimeError("CUDA OOM"), "engine_load_failed"),
        (EngineBuildRefused("MODEL_NOT_PUBLISHED", "not on the bucket"), "MODEL_NOT_PUBLISHED"),
        (
            EngineBuildRefused("QUANTIZATION_UNSUPPORTED_ON_GPU", "sm_86"),
            "QUANTIZATION_UNSUPPORTED_ON_GPU",
        ),
    ],
)
async def test_a_load_failure_is_a_503_named_by_its_code(
    settings: Settings, failure: Exception, code: str
) -> None:
    app = create_app(
        settings,
        engine_factory=FakeEngineFactory(fail_with=failure),
        serving_spec_client=FakeSpecResolver(),
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        response = await post(c)
    assert response.status_code == 503
    error = openai_error(response)
    assert (error["type"], error["code"]) == ("server_error", code)


async def test_a_spec_over_the_whole_budget_is_503_vram_budget_exceeded(client, resolver) -> None:  # type: ignore[no-untyped-def]
    resolver.specs[SLUG] = serving_spec_payload(vramGiB=7)
    response = await post(client)
    assert response.status_code == 503
    assert openai_error(response)["code"] == "VRAM_BUDGET_EXCEEDED"


async def test_no_vllm_in_the_image_is_503(settings: Settings) -> None:
    app = create_app(
        settings,
        engine_factory=FakeEngineFactory(unavailable_reason="vllm is not installed"),
        serving_spec_client=FakeSpecResolver(),
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        response = await post(c)
    assert response.status_code == 503
    assert openai_error(response)["code"] == "ENGINE_BACKEND_UNAVAILABLE"


async def test_a_row_edit_that_keeps_the_runtime_key_is_served_by_the_resident_engine(  # type: ignore[no-untyped-def]
    client, resolver, factory
) -> None:
    """Only WEIGHT identity is pinned to a runtime key; a sizing edit on the row (same
    `runtimeKey`) is served by the engine already resident, never a 409 outage."""
    assert (await post(client)).status_code == 200
    resolver.specs[SLUG] = serving_spec_payload(vramGiB=4, maxNumSeqs=32)
    assert (await post(client)).status_code == 200
    assert factory.builds == [RUNTIME_KEY]


async def test_the_same_runtime_key_for_different_weights_is_refused(client, resolver) -> None:  # type: ignore[no-untyped-def]
    assert (await post(client)).status_code == 200
    resolver.specs[SLUG] = serving_spec_payload(localPath="/some/other/weights")
    response = await post(client)
    assert response.status_code == 409
    assert "RUNTIME_KEY_SPEC_MISMATCH" in openai_error(response)["message"]


# ── review focus 4: the client goes away mid-decode ─────────────────────────


async def test_cancelling_the_request_aborts_the_decode_and_releases_the_lease(  # type: ignore[no-untyped-def]
    client, app, factory
) -> None:
    factory.engine_delay_s = 5.0
    task = asyncio.create_task(post(client))
    await asyncio.sleep(0.1)
    engine = factory.engines[RUNTIME_KEY]
    assert engine.inflight == 1
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0.05)
    assert len(engine.aborted) == 1
    assert app.state.engine_pool.inflight(RUNTIME_KEY) == 0


async def test_a_client_disconnect_aborts_the_decode_and_releases_the_lease(  # type: ignore[no-untyped-def]
    app, factory
) -> None:
    """Driven at the ASGI layer: the body arrives, then `http.disconnect` — what uvicorn
    delivers when the peer closes the socket. Starlette never cancels a handler for that,
    so the route itself must notice and abort."""
    import httpx

    factory.engine_delay_s = 5.0
    data, files = transcription_form()
    built = httpx.Request("POST", f"http://t{ROUTE}", data=data, files=files, headers=HEADERS)
    body = built.read()
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": ROUTE,
        "raw_path": ROUTE.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(k.lower().encode(), v.encode()) for k, v in built.headers.items()],
        "client": ("127.0.0.1", 1234),
        "server": ("t", 80),
        "state": {},
    }
    loop = asyncio.get_running_loop()
    hang_up_at: float | None = None

    async def receive() -> dict[str, Any]:
        # uvicorn's contract: the body, then — once the peer has gone — `http.disconnect`
        # IMMEDIATELY on every later call (it is already queued), never before.
        nonlocal hang_up_at
        if hang_up_at is None:
            hang_up_at = loop.time() + 0.2  # the peer hangs up while the decode runs
            return {"type": "http.request", "body": body, "more_body": False}
        remaining = hang_up_at - loop.time()
        if remaining > 0:
            await asyncio.sleep(remaining)
        return {"type": "http.disconnect"}

    messages: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        messages.append(message)

    async with app.router.lifespan_context(app):
        await asyncio.wait_for(app(scope, receive, send), timeout=3.0)
        engine = factory.engines[RUNTIME_KEY]
        assert len(engine.aborted) == 1
        assert app.state.engine_pool.inflight(RUNTIME_KEY) == 0


# ── GET /v1/models ──────────────────────────────────────────────────────────


async def test_models_lists_resident_engines(client) -> None:  # type: ignore[no-untyped-def]
    assert (await client.get("/v1/models", headers=HEADERS)).json() == {
        "object": "list",
        "data": [],
    }
    await post(client)
    assert (await client.get("/v1/models", headers=HEADERS)).json() == {
        "object": "list",
        "data": [
            {
                "id": SLUG,
                "object": "model",
                "owned_by": "hope",
                "x_hope": {"kind": "asr", "resident": True, "pinned": False},
            }
        ],
    }


async def test_models_never_lists_another_tenants_resident_model(client, resolver) -> None:  # type: ignore[no-untyped-def]
    other = "70000000-0000-0000-0000-000000000007"
    resolver.specs["byo-model"] = serving_spec_payload(
        slug="byo-model", runtimeKey="byo:v1", tenantId=other
    )
    await post(client, model="byo-model", headers={"X-Tenant-Id": other})
    mine = (await client.get("/v1/models", headers=HEADERS)).json()["data"]
    theirs = (await client.get("/v1/models", headers={"X-Tenant-Id": other})).json()["data"]
    assert [m["id"] for m in mine] == []
    assert [m["id"] for m in theirs] == ["byo-model"]
    assert SYSTEM_TENANT_ID != other


async def test_models_lists_a_pin_before_it_is_resident(settings: Settings) -> None:
    from hope_vllm.core.control_plane import apply_control_plane

    pool = {"acceptedKinds": ["asr"], "pins": [SLUG], "vramBudgetGiB": 6, "maxResidentEngines": 1}
    apply_control_plane(settings, {"settings": {"vllm.pools": {"value": {"default": pool}}}})
    factory = FakeEngineFactory(build_delay_s=0.3)
    app = create_app(settings, engine_factory=factory, serving_spec_client=FakeSpecResolver())
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            for _ in range(100):  # until the pin has been resolved and is loading
                if app.state.engine_pool.snapshot()["loading"]:
                    break
                await asyncio.sleep(0.01)
            early = (await c.get("/v1/models", headers=HEADERS)).json()["data"]
            await app.state.pins_task
            late = (await c.get("/v1/models", headers=HEADERS)).json()["data"]
    assert [(m["id"], m["x_hope"]) for m in early] == [
        (SLUG, {"kind": "asr", "resident": False, "pinned": True})
    ]
    assert [(m["id"], m["x_hope"]) for m in late] == [
        (SLUG, {"kind": "asr", "resident": True, "pinned": True})
    ]


async def test_models_needs_a_tenant(client) -> None:  # type: ignore[no-untyped-def]
    response = await client.get("/v1/models")
    assert response.status_code == 400
    assert openai_error(response)["code"] == "tenant_id_required"


# ── the house routes the shell keeps ────────────────────────────────────────


async def test_warm_takes_a_model_slug_for_the_tenant(client, resolver, factory) -> None:  # type: ignore[no-untyped-def]
    response = await client.post("/api/v1/engines/warm", json={"model": SLUG}, headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert body["runtime_key"] == RUNTIME_KEY and body["already_resident"] is False
    assert resolver.calls == [(SLUG, TENANT_ID)]
    again = await client.post("/api/v1/engines/warm", json={"model": SLUG}, headers=HEADERS)
    assert again.json()["already_resident"] is True
    assert factory.builds == [RUNTIME_KEY]


async def test_warm_needs_a_tenant_and_names_its_errors(client, resolver) -> None:  # type: ignore[no-untyped-def]
    assert (await client.post("/api/v1/engines/warm", json={"model": SLUG})).status_code == 400
    resolver.missing.add("nope")
    response = await client.post("/api/v1/engines/warm", json={"model": "nope"}, headers=HEADERS)
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "MODEL_NOT_FOUND"


async def test_engines_is_the_pool_snapshot(client) -> None:  # type: ignore[no-untyped-def]
    await post(client)
    body = (await client.get("/api/v1/engines")).json()
    assert [e["runtime_key"] for e in body["loaded"]] == [RUNTIME_KEY]
    assert body["vram_budget_gib"] == 6.0


async def test_the_spike_route_is_gone(client) -> None:  # type: ignore[no-untyped-def]
    response = await client.post("/api/v1/transcriptions", json={}, headers=HEADERS)
    assert response.status_code == 404


def test_no_error_body_is_ever_the_fastapi_default_on_v1() -> None:
    """Every `/v1/*` refusal above goes through `openai_error`; this pins the helper."""
    from hope_vllm.api.openai_errors import openai_error_body

    assert json.loads(openai_error_body("m", "t", "p", "c")) == {
        "error": {"message": "m", "type": "t", "param": "p", "code": "c"}
    }


# ── fix round 1 · M2: the upload is capped before it is read ────────────────


async def test_an_upload_larger_than_any_30s_wav_is_refused_unread(client, factory) -> None:  # type: ignore[no-untyped-def]
    from hope_vllm.api.endpoints.openai_transcriptions import MAX_UPLOAD_BYTES
    from hope_vllm.audio import MAX_SAMPLE_RATE

    assert MAX_UPLOAD_BYTES >= 30 * MAX_SAMPLE_RATE * 2  # a legal 30 s file always fits
    response = await post(client, audio=b"RIFF" + b"\0" * MAX_UPLOAD_BYTES)
    assert response.status_code == 400
    error = openai_error(response)
    assert (error["code"], error["param"]) == ("audio_too_long", "file")
    assert factory.builds == []


async def test_a_legal_30s_wav_at_the_highest_accepted_rate_is_accepted(client) -> None:  # type: ignore[no-untyped-def]
    from hope_vllm.audio import MAX_SAMPLE_RATE

    response = await post(client, audio=wav_bytes(30.0, rate=MAX_SAMPLE_RATE))
    assert response.status_code == 200


async def test_a_sample_rate_above_the_maximum_is_unsupported(client) -> None:  # type: ignore[no-untyped-def]
    from hope_vllm.audio import MAX_SAMPLE_RATE

    response = await post(client, audio=wav_bytes(0.5, rate=MAX_SAMPLE_RATE * 2))
    assert response.status_code == 400
    assert openai_error(response)["code"] == "unsupported_audio"
