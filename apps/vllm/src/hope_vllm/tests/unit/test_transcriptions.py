"""POST /api/v1/transcriptions and POST /api/v1/engines/warm."""

from __future__ import annotations

import asyncio

import numpy as np
import pytest
from httpx import ASGITransport, AsyncClient

from hope_vllm.core.config import Settings
from hope_vllm.engine.base import EngineBuildRefused
from hope_vllm.main import create_app
from hope_vllm.tests.conftest import (
    DROP,
    TENANT_ID,
    pcm16_b64,
    serving_spec_payload,
    transcription_body,
)
from hope_vllm.tests.fakes import FakeEngineFactory

HEADERS = {"X-Tenant-Id": TENANT_ID}


async def test_returns_text_language_timings_and_runtime_key(client, factory) -> None:  # type: ignore[no-untyped-def]
    response = await client.post(
        "/api/v1/transcriptions", json=transcription_body(), headers=HEADERS
    )

    assert response.status_code == 200
    body = response.json()
    assert body["text"] == "hello world from the fake engine"
    assert body["language"] == "ml"
    assert body["runtime_key"] == "model-0001:v1"
    assert body["audio_seconds"] == pytest.approx(7.0)
    assert body["finish_reason"] == "stop"
    assert set(body["timings"]) == {"queue_ms", "decode_ms", "engine_queue_ms"}
    assert body["timings"]["queue_ms"] >= 0 and body["timings"]["decode_ms"] >= 0
    assert set(body["truncation"]) == {"suspected", "reason", "voiced_seconds", "chars"}


async def test_hands_the_engine_float32_audio_and_the_decode_params(client, factory) -> None:  # type: ignore[no-untyped-def]
    body = transcription_body(
        prompt="previous words", temperature=0.2, max_tokens=120, language="en"
    )
    assert (
        await client.post("/api/v1/transcriptions", json=body, headers=HEADERS)
    ).status_code == 200

    (request,) = factory.engines["model-0001:v1"].requests
    assert request.audio.dtype == np.float32 and request.audio.shape == (7 * 16_000,)
    assert request.language == "en"
    assert request.prompt == "previous words"
    assert request.temperature == pytest.approx(0.2)
    assert request.max_tokens == 120
    assert request.request_id


async def test_tenant_header_is_required(client) -> None:  # type: ignore[no-untyped-def]
    response = await client.post("/api/v1/transcriptions", json=transcription_body())
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "TENANT_ID_REQUIRED"


async def test_a_window_over_thirty_seconds_is_refused_by_name(client) -> None:  # type: ignore[no-untyped-def]
    body = transcription_body(audio_b64=pcm16_b64(31.0))
    response = await client.post("/api/v1/transcriptions", json=body, headers=HEADERS)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "WINDOW_TOO_LONG"


async def test_malformed_audio_is_refused_by_name(client) -> None:  # type: ignore[no-untyped-def]
    body = transcription_body(audio_b64="%%%")
    response = await client.post("/api/v1/transcriptions", json=body, headers=HEADERS)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "AUDIO_NOT_BASE64"


@pytest.mark.parametrize(
    "override",
    [
        {"format": "WHISPER_CPP"},  # a GGUF row cannot load in vLLM — fail closed
        {"format": "FASTER_WHISPER"},
        {"runtimeKey": ""},
        # The registry identity must be present — a body without it is not a resolver's.
        {"runtimeKey": DROP},
        {"tenantId": DROP},
        {"checksum": DROP},
    ],
)
async def test_a_spec_this_engine_cannot_serve_is_refused(client, factory, override) -> None:  # type: ignore[no-untyped-def]
    body = transcription_body(spec=serving_spec_payload(**override))
    response = await client.post("/api/v1/transcriptions", json=body, headers=HEADERS)
    assert response.status_code == 422
    assert factory.builds == []


async def test_non_16khz_audio_is_refused(client) -> None:  # type: ignore[no-untyped-def]
    body = transcription_body(sample_rate=8000)
    assert (
        await client.post("/api/v1/transcriptions", json=body, headers=HEADERS)
    ).status_code == 422


async def test_backend_unavailable_is_503(settings: Settings) -> None:
    app = create_app(settings, engine_factory=FakeEngineFactory(unavailable_reason="no vllm"))
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/api/v1/transcriptions", json=transcription_body(), headers=HEADERS
            )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "ENGINE_BACKEND_UNAVAILABLE"


