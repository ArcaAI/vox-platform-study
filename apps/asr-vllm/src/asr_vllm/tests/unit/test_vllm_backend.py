"""The vLLM adapter, exercised against a stand-in ``vllm`` module (no GPU, no vllm install).

The stand-in mirrors the vLLM 0.30.0 surface the adapter depends on — verified against
the v0.30.0 sources: ``AsyncLLM.from_engine_args`` / ``generate(prompt, sampling_params,
request_id)`` / ``abort`` / ``shutdown``, ``vllm.inputs.ExplicitEncoderDecoderPrompt`` +
``TextPrompt`` (both TypedDicts), and ``SamplingParams``. What it CANNOT prove is that a
real engine accepts these objects — that is the GPU run's job (ticket README).
"""

from __future__ import annotations

import asyncio
import importlib.machinery
import sys
import types
from collections.abc import AsyncIterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from asr_vllm.core.config import Settings
from asr_vllm.core.control_plane import apply_control_plane
from asr_vllm.engine.base import DecoderBudgetError, DecodeRequest, EngineBuildRefused
from asr_vllm.engine.vllm_backend import (
    VllmEngineFactory,
    build_decoder_prompt,
    resolve_max_tokens,
)
from asr_vllm.spec import AsrModelSlice, ResolvedVllmAsrSpec
from asr_vllm.tests.conftest import spec_payload


class FakeAsyncLLM:
    created: list[FakeAsyncLLM] = []

    def __init__(self, args: Any) -> None:
        self.args = args
        self.calls: list[tuple[Any, Any, str]] = []
        self.aborted: list[str] = []
        self.hang = False
        self.shutdown_called = False
        self.model_config = SimpleNamespace(max_model_len=448)

    @classmethod
    def from_engine_args(cls, engine_args: Any) -> FakeAsyncLLM:
        inst = cls(engine_args)
        cls.created.append(inst)
        return inst

    async def generate(
        self, prompt: Any, sampling_params: Any, request_id: str
    ) -> AsyncIterator[Any]:
        self.calls.append((prompt, sampling_params, request_id))
        yield SimpleNamespace(
            outputs=[SimpleNamespace(text="partial", finish_reason=None)], metrics=None
        )
        if self.hang:
            await asyncio.sleep(10)
        yield SimpleNamespace(
            outputs=[SimpleNamespace(text=" final text ", finish_reason="stop")],
            metrics=SimpleNamespace(queued_ts=10.0, scheduled_ts=10.25),
        )

    async def abort(self, request_id: str) -> None:
        self.aborted.append(request_id)

    def shutdown(self) -> None:
        self.shutdown_called = True


class _Kwargs:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


@pytest.fixture
def fake_vllm(monkeypatch: pytest.MonkeyPatch) -> type[FakeAsyncLLM]:
    FakeAsyncLLM.created = []

    def module(name: str) -> types.ModuleType:
        mod = types.ModuleType(name)
        mod.__spec__ = importlib.machinery.ModuleSpec(name, None)
        monkeypatch.setitem(sys.modules, name, mod)
        return mod

    root = module("vllm")
    root.AsyncEngineArgs = type("AsyncEngineArgs", (_Kwargs,), {})  # type: ignore[attr-defined]
    root.SamplingParams = type("SamplingParams", (_Kwargs,), {})  # type: ignore[attr-defined]
    inputs = module("vllm.inputs")
    inputs.ExplicitEncoderDecoderPrompt = dict  # type: ignore[attr-defined]  # TypedDicts in vLLM
    inputs.TextPrompt = dict  # type: ignore[attr-defined]
    module("vllm.v1")
    module("vllm.v1.engine")
    async_llm = module("vllm.v1.engine.async_llm")
    async_llm.AsyncLLM = FakeAsyncLLM  # type: ignore[attr-defined]
    return FakeAsyncLLM


TOKENIZER_DIRS: list[str] = []


def _count_chars_as_tokens(model_dir: str) -> Any:
    """Stand-in tokenizer: every special token counts 1, i.e. 4 for the bare prompt."""
    TOKENIZER_DIRS.append(model_dir)
    return lambda text: text.count("<|")


#: Where the stand-in resolver "finds" the weights — always a LOCAL directory.
RESOLVED_DIR = Path("/resolved/snapshots/abc123")


class FakeResolver:
    """Records what the factory asks to resolve; returns a local directory (OD-7)."""

    def __init__(self) -> None:
        self.calls: list[AsrModelSlice] = []

    async def resolve(self, model: AsrModelSlice) -> Path:
        self.calls.append(model)
        return RESOLVED_DIR


def serve(settings: Settings, **values: Any) -> None:
    """Overlay platform values exactly as the effective-config pull would (OD-6)."""
    apply_control_plane(
        settings,
        {"settings": {f"asrVllm.engine.{key}": {"value": v} for key, v in values.items()}},
    )


@pytest.fixture
def settings() -> Settings:
    settings = Settings()
    serve(settings, gpuMemoryUtilization=0.4, maxNumSeqs=48)
    return settings


