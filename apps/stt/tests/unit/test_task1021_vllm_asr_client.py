"""TASK-1021 L3.2 — the `vllm` REST client (contract C-3), with backpressure.

`respx` is not installed in the `arcaenv` interpreter, so the wire is mocked with
httpx's own ``MockTransport`` behind the module's client factory — the same
request/response objects `respx` would route.
"""

from __future__ import annotations

import asyncio
import email
import email.policy
from collections.abc import Callable
from typing import Any

import httpx
import numpy as np
import pytest
from opentelemetry.sdk.trace import TracerProvider

from stt.core.exceptions import (
    CloudASRAuthError,
    CloudASRQuotaError,
    CloudASRTranscriptionError,
)
from stt.models.vllm_loader import VllmAsrConfig
from stt.streaming import vllm_asr
from stt.streaming.vllm_asr import vllm_recognize_utterance

SR = 16_000
SAMPLES = np.zeros(SR, dtype=np.float32)
TEXT = "രോഗിക്ക് പനി ഉണ്ട് fever since two days"


def _config(max_concurrent: int | None = None, base_url: str = "http://vllm.test/v1"):
    return VllmAsrConfig(
        base_url=base_url, model_slug="ml-en-vllm", max_concurrent=max_concurrent, timeout_s=5.0
    )


def _body(truncation: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "task": "transcribe",
        "language": "ml",
        "duration": 1.0,
        "text": f" {TEXT} ",
        "segments": [],
        "x_hope": {
            "finish_reason": "stop",
            "decode_ms": 12.0,
            "engine_queue_ms": 0.1,
            "truncation": truncation
            or {"suspected": False, "reason": None, "voiced_seconds": 0.9, "chars": 38},
        },
    }


