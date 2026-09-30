"""L2.5: the Prometheus contract, no transcript in any log, and a graceful drain.

* Every ``hope_vllm_*`` series the dashboards and the HPA candidates read, plus the
  model-residency contract (``model_resident_bytes{service,model,device}``,
  ``model_load_seconds{service,model}`` — ``hope_runtime_models.metrics``), after ONE
  request. No series carries a tenant label; ``model`` is the slug.
* No transcript text reaches a log line.
* SIGTERM → draining: new ``/v1/*`` requests get 503 ``draining``, ``/health/ready`` is
  503, and a decode already in flight completes before the pool is closed.
"""

from __future__ import annotations

import asyncio
import logging
import re
import signal
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from hope_vllm.core.config import Settings
from hope_vllm.main import begin_drain, create_app
from hope_vllm.tests.conftest import HEADERS, RUNTIME_KEY, transcription_form
from hope_vllm.tests.fakes import FakeEngineFactory, FakeSpecResolver

ROUTE = "/v1/audio/transcriptions"

HOPE_SERIES = (
    "hope_vllm_requests_total",
    "hope_vllm_request_seconds",
    "hope_vllm_asr_rtf",
    "hope_vllm_inflight",
    "hope_vllm_queue_depth",
    "hope_vllm_rejections_total",
    "hope_vllm_engine_loads_total",
    "hope_vllm_engine_evictions_total",
    "hope_vllm_resident_gib",
    "hope_vllm_vram_budget_gib",
)


async def post(client: AsyncClient, **form: Any) -> Any:
    data, files = transcription_form(**form)
    return await client.post(ROUTE, data=data, files=files, headers=HEADERS)


def series(text: str, name: str) -> list[str]:
    return [
        line
        for line in text.splitlines()
        if re.match(rf"{name}(_bucket|_sum|_count|_total)?[{{ ]", line)
    ]


# ── metrics ─────────────────────────────────────────────────────────────────


async def test_every_hope_vllm_series_is_exposed_after_one_request(client, resolver) -> None:  # type: ignore[no-untyped-def]
    resolver.missing.add("missing-model")
    assert (await post(client, model="missing-model")).status_code == 404  # a rejection
    assert (await post(client, model="other-model")).status_code == 200  # a load
    assert (await post(client)).status_code == 200  # an eviction (the pool holds one)
    text = (await client.get("/metrics")).text
    for name in HOPE_SERIES:
        assert series(text, name), f"{name} is not exposed"


async def test_the_request_series_are_labelled_by_route_kind_model_and_status(client) -> None:  # type: ignore[no-untyped-def]
    await post(client)
    text = (await client.get("/metrics")).text
    assert re.search(
        r'hope_vllm_requests_total\{kind="asr",model="arcaai-whisper-large-ml-en-vllm",'
        r'route="/v1/audio/transcriptions",status="200"\} [1-9]',
        text,
    ), series(text, "hope_vllm_requests_total")
    assert re.search(
        r'hope_vllm_asr_rtf_count\{model="arcaai-whisper-large-ml-en-vllm"\} [1-9]', text
    )
    assert re.search(r"hope_vllm_vram_budget_gib 6\.0", text)
    assert re.search(r"hope_vllm_resident_gib 3\.0", text)


async def test_the_model_residency_contract_is_exposed(client) -> None:  # type: ignore[no-untyped-def]
    await post(client)
    text = (await client.get("/metrics")).text
    assert re.search(
        r'model_resident_bytes\{device="cuda:0",model="arcaai-whisper-large-ml-en-vllm",'
        r'service="vllm"\} 3\.221225472e\+09',
        text,
    ), series(text, "model_resident_bytes")
    assert re.search(
        r'model_load_seconds_count\{model="arcaai-whisper-large-ml-en-vllm",service="vllm"\} [1-9]',
        text,
    )


