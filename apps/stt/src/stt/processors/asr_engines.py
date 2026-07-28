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

from stt.pipeline.dto import AiModelFormat

from .registry import get_registry

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


class SarvamEngine(AsrEngine):
    """Sarvam AI speech-to-text (cloud REST). Per-utterance streaming + whole-
    audio batch via the same async recognize helper (TASK-567)."""

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


class OpenAIEngine(AsrEngine):
    """OpenAI speech-to-text (cloud REST). Per-utterance streaming (REST in v1)
    + whole-audio batch via the same async recognize helper (TASK-567)."""

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
