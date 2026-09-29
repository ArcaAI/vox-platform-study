"""TASK-1021 L3 fix round 1 — review findings on the `vllm` engine.

1. A failing window cancels its sibling windows (no orphan GPU requests) and the
   caller still sees the typed Cloud ASR error, never an ``ExceptionGroup``.
2. The session tenant is threaded EXPLICITLY into the streaming callable.
3. The batch job tenant is threaded through ``run_batch``.
4. A 503 is retried only for engine capacity; any other 503 fails over at once.
5. The deliberate no-``prompt`` signature does not warn.
6. The batch language receipt names the `vllm` engine.
"""

from __future__ import annotations

import asyncio
import copy
import email
import email.policy
import io
import json
import wave
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import httpx
import numpy as np
import pytest
from pydantic import SecretStr

from stt.core.config.settings import get_settings
from stt.core.exceptions import CloudASRQuotaError, CloudASRTranscriptionError
from stt.models.base_loader import LoadedModel
from stt.models.vllm_loader import VllmAsrConfig
from stt.pipeline.dto import AiModelFormat, InferenceConfig
from stt.streaming import vllm_asr
from stt.streaming.session_manager import SessionManager
from stt.streaming.vllm_asr import VllmSessionContextError, vllm_recognize_windows
from stt.transcription.batch_service import BatchTranscriptionService

SR = 16_000
SLUG = "arcaai-whisper-large-ml-en-vllm"


def _config(max_concurrent: int | None = None) -> VllmAsrConfig:
    return VllmAsrConfig(
        base_url="http://vllm.test/v1", model_slug=SLUG, max_concurrent=max_concurrent, timeout_s=5
    )


def _loaded() -> LoadedModel:
    return LoadedModel(
        model_id="m", model_slug=SLUG, model=_config(), format=AiModelFormat.VLLM, device="remote"
    )


def _ok(text: str = "hello") -> httpx.Response:
    return httpx.Response(200, json={"text": text, "language": "ml", "x_hope": {}})


def _wav_seconds(request: httpx.Request) -> float:
    raw = f"Content-Type: {request.headers['content-type']}\r\n\r\n".encode() + request.content
    msg = email.message_from_bytes(raw, policy=email.policy.HTTP)
    for part in msg.iter_parts():
        if part.get_filename() is not None:
            with wave.open(io.BytesIO(part.get_payload(decode=True))) as wf:
                return wf.getnframes() / float(wf.getframerate())
    raise AssertionError("no file part")


@pytest.fixture
def wire(monkeypatch: pytest.MonkeyPatch):
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


@pytest.fixture(autouse=True)
def _token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "internal_access_token", SecretStr("svc-token"))


def _speech_with_pauses(total_s: float, pauses_s: list[float]) -> np.ndarray:
    audio = np.random.default_rng(1).normal(0, 0.2, int(total_s * SR)).astype(np.float32)
    for at in pauses_s:
        audio[int(at * SR) : int((at + 0.5) * SR)] = 0.0
    return audio


async def _windows(**kw: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "window_s": None,
        "language": "ml",
        "prompt": None,
        "tenant_id": "tenant-a",
        "request_id": None,
        "service_token": "svc-token",
    }
    kwargs.update(kw)
    audio = _speech_with_pauses(70.0, [27.75, 49.75])
    return await vllm_recognize_windows(_config(), audio, SR, **kwargs)


# ---------------------------------------------------------------------------
# 1 — structured concurrency
# ---------------------------------------------------------------------------


async def test_a_failing_window_cancels_its_in_flight_siblings(wire) -> None:
    cancelled: list[float] = []
    started = 0
    siblings_waiting = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal started
        seconds = _wav_seconds(request)
        if seconds > 25:  # the first (longest) window fails once its siblings are waiting
            await asyncio.wait_for(siblings_waiting.wait(), timeout=2.0)
            return httpx.Response(400, json={"error": {"code": "unsupported_audio"}})
        started += 1
        if started == 2:
            siblings_waiting.set()
        try:
            await asyncio.Event().wait()  # never completes on its own
        except asyncio.CancelledError:
            cancelled.append(seconds)
            raise
        raise AssertionError("unreachable")

    wire(handler)

    with pytest.raises(CloudASRTranscriptionError, match="unsupported_audio"):
        await asyncio.wait_for(_windows(), timeout=5.0)
    assert len(cancelled) == 2


