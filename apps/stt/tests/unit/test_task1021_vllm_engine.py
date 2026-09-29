"""TASK-1021 L3.3 — the `vllm` engine adapter, streaming and batch.

The wire is mocked with httpx's ``MockTransport`` behind ``vllm_asr._http_client``
(`respx` is not installed in `arcaenv`).
"""

from __future__ import annotations

import asyncio
import copy
import email
import email.policy
import inspect
import io
import json
import wave
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import numpy as np
import pytest
from hope_obs import bind_request_context, clear_request_context

from stt.models.base_loader import LoadedModel
from stt.models.cache import ModelCache
from stt.models.vllm_loader import VllmAsrConfig
from stt.pipeline.dto import AiModelFormat, InferenceConfig
from stt.processors.asr_engines import ASR_FORMAT_TO_NAME, VllmEngine, resolve_asr_engine
from stt.streaming import vllm_asr
from stt.streaming.session_manager import SessionManager
from stt.transcription.batch_service import BatchTranscriptionService

SR = 16_000
SLUG = "arcaai-whisper-large-ml-en-vllm"
AGENT_PROMPT = "Clinical consultation."


def _loaded(max_concurrent: int | None = None, base_url: str = "http://vllm.test/v1"):
    return LoadedModel(
        model_id="m",
        model_slug=SLUG,
        model=VllmAsrConfig(
            base_url=base_url, model_slug=SLUG, max_concurrent=max_concurrent, timeout_s=5.0
        ),
        format=AiModelFormat.VLLM,
        device="remote",
    )


def _parts(request: httpx.Request) -> tuple[dict[str, str], bytes]:
    """(text fields, the WAV file bytes) of a multipart request."""
    raw = f"Content-Type: {request.headers['content-type']}\r\n\r\n".encode() + request.content
    msg = email.message_from_bytes(raw, policy=email.policy.HTTP)
    fields: dict[str, str] = {}
    wav = b""
    for part in msg.iter_parts():
        if part.get_filename() is None:
            fields[str(part.get_param("name", header="content-disposition"))] = part.get_content()
        else:
            wav = part.get_payload(decode=True)
    return fields, wav


def _duration_s(wav: bytes) -> float:
    with wave.open(io.BytesIO(wav)) as wf:
        return wf.getnframes() / float(wf.getframerate())


def _ok(text: str = "hello") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "task": "transcribe",
            "language": "ml",
            "text": text,
            "segments": [],
            "x_hope": {"truncation": {"suspected": False}},
        },
    )


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
    from pydantic import SecretStr

    from stt.core.config.settings import get_settings

    monkeypatch.setattr(get_settings(), "internal_access_token", SecretStr("svc-token"))


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------


def test_the_vllm_format_resolves_the_vllm_engine() -> None:
    assert ASR_FORMAT_TO_NAME[AiModelFormat.VLLM] == "vllm"
    assert isinstance(resolve_asr_engine(AiModelFormat.VLLM), VllmEngine)


@pytest.mark.parametrize("mode", ["streaming", "batch"])
def test_the_capability_is_remote_for_both_modes(mode: str) -> None:
    from stt.processors.binding import resolve_engine_binding

    binding = resolve_engine_binding("asr", "vllm", mode=mode, platform="cpu", warn=False)
    assert binding is not None
    assert binding.device == "remote"


def test_a_code_switch_pair_pins_its_primary_on_vllm() -> None:
    """The route needs a language token (C-3), so a pair cannot run unpinned."""
    from stt.pipeline.language_modes import resolve_language

    resolved, receipt = resolve_language("ml-en", AiModelFormat.VLLM, source="agent")
    assert resolved.language == "ml"
    assert resolved.streaming_english_gloss is False
    assert resolved.initial_prompt is None  # no synthesised priming prompt (TASK-994)
    assert receipt.degraded is False


# ---------------------------------------------------------------------------
# streaming callable
# ---------------------------------------------------------------------------


def _manager() -> MagicMock:
    mgr = MagicMock(spec=SessionManager)
    mgr._make_vllm_callable = lambda *a, **k: SessionManager._make_vllm_callable(mgr, *a, **k)
    return mgr


