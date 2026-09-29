"""vLLM backend — Whisper encoder-decoder on ``AsyncLLM`` continuous batching.

``vllm`` is imported LAZILY, inside :meth:`VllmEngineFactory._build_sync`, never at
module scope: the service, its app factory and its unit tests must import in the shared
conda env ``arcaenv`` (a Mac, no CUDA), where vLLM is not — and must never be — installed.
Same pattern as ``apps/stt/src/stt/streaming/faster_whisper_asr.py``.

Surface used, verified against the vLLM **0.30.0** sources (``vllm/model_executor/models/
whisper.py``, ``vllm/v1/engine/async_llm.py``, ``vllm/sampling_params.py``):

* ``AsyncLLM.from_engine_args(AsyncEngineArgs(...))`` — ``AsyncLLMEngine`` is only an
  alias of it in 0.30.0. Blocking (it spawns the engine-core process and waits for the
  weights), so it runs in a worker thread: the event loop — and therefore
  ``/health/live`` — must never stall on a model load (TASK-1007 D-2).
* ``generate(prompt, sampling_params, request_id)`` — an async generator of
  ``RequestOutput``; the last one carries the final text. Concurrency is vLLM's: every
  in-flight request joins the running batch (continuous batching), so this adapter
  never serialises windows.
* The prompt is the one vLLM's own ``WhisperForConditionalGeneration.
  get_generation_prompt`` builds: ``ExplicitEncoderDecoderPrompt`` with an EMPTY encoder
  text prompt carrying ``multi_modal_data={"audio": (float32 array, 16000)}``, and a
  decoder prompt ``<|startoftranscript|><|lang|><|transcribe|><|notimestamps|>``.
  ONE deliberate difference: vLLM 0.30.0 prefixes previous text with ``<|prev|>``,
  which is not a Whisper special token (Whisper's is ``<|startofprev|>``); this adapter
  uses ``<|startofprev|>``. Note TASK-994: the ml-en fine-tune decodes best with NO prior
  text at all, so callers should normally omit ``prompt``.
* ``SamplingParams.max_tokens`` defaults to **16** — a silent truncation for ASR — and
  vLLM rejects a value larger than the remaining context. So the adapter always sends an
  explicit budget: ``max_model_len − decoder-prompt tokens``, clamped from the request's.

What a BUILD does, in order (TASK-1010 phase B):

1. **Quantization** (``AiModel._metadata.asr.quantization`` → ``spec.models.asr``) is
   mapped onto vLLM's method names; a value vLLM has no method for is refused by name
   BEFORE any weights move. ``fp8`` additionally needs FP8 tensor cores — compute
   capability ≥ 8.9 (Ada / Hopper and newer) — and is refused below it (OD-11: the
   production RTX A6000 is sm_86; dev's RTX 2000 Ada is sm_89).
2. **Weights** come from ``ModelSourceResolver`` (OD-7): always a LOCAL DIRECTORY —
   vLLM is never handed a repo id, so it can never pull on its own.
3. **Engine sizing** comes from the MODEL ROW (``spec.engine``, TASK-1021 D-11): the GiB
   the row declares becomes vLLM's ``gpu_memory_utilization`` as a fraction of THIS
   device's total memory (read from NVML — no CUDA context in the server process), and
   ``maxNumSeqs`` / ``enforceEager`` pass through with the service defaults (64 / off).
"""

from __future__ import annotations

import asyncio
import importlib.util
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from hope_obs import get_logger

from hope_vllm.audio import SAMPLE_RATE
from hope_vllm.core.config import Settings
from hope_vllm.engine.base import (
    DEFAULT_MAX_NUM_SEQS,
    DecoderBudgetError,
    DecodeRequest,
    DecodeResult,
    EngineBuildRefused,
)
from hope_vllm.models.source_resolver import ModelSourceResolver
from hope_vllm.spec import ResolvedServingSpec

logger = get_logger(__name__)

#: ``checkpoint dir -> (text -> token count)``; the default loads the checkpoint's tokenizer.
TokenCounterLoader = Callable[[str], Callable[[str], int]]

#: ``() -> (major, minor)`` of the GPU this process will run on, or None (no CUDA device).
CudaCapability = Callable[[], tuple[int, int] | None]

#: Registry ``quantization`` → vLLM ``quantization=``. ``none`` = the checkpoint's own
#: precision. ``int8`` is deliberately ABSENT: vLLM has no method of that name (it runs a
#: pre-quantised int8 checkpoint by detecting the checkpoint's own ``quantization_config``),
#: so passing it would fail inside vLLM after the weights had already moved.
VLLM_QUANTIZATION: dict[str, str | None] = {
    "none": None,
    "fp8": "fp8",
    "awq": "awq",
    "gptq": "gptq",
}

#: FP8 tensor cores: Ada (sm_89), Hopper (sm_90) and newer.
FP8_MIN_CAPABILITY = (8, 9)

#: ``() -> total memory of the GPU this process runs on, in GiB``.
DeviceTotalGib = Callable[[], float]


