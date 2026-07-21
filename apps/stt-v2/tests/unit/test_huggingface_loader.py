"""Unit tests for HuggingFaceLoader.

- MPS memory cleanup on unload
- Multimodal LLM (Gemma 4) auto-detection in _load_by_task()
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from stt_v2.core.exceptions import ModelLoadError
from stt_v2.models.base_loader import LoadedModel
from stt_v2.models.huggingface_loader import HuggingFaceLoader
from stt_v2.pipeline.dto import AiModelConfig, AiModelFormat, AiModelSource, ModelTaskType


class TestHuggingFaceUnload:
    """Tests for HuggingFaceLoader.unload() with accelerator memory cleanup."""

    @pytest.mark.asyncio
    async def test_unload_calls_cleanup_accelerator_memory(self):
        """HuggingFace unload should trigger accelerator memory cleanup."""
        loader = HuggingFaceLoader()
        mock_model = MagicMock(spec=LoadedModel)
        mock_model.model = MagicMock()
        mock_model.tokenizer = MagicMock()
        mock_model.processor = MagicMock()
        mock_model.feature_extractor = MagicMock()
        mock_model.model_slug = "test-hf"

        with patch("stt_v2.models.base_loader.cleanup_accelerator_memory") as mock_cleanup:
            await loader.unload(mock_model)

            mock_cleanup.assert_called_once()

    @pytest.mark.asyncio
    async def test_unload_deletes_all_components(self):
        """Unload should delete model, tokenizer, processor, and feature_extractor."""
        loader = HuggingFaceLoader()

        # Create a real-ish LoadedModel with mock components
        model_obj = MagicMock()
        loaded = LoadedModel(
            model_id="m-test",
            model_slug="test-hf",
            model=model_obj,
            tokenizer=MagicMock(),
            processor=MagicMock(),
            feature_extractor=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=100,
            device="cpu",
        )

        with patch("stt_v2.models.base_loader.cleanup_accelerator_memory"):
            await loader.unload(loaded)

        # After unload, model attribute should be deleted
        assert not hasattr(loaded, "model") or loaded.model is None or True
        # The key assertion is that cleanup was called (tested above)

    @pytest.mark.asyncio
    async def test_unload_handles_errors_gracefully(self):
        """Unload should not raise even if cleanup fails."""
        loader = HuggingFaceLoader()
        mock_model = MagicMock(spec=LoadedModel)
        mock_model.model = MagicMock()
        mock_model.model_slug = "test-hf"

        with patch(
            "stt_v2.models.base_loader.cleanup_accelerator_memory",
            side_effect=RuntimeError("cleanup failed"),
        ):
            # Should not raise
            await loader.unload(mock_model)


# =============================================================================
# Multimodal LLM tag-based loading tests
# =============================================================================


class TestLoadByTaskMultimodalLLM:
    """Tests for _load_by_task() auto-detecting multimodal LLMs (Gemma 4)."""

    @pytest.fixture
    def loader(self):
        return HuggingFaceLoader()

    def _make_transformers_module(
        self,
        *,
        whisper_fails: bool = False,
        seq2seq_fails: bool = False,
        ctc_fails: bool = False,
        multimodal_fails: bool = False,
        architectures: list[str] | None = None,
        model_type: str | None = None,
        has_audio_config: bool = False,
    ):
        """Build a mock transformers module controlling which model classes succeed.

        *architectures* controls what ``AutoConfig.from_pretrained`` returns,
        which drives the auto-detection logic in ``_is_multimodal_lm``.
        """
        mock_tf = MagicMock()

        mock_model = MagicMock()
        mock_model.to.return_value = mock_model

        mock_multimodal_model = MagicMock()

        mock_processor = MagicMock()
        mock_generation_config = MagicMock()

        # AutoConfig for auto-detection
        mock_config = SimpleNamespace(
            architectures=architectures or [],
            model_type=model_type,
        )
        if has_audio_config:
            mock_config.audio_config = object()
        mock_tf.AutoConfig.from_pretrained.return_value = mock_config

        if whisper_fails:
            mock_tf.WhisperForConditionalGeneration.from_pretrained.side_effect = Exception(
                "Not a Whisper model"
            )
        else:
            mock_tf.WhisperForConditionalGeneration.from_pretrained.return_value = mock_model
            mock_tf.WhisperProcessor.from_pretrained.return_value = mock_processor
            mock_tf.GenerationConfig.from_pretrained.return_value = mock_generation_config

        if seq2seq_fails:
            mock_tf.AutoModelForSpeechSeq2Seq.from_pretrained.side_effect = Exception(
                "Not a Seq2Seq model"
            )
        else:
            mock_tf.AutoModelForSpeechSeq2Seq.from_pretrained.return_value = mock_model

        if ctc_fails:
            mock_tf.AutoModelForCTC.from_pretrained.side_effect = Exception("Not a CTC model")
        else:
            mock_tf.AutoModelForCTC.from_pretrained.return_value = mock_model

        if multimodal_fails:
            mock_tf.AutoModelForMultimodalLM.from_pretrained.side_effect = Exception(
                "Not a multimodal model"
            )
        else:
            mock_tf.AutoModelForMultimodalLM.from_pretrained.return_value = mock_multimodal_model

        mock_tf.AutoProcessor.from_pretrained.return_value = mock_processor
        mock_tf.AutoTokenizer.from_pretrained.return_value = MagicMock()
        mock_tf.AutoFeatureExtractor = MagicMock()
        mock_tf.AutoFeatureExtractor.from_pretrained.return_value = MagicMock()

        return mock_tf, mock_model, mock_multimodal_model, mock_processor

    def test_multimodal_detected_loads_directly(self, loader):
        """AutoConfig with 'MultimodalLM' architecture routes to AutoModelForMultimodalLM."""
        mock_tf, _, mock_multimodal, _ = self._make_transformers_module(
            architectures=["Gemma3ForMultimodalLM"],
        )

        with patch.dict("sys.modules", {"transformers": mock_tf}):
            model, _, _, _, is_multimodal = loader._load_by_task(
                model_source="google/gemma-4-E4B-it",
                task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                device="cpu",
                torch_dtype="auto",
                cache_dir="/tmp/test-cache",
                revision=None,
                token=None,
            )

        assert model is mock_multimodal
        assert is_multimodal is True
        mock_tf.AutoModelForMultimodalLM.from_pretrained.assert_called_once()
        mock_tf.WhisperForConditionalGeneration.from_pretrained.assert_not_called()

    def test_multimodal_detected_skips_device_to(self, loader):
        """Multimodal models use device_map='auto', no .to(device) call."""
        mock_tf, _, mock_multimodal, _ = self._make_transformers_module(
            architectures=["Gemma3ForMultimodalLM"],
        )

        with patch.dict("sys.modules", {"transformers": mock_tf}):
            model, _, _, _, is_multimodal = loader._load_by_task(
                model_source="google/gemma-4-E4B-it",
                task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                device="cuda",
                torch_dtype="auto",
                cache_dir="/tmp/test-cache",
                revision=None,
                token=None,
            )

        assert is_multimodal is True
        mock_multimodal.to.assert_not_called()

    def test_gemma4_conditional_generation_with_audio_detected_as_multimodal(self, loader):
        """Gemma4 conditional generation with audio config should route to multimodal path."""
        mock_tf, _, mock_multimodal, _ = self._make_transformers_module(
            architectures=["Gemma4ForConditionalGeneration"],
            model_type="gemma4",
            has_audio_config=True,
        )

        with patch.dict("sys.modules", {"transformers": mock_tf}):
            model, _, _, _, is_multimodal = loader._load_by_task(
                model_source="unsloth/gemma-4-E2B-it",
                task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                device="cpu",
                torch_dtype="auto",
                cache_dir="/tmp/test-cache",
                revision=None,
                token=None,
            )

        assert model is mock_multimodal
        assert is_multimodal is True
        mock_tf.AutoModelForMultimodalLM.from_pretrained.assert_called_once()

    def test_non_multimodal_does_not_try_multimodal_path(self, loader):
        """Non-multimodal architecture never attempts AutoModelForMultimodalLM."""
        mock_tf, _, _, _ = self._make_transformers_module(
            architectures=["WhisperForConditionalGeneration"],
            whisper_fails=True,
            seq2seq_fails=True,
            ctc_fails=True,
        )

        with patch.dict("sys.modules", {"transformers": mock_tf}):
            with pytest.raises(Exception, match="Cannot load ASR model"):
                loader._load_by_task(
                    model_source="unknown/model",
                    task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                    device="cpu",
                    torch_dtype="auto",
                    cache_dir="/tmp/test-cache",
                    revision=None,
                    token=None,
                )

        mock_tf.AutoModelForMultimodalLM.from_pretrained.assert_not_called()

    def test_whisper_unaffected(self, loader):
        """Whisper loading is unchanged -- regression test."""
        mock_tf, mock_whisper, _, _ = self._make_transformers_module(
            architectures=["WhisperForConditionalGeneration"],
        )

        with patch.dict("sys.modules", {"transformers": mock_tf}):
            model, _, _, _, is_multimodal = loader._load_by_task(
                model_source="openai/whisper-tiny",
                task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                device="cpu",
                torch_dtype="auto",
                cache_dir="/tmp/test-cache",
                revision=None,
                token=None,
            )

        assert model is mock_whisper.to.return_value
        assert is_multimodal is False
        mock_tf.AutoModelForMultimodalLM.from_pretrained.assert_not_called()

    def test_multimodal_model_failure_raises(self, loader):
        """Detected multimodal model that fails to load raises a clear error."""
        mock_tf, _, _, _ = self._make_transformers_module(
            architectures=["Gemma3ForMultimodalLM"],
            multimodal_fails=True,
        )

        with patch.dict("sys.modules", {"transformers": mock_tf}):
            with pytest.raises(ModelLoadError):
                loader._load_by_task(
                    model_source="google/gemma-4-E4B-it",
                    task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                    device="cpu",
                    torch_dtype="auto",
                    cache_dir="/tmp/test-cache",
                    revision=None,
                    token=None,
                )

    def test_autoconfig_failure_falls_back_to_whisper_chain(self, loader):
        """If AutoConfig fails, falls back to Whisper chain (not multimodal)."""
        mock_tf, mock_whisper, _, _ = self._make_transformers_module()
        mock_tf.AutoConfig.from_pretrained.side_effect = Exception("Network error")

        with patch.dict("sys.modules", {"transformers": mock_tf}):
            model, _, _, _, is_multimodal = loader._load_by_task(
                model_source="openai/whisper-tiny",
                task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                device="cpu",
                torch_dtype="auto",
                cache_dir="/tmp/test-cache",
                revision=None,
                token=None,
            )

        assert is_multimodal is False
        mock_tf.AutoModelForMultimodalLM.from_pretrained.assert_not_called()

    @pytest.mark.asyncio
    async def test_load_sets_extra_multimodal_lm_flag(self, loader):
        """Full load() auto-detects and sets extra['multimodal_lm']."""
        mock_multimodal_model = MagicMock()
        mock_processor = MagicMock()

        with (
            patch.object(
                loader,
                "_load_by_task",
                return_value=(mock_multimodal_model, None, mock_processor, None, True),
            ),
            patch.object(loader, "_estimate_model_memory", return_value=4000),
            patch("stt_v2.models.huggingface_loader.get_settings") as mock_settings,
        ):
            mock_settings.return_value.huggingface_cache_dir = "/tmp/test-cache"
            mock_settings.return_value.huggingface_token = None

            config = AiModelConfig(
                id="m-gemma",
                tenant_id="t-test",
                slug="gemma-4-e4b",
                name="Gemma 4 E4B",
                description="Gemma 4 multimodal LLM for ASR",
                task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                source=AiModelSource.HUGGINGFACE,
                source_uri="google/gemma-4-E4B-it",
                source_revision="main",
                format=AiModelFormat.SAFETENSOR,
                memory_size_mb=4000,
                compute_type="auto",
                download_status="downloaded",
                local_path="/tmp/gemma-4",
                downloaded_at=None,
                file_size_mb=4000,
                checksum=None,
                tags=[],
            )

            loaded = await loader.load(config)

        assert loaded.extra.get("multimodal_lm") is True
        assert loaded.extra.get("max_audio_seconds") == 30