async def test_the_streaming_callable_forwards_tenant_language_and_the_agent_prompt(wire) -> None:
    seen = wire(lambda r: _ok("രോഗി fever"))
    mgr = _manager()
    config = InferenceConfig(language="ml")

    run = SessionManager._make_asr_callable(
        mgr, _loaded(), config, initial_prompt=AGENT_PROMPT, tenant_id="tenant-a"
    )
    result = await run(np.zeros(SR, dtype=np.float32), SR)

    fields, _wav = _parts(seen[0])
    assert seen[0].headers["X-Tenant-Id"] == "tenant-a"
    assert seen[0].headers["X-Service-Token"] == "svc-token"
    assert fields["prompt"] == AGENT_PROMPT
    assert fields["language"] == "ml"
    assert fields["model"] == SLUG
    assert result["text"] == "രോഗി fever"


def test_the_streaming_callable_takes_no_carry_forward_prompt() -> None:
    """The inference worker sends ``prompt=`` (prior-transcript context) only to a
    callable that declares it; this one does not, so none is ever synthesised."""
    run = SessionManager._make_vllm_callable(
        _manager(), _loaded(), InferenceConfig(language="ml"), tenant_id="tenant-a"
    )
    params = inspect.signature(run).parameters
    assert "prompt" not in params
    assert "max_decode_window_sec" in params


async def test_the_streaming_callable_sends_no_prompt_when_the_agent_has_none(wire) -> None:
    seen = wire(lambda r: _ok())
    run = SessionManager._make_vllm_callable(
        _manager(), _loaded(), InferenceConfig(language="ml"), tenant_id="tenant-a"
    )
    await run(np.zeros(SR, dtype=np.float32), SR)
    assert "prompt" not in _parts(seen[0])[0]


@pytest.mark.parametrize(
    ("tenant_id", "language", "match"),
    [(None, "ml", "tenant"), ("tenant-a", None, "language")],
)
def test_the_streaming_callable_refuses_to_build_without_tenant_or_language(
    tenant_id: str | None, language: str | None, match: str
) -> None:
    from stt.streaming.vllm_asr import VllmSessionContextError

    with pytest.raises(VllmSessionContextError, match=match):
        SessionManager._make_vllm_callable(
            _manager(), _loaded(), InferenceConfig(language=language), tenant_id=tenant_id
        )


async def test_a_long_final_is_split_at_the_models_window(wire) -> None:
    seen = wire(lambda r: _ok("x"))
    run = SessionManager._make_vllm_callable(
        _manager(),
        _loaded(),
        InferenceConfig(language="ml", max_decode_window_sec=7.0),
        tenant_id="tenant-a",
    )

    await run(np.random.default_rng(0).normal(0, 0.1, 20 * SR).astype(np.float32), SR)

    durations = [_duration_s(_parts(r)[1]) for r in seen]
    assert len(durations) >= 3
    assert max(durations) <= 7.0 + 1e-6


async def test_the_session_load_hands_the_session_tenant_to_the_callable(wire) -> None:
    """End to end through `_load_asr_pipeline`: the tenant is the SESSION's."""
    seen = wire(lambda r: _ok())
    spec = _vllm_spec()
    mgr = MagicMock(spec=SessionManager)
    for name in (
        "_session_specs",
        "_session_language_modes",
        "_session_asr_formats",
        "_session_connections",
        "_session_pinned_models",
    ):
        setattr(mgr, name, {})
    mgr._pending_want_word_timestamps = False
    mgr._warm_and_pin_pipeline_models = AsyncMock(return_value=[])
    mgr._load_cloud_asr_uncached = lambda **kw: SessionManager._load_cloud_asr_uncached(mgr, **kw)
    mgr._make_asr_callable = lambda *a, **k: SessionManager._make_asr_callable(mgr, *a, **k)
    mgr._make_vllm_callable = lambda *a, **k: SessionManager._make_vllm_callable(mgr, *a, **k)
    bundle = SessionManager._register_resolved_spec(mgr, "s1", spec)
    config = await SessionManager._load_pipeline_config(mgr, bundle.runtime_key, session_id="s1")
    mgr._session_language_modes["s1"] = "ml-en"
    mgr._session_language_sources = {"s1": "agent"}

    real = ModelCache.__new__(ModelCache)
    ModelCache._install_loaders(real)
    cache = MagicMock()
    cache.loader_for = real.loader_for
    cache._get_loader = real._get_loader
    cache.pin = AsyncMock()
    overrides = {"vllm": {"base_url": "http://vllm.test/v1", "max_concurrent": 4}}
    with patch("stt.models.get_model_cache", return_value=cache):
        run, _prompt = await SessionManager._load_asr_pipeline(
            mgr, config, "s1", tenant_id="tenant-b", provider_overrides=overrides
        )
    await run(np.zeros(SR, dtype=np.float32), SR)

    assert seen[0].headers["X-Tenant-Id"] == "tenant-b"
    assert _parts(seen[0])[0]["language"] == "ml"