@pytest.fixture
def wire(monkeypatch: pytest.MonkeyPatch) -> Callable[[Any], list[httpx.Request]]:
    """Install a handler; returns the list of requests it saw."""

    def install(handler: Any) -> list[httpx.Request]:
        seen: list[httpx.Request] = []

        async def recording(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            result = handler(request)
            if asyncio.iscoroutine(result):
                result = await result
            return result

        transport = httpx.MockTransport(recording)
        monkeypatch.setattr(
            vllm_asr,
            "_http_client",
            lambda timeout_s: httpx.AsyncClient(transport=transport, timeout=timeout_s),
        )
        return seen

    return install


async def _call(config: VllmAsrConfig | None = None, **kw: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "language": "ml",
        "prompt": None,
        "tenant_id": "tenant-a",
        "request_id": "req-1",
        "service_token": "svc-token",
    }
    kwargs.update(kw)
    return await vllm_recognize_utterance(config or _config(), SAMPLES, SR, **kwargs)


def _form(request: httpx.Request) -> dict[str, str]:
    """The multipart TEXT fields of a request (the `file` part excluded)."""
    ctype = request.headers["content-type"]
    raw = f"Content-Type: {ctype}\r\n\r\n".encode() + request.content
    msg = email.message_from_bytes(raw, policy=email.policy.HTTP)
    fields: dict[str, str] = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if part.get_filename() is None:
            fields[str(name)] = part.get_content()
    return fields


# ---------------------------------------------------------------------------
# the request
# ---------------------------------------------------------------------------


async def test_the_multipart_carries_model_language_and_verbose_json(wire) -> None:
    seen = wire(lambda r: httpx.Response(200, json=_body()))

    result = await _call(language="ml-IN")

    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == "http://vllm.test/v1/audio/transcriptions"
    form = _form(request)
    assert form["model"] == "ml-en-vllm"
    assert form["language"] == "ml"  # ISO-639-1 primary subtag
    assert form["response_format"] == "verbose_json"
    assert "prompt" not in form
    assert b'filename="audio.wav"' in request.content
    assert result["text"] == TEXT
    assert result["language"] == "ml"
    assert result["word_timestamps"] == []
    assert result["truncation"]["suspected"] is False
    assert result["request_bytes"] > 0
    assert result["response_bytes"] > 0
    assert "byte_source" in result


async def test_the_prompt_is_sent_only_when_set(wire) -> None:
    seen = wire(lambda r: httpx.Response(200, json=_body()))

    await _call(prompt="Clinical consultation.")
    await _call(prompt="")

    assert _form(seen[0])["prompt"] == "Clinical consultation."
    assert "prompt" not in _form(seen[1])


async def test_all_four_headers_are_present(wire) -> None:
    seen = wire(lambda r: httpx.Response(200, json=_body()))

    tracer = TracerProvider().get_tracer("task1021")
    with tracer.start_as_current_span("utterance"):
        await _call()

    headers = seen[0].headers
    assert headers["X-Service-Token"] == "svc-token"
    assert headers["X-Tenant-Id"] == "tenant-a"
    assert headers["X-Request-Id"] == "req-1"
    assert headers["traceparent"].startswith("00-")


async def test_no_request_id_header_when_none_is_set(wire) -> None:
    seen = wire(lambda r: httpx.Response(200, json=_body()))

    await _call(request_id=None)

    assert "X-Request-Id" not in seen[0].headers


# ---------------------------------------------------------------------------
# retries and error taxonomy
# ---------------------------------------------------------------------------


async def test_a_429_with_retry_after_is_retried_once_then_succeeds(wire) -> None:
    responses = iter(
        [
            httpx.Response(429, headers={"Retry-After": "0.1"}, json={"error": {}}),
            httpx.Response(200, json=_body()),
        ]
    )
    seen = wire(lambda r: next(responses))

    result = await _call()

    assert len(seen) == 2
    assert result["text"] == TEXT


async def test_a_429_that_persists_raises_the_quota_error(wire) -> None:
    seen = wire(lambda r: httpx.Response(429, headers={"Retry-After": "0"}, json={}))

    with pytest.raises(CloudASRQuotaError):
        await _call()
    assert len(seen) == 3  # one call + two retries


async def test_three_503s_raise_the_transcription_error(wire) -> None:
    seen = wire(lambda r: httpx.Response(503, headers={"Retry-After": "0"}, json={}))

    with pytest.raises(CloudASRTranscriptionError):
        await _call()
    assert len(seen) == 3


async def test_a_400_is_not_retried(wire) -> None:
    seen = wire(
        lambda r: httpx.Response(
            400, json={"error": {"code": "audio_too_long", "type": "invalid_request_error"}}
        )
    )

    with pytest.raises(CloudASRTranscriptionError, match="audio_too_long"):
        await _call()
    assert len(seen) == 1


async def test_a_401_is_an_auth_error_and_not_retried(wire) -> None:
    seen = wire(lambda r: httpx.Response(401, json={}))

    with pytest.raises(CloudASRAuthError):
        await _call()
    assert len(seen) == 1


async def test_a_transport_failure_is_a_transcription_error(wire) -> None:
    def _boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    wire(_boom)

    with pytest.raises(CloudASRTranscriptionError):
        await _call()


async def test_a_missing_language_fails_before_the_wire(wire) -> None:
    seen = wire(lambda r: httpx.Response(200, json=_body()))

    with pytest.raises(CloudASRTranscriptionError, match="language"):
        await _call(language="")
    assert seen == []


# ---------------------------------------------------------------------------
# backpressure
# ---------------------------------------------------------------------------


async def test_max_concurrent_caps_in_flight_requests_per_base_url(wire) -> None:
    gate = asyncio.Event()
    in_flight = 0
    peak = 0

    async def gated(request: httpx.Request) -> httpx.Response:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await gate.wait()
        in_flight -= 1
        return httpx.Response(200, json=_body())

    seen = wire(gated)
    config = _config(max_concurrent=2, base_url="http://cap.test/v1")

    tasks = [asyncio.create_task(_call(config)) for _ in range(3)]
    for _ in range(20):
        await asyncio.sleep(0)
    assert in_flight == 2  # the third call is waiting on the semaphore
    assert len(seen) == 2

    gate.set()
    await asyncio.gather(*tasks)
    assert peak == 2
    assert len(seen) == 3


async def test_unbounded_when_max_concurrent_is_none(wire) -> None:
    gate = asyncio.Event()
    in_flight = 0

    async def gated(request: httpx.Request) -> httpx.Response:
        nonlocal in_flight
        in_flight += 1
        await gate.wait()
        return httpx.Response(200, json=_body())

    wire(gated)
    config = _config(max_concurrent=None, base_url="http://open.test/v1")

    tasks = [asyncio.create_task(_call(config)) for _ in range(5)]
    for _ in range(20):
        await asyncio.sleep(0)
    assert in_flight == 5
    gate.set()
    await asyncio.gather(*tasks)


# ---------------------------------------------------------------------------
# truncation
# ---------------------------------------------------------------------------


class _RecordingLogger:
    """Stands in for the module logger: structlog may already be configured (and its
    loggers cached) by an earlier test, which ``capture_logs`` cannot intercept."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def _record(self, event: str, **fields: Any) -> None:
        self.events.append({"event": event, **fields})

    info = warning = error = debug = _record


async def test_a_suspected_truncation_is_logged_without_the_transcript(
    wire, monkeypatch: pytest.MonkeyPatch
) -> None:
    truncation = {
        "suspected": True,
        "reason": "chars_per_voiced_second",
        "voiced_seconds": 9.7,
        "chars": 12,
    }
    wire(lambda r: httpx.Response(200, json=_body(truncation)))
    recorder = _RecordingLogger()
    monkeypatch.setattr(vllm_asr, "logger", recorder)

    result = await _call()

    logs = recorder.events
    events = [e for e in logs if e["event"] == "stt.vllm.truncation_suspected"]
    assert len(events) == 1
    event = events[0]
    assert event["model_slug"] == "ml-en-vllm"
    assert event["reason"] == "chars_per_voiced_second"
    assert event["voiced_seconds"] == 9.7
    assert event["chars"] == 12
    assert TEXT not in repr(logs)
    assert result["truncation"]["suspected"] is True