async def test_engine_load_failure_is_503(settings: Settings) -> None:
    app = create_app(settings, engine_factory=FakeEngineFactory(fail_with=RuntimeError("CUDA OOM")))
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/api/v1/transcriptions", json=transcription_body(), headers=HEADERS
            )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "ENGINE_LOAD_FAILED"


async def test_runtime_key_reused_for_a_different_model_is_409(client) -> None:  # type: ignore[no-untyped-def]
    assert (
        await client.post("/api/v1/transcriptions", json=transcription_body(), headers=HEADERS)
    ).status_code == 200
    drifted = transcription_body(spec=serving_spec_payload(localPath="/some/other/weights"))
    response = await client.post("/api/v1/transcriptions", json=drifted, headers=HEADERS)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "RUNTIME_KEY_SPEC_MISMATCH"


async def test_all_resident_engines_busy_is_503_with_retry_after(settings: Settings) -> None:
    factory = FakeEngineFactory(engine_delay_s=0.2)
    app = create_app(settings, engine_factory=factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            busy = asyncio.create_task(
                client.post("/api/v1/transcriptions", json=transcription_body(), headers=HEADERS)
            )
            await asyncio.sleep(0.05)
            other = transcription_body(
                spec=serving_spec_payload(runtimeKey="another-agent-version")
            )
            response = await client.post("/api/v1/transcriptions", json=other, headers=HEADERS)
            assert (await busy).status_code == 200
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "ENGINE_CAPACITY"
    assert "retry-after" in response.headers


async def test_concurrent_requests_reach_the_engine_concurrently(settings: Settings) -> None:
    """Batching is vLLM's job: the service must never serialise windows in front of it."""
    factory = FakeEngineFactory(engine_delay_s=0.1)
    app = create_app(settings, engine_factory=factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            responses = await asyncio.gather(
                *(
                    client.post(
                        "/api/v1/transcriptions", json=transcription_body(), headers=HEADERS
                    )
                    for _ in range(25)
                )
            )
    assert all(r.status_code == 200 for r in responses)
    assert factory.builds == ["model-0001:v1"]
    assert factory.engines["model-0001:v1"].max_inflight == 25


async def test_short_output_on_voiced_audio_is_flagged_as_suspected_truncation(
    settings: Settings,
) -> None:
    app = create_app(settings, engine_factory=FakeEngineFactory(engine_text="ok"))
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            body = (
                await client.post(
                    "/api/v1/transcriptions", json=transcription_body(), headers=HEADERS
                )
            ).json()
    assert body["truncation"]["suspected"] is True
    assert body["truncation"]["reason"] == "short_output_for_voiced_audio"
    assert body["truncation"]["voiced_seconds"] == pytest.approx(7.0, abs=0.1)


async def test_warm_loads_the_engine_and_reports_load_time(client, factory) -> None:  # type: ignore[no-untyped-def]
    response = await client.post(
        "/api/v1/engines/warm", json={"spec": serving_spec_payload()}, headers=HEADERS
    )
    assert response.status_code == 200
    body = response.json()
    assert body["runtime_key"] == "model-0001:v1"
    assert body["already_resident"] is False
    assert body["load_seconds"] >= 0

    again = (
        await client.post(
            "/api/v1/engines/warm", json={"spec": serving_spec_payload()}, headers=HEADERS
        )
    ).json()
    assert again["already_resident"] is True
    assert factory.builds == ["model-0001:v1"]


async def test_warm_requires_the_tenant_header(client) -> None:  # type: ignore[no-untyped-def]
    response = await client.post("/api/v1/engines/warm", json={"spec": serving_spec_payload()})
    assert response.status_code == 400


@pytest.mark.parametrize(
    "code",
    [
        "MODEL_CREDENTIAL_DENIED",
        "MODEL_CREDENTIAL_UNAVAILABLE",
        "MODEL_CHECKSUM_MISMATCH",
        "QUANTIZATION_UNSUPPORTED_ON_GPU",
    ],
)
async def test_a_named_build_refusal_is_a_503_carrying_its_reason(
    settings: Settings, code: str
) -> None:
    factory = FakeEngineFactory(fail_with=EngineBuildRefused(code, f"because {code}"))
    app = create_app(settings, engine_factory=factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            window = await client.post(
                "/api/v1/transcriptions", json=transcription_body(), headers=HEADERS
            )
            warm = await client.post(
                "/api/v1/engines/warm", json={"spec": serving_spec_payload()}, headers=HEADERS
            )
    for response in (window, warm):
        assert response.status_code == 503
        assert response.json()["detail"] == {"code": code, "message": f"because {code}"}
