"""ASR engine adapters — the registry's dispatch surface.

One adapter per engine family, resolved from the processor registry by
``AiModelFormat``. This is a DELEGATION layer: the battle-tested inference
bodies still live on the orchestrators (``BatchTranscriptionService`` per-
engine ``_run_*_inference`` methods, ``SessionManager`` per-engine
``_make_*_callable`` builders); adding a new engine means one spec in
``asr_capabilities.py`` + one adapter class here instead of editing dispatch
chains in two 2,000+ line modules. Bodies can migrate into these adapters
engine-by-engine without changing the dispatch surface again.

Import-cheap by design: no torch/onnx/azure imports at module import.
"""

from __future__ import annotations

from typing import Any

import structlog

from stt.pipeline.dto import AiModelFormat

from .registry import get_registry

logger = structlog.get_logger(__name__)

# TASK-998 — each cloud engine's duplex adapter, as ``(module, factory)``. Kept
# as a table of STRINGS and imported only inside ``make_streaming_session``, for
# the reason the module docstring gives: an adapter pulls a websocket client and
# a vendor SDK, and this module is on the import path of the BATCH service too.
_DUPLEX_ADAPTERS: dict[str, tuple[str, str]] = {
    "sarvam": ("stt.streaming.sarvam_realtime_asr", "make_sarvam_duplex_session"),
    "openai": ("stt.streaming.openai_realtime_asr", "make_openai_duplex_session"),
    "azure-speech": ("stt.streaming.azure_continuous_asr", "make_azure_duplex_session"),
}


def _resolve_duplex_factory(provider: str) -> Any | None:
    """The duplex session factory for ``provider``, or ``None`` when unavailable.

    An absent module (or a module missing its factory) is a PACKAGING fault, not
    a runtime condition — but failing a clinical session over one is worse than
    running the per-utterance REST path this ticket supersedes, which is still
    present and still correct. So the miss degrades, loudly and by name, and the
    engine falls back to ``make_streaming_callable``.

    Anything the factory ITSELF raises propagates: a rejected credential or an
    unusable endpoint is a SELECTION failure, and selection is fail-closed
    (``09-infrastructure-devops.md`` §Configuration Tiers).
    """
    module_name, attr = _DUPLEX_ADAPTERS[provider]
    try:
        from importlib import import_module

        return getattr(import_module(module_name), attr)
    except (ImportError, AttributeError) as exc:
        logger.warning(
            "stt.asr.duplex_adapter_unavailable",
            provider=provider,
            module=module_name,
            factory=attr,
            error=str(exc),
        )
        return None


ASR_FORMAT_TO_NAME: dict[AiModelFormat, str] = {
    AiModelFormat.SAFETENSOR: "safetensor",
    AiModelFormat.PYTORCH: "safetensor",
    AiModelFormat.CTRANSLATE2: "safetensor",  # legacy alias — loads via transformers
    AiModelFormat.ONNX: "onnx",
    AiModelFormat.ONNX_OPTIMUM: "onnx_optimum",
    AiModelFormat.NEMO: "nemo",
    AiModelFormat.FASTER_WHISPER: "faster_whisper",
    AiModelFormat.AZURE_SPEECH: "azure_speech",
    AiModelFormat.AZURE_FOUNDRY: "azure_foundry",
    AiModelFormat.PARAKEET_CPP: "parakeet_cpp",
    AiModelFormat.WHISPER_CPP: "whisper_cpp",
    AiModelFormat.SARVAM: "sarvam",
    AiModelFormat.OPENAI: "openai",
    # TASK-1021 — Whisper on the in-cluster `vllm` service (stt-side pseudo-format).
    AiModelFormat.VLLM: "vllm",
}


