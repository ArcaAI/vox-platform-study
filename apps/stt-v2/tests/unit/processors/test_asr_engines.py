"""ASR engine adapter dispatch tests (TASK-505 Phase 1)."""

from unittest.mock import AsyncMock

import pytest

from stt_v2.pipeline.dto import AiModelFormat
from stt_v2.processors.asr_engines import (
    ASR_FORMAT_TO_NAME,
    AsrEngine,
    AzureSpeechEngine,
    FasterWhisperEngine,
    NemoEngine,
    OnnxEngine,
    SafetensorEngine,
    resolve_asr_engine,
)


class TestFormatMap:
    def test_every_model_format_is_mapped(self):
        # A new AiModelFormat member without a dispatch mapping must fail CI,
        # not fall through at runtime.
        assert set(ASR_FORMAT_TO_NAME) == set(AiModelFormat)

    def test_mapped_names_are_registered_specs(self):
        from stt_v2.processors import get_registry

        assert set(ASR_FORMAT_TO_NAME.values()) <= set(get_registry().names("asr"))


class TestResolve:
    @pytest.mark.parametrize(
        ("fmt", "cls"),
        [
            (AiModelFormat.SAFETENSOR, SafetensorEngine),
            (AiModelFormat.PYTORCH, SafetensorEngine),
            (AiModelFormat.CTRANSLATE2, SafetensorEngine),
            (AiModelFormat.ONNX, OnnxEngine),
            (AiModelFormat.ONNX_OPTIMUM, OnnxEngine),
            (AiModelFormat.NEMO, NemoEngine),
            (AiModelFormat.FASTER_WHISPER, FasterWhisperEngine),
            (AiModelFormat.AZURE_SPEECH, AzureSpeechEngine),
        ],
    )
    def test_resolves_expected_adapter(self, fmt, cls):
        engine = resolve_asr_engine(fmt)
        assert isinstance(engine, cls)
        assert isinstance(engine, AsrEngine)

    def test_unknown_format_raises_lookup_error(self):
        with pytest.raises(LookupError, match="No ASR engine registered"):
            resolve_asr_engine("NOT_A_FORMAT")


class TestBindingResolution:
    """Platform-aware binding resolution (TASK-505 P1 tail)."""

    def test_platform_device_preferences(self):
        from stt_v2.processors.binding import platform_device_preferences

        assert platform_device_preferences("cuda") == ["cuda", "cpu", "cloud"]
        assert platform_device_preferences("mps") == ["mps", "cpu", "cloud"]
        assert platform_device_preferences("cpu") == ["cpu", "cloud"]

    def test_faster_whisper_falls_back_to_cpu_on_mps(self):
        from stt_v2.processors.binding import resolve_engine_binding

        binding = resolve_engine_binding(
            "asr", "faster_whisper", mode="streaming", platform="mps", warn=False
        )
        assert binding is not None
        assert binding.device == "cpu"

    def test_azure_resolves_cloud_on_any_platform(self):
        from stt_v2.processors.binding import resolve_engine_binding

        binding = resolve_engine_binding(
            "asr", "azure_speech", mode="batch", platform="cpu", warn=False
        )
        assert binding is not None
        assert binding.device == "cloud"

    def test_raw_onnx_streaming_unsupported_returns_none(self):
        from stt_v2.processors.binding import resolve_engine_binding

        binding = resolve_engine_binding(
            "asr", "onnx", mode="streaming", platform="cuda", warn=False
        )
        assert binding is None

    def test_compute_preference_respected(self):
        from stt_v2.processors.binding import resolve_engine_binding

        binding = resolve_engine_binding(
            "asr",
            "faster_whisper",
            mode="batch",
            platform="cuda",
            compute_pref=["int8_float16"],
            warn=False,
        )
        assert binding is not None
        assert (binding.device, binding.compute) == ("cuda", "int8_float16")

    def test_health_payload_shape(self):
        from unittest.mock import patch

        from stt_v2.processors import binding as binding_mod

        with patch.object(binding_mod, "detect_platform") as mock_detect:
            mock_detect.return_value.value = "cpu"
            payload = binding_mod.asr_processor_health()

        assert payload["platform"] == "cpu"
        assert set(payload["asr_engines"]) == {
            "safetensor", "onnx", "onnx_optimum", "nemo",
            "faster_whisper", "azure_speech",
            "parakeet_cpp", "azure_foundry",
        }
        assert payload["asr_engines"]["onnx"]["streaming"] == "unsupported"
        assert payload["asr_engines"]["safetensor"]["batch"]["device"] == "cpu"