def _vllm_spec() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            fixture = json.loads(candidate.read_text(encoding="utf-8"))
            break
    else:
        raise AssertionError("shared ResolvedAsrSpec contract fixture not found")
    spec = copy.deepcopy(fixture["vllmServingFacts"]["expected"])
    spec["models"]["asr"].update(slug=SLUG, libraryName="vllm", provider="vllm")
    return spec


# ---------------------------------------------------------------------------
# batch
# ---------------------------------------------------------------------------


def _speech_with_pauses(total_s: float, pauses_s: list[float]) -> np.ndarray:
    """Loud noise with a 0.5 s silence at each pause — the splitter cuts there."""
    audio = np.random.default_rng(1).normal(0, 0.2, int(total_s * SR)).astype(np.float32)
    for at in pauses_s:
        audio[int(at * SR) : int((at + 0.5) * SR)] = 0.0
    return audio


async def test_a_70s_file_is_three_windows_decoded_concurrently_and_reassembled_in_order(
    wire,
) -> None:
    in_flight = 0
    peak = 0
    three_in_flight = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        if in_flight == 3:
            three_in_flight.set()
        await asyncio.wait_for(three_in_flight.wait(), timeout=2.0)
        duration = _duration_s(_parts(request)[1])
        # Longer windows answer later, so the FIRST window (the longest) completes
        # last: order must come from reassembly, not from arrival.
        await asyncio.sleep(duration / 500.0)
        in_flight -= 1
        return _ok(f"w{round(duration)}")

    seen = wire(handler)
    audio = _speech_with_pauses(70.0, [27.75, 49.75])
    service = BatchTranscriptionService.__new__(BatchTranscriptionService)
    progress: list[float] = []

    bind_request_context(requestId="req-9")  # the request id rides the job context
    try:
        result = await service._run_vllm_inference(
            audio,
            SR,
            _loaded(),
            InferenceConfig(language="ml"),
            progress.append,
            tenant_id="tenant-c",
        )
    finally:
        clear_request_context()

    durations = [_duration_s(_parts(r)[1]) for r in seen]
    assert len(durations) == 3
    assert all(d <= 30.0 for d in durations)
    assert peak == 3
    assert all(r.headers["X-Tenant-Id"] == "tenant-c" for r in seen)
    assert all(r.headers["X-Request-Id"] == "req-9" for r in seen)

    starts = [seg["start"] for seg in result.segments]
    assert starts == sorted(starts)
    assert starts[0] == 0.0
    assert 27.0 < starts[1] < 28.5
    assert 49.0 < starts[2] < 50.5
    assert result.segments[-1]["end"] == pytest.approx(70.0, abs=0.01)
    assert result.text == " ".join(seg["text"] for seg in result.segments)
    assert [seg["text"] for seg in result.segments] == [
        f"w{round(result.segments[i]['end'] - result.segments[i]['start'])}" for i in range(3)
    ]
    assert result.language == "ml"
    assert progress[-1] == 1.0


async def test_batch_windows_honour_a_shorter_model_window(wire) -> None:
    seen = wire(lambda r: _ok("x"))
    service = BatchTranscriptionService.__new__(BatchTranscriptionService)
    audio = _speech_with_pauses(20.0, [])

    await service._run_vllm_inference(
        audio,
        SR,
        _loaded(),
        InferenceConfig(language="ml", max_decode_window_sec=7.0),
        tenant_id="tenant-c",
    )

    assert max(_duration_s(_parts(r)[1]) for r in seen) <= 7.0 + 1e-6


async def test_batch_refuses_without_a_tenant(wire) -> None:
    from stt.transcription.batch_service import TranscriptionError

    wire(lambda r: _ok())
    service = BatchTranscriptionService.__new__(BatchTranscriptionService)
    clear_request_context()

    with pytest.raises(TranscriptionError, match="tenant"):
        await service._run_vllm_inference(
            np.zeros(SR, dtype=np.float32), SR, _loaded(), InferenceConfig(language="ml")
        )


async def test_the_batch_engine_dispatches_to_the_vllm_body() -> None:
    service = SimpleNamespace(_run_vllm_inference=AsyncMock(return_value="raw"))

    out = await VllmEngine().run_batch(
        service,
        "samples",
        SR,
        "model",
        "config",
        None,
        prompt="carry",
        initial_prompt="agent",
        tenant_id="job-tenant",
    )

    assert out == "raw"
    service._run_vllm_inference.assert_awaited_once_with(
        "samples", SR, "model", "config", None, initial_prompt="agent", tenant_id="job-tenant"
    )