@pytest.fixture
def resolver() -> FakeResolver:
    return FakeResolver()


@pytest.fixture
def capability() -> dict[str, tuple[int, int] | None]:
    """The GPU the factory sees — sm_89 (the dev RTX 2000 Ada) unless a test says otherwise."""
    return {"value": (8, 9)}


@pytest.fixture
def factory(
    settings: Settings, resolver: FakeResolver, capability: dict[str, tuple[int, int] | None]
) -> VllmEngineFactory:
    TOKENIZER_DIRS.clear()
    return VllmEngineFactory(
        settings,
        source_resolver=resolver,
        token_counter_loader=_count_chars_as_tokens,
        cuda_capability=lambda: capability["value"],
    )


def make_spec(**overrides: object) -> ResolvedVllmAsrSpec:
    return ResolvedVllmAsrSpec.model_validate(spec_payload(**overrides))


def decode_request(**overrides: Any) -> DecodeRequest:
    fields: dict[str, Any] = {
        "audio": np.zeros(16_000, dtype=np.float32),
        "language": "ml",
        "prompt": None,
        "temperature": 0.0,
        "max_tokens": None,
        "request_id": "req-1",
    }
    fields.update(overrides)
    return DecodeRequest(**fields)


# ── pure helpers ────────────────────────────────────────────────────────────


def test_decoder_prompt_is_whisper_transcribe_without_timestamps() -> None:
    assert (
        build_decoder_prompt("ml", None)
        == "<|startoftranscript|><|ml|><|transcribe|><|notimestamps|>"
    )


def test_previous_text_uses_whispers_real_startofprev_token() -> None:
    """vLLM 0.30.0's own server writes `<|prev|>`, which is not a Whisper special token."""
    assert build_decoder_prompt("en", "fever since monday").startswith(
        "<|startofprev|>fever since monday<|startoftranscript|><|en|>"
    )


def test_max_tokens_defaults_to_the_remaining_decoder_context() -> None:
    assert resolve_max_tokens(None, max_model_len=448, prompt_tokens=4) == 444


def test_requested_max_tokens_is_clamped_to_the_context() -> None:
    assert resolve_max_tokens(120, max_model_len=448, prompt_tokens=4) == 120
    assert resolve_max_tokens(1000, max_model_len=448, prompt_tokens=4) == 444


def test_a_prompt_that_fills_the_decoder_context_is_refused() -> None:
    with pytest.raises(DecoderBudgetError):
        resolve_max_tokens(None, max_model_len=448, prompt_tokens=448)


# ── lazy import + availability ──────────────────────────────────────────────


def test_importing_the_adapter_does_not_import_vllm() -> None:
    assert "vllm" not in sys.modules


def test_factory_is_unavailable_when_vllm_is_not_installed() -> None:
    reason = VllmEngineFactory(Settings()).availability()
    assert reason is not None and "vllm" in reason


def test_factory_is_available_when_vllm_is_importable(fake_vllm, factory) -> None:  # type: ignore[no-untyped-def]
    assert factory.availability() is None


# ── build ───────────────────────────────────────────────────────────────────


async def test_build_passes_the_resolved_spec_and_engine_tuning(  # type: ignore[no-untyped-def]
    fake_vllm, factory, resolver
) -> None:
    spec = make_spec(quantization="fp8", maxModelLen=448, computeType="bfloat16")
    await factory.build(spec)

    assert resolver.calls == [spec.model]
    (engine,) = fake_vllm.created
    kwargs = engine.args.kwargs
    assert kwargs["model"] == str(RESOLVED_DIR)  # the resolved LOCAL directory
    assert kwargs.get("revision") is None  # a local directory has no revision
    assert kwargs["dtype"] == "bfloat16"
    assert kwargs["quantization"] == "fp8"
    assert kwargs["max_model_len"] == 448
    assert kwargs["gpu_memory_utilization"] == pytest.approx(0.4)
    assert kwargs["max_num_seqs"] == 48
    assert kwargs["limit_mm_per_prompt"] == {"audio": 1}
    assert TOKENIZER_DIRS == [str(RESOLVED_DIR)]  # the tokenizer loads from the same dir


async def test_vllm_is_never_handed_a_repo_id(fake_vllm, factory) -> None:  # type: ignore[no-untyped-def]
    """An HF-only row still reaches vLLM as the directory the resolver pulled into."""
    await factory.build(make_spec(localPath=None, sourceRevision="abc123"))
    kwargs = fake_vllm.created[0].args.kwargs
    assert kwargs["model"] == str(RESOLVED_DIR)
    assert "taphuynh/" not in str(kwargs)
    assert kwargs.get("revision") is None


@pytest.mark.parametrize(
    ("registry", "vllm"), [(None, None), ("none", None), ("awq", "awq"), ("gptq", "gptq")]
)
async def test_quantization_passes_through_to_vllm(  # type: ignore[no-untyped-def]
    fake_vllm, factory, registry: str | None, vllm: str | None
) -> None:
    await factory.build(make_spec(quantization=registry))
    assert fake_vllm.created[0].args.kwargs["quantization"] == vllm