class TestP1ReviewFixes:
    """Regression locks for the Phase 1 adversarial-review findings."""

    def test_profile_compute_mismatch_still_resolves(self):
        # NeMo declares only float32; a CUDA profile prefers float16 — the
        # binding must resolve (soft preference), not warn "unsupported".
        from stt_v2.processors.binding import resolve_engine_binding

        binding = resolve_engine_binding(
            "asr", "nemo", mode="streaming", platform="cuda",
            compute_pref=["float16"], warn=False,
        )
        assert binding is not None
        assert (binding.device, binding.compute) == ("cuda", "float32")

    def test_cloud_binding_has_no_compute(self):
        from stt_v2.processors.binding import resolve_engine_binding

        binding = resolve_engine_binding(
            "asr", "azure_speech", mode="batch", platform="cuda",
            compute_pref=["float16"], warn=False,
        )
        assert binding is not None
        assert binding.compute is None

    def test_onnx_optimum_engine_string_accepted(self):
        # The enum's own value must round-trip through YAML now that unknown
        # strings hard-error.
        from stt_v2.pipeline.dto import AiModelFormat, ModelRef

        ref = ModelRef.from_value({"hf_model_id": "x", "engine": "onnx_optimum"})
        assert ref.inline.engine == AiModelFormat.ONNX_OPTIMUM

    @pytest.mark.asyncio
    async def test_fw_batch_prefers_composed_prompt(self):
        # The segmented batch path passes prompt=compose_prompt(initial, prev
        # segment context) — a superset of initial_prompt. It must win.
        from unittest.mock import AsyncMock, MagicMock

        from stt_v2.processors.asr_engines import FasterWhisperEngine

        service = MagicMock()
        service._run_faster_whisper_inference = AsyncMock(return_value="ok")
        engine = FasterWhisperEngine()

        await engine.run_batch(
            service, None, 16000, MagicMock(), MagicMock(),
            prompt="composed rolling prompt", initial_prompt="bare initial",
        )

        kwargs = service._run_faster_whisper_inference.call_args.kwargs
        assert kwargs["initial_prompt"] == "composed rolling prompt"