class SourceResolver(Protocol):
    async def resolve(self, model: ResolvedServingSpec) -> Path: ...


def vllm_quantization(model: ResolvedServingSpec, capability: CudaCapability) -> str | None:
    """The vLLM ``quantization=`` for ``model``, or a named refusal (before any pull)."""
    if model.quantization is None:
        return None
    if model.quantization not in VLLM_QUANTIZATION:
        raise EngineBuildRefused(
            "QUANTIZATION_UNSUPPORTED",
            f"model '{model.slug}' declares quantization '{model.quantization}', which vLLM "
            f"has no method for (supported: {', '.join(sorted(VLLM_QUANTIZATION))})",
        )
    if model.quantization == "fp8":
        sm = capability()
        if sm is not None and sm < FP8_MIN_CAPABILITY:
            raise EngineBuildRefused(
                "QUANTIZATION_UNSUPPORTED_ON_GPU",
                f"model '{model.slug}' is fp8, which needs compute capability >= sm_89; this "
                f"GPU is sm_{sm[0]}{sm[1]} — bind an fp16 or int8 row here (OD-11)",
            )
    return VLLM_QUANTIZATION[model.quantization]


def _vllm_cuda_capability() -> tuple[int, int] | None:
    """The device's compute capability through vLLM's platform layer.

    vLLM's CUDA platform answers from NVML, so this creates no CUDA context in the
    server process (a context here would force vLLM's engine-core process onto
    ``spawn``). ``None`` off CUDA — the guard then leaves the decision to vLLM.
    """
    from vllm.platforms import current_platform

    if not current_platform.is_cuda():
        return None
    capability = current_platform.get_device_capability()
    if capability is None:
        return None
    return int(capability.major), int(capability.minor)


def nvml_device_total_gib() -> float:
    """Total memory of device 0, in GiB, from NVML.

    ``pynvml`` is vLLM's own ``nvidia-ml-py`` dependency (present wherever vLLM is), imported
    lazily. NVML answers without a CUDA context, so the server process never initialises
    CUDA (which would force vLLM's engine-core process onto ``spawn``). Device 0 is the
    GPU the device plugin handed this container — the only one it can see.
    """
    import pynvml

    pynvml.nvmlInit()
    try:
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        total = pynvml.nvmlDeviceGetMemoryInfo(handle).total
    finally:
        pynvml.nvmlShutdown()
    return float(total) / 2**30


def gpu_memory_utilization(vram_gib: float, device_total_gib: float) -> float:
    """The spec's GiB as vLLM's fraction of the WHOLE device, rounded to 3 places."""
    return round(vram_gib / device_total_gib, 3)


def build_decoder_prompt(language: str, prompt: str | None) -> str:
    """Whisper's transcribe decoder prompt, optionally preceded by previous text."""
    prefix = f"<|startofprev|>{prompt}" if prompt else ""
    return f"{prefix}<|startoftranscript|><|{language}|><|transcribe|><|notimestamps|>"


def resolve_max_tokens(requested: int | None, *, max_model_len: int, prompt_tokens: int) -> int:
    """The generation budget: the remaining decoder context, never more, never vLLM's 16."""
    budget = max_model_len - prompt_tokens
    if budget < 1:
        raise DecoderBudgetError(
            f"decoder prompt uses {prompt_tokens} of {max_model_len} tokens; nothing left to generate"
        )
    return budget if requested is None else min(requested, budget)


def _hf_token_counter(model_dir: str) -> Callable[[str], int]:
    """Count decoder-prompt tokens with the checkpoint's own tokenizer (``transformers``
    ships with vLLM), loaded from the SAME local directory the engine loads — never a
    repo id. Special tokens written in the text resolve to their single ids."""
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(model_dir)

    def count(text: str) -> int:
        return len(tokenizer(text, add_special_tokens=False)["input_ids"])

    return count


@dataclass(frozen=True)
class _VllmApi:
    """The three vLLM constructors a decode needs, captured at (lazy) import time."""

    encoder_decoder_prompt: Callable[..., Any]
    text_prompt: Callable[..., Any]
    sampling_params: Callable[..., Any]