async def test_a_quantization_vllm_has_no_method_for_is_refused_before_any_pull(  # type: ignore[no-untyped-def]
    fake_vllm, factory, resolver
) -> None:
    with pytest.raises(EngineBuildRefused) as caught:
        await factory.build(make_spec(quantization="int8"))
    assert caught.value.code == "QUANTIZATION_UNSUPPORTED"
    assert resolver.calls == [] and fake_vllm.created == []


@pytest.mark.parametrize("sm", [(8, 6), (8, 0), (7, 5)])
async def test_fp8_below_sm89_is_refused_by_name_before_any_pull(  # type: ignore[no-untyped-def]
    fake_vllm, factory, resolver, capability, sm: tuple[int, int]
) -> None:
    """OD-11: production A6000 is sm_86 — fp8 is refused there until measured."""
    capability["value"] = sm
    with pytest.raises(EngineBuildRefused) as caught:
        await factory.build(make_spec(quantization="fp8"))
    assert caught.value.code == "QUANTIZATION_UNSUPPORTED_ON_GPU"
    assert f"sm_{sm[0]}{sm[1]}" in str(caught.value)
    assert resolver.calls == [] and fake_vllm.created == []


@pytest.mark.parametrize("sm", [(8, 9), (9, 0), (12, 0)])
async def test_fp8_on_sm89_or_newer_is_passed_through(  # type: ignore[no-untyped-def]
    fake_vllm, factory, capability, sm: tuple[int, int]
) -> None:
    capability["value"] = sm
    await factory.build(make_spec(quantization="fp8"))
    assert fake_vllm.created[0].args.kwargs["quantization"] == "fp8"


async def test_the_arch_guard_only_looks_at_the_gpu_for_fp8(  # type: ignore[no-untyped-def]
    fake_vllm, factory, capability
) -> None:
    capability["value"] = (7, 5)
    await factory.build(make_spec(quantization="none"))
    assert fake_vllm.created[0].args.kwargs["quantization"] is None


async def test_engine_knobs_are_read_when_an_engine_is_built(  # type: ignore[no-untyped-def]
    fake_vllm, factory, settings
) -> None:
    """A resident engine keeps its shape; the NEXT build takes the platform's new values."""
    await factory.build(make_spec(runtimeKey="first"))
    serve(settings, gpuMemoryUtilization=0.3, maxNumSeqs=16, enforceEager=True)
    await factory.build(make_spec(runtimeKey="second"))

    first, second = (engine.args.kwargs for engine in fake_vllm.created)
    assert (first["gpu_memory_utilization"], first["max_num_seqs"]) == (0.4, 48)
    assert first["enforce_eager"] is False
    assert second["gpu_memory_utilization"] == pytest.approx(0.3)
    assert (second["max_num_seqs"], second["enforce_eager"]) == (16, True)


# ── transcribe ──────────────────────────────────────────────────────────────


async def test_transcribe_sends_whispers_encoder_decoder_prompt(fake_vllm, factory) -> None:  # type: ignore[no-untyped-def]
    engine = await factory.build(make_spec())
    audio = np.linspace(-0.5, 0.5, 16_000, dtype=np.float32)

    result = await engine.transcribe(decode_request(audio=audio, temperature=0.1, max_tokens=100))

    prompt, params, request_id = fake_vllm.created[0].calls[0]
    assert prompt["encoder_prompt"]["prompt"] == ""
    sent_audio, rate = prompt["encoder_prompt"]["multi_modal_data"]["audio"]
    assert rate == 16_000 and sent_audio is audio
    assert prompt["decoder_prompt"] == {
        "prompt": "<|startoftranscript|><|ml|><|transcribe|><|notimestamps|>"
    }
    assert params.kwargs["temperature"] == pytest.approx(0.1)
    assert params.kwargs["max_tokens"] == 100
    assert params.kwargs["skip_special_tokens"] is True
    assert request_id == "req-1"
    assert result.text == "final text"
    assert result.finish_reason == "stop"
    assert result.engine_queue_ms == pytest.approx(250.0)
    assert result.decode_ms >= 0


async def test_unset_max_tokens_uses_the_whole_remaining_context(fake_vllm, factory) -> None:  # type: ignore[no-untyped-def]
    engine = await factory.build(make_spec())
    await engine.transcribe(decode_request())
    params = fake_vllm.created[0].calls[0][1]
    assert params.kwargs["max_tokens"] == 448 - 4  # never vLLM's silent default of 16


async def test_a_cancelled_request_is_aborted_inside_the_engine(fake_vllm, factory) -> None:  # type: ignore[no-untyped-def]
    engine = await factory.build(make_spec())
    fake_vllm.created[0].hang = True

    task = asyncio.create_task(engine.transcribe(decode_request(request_id="req-cancel")))
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert fake_vllm.created[0].aborted == ["req-cancel"]


async def test_shutdown_stops_the_engine(fake_vllm, factory) -> None:  # type: ignore[no-untyped-def]
    engine = await factory.build(make_spec())
    await engine.shutdown()
    assert fake_vllm.created[0].shutdown_called is True