class AsrEngine:
    """Delegation adapter contract for one ASR engine family."""

    async def run_batch(
        self,
        service: Any,
        samples: Any,
        sample_rate: int,
        model: Any,
        config: Any,
        progress_callback: Any = None,
        *,
        chunk_callback: Any = None,
        first_word_hook: Any = None,
        prompt: str | None = None,
        initial_prompt: str | None = None,
    ) -> Any:
        raise NotImplementedError

    def make_streaming_callable(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> Any:
        raise NotImplementedError

    def make_streaming_session(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        task: str = "transcribe",
    ) -> Any:
        """Return a ``DuplexAsrSession`` for an engine that streams natively,
        or ``None`` to use the per-utterance ``make_streaming_callable`` path.

        TASK-998. Returning a session changes the session manager's contract
        with this engine: HOPE stops segmenting (owner decision OD-2 — no local
        VAD for a duplex engine) and stops firing its own partial decodes,
        because the vendor supplies both. The default ``None`` is why every
        local engine is unaffected by this ticket.
        """
        return None


class SafetensorEngine(AsrEngine):
    """transformers path (SAFETENSOR/PYTORCH/CTRANSLATE2), incl. multimodal-LM routing."""

    async def run_batch(
        self,
        service: Any,
        samples: Any,
        sample_rate: int,
        model: Any,
        config: Any,
        progress_callback: Any = None,
        *,
        chunk_callback: Any = None,
        first_word_hook: Any = None,
        prompt: str | None = None,
        initial_prompt: str | None = None,
    ) -> Any:
        return await service._run_transformers_inference(
            samples,
            sample_rate,
            model,
            config,
            progress_callback,
            prompt=prompt,
            initial_prompt=initial_prompt,
        )

    def make_streaming_callable(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> Any:
        return manager._make_transformers_callable(
            loaded_model,
            inference_config,
            initial_prompt=initial_prompt,
            task=task,
        )


class OnnxEngine(AsrEngine):
    """ONNX family. Batch routes Optimum-vs-raw by the LOADED model's shape
    (``extra["optimum"]``/processor presence — a runtime property, not the
    declared format); streaming uses the transformers callable, whose
    no-processor guard rejects raw ORT sessions."""

    async def run_batch(
        self,
        service: Any,
        samples: Any,
        sample_rate: int,
        model: Any,
        config: Any,
        progress_callback: Any = None,
        *,
        chunk_callback: Any = None,
        first_word_hook: Any = None,
        prompt: str | None = None,
        initial_prompt: str | None = None,
    ) -> Any:
        if model.extra.get("optimum") or model.processor is not None:
            return await service._run_optimum_onnx_inference(
                samples,
                sample_rate,
                model,
                config,
                progress_callback,
                chunk_callback=chunk_callback,
                first_word_hook=first_word_hook,
                prompt=prompt,
            )
        return await service._run_onnx_inference(
            samples, sample_rate, model, config, progress_callback
        )

    def make_streaming_callable(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> Any:
        return manager._make_transformers_callable(
            loaded_model,
            inference_config,
            initial_prompt=initial_prompt,
            task=task,
        )


class NemoEngine(AsrEngine):
    async def run_batch(
        self,
        service: Any,
        samples: Any,
        sample_rate: int,
        model: Any,
        config: Any,
        progress_callback: Any = None,
        *,
        chunk_callback: Any = None,
        first_word_hook: Any = None,
        prompt: str | None = None,
        initial_prompt: str | None = None,
    ) -> Any:
        return await service._run_nemo_inference(
            samples, sample_rate, model, config, progress_callback
        )

    def make_streaming_callable(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> Any:
        return manager._make_nemo_callable(
            loaded_model,
            inference_config,
            initial_prompt=initial_prompt,
        )


class FasterWhisperEngine(AsrEngine):
    async def run_batch(
        self,
        service: Any,
        samples: Any,
        sample_rate: int,
        model: Any,
        config: Any,
        progress_callback: Any = None,
        *,
        chunk_callback: Any = None,
        first_word_hook: Any = None,
        prompt: str | None = None,
        initial_prompt: str | None = None,
    ) -> Any:
        # `prompt` first: on the segmented batch path it
        # is compose_prompt(initial_prompt, previous_segment_text), a superset
        # that already contains initial_prompt; preferring the bare
        # initial_prompt silently discarded the rolling segment context.
        return await service._run_faster_whisper_inference(
            samples,
            sample_rate,
            model,
            config,
            progress_callback,
            initial_prompt=prompt or initial_prompt,
        )

    def make_streaming_callable(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> Any:
        return manager._make_faster_whisper_callable(
            loaded_model,
            inference_config,
            task=task,
        )


class AzureSpeechEngine(AsrEngine):
    async def run_batch(
        self,
        service: Any,
        samples: Any,
        sample_rate: int,
        model: Any,
        config: Any,
        progress_callback: Any = None,
        *,
        chunk_callback: Any = None,
        first_word_hook: Any = None,
        prompt: str | None = None,
        initial_prompt: str | None = None,
    ) -> Any:
        return await service._run_azure_speech_inference(
            samples, sample_rate, model, config, progress_callback
        )

    def make_streaming_callable(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> Any:
        return manager._make_azure_callable(loaded_model, inference_config)

    def make_streaming_session(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        task: str = "transcribe",
    ) -> Any:
        """Azure Speech ``ContinuousRecognition`` — the vendor owns the endpointer.

        TASK-998 / OD-1. ``loaded_model.model`` is the Azure ``SpeechConfig``
        rather than a ``CloudRestConfig``, which is exactly why the factory takes
        the LOADED MODEL and not a config type: the three adapters share a
        signature, not a payload.
        """
        factory = _resolve_duplex_factory("azure-speech")
        if factory is None:
            return None
        return factory(loaded_model, inference_config, task=task)


class SarvamEngine(AsrEngine):
    """Sarvam AI speech-to-text. Batch (and the superseded per-utterance
    streaming path) over cloud REST; live streaming over the vendor's duplex
    socket — see ``make_streaming_session``."""

    async def run_batch(
        self,
        service: Any,
        samples: Any,
        sample_rate: int,
        model: Any,
        config: Any,
        progress_callback: Any = None,
        *,
        chunk_callback: Any = None,
        first_word_hook: Any = None,
        prompt: str | None = None,
        initial_prompt: str | None = None,
    ) -> Any:
        return await service._run_sarvam_inference(
            samples, sample_rate, model, config, progress_callback
        )

    def make_streaming_callable(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> Any:
        return manager._make_sarvam_callable(loaded_model, inference_config)

    def make_streaming_session(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        task: str = "transcribe",
    ) -> Any:
        """Sarvam's native streaming socket — the vendor owns the endpointer.

        TASK-998 / OD-1. ``loaded_model.model`` is the ``CloudRestConfig`` the
        loader validated; the adapter reuses its key and base URL for the socket
        handshake, so a tenant's BYO credential reaches the duplex path by the
        same route it reaches the REST one.
        """
        factory = _resolve_duplex_factory("sarvam")
        if factory is None:
            return None
        return factory(loaded_model, inference_config, task=task)


class OpenAIEngine(AsrEngine):
    """OpenAI speech-to-text. Batch (and the superseded per-utterance streaming
    path) over cloud REST; live streaming over the Realtime transcription
    socket — see ``make_streaming_session``."""

    async def run_batch(
        self,
        service: Any,
        samples: Any,
        sample_rate: int,
        model: Any,
        config: Any,
        progress_callback: Any = None,
        *,
        chunk_callback: Any = None,
        first_word_hook: Any = None,
        prompt: str | None = None,
        initial_prompt: str | None = None,
    ) -> Any:
        return await service._run_openai_inference(
            samples, sample_rate, model, config, progress_callback
        )

    def make_streaming_callable(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> Any:
        return manager._make_openai_callable(loaded_model, inference_config)

    def make_streaming_session(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        task: str = "transcribe",
    ) -> Any:
        """OpenAI's Realtime transcription socket — the vendor owns the endpointer.

        TASK-998 / OD-1. ``loaded_model.model`` is the ``CloudRestConfig`` the
        loader validated, so the socket authenticates with the same BYO key the
        REST path uses.
        """
        factory = _resolve_duplex_factory("openai")
        if factory is None:
            return None
        return factory(loaded_model, inference_config, task=task)


def resolve_asr_engine(model_format: Any) -> AsrEngine:
    """Resolve the engine adapter for a model format via the registry.

    Raises :class:`LookupError` for unmapped formats — callers translate to
    their surface-appropriate error (batch keeps its historical
    ``TranscriptionError("Unsupported model format: ...")``).
    """
    name = ASR_FORMAT_TO_NAME.get(model_format)
    if name is None:
        raise LookupError(
            f"No ASR engine registered for model format {model_format!r}. "
            "Registered: " + ", ".join(sorted(get_registry().names("asr")))
        )
    engine_cls = get_registry().load("asr", name)
    return engine_cls()  # type: ignore[no-any-return]


class ParakeetCppEngine(AsrEngine):
    """parakeet.cpp (ggml). Per-utterance streaming +
    whole-audio batch via the same duck-typed binding adapter."""

    async def run_batch(
        self,
        service: Any,
        samples: Any,
        sample_rate: int,
        model: Any,
        config: Any,
        progress_callback: Any = None,
        *,
        chunk_callback: Any = None,
        first_word_hook: Any = None,
        prompt: str | None = None,
        initial_prompt: str | None = None,
    ) -> Any:
        return await service._run_parakeet_cpp_inference(
            samples, sample_rate, model, config, progress_callback
        )

    def make_streaming_callable(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> Any:
        return manager._make_parakeet_cpp_callable(loaded_model, inference_config)


class WhisperCppEngine(AsrEngine):
    """whisper.cpp (ggml). Per-utterance streaming + whole-audio
    batch via the same duck-typed adapter (mirrors ``ParakeetCppEngine``)."""

    async def run_batch(
        self,
        service: Any,
        samples: Any,
        sample_rate: int,
        model: Any,
        config: Any,
        progress_callback: Any = None,
        *,
        chunk_callback: Any = None,
        first_word_hook: Any = None,
        prompt: str | None = None,
        initial_prompt: str | None = None,
    ) -> Any:
        return await service._run_whisper_cpp_inference(
            samples,
            sample_rate,
            model,
            config,
            progress_callback,
            prompt=prompt or initial_prompt,
        )

    def make_streaming_callable(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> Any:
        return manager._make_whisper_cpp_callable(loaded_model, inference_config)


class AzureFoundryEngine(AsrEngine):
    """Azure AI Foundry MAI-Transcribe —
    PREVIEW service, batch-only, disabled by default."""

    async def run_batch(
        self,
        service: Any,
        samples: Any,
        sample_rate: int,
        model: Any,
        config: Any,
        progress_callback: Any = None,
        *,
        chunk_callback: Any = None,
        first_word_hook: Any = None,
        prompt: str | None = None,
        initial_prompt: str | None = None,
    ) -> Any:
        return await service._run_azure_foundry_inference(
            samples, sample_rate, model, config, progress_callback
        )

    def make_streaming_callable(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> Any:
        raise RuntimeError(
            "Azure Foundry (MAI-Transcribe) is batch-only (decision D4: "
            "preview service; realtime requires the Voice Live API — "
            "separate ticket)."
        )

    # TASK-998 — deliberately NOT overriding ``make_streaming_session``. Foundry
    # shares Azure's NAME, not its realtime transport: MAI-Transcribe is
    # batch-only (D4) and its capability spec declares ``streaming=False``, so
    # handing it the Azure Speech ``ContinuousRecognition`` adapter would open a
    # socket against a service that has none. The inherited ``None`` keeps this
    # engine on the callable path, where its own guard above still refuses.


class VllmEngine(AsrEngine):
    """Whisper on the in-cluster `vllm` service (TASK-1021, contract C-3).

    Streaming decodes each utterance as ≤ 30 s windows over REST; batch cuts the
    file with the whisper.cpp segmenter and decodes the windows concurrently. Both
    send the agent's own initial prompt and never prior-transcript context
    (TASK-994). Transcribe only: the route has no translate task, so no gloss.
    """

    async def run_batch(
        self,
        service: Any,
        samples: Any,
        sample_rate: int,
        model: Any,
        config: Any,
        progress_callback: Any = None,
        *,
        chunk_callback: Any = None,
        first_word_hook: Any = None,
        prompt: str | None = None,
        initial_prompt: str | None = None,
    ) -> Any:
        # `prompt` is the batch path's carry-forward context; deliberately not sent.
        return await service._run_vllm_inference(
            samples, sample_rate, model, config, progress_callback, initial_prompt=initial_prompt
        )

    def make_streaming_callable(
        self,
        manager: Any,
        loaded_model: Any,
        inference_config: Any,
        *,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> Any:
        if task != "transcribe":
            raise RuntimeError(f"vllm serves task=transcribe only, not task={task!r}")
        return manager._make_vllm_callable(
            loaded_model, inference_config, initial_prompt=initial_prompt
        )