class VllmWhisperEngine:
    """One resident ``AsyncLLM`` serving one Whisper checkpoint."""

    def __init__(
        self,
        *,
        api: _VllmApi,
        engine: Any,
        spec: ResolvedServingSpec,
        count_tokens: Callable[[str], int],
        max_model_len: int,
    ) -> None:
        self._api = api
        self._engine = engine
        self._spec = spec
        self._count_tokens = count_tokens
        self._max_model_len = max_model_len

    async def transcribe(self, request: DecodeRequest) -> DecodeResult:
        api = self._api
        decoder_text = build_decoder_prompt(request.language, request.prompt)
        max_tokens = resolve_max_tokens(
            request.max_tokens,
            max_model_len=self._max_model_len,
            prompt_tokens=self._count_tokens(decoder_text),
        )
        prompt = api.encoder_decoder_prompt(
            encoder_prompt=api.text_prompt(
                prompt="",
                multi_modal_data={"audio": (request.audio, SAMPLE_RATE)},
            ),
            decoder_prompt=api.text_prompt(prompt=decoder_text),
        )
        params = api.sampling_params(
            temperature=request.temperature,
            max_tokens=max_tokens,
            skip_special_tokens=True,
        )
        started = time.perf_counter()
        final: Any = None
        try:
            async for output in self._engine.generate(prompt, params, request.request_id):
                final = output
        except asyncio.CancelledError:
            # The caller went away: free the batch slot instead of decoding for nobody.
            await self._engine.abort(request.request_id)
            raise
        decode_ms = (time.perf_counter() - started) * 1000.0
        if final is None or not final.outputs:
            return DecodeResult(
                text="", finish_reason=None, decode_ms=decode_ms, engine_queue_ms=None
            )
        completion = final.outputs[0]
        return DecodeResult(
            text=completion.text.strip(),
            finish_reason=completion.finish_reason,
            decode_ms=decode_ms,
            engine_queue_ms=_engine_queue_ms(final),
        )

    async def shutdown(self) -> None:
        await asyncio.to_thread(self._engine.shutdown)


def _engine_queue_ms(output: Any) -> float | None:
    """vLLM's scheduler wait, when the engine attaches request stats (best effort)."""
    metrics = getattr(output, "metrics", None)
    queued = getattr(metrics, "queued_ts", None)
    scheduled = getattr(metrics, "scheduled_ts", None)
    if (
        isinstance(queued, int | float)
        and isinstance(scheduled, int | float)
        and scheduled >= queued
    ):
        return (scheduled - queued) * 1000.0
    return None


class VllmEngineFactory:
    name = "vllm"

    def __init__(
        self,
        settings: Settings,
        *,
        source_resolver: SourceResolver | None = None,
        token_counter_loader: TokenCounterLoader | None = None,
        cuda_capability: CudaCapability | None = None,
        device_total_gib: DeviceTotalGib | None = None,
    ) -> None:
        self._settings = settings
        self._source_resolver: SourceResolver = (
            source_resolver or ModelSourceResolver.from_settings(settings)
        )
        self._token_counter_loader = token_counter_loader or _hf_token_counter
        self._cuda_capability = cuda_capability or _vllm_cuda_capability
        self._device_total_gib = device_total_gib or nvml_device_total_gib

    def availability(self) -> str | None:
        try:
            found = importlib.util.find_spec("vllm") is not None
        except (ImportError, ValueError):
            found = False
        return None if found else "vllm is not installed in this image (Linux + CUDA only)"

    async def build(self, spec: ResolvedServingSpec) -> VllmWhisperEngine:
        quantization = vllm_quantization(spec, self._cuda_capability)
        model_dir = await self._source_resolver.resolve(spec)
        return await asyncio.to_thread(self._build_sync, spec, str(model_dir), quantization)

    def _build_sync(
        self, spec: ResolvedServingSpec, model_dir: str, quantization: str | None
    ) -> VllmWhisperEngine:
        from vllm import AsyncEngineArgs, SamplingParams
        from vllm.inputs import ExplicitEncoderDecoderPrompt, TextPrompt
        from vllm.v1.engine.async_llm import AsyncLLM

        sizing = spec.engine
        utilization = gpu_memory_utilization(sizing.vram_gib, self._device_total_gib())
        max_num_seqs = sizing.max_num_seqs or DEFAULT_MAX_NUM_SEQS
        enforce_eager = bool(sizing.enforce_eager)
        args = AsyncEngineArgs(
            model=model_dir,
            # vLLM's `model_name` metric label: the slug, never a models-bucket path.
            served_model_name=spec.slug,
            dtype=spec.compute_type or "auto",
            quantization=quantization,
            max_model_len=spec.max_model_len,
            gpu_memory_utilization=utilization,
            max_num_seqs=max_num_seqs,
            enforce_eager=enforce_eager,
            limit_mm_per_prompt={"audio": 1},
            # vLLM's `vllm:*` Prometheus series (served from this process's /metrics) —
            # and NO request logging: a logged request would carry the transcript.
            disable_log_stats=False,
            enable_log_requests=False,
        )
        engine = AsyncLLM.from_engine_args(args)
        max_model_len = spec.max_model_len or int(engine.model_config.max_model_len)
        logger.info(
            "vllm.backend.engine_started",
            runtime_key=spec.runtime_key,
            max_model_len=max_model_len,
            vram_gib=sizing.vram_gib,
            gpu_memory_utilization=utilization,
            max_num_seqs=max_num_seqs,
            enforce_eager=enforce_eager,
            quantization=quantization,
        )
        return VllmWhisperEngine(
            api=_VllmApi(
                encoder_decoder_prompt=ExplicitEncoderDecoderPrompt,
                text_prompt=TextPrompt,
                sampling_params=SamplingParams,
            ),
            engine=engine,
            spec=spec,
            count_tokens=self._token_counter_loader(model_dir),
            max_model_len=max_model_len,
        )