async def test_the_typed_error_survives_the_task_group_unwrapped(wire) -> None:
    wire(lambda r: httpx.Response(429, headers={"Retry-After": "0"}, json={}))

    with pytest.raises(CloudASRQuotaError) as info:
        await _windows()
    assert not isinstance(info.value, BaseExceptionGroup)


# ---------------------------------------------------------------------------
# 2 — the streaming tenant is explicit
# ---------------------------------------------------------------------------


def _bare_manager() -> MagicMock:
    mgr = MagicMock(spec=SessionManager)
    mgr._make_vllm_callable = lambda *a, **k: SessionManager._make_vllm_callable(mgr, *a, **k)
    return mgr


async def test_two_sessions_each_carry_their_own_tenant(wire) -> None:
    seen = wire(lambda r: _ok())
    mgr = _bare_manager()
    config = InferenceConfig(language="ml")

    run_a = SessionManager._make_asr_callable(mgr, _loaded(), config, tenant_id="tenant-a")
    run_b = SessionManager._make_asr_callable(mgr, _loaded(), config, tenant_id="tenant-b")
    await run_b(np.zeros(SR, dtype=np.float32), SR)
    await run_a(np.zeros(SR, dtype=np.float32), SR)

    assert [r.headers["X-Tenant-Id"] for r in seen] == ["tenant-b", "tenant-a"]


def test_no_manager_state_carries_a_tenant_between_builds() -> None:
    """The removed stash must stay removed: a build reads only its own argument."""
    mgr = _bare_manager()
    mgr._pending_tenant_id = "someone-else"

    with pytest.raises(VllmSessionContextError, match="tenant"):
        SessionManager._make_asr_callable(mgr, _loaded(), InferenceConfig(language="ml"))


# ---------------------------------------------------------------------------
# 3 — the batch tenant is explicit
# ---------------------------------------------------------------------------


async def test_the_batch_tenant_is_threaded_through_run_batch(wire) -> None:
    from hope_obs import bind_request_context, clear_request_context

    seen = wire(lambda r: _ok())
    service = BatchTranscriptionService.__new__(BatchTranscriptionService)

    bind_request_context(tenantId="ambient-tenant")  # must NOT be the source
    try:
        await service._run_inference(
            np.zeros(SR, dtype=np.float32),
            SR,
            _loaded(),
            InferenceConfig(language="ml"),
            tenant_id="job-tenant",
        )
    finally:
        clear_request_context()

    assert seen[0].headers["X-Tenant-Id"] == "job-tenant"


async def test_a_batch_job_without_a_tenant_is_refused(wire) -> None:
    from stt.transcription.batch_service import TranscriptionError

    wire(lambda r: _ok())
    service = BatchTranscriptionService.__new__(BatchTranscriptionService)

    with pytest.raises(TranscriptionError, match="tenant"):
        await service._run_inference(
            np.zeros(SR, dtype=np.float32), SR, _loaded(), InferenceConfig(language="ml")
        )


# ---------------------------------------------------------------------------
# 4 — 503: capacity retries, everything else fails over
# ---------------------------------------------------------------------------


async def _one(**_: Any) -> dict[str, Any]:
    return await vllm_asr.vllm_recognize_utterance(
        _config(),
        np.zeros(SR, dtype=np.float32),
        SR,
        language="ml",
        prompt=None,
        tenant_id="tenant-a",
        request_id=None,
        service_token="svc-token",
    )


@pytest.mark.parametrize("code", ["engine_load_failed", "MODEL_NOT_PUBLISHED", "fp8_unsupported"])
async def test_a_non_capacity_503_fails_over_immediately(wire, code: str) -> None:
    seen = wire(lambda r: httpx.Response(503, json={"error": {"code": code, "message": "x"}}))

    with pytest.raises(CloudASRTranscriptionError, match=code):
        await _one()
    assert len(seen) == 1