async def test_a_refusal_is_counted_by_reason(client, resolver) -> None:  # type: ignore[no-untyped-def]
    resolver.missing.add("nope")
    await post(client, model="nope")
    text = (await client.get("/metrics")).text
    assert re.search(r'hope_vllm_rejections_total\{reason="model_not_found"\} [1-9]', text)
    # An unresolved slug never becomes a label value (a client could otherwise mint series).
    assert 'model="nope"' not in text


async def test_no_series_carries_a_tenant_label(client) -> None:  # type: ignore[no-untyped-def]
    await post(client)
    text = (await client.get("/metrics")).text
    assert "tenant" not in text.lower()


# ── no transcript text in any log ───────────────────────────────────────────


async def test_no_transcript_text_is_ever_logged(
    settings: Settings, caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    secret = "PATIENT-SAID-SOMETHING-PRIVATE"
    factory = FakeEngineFactory(engine_text=secret, engine_finish_reason="length")
    app = create_app(settings, engine_factory=factory, serving_spec_client=FakeSpecResolver())
    caplog.set_level(logging.DEBUG)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
            for fmt in ("json", "text", "verbose_json"):
                assert secret in (await post(c, response_format=fmt)).text
    captured = capsys.readouterr()
    assert secret not in caplog.text
    assert secret not in captured.out and secret not in captured.err


# ── drain ───────────────────────────────────────────────────────────────────


async def test_draining_refuses_new_requests_and_readiness(client, app) -> None:  # type: ignore[no-untyped-def]
    begin_drain(app)
    response = await post(client)
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "1"
    assert response.json()["error"]["type"] == "server_error"
    assert response.json()["error"]["code"] == "draining"
    assert (await client.get("/v1/models", headers=HEADERS)).status_code == 503
    ready = await client.get("/api/v1/health/ready")
    assert ready.status_code == 503 and ready.json()["status"] == "draining"
    assert (await client.get("/api/v1/health/live")).status_code == 200


async def test_an_inflight_decode_completes_while_draining(client, app, factory) -> None:  # type: ignore[no-untyped-def]
    factory.engine_delay_s = 0.3
    inflight = asyncio.create_task(post(client))
    await asyncio.sleep(0.05)
    begin_drain(app)
    assert (await post(client)).status_code == 503
    assert (await inflight).status_code == 200


async def test_shutdown_waits_for_inflight_leases_before_closing_the_pool(
    settings: Settings,
) -> None:
    factory = FakeEngineFactory(engine_delay_s=0.3)
    app = create_app(settings, engine_factory=factory, serving_spec_client=FakeSpecResolver())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        async with app.router.lifespan_context(app):
            inflight = asyncio.create_task(post(c))
            await asyncio.sleep(0.05)
        # The lifespan exit (= SIGTERM after uvicorn stopped accepting) drained first.
        assert inflight.done()
        assert (await inflight).status_code == 200
    engine = factory.engines[RUNTIME_KEY]
    assert engine.shut_down is True
    assert engine.aborted == []


async def test_sigterm_starts_the_drain_and_still_reaches_the_servers_own_handler(
    settings: Settings,
) -> None:
    """The lifespan chains onto whatever SIGTERM handler the server (uvicorn) installed."""
    seen: list[int] = []

    def server_handler(signum: int, frame: object) -> None:
        seen.append(signum)

    previous = signal.signal(signal.SIGTERM, server_handler)
    try:
        app = create_app(
            settings, engine_factory=FakeEngineFactory(), serving_spec_client=FakeSpecResolver()
        )
        async with app.router.lifespan_context(app):
            handler = signal.getsignal(signal.SIGTERM)
            assert callable(handler) and handler is not server_handler
            handler(signal.SIGTERM, None)  # type: ignore[operator]
            assert app.state.draining is True
            assert seen == [signal.SIGTERM]
        assert signal.getsignal(signal.SIGTERM) is server_handler  # restored
    finally:
        signal.signal(signal.SIGTERM, previous)
