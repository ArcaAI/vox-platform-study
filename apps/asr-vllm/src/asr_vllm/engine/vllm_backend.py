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
"""

from __future__ import annotations

import asyncio
import importlib.util
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from hope_obs import get_logger

from asr_vllm.audio import SAMPLE_RATE
from asr_vllm.core.config import Settings
from asr_vllm.engine.base import DecoderBudgetError, DecodeRequest, DecodeResult
from asr_vllm.spec import ResolvedVllmAsrSpec

logger = get_logger(__name__)

#: ``spec -> (text -> token count)``; the default loads the checkpoint's own tokenizer.
TokenCounterLoader = Callable[[ResolvedVllmAsrSpec], Callable[[str], int]]


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


def _load_target(spec: ResolvedVllmAsrSpec) -> tuple[str, str | None]:
    """The published directory, else the HF repo id at the row's pinned revision."""
    model = spec.model
    if model.local_path:
        return model.local_path, None
    uri = model.source_uri.strip()
    for prefix in ("hf://", "huggingface://"):
        if uri.startswith(prefix):
            return uri[len(prefix) :], model.source_revision
    return uri, model.source_revision


def _hf_token_counter(spec: ResolvedVllmAsrSpec) -> Callable[[str], int]:
    """Count decoder-prompt tokens with the checkpoint's own tokenizer (``transformers``
    ships with vLLM). Special tokens written in the text resolve to their single ids."""
    from transformers import AutoTokenizer

    target, revision = _load_target(spec)
    tokenizer = AutoTokenizer.from_pretrained(target, revision=revision)

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
        spec: ResolvedVllmAsrSpec,
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
        self, settings: Settings, *, token_counter_loader: TokenCounterLoader | None = None
    ) -> None:
        self._settings = settings
        self._token_counter_loader = token_counter_loader or _hf_token_counter

    def availability(self) -> str | None:
        try:
            found = importlib.util.find_spec("vllm") is not None
        except (ImportError, ValueError):
            found = False
        return None if found else "vllm is not installed in this image (Linux + CUDA only)"

    async def build(self, spec: ResolvedVllmAsrSpec) -> VllmWhisperEngine:
        return await asyncio.to_thread(self._build_sync, spec)

    def _build_sync(self, spec: ResolvedVllmAsrSpec) -> VllmWhisperEngine:
        from vllm import AsyncEngineArgs, SamplingParams
        from vllm.inputs import ExplicitEncoderDecoderPrompt, TextPrompt
        from vllm.v1.engine.async_llm import AsyncLLM

        settings = self._settings
        model = spec.model
        target, revision = _load_target(spec)
        args = AsyncEngineArgs(
            model=target,
            revision=revision,
            dtype=model.compute_type or "auto",
            quantization=model.quantization,
            max_model_len=model.max_model_len,
            gpu_memory_utilization=settings.gpu_memory_utilization,
            max_num_seqs=settings.max_num_seqs,
            enforce_eager=settings.enforce_eager,
            limit_mm_per_prompt={"audio": 1},
        )
        engine = AsyncLLM.from_engine_args(args)
        max_model_len = model.max_model_len or int(engine.model_config.max_model_len)
        logger.info(
            "asr_vllm.vllm.engine_started",
            runtime_key=spec.runtime_key,
            max_model_len=max_model_len,
            max_num_seqs=settings.max_num_seqs,
        )
        return VllmWhisperEngine(
            api=_VllmApi(
                encoder_decoder_prompt=ExplicitEncoderDecoderPrompt,
                text_prompt=TextPrompt,
                sampling_params=SamplingParams,
            ),
            engine=engine,
            spec=spec,
            count_tokens=self._token_counter_loader(spec),
            max_model_len=max_model_len,
        )