async def test_an_engine_capacity_503_is_retried(wire, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vllm_asr, "_DEFAULT_RETRY_AFTER_S", 0.0)
    responses = iter(
        [
            httpx.Response(503, json={"error": {"code": "engine_capacity"}}),
            _ok("after capacity"),
        ]
    )
    seen = wire(lambda r: next(responses))

    result = await _one()

    assert len(seen) == 2
    assert result["text"] == "after capacity"


async def test_a_503_with_retry_after_is_retried(wire) -> None:
    responses = iter(
        [httpx.Response(503, headers={"Retry-After": "0"}, json={"error": {}}), _ok("later")]
    )
    seen = wire(lambda r: next(responses))

    assert (await _one())["text"] == "later"
    assert len(seen) == 2


# ---------------------------------------------------------------------------
# 5 — the deliberate no-prompt signature does not warn
# ---------------------------------------------------------------------------


def test_the_vllm_callable_does_not_trip_the_no_prompt_warning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from stt.streaming import inference as inference_mod
    from stt.streaming.inference import StreamingInferenceWorker

    warnings: list[str] = []

    class _Logger:
        def warning(self, event: str, **_: Any) -> None:
            warnings.append(event)

        def debug(self, *_: Any, **__: Any) -> None: ...

        def info(self, *_: Any, **__: Any) -> None: ...

    monkeypatch.setattr(inference_mod, "logger", _Logger())
    run = SessionManager._make_vllm_callable(
        _bare_manager(), _loaded(), InferenceConfig(language="ml"), tenant_id="tenant-a"
    )
    worker = StreamingInferenceWorker(asr_pipeline=run, active_pipeline_id="p")

    assert "prompt" not in worker._asr_accepted_kwargs()
    assert "stt.streaming.asr_signature.no_prompt" not in warnings


def test_an_undeclared_no_prompt_engine_still_warns(monkeypatch: pytest.MonkeyPatch) -> None:
    """The suppression is opt-in per callable, not a blanket silence."""
    from stt.streaming import inference as inference_mod
    from stt.streaming.inference import StreamingInferenceWorker

    warnings: list[str] = []

    class _Logger:
        def warning(self, event: str, **_: Any) -> None:
            warnings.append(event)

        def debug(self, *_: Any, **__: Any) -> None: ...

        def info(self, *_: Any, **__: Any) -> None: ...

    monkeypatch.setattr(inference_mod, "logger", _Logger())

    async def plain(samples: Any, sample_rate: int) -> dict[str, Any]:
        return {"text": ""}

    StreamingInferenceWorker(asr_pipeline=plain, active_pipeline_id="p")._asr_accepted_kwargs()
    assert "stt.streaming.asr_signature.no_prompt" in warnings


# ---------------------------------------------------------------------------
# 6 — the batch receipt names the vllm engine
# ---------------------------------------------------------------------------


def test_the_batch_language_receipt_names_the_vllm_engine() -> None:
    from stt.pipeline.spec import bundle_from_resolved
    from stt.transcription.workers.transcribe_file import _resolve_chain_language

    here = Path(__file__).resolve()
    fixture = next(
        json.loads(p.read_text(encoding="utf-8"))
        for p in (
            d / "tests" / "contracts" / "resolved-asr-spec.fixture.json" for d in here.parents
        )
        if p.is_file()
    )
    spec = copy.deepcopy(fixture["vllmServingFacts"]["expected"])
    spec["models"]["asr"].update(slug=SLUG, libraryName="vllm", provider="vllm")
    bundle = bundle_from_resolved(spec)

    config, receipt = _resolve_chain_language(bundle, bundle.runtime_key, "ml-en", "agent")

    assert receipt is not None
    assert receipt.engine == "vllm"
    assert receipt.degraded is False
    assert config.spec.inference.language == "ml"
    assert config.spec.inference.streaming_english_gloss is False