class TestP3NewEngines:
    """TASK-505 P3 — PARAKEET_CPP + AZURE_FOUNDRY engines (inline-YAML-only)."""

    def test_new_formats_exist_and_map(self):
        from stt_v2.processors.asr_engines import (
            AzureFoundryEngine,
            ParakeetCppEngine,
        )

        assert ASR_FORMAT_TO_NAME[AiModelFormat.PARAKEET_CPP] == "parakeet_cpp"
        assert ASR_FORMAT_TO_NAME[AiModelFormat.AZURE_FOUNDRY] == "azure_foundry"
        assert isinstance(resolve_asr_engine(AiModelFormat.PARAKEET_CPP), ParakeetCppEngine)
        assert isinstance(resolve_asr_engine(AiModelFormat.AZURE_FOUNDRY), AzureFoundryEngine)

    def test_provider_shorthand_for_new_engines(self):
        from stt_v2.pipeline.dto import ModelRef

        ref = ModelRef.from_value(
            "parakeet.cpp :: nvidia/nemotron-3.5-asr-streaming-0.6b"
        )
        assert ref.inline.engine == AiModelFormat.PARAKEET_CPP
        assert ref.inline.hf_model_id == "nvidia/nemotron-3.5-asr-streaming-0.6b"

        ref2 = ModelRef.from_value("azure-foundry :: mai-transcribe-1.5")
        assert ref2.inline.engine == AiModelFormat.AZURE_FOUNDRY

    def test_azure_foundry_is_batch_only(self):
        # Decision D4: preview → capability streaming=False AND the adapter
        # refuses to build a streaming callable.
        from unittest.mock import MagicMock

        from stt_v2.processors import get_registry
        from stt_v2.processors.asr_engines import AzureFoundryEngine

        spec = get_registry().spec("asr", "azure_foundry")
        assert not any(c.streaming for c in spec.capabilities)

        with pytest.raises(RuntimeError, match="batch-only"):
            AzureFoundryEngine().make_streaming_callable(
                MagicMock(), MagicMock(), MagicMock()
            )

    @pytest.mark.asyncio
    async def test_azure_foundry_disabled_by_default(self):
        # Decision D4: the loader refuses unless azure_foundry_enabled is set.
        from unittest.mock import MagicMock, patch

        from stt_v2.core.exceptions import CloudASRAuthError
        from stt_v2.models.azure_foundry_loader import AzureFoundryLoader

        settings = MagicMock(azure_foundry_enabled=False)
        with patch(
            "stt_v2.models.azure_foundry_loader.get_settings", return_value=settings
        ):
            with pytest.raises(CloudASRAuthError, match="disabled"):
                await AzureFoundryLoader().load(MagicMock())

    def test_parakeet_adapter_contract(self):
        # Duck-typed binding: transcribe() dict → callable contract dict.
        import numpy as np

        from stt_v2.models.base_loader import LoadedModel
        from stt_v2.streaming.parakeet_cpp_asr import ParakeetCppAsrAdapter

        class FakeBinding:
            def transcribe(self, samples, sample_rate, num_threads=4, **kw):
                return {
                    "text": "hello world",
                    "words": [
                        {"word": "hello", "start": 0.0, "end": 0.4},
                        {"word": "world", "start": 0.4, "end": 0.9},
                    ],
                }

        loaded = LoadedModel(
            model_id="m",
            model_slug="nemotron",
            model=FakeBinding(),
            format=AiModelFormat.PARAKEET_CPP,
            extra={"num_threads": 2},
        )
        from unittest.mock import MagicMock

        adapter = ParakeetCppAsrAdapter(loaded, MagicMock(language="en"))
        out = adapter(np.zeros(16000, dtype=np.float32), 16000)

        assert out["text"] == "hello world"
        assert len(out["word_timestamps"]) == 2
        assert out["segments"][0]["end"] == 1.0

    def test_parakeet_raw_ctypes_handle_rejected(self):
        from unittest.mock import MagicMock

        from stt_v2.models.base_loader import LoadedModel
        from stt_v2.streaming.parakeet_cpp_asr import ParakeetCppAsrAdapter

        loaded = LoadedModel(
            model_id="m",
            model_slug="nemotron",
            model={"library": object(), "model_path": "/x"},
            format=AiModelFormat.PARAKEET_CPP,
        )
        with pytest.raises(RuntimeError, match="binding"):
            ParakeetCppAsrAdapter(loaded, MagicMock(language=None))

    @pytest.mark.asyncio
    async def test_azure_foundry_batch_parses_llm_speech_response(self):
        # The batch method must map the LLM Speech API response shape into
        # RawTranscription (phrases → segments, words → word_timestamps).
        from unittest.mock import MagicMock, patch

        from stt_v2.transcription.batch_service import BatchTranscriptionService

        service = BatchTranscriptionService()
        model = MagicMock()
        model.model = {"endpoint": "https://r.cognitiveservices.azure.com", "api_key": "k", "model": "mai-transcribe-1.5"}

        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {
            "combinedPhrases": [{"text": "severe chest pain"}],
            "phrases": [
                {
                    "text": "severe chest pain",
                    "offsetMilliseconds": 100,
                    "durationMilliseconds": 1400,
                    "locale": "en-US",
                    "words": [
                        {"text": "severe", "offsetMilliseconds": 100, "durationMilliseconds": 400},
                        {"text": "chest", "offsetMilliseconds": 500, "durationMilliseconds": 400},
                        {"text": "pain", "offsetMilliseconds": 900, "durationMilliseconds": 600},
                    ],
                }
            ],
        }

        client = MagicMock()
        client.post = AsyncMock(return_value=response)
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=False)

        import numpy as np

        with patch("httpx.AsyncClient", return_value=client):
            raw = await service._run_azure_foundry_inference(
                np.zeros(16000, dtype=np.float32), 16000, model, MagicMock(language="en"),
            )

        assert raw.text == "severe chest pain"
        assert len(raw.word_timestamps) == 3
        assert raw.word_timestamps[0]["start"] == 0.1
        assert raw.segments[0]["end"] == 1.5
        # Definition carried the enhancedMode model selection.
        _args, kwargs = client.post.call_args
        assert "mai-transcribe-1.5" in kwargs["data"]["definition"]

    @pytest.mark.asyncio
    async def test_azure_foundry_maps_auth_and_quota_errors(self):
        from unittest.mock import MagicMock, patch

        import numpy as np

        from stt_v2.core.exceptions import CloudASRAuthError, CloudASRQuotaError
        from stt_v2.transcription.batch_service import BatchTranscriptionService

        service = BatchTranscriptionService()
        model = MagicMock()
        model.model = {"endpoint": "https://r", "api_key": "k", "model": "m"}

        for status, exc_type in ((401, CloudASRAuthError), (429, CloudASRQuotaError)):
            response = MagicMock(status_code=status, text="err")
            client = MagicMock()
            client.post = AsyncMock(return_value=response)
            client.__aenter__ = AsyncMock(return_value=client)
            client.__aexit__ = AsyncMock(return_value=False)
            with patch("httpx.AsyncClient", return_value=client):
                with pytest.raises(exc_type):
                    await service._run_azure_foundry_inference(
                        np.zeros(160, dtype=np.float32), 16000, model, MagicMock(language=None),
                    )


class TestP4EmbeddingDim:
    """TASK-505 P4 (decision D1) — settings-driven voice-profile embedding dim."""

    def test_extraction_dim_follows_settings(self):
        from unittest.mock import MagicMock, patch

        from stt_v2.voice_profile import extraction_service as es

        settings = MagicMock(voice_profile_embedding_dim=192)
        with patch.object(es, "EXPECTED_EMBEDDING_DIM", 256):
            with patch(
                "stt_v2.core.config.settings.get_settings", return_value=settings
            ):
                svc = es.ExtractionService(
                    embedding_service=MagicMock(),
                    vad_service=MagicMock(),
                    min_cross_sample_similarity=0.5,
                )
        assert svc._expected_embedding_dim == 192

    def test_explicit_dim_still_wins(self):
        from unittest.mock import MagicMock

        from stt_v2.voice_profile.extraction_service import ExtractionService

        svc = ExtractionService(
            embedding_service=MagicMock(),
            vad_service=MagicMock(),
            min_cross_sample_similarity=0.5,
            expected_embedding_dim=512,
        )
        assert svc._expected_embedding_dim == 512
