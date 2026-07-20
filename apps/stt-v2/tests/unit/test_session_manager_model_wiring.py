"""Unit tests for SessionManager model wiring (TASK-020 Track B).

Covers the new helper methods added to SessionManager for loading
VAD and ASR models into streaming sessions:

- ``_load_pipeline_config()`` — loads PipelineSpec from PipelineConfigReader
- ``_load_vad_service()`` — loads Silero VAD via singleton
- ``_load_asr_pipeline()`` — loads ASR model and creates callable pipeline
- ``_make_asr_callable()`` — creates async inference closure
- ``create_session()`` integration with model loading
- ``_recover_sessions()`` integration with model loading

Also covers the ``_check_streaming()`` health helper added to
``health/api/routes.py``.
"""

import asyncio
from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt_v2.pipeline.dto import AiModelFormat

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_profile(max_streams: int = 10):
    """Create a minimal ExecutionProfile mock."""
    from stt_v2.streaming.execution_profile import ExecutionProfile, PlatformType

    return ExecutionProfile(
        platform=PlatformType.CPU,
        device_name="cpu-test",
        gpu_count=0,
        total_vram_gb=0,
        total_ram_gb=16,
        cpu_cores=4,
        asr_device="cpu",
        asr_compute_type="float32",
        asr_max_batch_size=2,
        asr_model_quantization="fp16",
        embedding_device="cpu",
        embedding_batch_size=2,
        preprocess_pool_size=2,
        denoise_enabled_default=False,
        max_concurrent_streams=max_streams,
        batch_scheduler_max_wait_ms=500,
        vad_silence_threshold_ms=700,
        multi_gpu_strategy="none",
    )


def _make_manager(max_streams: int = 10):
    """Create a SessionManager with mocked Redis."""
    from stt_v2.streaming.session_manager import SessionManager

    redis_mock = AsyncMock()
    redis_mock.hset = AsyncMock()
    redis_mock.expire = AsyncMock()
    redis_mock.delete = AsyncMock()
    redis_mock.scan = AsyncMock(return_value=(0, []))
    profile = _make_profile(max_streams)
    mgr = SessionManager(redis=redis_mock, profile=profile, worker_id="test-worker")
    return mgr


def _make_pipeline_config(vad_enabled: bool = True, asr_slug: str = "whisper-test"):
    """Create a mock PipelineSpec with VAD and ASR config."""
    vad_cfg = MagicMock()
    vad_cfg.enabled = vad_enabled
    vad_cfg.threshold = 0.5
    vad_cfg.min_speech_duration_ms = 250
    vad_cfg.min_silence_duration_ms = 700
    vad_cfg.model_slug = "silero-vad"

    preprocessing = MagicMock()
    preprocessing.vad = vad_cfg
    preprocessing.denoise.enabled = False
    preprocessing.target_sample_rate = None
    preprocessing.normalize = False

    asr_ref = MagicMock()
    asr_ref.slug = asr_slug

    models = MagicMock()
    models.asr = asr_ref

    inference = MagicMock()
    inference.language = "en"
    inference.code_switching = False
    inference.initial_prompt = None

    config = MagicMock()
    config.preprocessing = preprocessing
    config.models = models
    config.inference = inference
    return config


# ---------------------------------------------------------------------------
# _load_pipeline_config Tests
# ---------------------------------------------------------------------------


class TestLoadPipelineConfig:
    """Tests for SessionManager._load_pipeline_config()."""

    @pytest.mark.asyncio
    async def test_returns_spec_when_pipeline_found(self):
        mgr = _make_manager()
        mock_spec = _make_pipeline_config()
        mock_pipeline = MagicMock()
        mock_pipeline.spec = mock_spec

        mock_reader = AsyncMock()
        mock_reader.get_pipeline = AsyncMock(return_value=mock_pipeline)

        with patch(
            "stt_v2.streaming.session_manager.get_pipeline_reader",
            return_value=mock_reader,
            create=True,
        ):
            # Patch the import inside the method
            with patch.dict(
                "sys.modules",
                {
                    "stt_v2.pipeline.config_reader": MagicMock(
                        get_pipeline_reader=lambda: mock_reader
                    )
                },
            ):
                result = await mgr._load_pipeline_config("pipe-1")

        assert result is mock_spec
        # TASK-298 D-3 — _load_pipeline_config forwards tenant_id (None here) to
        # the reader so STT-V2 can refuse cross-tenant pipeline loads.
        mock_reader.get_pipeline.assert_awaited_once_with("pipe-1", tenant_id=None)

    @pytest.mark.asyncio
    async def test_raises_when_pipeline_not_found(self):
        mgr = _make_manager()
        mock_reader = AsyncMock()
        mock_reader.get_pipeline = AsyncMock(return_value=None)

        with patch.dict(
            "sys.modules",
            {"stt_v2.pipeline.config_reader": MagicMock(get_pipeline_reader=lambda: mock_reader)},
        ):
            with pytest.raises(RuntimeError, match="not found"):
                await mgr._load_pipeline_config("nonexistent")

    @pytest.mark.asyncio
    async def test_raises_on_exception(self):
        mgr = _make_manager()
        mock_reader = AsyncMock()
        mock_reader.get_pipeline = AsyncMock(side_effect=RuntimeError("DB down"))

        with patch.dict(
            "sys.modules",
            {"stt_v2.pipeline.config_reader": MagicMock(get_pipeline_reader=lambda: mock_reader)},
        ):
            with pytest.raises(RuntimeError, match="DB down"):
                await mgr._load_pipeline_config("pipe-err")


# ---------------------------------------------------------------------------
# _load_vad_service Tests
# ---------------------------------------------------------------------------


class TestLoadVadService:
    """Tests for SessionManager._load_vad_service()."""

    @pytest.mark.asyncio
    async def test_returns_none_when_config_is_none(self):
        mgr = _make_manager()
        result = await mgr._load_vad_service(None, "s-1")
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_when_vad_disabled(self):
        mgr = _make_manager()
        config = _make_pipeline_config(vad_enabled=False)
        result = await mgr._load_vad_service(config, "s-1")
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_vad_service_when_enabled_and_loaded(self):
        mgr = _make_manager()
        config = _make_pipeline_config(vad_enabled=True)

        mock_vad = MagicMock()
        mock_vad.is_loaded = True
        mock_vad.initialize = AsyncMock()

        with patch.dict(
            "sys.modules",
            {"stt_v2.vad.silero_service": MagicMock(get_vad_service=lambda: mock_vad)},
        ):
            result = await mgr._load_vad_service(config, "s-1")

        assert result is mock_vad
        mock_vad.initialize.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_initializes_vad_when_not_loaded(self):
        mgr = _make_manager()
        config = _make_pipeline_config(vad_enabled=True)

        mock_vad = MagicMock()
        mock_vad.is_loaded = False
        mock_vad.initialize = AsyncMock()

        with patch.dict(
            "sys.modules",
            {"stt_v2.vad.silero_service": MagicMock(get_vad_service=lambda: mock_vad)},
        ):
            result = await mgr._load_vad_service(config, "s-1")

        assert result is mock_vad
        mock_vad.initialize.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_returns_none_on_exception(self):
        mgr = _make_manager()
        config = _make_pipeline_config(vad_enabled=True)

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.vad.silero_service": MagicMock(
                    get_vad_service=MagicMock(side_effect=ImportError("no silero"))
                )
            },
        ):
            result = await mgr._load_vad_service(config, "s-1")

        assert result is None


# ---------------------------------------------------------------------------
# _load_asr_pipeline Tests
# ---------------------------------------------------------------------------


class TestLoadAsrPipeline:
    """Tests for SessionManager._load_asr_pipeline()."""

    @pytest.mark.asyncio
    async def test_raises_when_config_is_none(self):
        mgr = _make_manager()
        with pytest.raises(RuntimeError, match="pipeline config is None"):
            await mgr._load_asr_pipeline(None, "s-1")

    @pytest.mark.asyncio
    async def test_returns_callable_on_success(self):
        mgr = _make_manager()
        config = _make_pipeline_config()

        mock_model = MagicMock()
        mock_model.model_slug = "whisper-test"
        mock_model.format = MagicMock(value="onnx")

        mock_cache = AsyncMock()
        mock_cache.get_or_load_from_ref = AsyncMock(return_value=mock_model)

        mgr._make_asr_callable = (
            lambda asr_model, inference_config, initial_prompt=None: AsyncMock(return_value="ok")
        )

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.models": MagicMock(get_model_cache=lambda: mock_cache),
                "stt_v2.pipeline.dto": MagicMock(
                    ModelTaskType=MagicMock(AUTOMATIC_SPEECH_RECOGNITION="asr")
                ),
            },
        ):
            result = await mgr._load_asr_pipeline(config, "s-1")

        assert callable(result[0])
        assert result[1] is None

    @pytest.mark.asyncio
    async def test_uses_pipeline_inference_config_directly(self):
        """Verify pipeline inference config is used as-is without overrides."""
        mgr = _make_manager()
        config = _make_pipeline_config()

        mock_model = MagicMock()
        mock_model.model_slug = "whisper-test"
        mock_model.format = MagicMock(value="onnx")

        mock_cache = AsyncMock()
        mock_cache.get_or_load_from_ref = AsyncMock(return_value=mock_model)

        # Capture the inference_config that _make_asr_callable receives
        captured = {}

        def spy_make_asr(asr_model, inference_config, initial_prompt=None):
            captured["model"] = asr_model
            captured["config"] = inference_config
            return AsyncMock(return_value="text")

        mgr._make_asr_callable = spy_make_asr

        @dataclass
        class FakeInferenceConfig:
            language: str = "en"
            code_switching: bool = False

        config.inference = FakeInferenceConfig(language="ml", code_switching=True)

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.models": MagicMock(get_model_cache=lambda: mock_cache),
                "stt_v2.pipeline.dto": MagicMock(
                    ModelTaskType=MagicMock(AUTOMATIC_SPEECH_RECOGNITION="asr")
                ),
            },
        ):
            result = await mgr._load_asr_pipeline(config, "s-1")

        assert result[0] is not None
        # Pipeline config values should be used directly
        assert captured["config"].language == "ml"
        assert captured["config"].code_switching is True

    @pytest.mark.asyncio
    async def test_raises_on_model_load_failure(self):
        mgr = _make_manager()
        config = _make_pipeline_config()

        mock_cache = AsyncMock()
        mock_cache.get_or_load_from_ref = AsyncMock(side_effect=RuntimeError("OOM"))

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.models": MagicMock(get_model_cache=lambda: mock_cache),
                "stt_v2.pipeline.dto": MagicMock(
                    ModelTaskType=MagicMock(AUTOMATIC_SPEECH_RECOGNITION="asr")
                ),
            },
        ):
            with pytest.raises(RuntimeError, match="OOM"):
                await mgr._load_asr_pipeline(config, "s-1")


# ---------------------------------------------------------------------------
# _make_asr_callable Tests
# ---------------------------------------------------------------------------


torch = pytest.importorskip("torch")


class TestMakeAsrCallable:
    """Tests for SessionManager._make_asr_callable()."""

    @staticmethod
    def _mock_asr_model(text="transcribed text", word_offsets=None):
        """Build a mock LoadedModel with model.generate() + processor."""

        fake_output = torch.tensor([[1, 2, 3]])

        mock_model = MagicMock()
        mock_model.dtype = torch.float32
        mock_model.generate.return_value = fake_output

        mock_processor = MagicMock()
        mock_processor.batch_decode.return_value = [f"  {text}  "]
        mock_processor.decode.return_value = {"offsets": word_offsets or []}

        loaded = MagicMock()
        loaded.model = mock_model
        loaded.processor = mock_processor
        loaded.feature_extractor = None
        loaded.device = torch.device("cpu")
        loaded.format = AiModelFormat.SAFETENSOR
        return loaded

    @staticmethod
    def _mock_inference_config(**overrides):
        defaults = {
            "beam_size": 1,
            "code_switching": False,
            "language": "en",
            "temperature": None,
            # Explicitly False so getattr doesn't return a truthy MagicMock
            # and accidentally flip condition_on_prev_tokens on.
            "condition_on_prev_tokens": False,
        }
        defaults.update(overrides)
        return MagicMock(**defaults)

    @pytest.mark.asyncio
    async def test_returns_async_callable(self):
        mgr = _make_manager()
        loaded = self._mock_asr_model(text="transcribed text")
        fn = mgr._make_asr_callable(loaded, self._mock_inference_config())

        assert callable(fn)
        samples = np.zeros(16000, dtype=np.float32)
        result = await fn(samples, 16000)
        assert result["text"] == "transcribed text"

    @pytest.mark.asyncio
    async def test_extracts_word_timestamps(self):
        mgr = _make_manager()
        offsets = [
            {"text": "hello", "timestamp": (0.0, 0.5)},
            {"text": "world", "timestamp": (0.5, 1.0)},
        ]
        loaded = self._mock_asr_model(text="hello world", word_offsets=offsets)
        fn = mgr._make_asr_callable(loaded, self._mock_inference_config())

        result = await fn(np.zeros(16000, dtype=np.float32), 16000)
        assert len(result["word_timestamps"]) == 2
        assert result["word_timestamps"][0]["word"] == "hello"

    @pytest.mark.asyncio
    async def test_returns_empty_text_when_model_returns_empty(self):
        mgr = _make_manager()
        loaded = self._mock_asr_model(text="")
        fn = mgr._make_asr_callable(loaded, self._mock_inference_config())

        result = await fn(np.zeros(100, dtype=np.float32), 16000)
        assert result["text"] == ""

    @pytest.mark.asyncio
    async def test_passes_samples_to_processor(self):
        mgr = _make_manager()
        loaded = self._mock_asr_model(text="ok")
        fn = mgr._make_asr_callable(loaded, self._mock_inference_config())

        samples = np.ones(8000, dtype=np.float32)
        await fn(samples, 8000)

        loaded.processor.assert_called_once()
        call_args = loaded.processor.call_args
        np.testing.assert_array_equal(call_args[0][0], samples)
        assert call_args[1]["sampling_rate"] == 8000

    @pytest.mark.asyncio
    async def test_passes_language_to_processor_that_requires_it(self):
        mgr = _make_manager()

        mock_model = MagicMock()
        mock_model.dtype = torch.float32
        mock_model.generate.return_value = torch.tensor([[1, 2, 3]])

        class _LanguageRequiredProcessor:
            def __init__(self) -> None:
                self.called_language: str | None = None
                self.batch_decode = MagicMock(return_value=["transcribed text"])
                self.decode = MagicMock(return_value={"offsets": []})

            def __call__(
                self,
                audio: np.ndarray,
                language: str,
                sampling_rate: int | None = None,
                return_tensors: str | None = None,
                return_attention_mask: bool | None = None,
            ) -> dict[str, Any]:
                self.called_language = language

                input_features = MagicMock()
                input_features.is_floating_point.return_value = True
                input_features.to.return_value = input_features

                attention_mask = MagicMock()
                attention_mask.is_floating_point.return_value = False
                attention_mask.to.return_value = attention_mask

                return {
                    "input_features": input_features,
                    "attention_mask": attention_mask,
                }

        processor = _LanguageRequiredProcessor()

        loaded = MagicMock()
        loaded.model = mock_model
        loaded.processor = processor
        loaded.feature_extractor = None
        loaded.device = torch.device("cpu")
        loaded.format = AiModelFormat.SAFETENSOR

        fn = mgr._make_asr_callable(
            loaded,
            self._mock_inference_config(language="fr", code_switching=False),
        )

        await fn(np.zeros(16000, dtype=np.float32), 16000)
        assert processor.called_language == "fr"

    @pytest.mark.asyncio
    async def test_raises_when_required_processor_language_missing(self):
        mgr = _make_manager()

        mock_model = MagicMock()
        mock_model.dtype = torch.float32
        mock_model.generate.return_value = torch.tensor([[1, 2, 3]])

        class _LanguageRequiredProcessor:
            def __init__(self) -> None:
                self.batch_decode = MagicMock(return_value=["transcribed text"])
                self.decode = MagicMock(return_value={"offsets": []})

            def __call__(
                self,
                audio: np.ndarray,
                language: str,
                sampling_rate: int | None = None,
                return_tensors: str | None = None,
                return_attention_mask: bool | None = None,
            ) -> dict[str, Any]:
                del audio, language, sampling_rate, return_tensors, return_attention_mask
                return {"input_features": MagicMock()}

        loaded = MagicMock()
        loaded.model = mock_model
        loaded.processor = _LanguageRequiredProcessor()
        loaded.feature_extractor = None
        loaded.device = torch.device("cpu")
        loaded.format = AiModelFormat.SAFETENSOR

        fn = mgr._make_asr_callable(
            loaded,
            self._mock_inference_config(language=None, code_switching=False),
        )

        with pytest.raises(RuntimeError, match="requires inference language"):
            await fn(np.zeros(16000, dtype=np.float32), 16000)

    @pytest.mark.asyncio
    async def test_forwards_condition_on_prev_tokens_when_enabled(self):
        """condition_on_prev_tokens=True on inference config must reach model.generate."""
        mgr = _make_manager()
        loaded = self._mock_asr_model(text="ok")
        config = self._mock_inference_config(condition_on_prev_tokens=True)

        fn = mgr._make_asr_callable(loaded, config)
        await fn(np.zeros(16000, dtype=np.float32), 16000)

        call_kwargs = loaded.model.generate.call_args[1]
        assert call_kwargs.get("condition_on_prev_tokens") is True

    @pytest.mark.asyncio
    async def test_omits_condition_on_prev_tokens_when_disabled(self):
        """Explicit condition_on_prev_tokens=False must not appear in generate kwargs."""
        mgr = _make_manager()
        loaded = self._mock_asr_model(text="ok")
        config = self._mock_inference_config(condition_on_prev_tokens=False)

        fn = mgr._make_asr_callable(loaded, config)
        await fn(np.zeros(16000, dtype=np.float32), 16000)

        call_kwargs = loaded.model.generate.call_args[1]
        assert "condition_on_prev_tokens" not in call_kwargs

    @pytest.mark.asyncio
    async def test_ignores_non_tensor_processor_output(self):
        """Processor outputs can include metadata fields that are not tensors.

        The streaming callable should move/cast only tensor values and must not
        forward non-tensor metadata fields to ``model.generate``.
        """
        mgr = _make_manager()

        mock_model = MagicMock()
        mock_model.dtype = torch.float32
        mock_model.generate.return_value = torch.tensor([[1, 2, 3]])

        input_features = torch.zeros((1, 80, 3000), dtype=torch.float32)
        attention_mask = torch.ones((1, 3000), dtype=torch.long)
        audio_chunk_index = [[0]]

        class _ProcessorWithMetadata:
            def __init__(self) -> None:
                self.called_kwargs: dict[str, Any] = {}
                self.batch_decode = MagicMock(return_value=["hello world"])
                self.decode = MagicMock(return_value={"offsets": []})

            def __call__(
                self,
                audio: np.ndarray,
                sampling_rate: int | None = None,
                return_tensors: str | None = None,
                return_attention_mask: bool | None = None,
                language: str | None = None,
            ) -> dict[str, Any]:
                del audio, sampling_rate, return_tensors, return_attention_mask, language
                return {
                    "input_features": input_features,
                    "attention_mask": attention_mask,
                    "audio_chunk_index": audio_chunk_index,
                }

        processor = _ProcessorWithMetadata()

        loaded = MagicMock()
        loaded.model = mock_model
        loaded.processor = processor
        loaded.feature_extractor = None
        loaded.device = torch.device("cpu")
        loaded.format = AiModelFormat.SAFETENSOR

        fn = mgr._make_asr_callable(loaded, self._mock_inference_config())
        result = await fn(np.zeros(16000, dtype=np.float32), 16000)

        assert result["text"] == "hello world"

        call_kwargs = mock_model.generate.call_args.kwargs
        assert "audio_chunk_index" not in call_kwargs
        assert torch.equal(call_kwargs["input_features"], input_features)
        assert torch.equal(call_kwargs["attention_mask"], attention_mask)


# ---------------------------------------------------------------------------
# create_session Integration with Model Loading
# ---------------------------------------------------------------------------


class TestCreateSessionModelWiring:
    """Tests that create_session() correctly wires VAD and ASR."""

    @pytest.mark.asyncio
    async def test_create_session_loads_vad_and_asr(self):
        mgr = _make_manager()

        mock_vad = MagicMock()
        mock_asr_fn = AsyncMock(return_value="hello")

        mgr._load_pipeline_config = AsyncMock(return_value=_make_pipeline_config())
        mgr._load_vad_service = AsyncMock(return_value=mock_vad)
        mgr._load_asr_pipeline = AsyncMock(return_value=(mock_asr_fn, None))

        # Mock the consumers/listeners to avoid real Redis operations
        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as MockListener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()

            session = await mgr.create_session(
                session_id="s-1",
                tenant_id="t-1",
                pipeline_id="pipe-1",
            )

        assert session is not None
        # TASK-298 D-3 — create_session forwards tenant_id to the config loader.
        mgr._load_pipeline_config.assert_awaited_once_with("pipe-1", tenant_id="t-1")
        mgr._load_vad_service.assert_awaited_once()
        mgr._load_asr_pipeline.assert_awaited_once()

        # Verify preprocessor got the VAD service
        preprocessor = mgr._preprocessors["s-1"]
        assert preprocessor._vad_service is mock_vad

        # Verify inference worker got the ASR pipeline
        worker = mgr._inference_workers["s-1"]
        assert worker._asr_pipeline is mock_asr_fn

    @pytest.mark.asyncio
    async def test_create_session_passes_vad_config_params(self):
        mgr = _make_manager()

        config = _make_pipeline_config(vad_enabled=True)
        config.preprocessing.vad.threshold = 0.6
        config.preprocessing.vad.min_speech_duration_ms = 300
        config.preprocessing.vad.min_silence_duration_ms = 800

        mgr._load_pipeline_config = AsyncMock(return_value=config)
        mgr._load_vad_service = AsyncMock(return_value=MagicMock())
        mgr._load_asr_pipeline = AsyncMock(return_value=(None, None))

        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as MockListener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()

            await mgr.create_session(
                session_id="s-2",
                tenant_id="t-1",
                pipeline_id="pipe-1",
            )

        preprocessor = mgr._preprocessors["s-2"]
        assert preprocessor._threshold == 0.6
        assert preprocessor._min_speech_duration_ms == 300
        assert preprocessor._min_silence_duration_ms == 800

    @pytest.mark.asyncio
    async def test_create_session_raises_when_pipeline_not_found(self):
        mgr = _make_manager()

        mgr._load_pipeline_config = AsyncMock(
            side_effect=RuntimeError("Pipeline 'nonexistent' not found")
        )

        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as MockListener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()

            with pytest.raises(RuntimeError, match="not found"):
                await mgr.create_session(
                    session_id="s-3",
                    tenant_id="t-1",
                    pipeline_id="nonexistent",
                )

    @pytest.mark.asyncio
    async def test_create_session_calls_asr_loader_with_pipeline_config(self):
        """Verify _load_asr_pipeline receives pipeline_config and session_id only."""
        mgr = _make_manager()

        # Use a spy to capture args while still returning a value
        captured_args = {}
        original_load = AsyncMock(return_value=(None, None))

        async def spy_load_asr(pipeline_config, session_id, tenant_id=None):
            captured_args["pipeline_config"] = pipeline_config
            captured_args["session_id"] = session_id
            return await original_load(pipeline_config, session_id)

        mgr._load_pipeline_config = AsyncMock(return_value=_make_pipeline_config())
        mgr._load_vad_service = AsyncMock(return_value=None)
        mgr._load_asr_pipeline = spy_load_asr

        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as MockListener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()

            await mgr.create_session(
                session_id="s-4",
                tenant_id="t-1",
                pipeline_id="pipe-1",
            )

        # Verify the ASR loader received pipeline config and session_id
        assert captured_args["pipeline_config"] is not None
        assert captured_args["session_id"] == "s-4"

    @pytest.mark.asyncio
    async def test_create_session_stores_session_and_components(self):
        """Verify create_session populates all internal dictionaries."""
        mgr = _make_manager()

        mock_vad = MagicMock()
        mock_asr_fn = AsyncMock(return_value="hello")

        mgr._load_pipeline_config = AsyncMock(return_value=_make_pipeline_config())
        mgr._load_vad_service = AsyncMock(return_value=mock_vad)
        mgr._load_asr_pipeline = AsyncMock(return_value=(mock_asr_fn, None))

        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as MockListener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()

            _session = await mgr.create_session(
                session_id="s-5",
                tenant_id="t-1",
                pipeline_id="pipe-1",
            )

        # Verify all internal maps are populated
        assert "s-5" in mgr._sessions
        assert "s-5" in mgr._consumers
        assert "s-5" in mgr._control_listeners
        assert "s-5" in mgr._publishers
        assert "s-5" in mgr._preprocessors
        assert "s-5" in mgr._inference_workers
        assert mgr.active_session_count == 1


# ---------------------------------------------------------------------------
# _recover_sessions Integration with Model Loading
# ---------------------------------------------------------------------------


class TestRecoverSessionsModelWiring:
    """Tests that _recover_sessions() loads VAD and ASR for recovered sessions."""

    @pytest.mark.asyncio
    async def test_recover_loads_vad_and_asr(self):
        from stt_v2.streaming.schemas import SessionMetadata, SessionStatus

        mgr = _make_manager()

        # Simulate Redis SCAN returning one active session
        meta = SessionMetadata(
            session_id="recovered-1",
            tenant_id="t-1",
            pipeline_id="pipe-1",
            status=SessionStatus.ACTIVE,
            worker_id="test-worker",
            sample_rate=16000,
        )
        redis_data = meta.to_redis_dict()

        mgr._redis.scan = AsyncMock(return_value=(0, [b"stt:session:recovered-1"]))
        mgr._redis.hgetall = AsyncMock(return_value=redis_data)
        mgr._redis.exists = AsyncMock(return_value=False)

        mock_vad = MagicMock()
        mock_asr_fn = AsyncMock()

        mgr._load_pipeline_config = AsyncMock(return_value=_make_pipeline_config())
        mgr._load_vad_service = AsyncMock(return_value=mock_vad)
        mgr._load_asr_pipeline = AsyncMock(return_value=(mock_asr_fn, None))

        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as MockListener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()

            await mgr._recover_sessions()

        assert "recovered-1" in mgr._sessions
        assert mgr._preprocessors["recovered-1"]._vad_service is mock_vad
        assert mgr._inference_workers["recovered-1"]._asr_pipeline is mock_asr_fn

    @pytest.mark.asyncio
    async def test_recover_skips_non_active_sessions(self):
        from stt_v2.streaming.schemas import SessionMetadata, SessionStatus

        mgr = _make_manager()

        meta = SessionMetadata(
            session_id="closed-1",
            tenant_id="t-1",
            pipeline_id="pipe-1",
            status=SessionStatus.CLOSED,
        )

        mgr._redis.scan = AsyncMock(return_value=(0, [b"stt:session:closed-1"]))
        mgr._redis.hgetall = AsyncMock(return_value=meta.to_redis_dict())

        await mgr._recover_sessions()

        assert "closed-1" not in mgr._sessions

    @pytest.mark.asyncio
    async def test_recover_wires_denoiser_and_preprocess_settings(self):
        from stt_v2.streaming.schemas import SessionMetadata, SessionStatus

        mgr = _make_manager()

        meta = SessionMetadata(
            session_id="recovered-2",
            tenant_id="t-1",
            pipeline_id="pipe-1",
            status=SessionStatus.ACTIVE,
            worker_id="test-worker",
            sample_rate=16000,
        )

        mgr._redis.scan = AsyncMock(return_value=(0, [b"stt:session:recovered-2"]))
        mgr._redis.hgetall = AsyncMock(return_value=meta.to_redis_dict())
        mgr._redis.exists = AsyncMock(return_value=False)

        pipeline_cfg = _make_pipeline_config()
        pipeline_cfg.preprocessing.normalize = True
        pipeline_cfg.preprocessing.target_sample_rate = 16000
        pipeline_cfg.preprocessing.denoise.enabled = True
        pipeline_cfg.preprocessing.denoise.strength = 0.7

        mgr._load_pipeline_config = AsyncMock(return_value=pipeline_cfg)
        mgr._load_vad_service = AsyncMock(return_value=MagicMock())
        mgr._load_asr_pipeline = AsyncMock(return_value=(AsyncMock(), None))

        with (
            patch("stt_v2.streaming.session_manager.StreamingDenoiser") as MockDenoiser,
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as MockListener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            mock_denoiser = MockDenoiser.return_value
            mock_denoiser.initialize.return_value = True
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()

            await mgr._recover_sessions()

        MockDenoiser.assert_called_once_with(input_sr=16000, strength=0.7)
        preprocessor = mgr._preprocessors["recovered-2"]
        assert preprocessor.has_denoiser is True
        assert preprocessor._normalize is True
        assert preprocessor.target_sample_rate == 16000


# ---------------------------------------------------------------------------
# Health Endpoint: _check_streaming Tests
# ---------------------------------------------------------------------------


class TestCheckStreamingHealth:
    """Tests for _check_streaming() in health/api/routes.py."""

    def test_returns_degraded_when_manager_is_none(self):
        from stt_v2.health.api.routes import _check_streaming

        with patch(
            "stt_v2.health.api.routes.get_session_manager",
            return_value=None,
            create=True,
        ):
            with patch.dict(
                "sys.modules",
                {
                    "stt_v2.streaming._runtime": MagicMock(get_session_manager=lambda: None),
                },
            ):
                result = _check_streaming()

        assert result["status"] == "degraded"
        assert result["duration_ms"] == 0

    def test_returns_healthy_when_manager_available(self):
        from stt_v2.health.api.routes import _check_streaming

        mock_mgr = MagicMock()

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.streaming._runtime": MagicMock(get_session_manager=lambda: mock_mgr),
            },
        ):
            result = _check_streaming()

        assert result["status"] == "healthy"
        assert result["duration_ms"] == 0

    def test_returns_degraded_on_exception(self):
        from stt_v2.health.api.routes import _check_streaming

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.streaming._runtime": MagicMock(
                    get_session_manager=MagicMock(side_effect=RuntimeError("boom"))
                ),
            },
        ):
            result = _check_streaming()

        assert result["status"] == "degraded"
        assert "boom" in (result.get("message") or "")


# ---------------------------------------------------------------------------
# Frame Handler Integration (VAD + ASR wired)
# ---------------------------------------------------------------------------


class TestFrameHandlerWithModels:
    """Tests that _make_frame_handler correctly uses preprocessor and inference."""

    @pytest.mark.asyncio
    async def test_frame_handler_feeds_preprocessor_and_runs_inference(self):
        from stt_v2.streaming.preprocessor import AudioUtterance
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-1"
        session.status = SessionStatus.ACTIVE
        session.pending_segments = asyncio.Queue()
        session.persist_if_needed = AsyncMock(return_value=False)
        session.record_frame = MagicMock()

        mock_utterance = AudioUtterance(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            start_time=0.0,
            end_time=1.0,
            utterance_index=0,
            is_final=True,
        )

        preprocessor = AsyncMock()
        preprocessor.feed = AsyncMock(return_value=[mock_utterance])
        preprocessor.utterance_count = 1
        inference_queue: asyncio.Queue = asyncio.Queue(maxsize=4)
        mgr._inference_queues["s-1"] = inference_queue

        handler = mgr._make_frame_handler(session, preprocessor)

        # Create a fake frame
        from stt_v2.streaming.schemas import AudioEncoding, AudioFrame

        frame = AudioFrame(
            seq=1,
            sr=16000,
            enc=AudioEncoding.PCM_S16LE,
            ch=1,
            data=b"\x00" * 960,
            final=False,
            ts=1000.0,
        )

        await handler(frame)

        preprocessor.feed.assert_awaited_once_with(frame.data)
        queued = inference_queue.get_nowait()
        assert queued is mock_utterance

    @pytest.mark.asyncio
    async def test_frame_handler_works_without_preprocessor(self):
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-1"
        session.status = SessionStatus.ACTIVE
        session.pending_segments = asyncio.Queue()
        session.persist_if_needed = AsyncMock()
        session.record_frame = MagicMock()

        handler = mgr._make_frame_handler(session, None)

        from stt_v2.streaming.schemas import AudioEncoding, AudioFrame

        audio_data = b"\x00" * 960
        frame = AudioFrame(
            seq=1,
            sr=16000,
            enc=AudioEncoding.PCM_S16LE,
            ch=1,
            data=audio_data,
            final=False,
            ts=1000.0,
        )

        await handler(frame)

        # Verify record_frame is called with the correct args from the frame
        session.record_frame.assert_called_once_with(seq=1, data=audio_data, sample_rate=16000)


# ---------------------------------------------------------------------------
# Control Handler Integration (flush + ASR)
# ---------------------------------------------------------------------------


class TestControlHandlerWithModels:
    """Tests that _make_control_handler flushes preprocessor on FINALIZE."""

    @pytest.mark.asyncio
    async def test_finalize_flushes_preprocessor_and_runs_inference(self):
        from stt_v2.streaming.preprocessor import AudioUtterance
        from stt_v2.streaming.schemas import ControlAction, SessionControl

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-1"
        session.status = MagicMock(value="active")

        mock_utterance = AudioUtterance(
            samples=np.zeros(8000, dtype=np.float32),
            sample_rate=16000,
            start_time=5.0,
            end_time=5.5,
            utterance_index=3,
            is_final=True,
        )

        preprocessor = AsyncMock()
        preprocessor.flush = AsyncMock(return_value=mock_utterance)
        preprocessor.utterance_count = 4
        inference_queue: asyncio.Queue = asyncio.Queue(maxsize=4)
        mgr._inference_queues["s-1"] = inference_queue
        mgr._drain_inference_queue = AsyncMock()

        # Patch _finalize_session to avoid full finalization
        mgr._finalize_session = AsyncMock()

        handler = mgr._make_control_handler(session, preprocessor)

        control = SessionControl(action=ControlAction.FINALIZE)
        await handler(control)

        preprocessor.flush.assert_awaited_once()
        queued = inference_queue.get_nowait()
        assert queued is mock_utterance
        mgr._drain_inference_queue.assert_awaited_once_with("s-1")
        mgr._finalize_session.assert_awaited_once_with(session)

    @pytest.mark.asyncio
    async def test_finalize_handles_no_remaining_audio(self):
        from stt_v2.streaming.schemas import ControlAction, SessionControl

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-1"
        session.status = MagicMock(value="active")

        preprocessor = AsyncMock()
        preprocessor.flush = AsyncMock(return_value=None)
        inference_queue: asyncio.Queue = asyncio.Queue(maxsize=4)
        mgr._inference_queues["s-1"] = inference_queue
        mgr._drain_inference_queue = AsyncMock()
        mgr._finalize_session = AsyncMock()

        handler = mgr._make_control_handler(session, preprocessor)

        control = SessionControl(action=ControlAction.FINALIZE)
        await handler(control)

        preprocessor.flush.assert_awaited_once()
        assert inference_queue.empty()
        mgr._drain_inference_queue.assert_awaited_once_with("s-1")
        mgr._finalize_session.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_cancel_handler(self):
        from stt_v2.streaming.schemas import ControlAction, SessionControl

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-1"
        mgr._cancel_session = AsyncMock()

        handler = mgr._make_control_handler(session, None)
        control = SessionControl(action=ControlAction.CANCEL)
        await handler(control)

        mgr._cancel_session.assert_awaited_once_with(session)

    @pytest.mark.asyncio
    async def test_pause_handler_logs_without_error(self):
        from stt_v2.streaming.schemas import ControlAction, SessionControl

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-1"

        handler = mgr._make_control_handler(session, None)
        control = SessionControl(action=ControlAction.PAUSE)
        # Should not raise
        await handler(control)

    @pytest.mark.asyncio
    async def test_resume_handler_logs_without_error(self):
        from stt_v2.streaming.schemas import ControlAction, SessionControl

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-1"

        handler = mgr._make_control_handler(session, None)
        control = SessionControl(action=ControlAction.RESUME)
        await handler(control)


# ---------------------------------------------------------------------------
# _finalize_session Tests
# ---------------------------------------------------------------------------


class TestFinalizeSession:
    """Tests for SessionManager._finalize_session()."""

    @pytest.mark.asyncio
    async def test_finalize_publishes_status_and_closes(self):
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-1"
        session.status = SessionStatus.ACTIVE
        session.pending_segments = asyncio.Queue()
        session.finalize = AsyncMock()
        session.close = AsyncMock()

        publisher = AsyncMock()
        mgr._publishers["s-1"] = publisher
        mgr._sessions["s-1"] = session
        mgr.remove_session = AsyncMock()

        await mgr._finalize_session(session)

        session.finalize.assert_awaited_once()
        publisher.publish_status.assert_any_await("finalizing")
        publisher.publish_status.assert_any_await("closed")
        session.close.assert_awaited_once()
        mgr.remove_session.assert_awaited_once_with("s-1")

    @pytest.mark.asyncio
    async def test_finalize_skips_non_active_session(self):
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-1"
        session.status = SessionStatus.CLOSED
        session.finalize = AsyncMock()

        await mgr._finalize_session(session)

        session.finalize.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_finalize_without_publisher(self):
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-no-pub"
        session.status = SessionStatus.ACTIVE
        session.pending_segments = asyncio.Queue()
        session.finalize = AsyncMock()
        session.close = AsyncMock()

        mgr._sessions["s-no-pub"] = session
        mgr.remove_session = AsyncMock()

        await mgr._finalize_session(session)

        session.finalize.assert_awaited_once()
        session.close.assert_awaited_once()


# ---------------------------------------------------------------------------
# _cancel_session Tests
# ---------------------------------------------------------------------------


class TestCancelSession:
    """Tests for SessionManager._cancel_session()."""

    @pytest.mark.asyncio
    async def test_cancel_sets_closed_and_publishes(self):
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-cancel"
        session.force_persist = AsyncMock()

        publisher = AsyncMock()
        mgr._publishers["s-cancel"] = publisher
        mgr.remove_session = AsyncMock()

        await mgr._cancel_session(session)

        assert session.status == SessionStatus.CLOSED
        session.force_persist.assert_awaited_once()
        publisher.publish_status.assert_awaited_once_with("cancelled")
        mgr.remove_session.assert_awaited_once_with("s-cancel")

    @pytest.mark.asyncio
    async def test_cancel_without_publisher(self):
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-cancel-2"
        session.force_persist = AsyncMock()

        mgr.remove_session = AsyncMock()

        await mgr._cancel_session(session)

        assert session.status == SessionStatus.CLOSED
        mgr.remove_session.assert_awaited_once()


# ---------------------------------------------------------------------------
# start() / stop() Tests
# ---------------------------------------------------------------------------


class TestStartStop:
    """Tests for SessionManager.start() and stop()."""

    @pytest.mark.asyncio
    async def test_start_registers_worker_and_starts_tasks(self):
        mgr = _make_manager()
        mgr._register_worker = AsyncMock()
        mgr._recover_sessions = AsyncMock()

        await mgr.start()

        assert mgr._running is True
        mgr._register_worker.assert_awaited_once()
        mgr._recover_sessions.assert_awaited_once()
        assert mgr._heartbeat_task is not None
        assert mgr._reaper_task is not None

        # Clean up
        await mgr.stop()

    @pytest.mark.asyncio
    async def test_stop_cancels_tasks_and_unregisters(self):
        mgr = _make_manager()
        mgr._register_worker = AsyncMock()
        mgr._recover_sessions = AsyncMock()
        mgr._unregister_worker = AsyncMock()

        await mgr.start()

        # Add a mock session to verify persistence on shutdown
        mock_session = MagicMock()
        mock_session.force_persist = AsyncMock()
        mgr._sessions["s-1"] = mock_session
        mgr._consumers["s-1"] = AsyncMock()
        mgr._control_listeners["s-1"] = AsyncMock()

        await mgr.stop()

        assert mgr._running is False
        mock_session.force_persist.assert_awaited_once()
        mgr._unregister_worker.assert_awaited_once()
        assert len(mgr._sessions) == 0

    @pytest.mark.asyncio
    async def test_stop_handles_persist_error(self):
        mgr = _make_manager()
        mgr._register_worker = AsyncMock()
        mgr._recover_sessions = AsyncMock()
        mgr._unregister_worker = AsyncMock()

        await mgr.start()

        mock_session = MagicMock()
        mock_session.session_id = "s-err"
        mock_session.force_persist = AsyncMock(side_effect=RuntimeError("persist failed"))
        mgr._sessions["s-err"] = mock_session

        # Should not raise
        await mgr.stop()

        assert len(mgr._sessions) == 0


# ---------------------------------------------------------------------------
# Worker Heartbeat Tests
# ---------------------------------------------------------------------------


class TestWorkerHeartbeat:
    """Tests for worker registration and heartbeat."""

    @pytest.mark.asyncio
    async def test_register_worker(self):
        mgr = _make_manager()
        await mgr._register_worker()

        mgr._redis.hset.assert_awaited_once()
        call_args = mgr._redis.hset.call_args
        # Verify the correct Redis key (first positional arg)
        assert call_args.args[0] == "stt:worker:test-worker"
        # Verify the mapping contains required fields (keyword arg)
        mapping = call_args.kwargs["mapping"]
        assert "pid" in mapping
        assert "started_at" in mapping
        assert mapping["max_streams"] == "10"
        # Verify TTL is set on the same key
        mgr._redis.expire.assert_awaited_once()
        expire_args = mgr._redis.expire.call_args
        assert expire_args.args[0] == "stt:worker:test-worker"

    @pytest.mark.asyncio
    async def test_unregister_worker(self):
        mgr = _make_manager()
        await mgr._unregister_worker()

        mgr._redis.delete.assert_awaited_once()


# ---------------------------------------------------------------------------
# Reaper Tests
# ---------------------------------------------------------------------------


class TestReaper:
    """Tests for session reaper."""

    @pytest.mark.asyncio
    async def test_reap_expired_sessions(self):
        from datetime import datetime, timedelta

        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()

        # Create a session that's been idle for 120 seconds
        session = MagicMock()
        session.session_id = "s-old"
        session.status = SessionStatus.ACTIVE
        session.last_activity = (datetime.utcnow() - timedelta(seconds=120)).isoformat()

        mgr._sessions["s-old"] = session
        mgr._finalize_session = AsyncMock()

        count = await mgr.reap_expired_sessions(timeout_s=60)

        assert count == 1
        mgr._finalize_session.assert_awaited_once_with(session)

    @pytest.mark.asyncio
    async def test_reap_skips_active_sessions(self):
        from datetime import datetime

        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()

        session = MagicMock()
        session.session_id = "s-fresh"
        session.status = SessionStatus.ACTIVE
        session.last_activity = datetime.utcnow().isoformat()

        mgr._sessions["s-fresh"] = session
        mgr._finalize_session = AsyncMock()

        count = await mgr.reap_expired_sessions(timeout_s=60)

        assert count == 0
        mgr._finalize_session.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_reap_flushes_final_utterance_before_finalize(self):
        from datetime import datetime, timedelta

        from stt_v2.streaming.preprocessor import AudioUtterance
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()

        session = MagicMock()
        session.session_id = "s-old"
        session.status = SessionStatus.ACTIVE
        session.last_activity = (datetime.utcnow() - timedelta(seconds=120)).isoformat()

        preprocessor = AsyncMock()
        final_utt = AudioUtterance(
            samples=np.zeros(1600, dtype=np.float32),
            sample_rate=16000,
            start_time=1.0,
            end_time=1.1,
            utterance_index=0,
            is_final=True,
        )
        preprocessor.flush = AsyncMock(return_value=final_utt)
        preprocessor.utterance_count = 1

        mgr._sessions["s-old"] = session
        mgr._preprocessors["s-old"] = preprocessor
        mgr._inference_queues["s-old"] = asyncio.Queue(maxsize=4)
        mgr._drain_inference_queue = AsyncMock()
        mgr._finalize_session = AsyncMock()

        count = await mgr.reap_expired_sessions(timeout_s=60)

        assert count == 1
        preprocessor.flush.assert_awaited_once()
        queued = mgr._inference_queues["s-old"].get_nowait()
        assert queued is final_utt
        mgr._drain_inference_queue.assert_awaited_once_with("s-old")
        mgr._finalize_session.assert_awaited_once_with(session)

    @pytest.mark.asyncio
    async def test_reaper_loop_spares_active_session_paused_below_audio_idle(self):
        """C2-02 (TASK-456) task-0 fix — driving the real reaper loop once, a
        live ACTIVE session idle 120s (a normal clinical speech pause, well
        under the 300s audio-idle timeout) must NOT be finalized. Before the
        fix the loop reaps at the 60s session timeout and finalizes it."""
        from datetime import datetime, timedelta

        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()

        session = MagicMock()
        session.session_id = "s-paused"
        session.status = SessionStatus.ACTIVE
        session.last_activity = (datetime.utcnow() - timedelta(seconds=120)).isoformat()
        mgr._sessions["s-paused"] = session
        mgr._finalize_session = AsyncMock()

        # Drive the real reaper loop (real threshold) for a single scan.
        mgr._reaper_interval_s = 0
        real_reap = mgr._reap_expired_sessions

        async def _one_scan(timeout_s: int) -> int:
            result = await real_reap(timeout_s)
            mgr._running = False
            return result

        mgr._reap_expired_sessions = _one_scan  # type: ignore[assignment]
        mgr._running = True
        await mgr._reaper_loop()

        mgr._finalize_session.assert_not_awaited()


# ---------------------------------------------------------------------------
# Frame Handler: Final Frame
# ---------------------------------------------------------------------------


class TestFrameHandlerFinalFrame:
    """Tests that final frame triggers finalization."""

    @pytest.mark.asyncio
    async def test_final_frame_triggers_finalize(self):
        from stt_v2.streaming.schemas import AudioEncoding, AudioFrame, SessionStatus

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-1"
        session.status = SessionStatus.ACTIVE
        session.pending_segments = asyncio.Queue()
        session.persist_if_needed = AsyncMock(return_value=False)
        session.record_frame = MagicMock()
        mgr._flush_final_utterance = AsyncMock()
        mgr._drain_inference_queue = AsyncMock()
        mgr._finalize_session = AsyncMock()

        handler = mgr._make_frame_handler(session, None)

        frame = AudioFrame(
            seq=99,
            sr=16000,
            enc=AudioEncoding.PCM_S16LE,
            ch=1,
            data=b"\x00" * 960,
            final=True,
            ts=1000.0,
        )
        await handler(frame)

        mgr._flush_final_utterance.assert_awaited_once_with(
            session=session,
            preprocessor=None,
        )
        mgr._drain_inference_queue.assert_awaited_once_with("s-1")
        mgr._finalize_session.assert_awaited_once_with(session)

    @pytest.mark.asyncio
    async def test_final_frame_flushes_before_finalize(self):
        from stt_v2.streaming.preprocessor import AudioUtterance
        from stt_v2.streaming.schemas import AudioEncoding, AudioFrame, SessionStatus

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-1"
        session.status = SessionStatus.ACTIVE
        session.pending_segments = asyncio.Queue()
        session.persist_if_needed = AsyncMock(return_value=False)
        session.record_frame = MagicMock()
        mgr._finalize_session = AsyncMock()

        preprocessor = AsyncMock()
        preprocessor.feed = AsyncMock(return_value=[])
        final_utt = AudioUtterance(
            samples=np.zeros(1600, dtype=np.float32),
            sample_rate=16000,
            start_time=2.0,
            end_time=2.1,
            utterance_index=1,
            is_final=True,
        )
        preprocessor.flush = AsyncMock(return_value=final_utt)
        preprocessor.utterance_count = 2

        inference_queue: asyncio.Queue = asyncio.Queue(maxsize=4)
        mgr._inference_queues["s-1"] = inference_queue
        mgr._flush_final_utterance = AsyncMock()
        mgr._drain_inference_queue = AsyncMock()

        handler = mgr._make_frame_handler(session, preprocessor)

        frame = AudioFrame(
            seq=99,
            sr=16000,
            enc=AudioEncoding.PCM_S16LE,
            ch=1,
            data=b"\x00" * 960,
            final=True,
            ts=1000.0,
        )
        await handler(frame)

        preprocessor.feed.assert_awaited_once_with(frame.data)
        assert inference_queue.empty()
        mgr._flush_final_utterance.assert_awaited_once_with(
            session=session,
            preprocessor=preprocessor,
        )
        mgr._drain_inference_queue.assert_awaited_once_with("s-1")
        mgr._finalize_session.assert_awaited_once_with(session)


# ---------------------------------------------------------------------------
# Health Endpoint: Readiness with Streaming
# ---------------------------------------------------------------------------


class TestReadinessWithStreaming:
    """Tests for the /ready endpoint including streaming component."""

    @pytest.mark.asyncio
    async def test_readiness_includes_streaming_component(self):
        """Verify the streaming check returns healthy when manager is available."""
        from stt_v2.health.api.routes import _check_streaming

        mock_mgr = MagicMock()

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.streaming._runtime": MagicMock(get_session_manager=lambda: mock_mgr),
            },
        ):
            result = _check_streaming()

        assert result["status"] == "healthy"
        assert result["duration_ms"] == 0

    def test_streaming_not_initialized_does_not_affect_readiness(self):
        """Verify streaming degraded is informational only."""
        from stt_v2.health.api.routes import _check_streaming

        with patch.dict(
            "sys.modules",
            {
                "stt_v2.streaming._runtime": MagicMock(get_session_manager=lambda: None),
            },
        ):
            result = _check_streaming()

        assert result["status"] == "degraded"
        # This should NOT make the service unready — it's informational


# ---------------------------------------------------------------------------
# Properties Tests
# ---------------------------------------------------------------------------


class TestSessionManagerProperties:
    """Tests for SessionManager property accessors."""

    def test_worker_id(self):
        mgr = _make_manager()
        assert mgr.worker_id == "test-worker"

    def test_capacity_guard(self):
        mgr = _make_manager()
        assert mgr.capacity_guard is not None
        assert mgr.capacity_guard.max_streams == 10

    def test_active_session_count_empty(self):
        mgr = _make_manager()
        assert mgr.active_session_count == 0

    def test_profile(self):
        mgr = _make_manager()
        assert mgr.profile.max_concurrent_streams == 10

    def test_to_dict(self):
        mgr = _make_manager()
        d = mgr.to_dict()
        assert d["worker_id"] == "test-worker"
        assert d["active_sessions"] == 0
        assert "capacity" in d
        assert "profile" in d
        assert "sessions" in d


# ---------------------------------------------------------------------------
# Edge Cases: _make_asr_callable exception propagation
# ---------------------------------------------------------------------------


class TestMakeAsrCallableEdgeCases:
    """Edge cases for the ASR callable closure."""

    @pytest.mark.asyncio
    async def test_propagates_inference_exception(self):
        """Verify that exceptions from model.generate propagate through the closure."""
        mgr = _make_manager()

        mock_model = MagicMock()
        mock_model.dtype = torch.float32
        mock_model.generate.side_effect = RuntimeError("GPU OOM during inference")

        mock_processor = MagicMock()

        loaded = MagicMock()
        loaded.model = mock_model
        loaded.processor = mock_processor
        loaded.feature_extractor = None
        loaded.device = torch.device("cpu")
        loaded.format = AiModelFormat.SAFETENSOR

        fn = mgr._make_asr_callable(
            loaded, MagicMock(beam_size=1, code_switching=False, language="en", temperature=None)
        )

        with pytest.raises(RuntimeError, match="GPU OOM"):
            await fn(np.zeros(16000, dtype=np.float32), 16000)


# ---------------------------------------------------------------------------
# Edge Cases: _finalize_session with empty pending segments (fast path)
# ---------------------------------------------------------------------------


class TestFinalizeSessionPendingSegments:
    """Test finalize with various pending_segments states."""

    @pytest.mark.asyncio
    async def test_finalize_completes_when_queue_is_empty(self):
        """The fast path: empty queue means no drain wait needed."""
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-fast"
        session.status = SessionStatus.ACTIVE
        session.finalize = AsyncMock()
        session.close = AsyncMock()
        session.pending_segments = asyncio.Queue()  # empty

        publisher = AsyncMock()
        mgr._publishers["s-fast"] = publisher
        mgr._sessions["s-fast"] = session
        mgr.remove_session = AsyncMock()

        await mgr._finalize_session(session)

        session.finalize.assert_awaited_once()
        session.close.assert_awaited_once()
        publisher.publish_status.assert_any_await("finalizing")
        publisher.publish_status.assert_any_await("closed")

    @pytest.mark.asyncio
    async def test_drain_timeout_settles_loop_and_transcribes_tail_into_results(self):
        """C2-05 + I-2 (TASK-456) — on a drain timeout the racing background
        inference loop is settled FIRST, then the still-queued tail utterance is
        transcribed inline INTO the session transcript (not merely "inline drain
        was called"). The tail (last item enqueued) survives; the backlog item
        the loop was blocked on is forfeited on cancel."""
        from stt_v2.streaming.preprocessor import AudioUtterance
        from stt_v2.streaming.schemas import (
            SegmentResult,
            SessionMetadata,
            SessionStatus,
        )
        from stt_v2.streaming.session import StreamSession

        mgr = _make_manager()
        meta = SessionMetadata(
            session_id="s-drain",
            tenant_id="t1",
            pipeline_id="p1",
            consultation_id="c1",
            status=SessionStatus.ACTIVE,
            sample_rate=16000,
        )
        session = StreamSession(metadata=meta, redis=AsyncMock(), persist_interval_s=5.0)
        mgr._sessions["s-drain"] = session

        backlog = AudioUtterance(
            samples=np.zeros(1600, dtype=np.float32),
            sample_rate=16000,
            start_time=0.0,
            end_time=0.5,
            utterance_index=0,
            is_final=True,
        )
        tail = AudioUtterance(
            samples=np.zeros(1600, dtype=np.float32),
            sample_rate=16000,
            start_time=1.0,
            end_time=1.5,
            utterance_index=1,
            is_final=True,
        )

        started = asyncio.Event()
        release = asyncio.Event()

        async def _process(session_id, utt):
            if utt is backlog:
                started.set()
                await release.wait()  # block the loop → queue.join() times out
            return SegmentResult(
                text="tail text" if utt is tail else "backlog",
                start_time=utt.start_time,
                end_time=utt.end_time,
                is_final=True,
            )

        worker = MagicMock()
        worker.process_utterance = AsyncMock(side_effect=_process)
        mgr._inference_workers["s-drain"] = worker

        # Live background inference loop consuming the same queue.
        mgr._register_inference_runtime(session, worker)
        queue = mgr._inference_queues["s-drain"]
        await queue.put(backlog)  # loop grabs this and blocks in _process
        await asyncio.wait_for(started.wait(), timeout=1.0)
        await queue.put(tail)  # tail waits behind the backlog item
        mgr._inference_drain_timeout_s = 0.05  # force the join() timeout

        try:
            await mgr._drain_inference_queue("s-drain")
        finally:
            release.set()

        # I-2 — the background loop was settled (cancelled + de-registered)
        # before the inline drain, so it was not a concurrent second consumer.
        assert mgr._inference_tasks.get("s-drain") is None
        # C2-05 — the tail utterance was transcribed inline into the transcript.
        assert "tail text" in session.build_transcript_text()

    @pytest.mark.asyncio
    async def test_finalize_calls_sequence_in_correct_order(self):
        """Verify finalize → publish_status(finalizing) → close → publish_status(closed)."""
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()
        session = MagicMock()
        session.session_id = "s-order"
        session.status = SessionStatus.ACTIVE
        session.finalize = AsyncMock()
        session.close = AsyncMock()
        session.pending_segments = asyncio.Queue()  # empty = no waiting

        call_order = []
        publisher = AsyncMock()
        publisher.publish_status = AsyncMock(
            side_effect=lambda status: call_order.append(f"publish:{status}")
        )
        session.finalize = AsyncMock(side_effect=lambda: call_order.append("finalize"))
        session.close = AsyncMock(side_effect=lambda **kwargs: call_order.append("close"))

        mgr._publishers["s-order"] = publisher
        mgr._sessions["s-order"] = session
        mgr.remove_session = AsyncMock(side_effect=lambda sid: call_order.append("remove"))

        await mgr._finalize_session(session)

        assert call_order == [
            "finalize",
            "publish:finalizing",
            "close",
            "publish:closed",
            "remove",
        ]


# ---------------------------------------------------------------------------
# Edge Cases: _recover_sessions with another worker's session
# ---------------------------------------------------------------------------


class TestRecoverSessionsEdgeCases:
    """Edge cases for session recovery."""

    @pytest.mark.asyncio
    async def test_skips_session_owned_by_alive_worker(self):
        """If another worker owns the session and is alive, skip recovery."""
        from stt_v2.streaming.schemas import SessionMetadata, SessionStatus

        mgr = _make_manager()

        meta = SessionMetadata(
            session_id="other-worker-session",
            tenant_id="t-1",
            pipeline_id="pipe-1",
            status=SessionStatus.ACTIVE,
            worker_id="other-worker-id",  # Different worker
        )

        mgr._redis.scan = AsyncMock(return_value=(0, [b"stt:session:other-worker-session"]))
        mgr._redis.hgetall = AsyncMock(return_value=meta.to_redis_dict())
        # Other worker IS alive
        mgr._redis.exists = AsyncMock(return_value=True)

        await mgr._recover_sessions()

        assert "other-worker-session" not in mgr._sessions

    @pytest.mark.asyncio
    async def test_claims_session_from_dead_worker(self):
        """If the other worker is dead, claim and recover the session."""
        from stt_v2.streaming.schemas import SessionMetadata, SessionStatus

        mgr = _make_manager()

        meta = SessionMetadata(
            session_id="orphaned-session",
            tenant_id="t-1",
            pipeline_id="pipe-1",
            status=SessionStatus.ACTIVE,
            worker_id="dead-worker",
            sample_rate=16000,
        )

        mgr._redis.scan = AsyncMock(return_value=(0, [b"stt:session:orphaned-session"]))
        mgr._redis.hgetall = AsyncMock(return_value=meta.to_redis_dict())
        # Dead worker — does NOT exist in Redis
        mgr._redis.exists = AsyncMock(return_value=False)

        mgr._load_pipeline_config = AsyncMock(return_value=_make_pipeline_config())
        mgr._load_vad_service = AsyncMock(return_value=None)
        mgr._load_asr_pipeline = AsyncMock(return_value=(None, None))

        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as MockListener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()

            await mgr._recover_sessions()

        assert "orphaned-session" in mgr._sessions

    @pytest.mark.asyncio
    async def test_handles_corrupt_session_data(self):
        """Recovery should skip sessions with corrupt Redis data that cause exceptions."""
        mgr = _make_manager()

        mgr._redis.scan = AsyncMock(return_value=(0, [b"stt:session:corrupt"]))
        # Return data with an invalid status value that SessionStatus() will reject
        mgr._redis.hgetall = AsyncMock(
            return_value={
                b"session_id": b"corrupt",
                b"tenant_id": b"t-1",
                b"pipeline_id": b"pipe-1",
                b"status": b"INVALID_STATUS_VALUE",  # This will raise ValueError
            }
        )

        # Should not raise — errors are caught per-session
        await mgr._recover_sessions()

        assert "corrupt" not in mgr._sessions


# ---------------------------------------------------------------------------
# Edge Cases: reap_expired_sessions with invalid timestamp
# ---------------------------------------------------------------------------


class TestReaperEdgeCases:
    """Edge cases for the session reaper."""

    @pytest.mark.asyncio
    async def test_skips_session_with_invalid_timestamp(self):
        """Sessions with unparseable last_activity should be skipped, not crash."""
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()

        session = MagicMock()
        session.session_id = "s-bad-ts"
        session.status = SessionStatus.ACTIVE
        session.last_activity = "not-a-timestamp"

        mgr._sessions["s-bad-ts"] = session
        mgr._finalize_session = AsyncMock()

        count = await mgr.reap_expired_sessions(timeout_s=60)

        assert count == 0


# ---------------------------------------------------------------------------
# Leak Prevention Regression Tests
# ---------------------------------------------------------------------------


class TestSessionLeakPrevention:
    """Regression tests for active session/capacity leak scenarios."""

    @pytest.mark.asyncio
    async def test_create_session_releases_capacity_on_mid_failure(self):
        """If create fails after admission, capacity/session maps must be cleaned."""
        mgr = _make_manager(max_streams=1)

        mgr._load_pipeline_config = AsyncMock(return_value=_make_pipeline_config())
        mgr._load_vad_service = AsyncMock(return_value=None)
        mgr._load_asr_pipeline = AsyncMock(return_value=(None, None))

        broken_consumer = AsyncMock()
        broken_consumer.start = AsyncMock(side_effect=RuntimeError("consumer start failed"))

        with (
            patch(
                "stt_v2.streaming.session_manager.IngestionConsumer", return_value=broken_consumer
            ),
            patch("stt_v2.streaming.session_manager.ControlListener", return_value=AsyncMock()),
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            with pytest.raises(RuntimeError, match="consumer start failed"):
                await mgr.create_session("s-leak-create", "t1", "p1")

        assert mgr.capacity_guard.active_count == 0
        assert "s-leak-create" not in mgr._sessions
        assert "s-leak-create" not in mgr._consumers
        assert "s-leak-create" not in mgr._control_listeners

    @pytest.mark.asyncio
    async def test_recover_releases_capacity_on_mid_failure(self):
        """If recovered session wiring fails, acquired capacity must be released."""
        from stt_v2.streaming.schemas import SessionMetadata, SessionStatus

        mgr = _make_manager(max_streams=1)

        meta = SessionMetadata(
            session_id="s-leak-recover",
            tenant_id="t1",
            pipeline_id="p1",
            status=SessionStatus.ACTIVE,
            worker_id="dead-worker",
            sample_rate=16000,
        )
        mgr._redis.scan = AsyncMock(return_value=(0, [b"stt:session:s-leak-recover"]))
        mgr._redis.hgetall = AsyncMock(return_value=meta.to_redis_dict())
        mgr._redis.exists = AsyncMock(return_value=False)

        mgr._load_pipeline_config = AsyncMock(return_value=_make_pipeline_config())
        mgr._load_vad_service = AsyncMock(return_value=None)
        mgr._load_asr_pipeline = AsyncMock(return_value=(None, None))

        broken_consumer = AsyncMock()
        broken_consumer.start = AsyncMock(side_effect=RuntimeError("recover consumer start failed"))

        with (
            patch(
                "stt_v2.streaming.session_manager.IngestionConsumer", return_value=broken_consumer
            ),
            patch("stt_v2.streaming.session_manager.ControlListener", return_value=AsyncMock()),
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            await mgr._recover_sessions()

        assert mgr.capacity_guard.active_count == 0
        assert "s-leak-recover" not in mgr._sessions
        assert "s-leak-recover" not in mgr._consumers
        assert "s-leak-recover" not in mgr._control_listeners

    @pytest.mark.asyncio
    async def test_remove_session_always_releases_capacity(self):
        """Cleanup must continue even when one component stop() fails."""
        from stt_v2.streaming.schemas import SessionMetadata, SessionStatus
        from stt_v2.streaming.session import StreamSession

        mgr = _make_manager(max_streams=1)

        session_id = "s-leak-remove"
        meta = SessionMetadata(
            session_id=session_id,
            tenant_id="t1",
            pipeline_id="p1",
            status=SessionStatus.ACTIVE,
            worker_id="test-worker",
        )
        await mgr.capacity_guard.try_acquire(session_id)
        mgr._sessions[session_id] = StreamSession(metadata=meta, redis=mgr._redis)

        broken_consumer = AsyncMock()
        broken_consumer.stop = AsyncMock(side_effect=RuntimeError("stop failed"))
        listener = AsyncMock()
        listener.stop = AsyncMock()

        mgr._consumers[session_id] = broken_consumer
        mgr._control_listeners[session_id] = listener

        await mgr.remove_session(session_id)

        assert mgr.capacity_guard.active_count == 0
        assert session_id not in mgr._sessions
        assert session_id not in mgr._consumers
        assert session_id not in mgr._control_listeners

    @pytest.mark.asyncio
    async def test_finalize_session_releases_capacity_on_close_failure(self):
        """Finalize path must release resources even if close() raises."""
        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager(max_streams=1)
        session = MagicMock()
        session.session_id = "s-leak-finalize"
        session.status = SessionStatus.ACTIVE
        session.finalize = AsyncMock()
        session.close = AsyncMock(side_effect=RuntimeError("close failed"))

        await mgr.capacity_guard.try_acquire(session.session_id)
        mgr._sessions[session.session_id] = session

        publisher = AsyncMock()
        mgr._publishers[session.session_id] = publisher

        await mgr._finalize_session(session)

        assert mgr.capacity_guard.active_count == 0
        assert session.session_id not in mgr._sessions

    @pytest.mark.asyncio
    async def test_skips_non_active_status_in_reaper(self):
        """Only ACTIVE sessions should be considered for reaping."""
        from datetime import datetime, timedelta

        from stt_v2.streaming.schemas import SessionStatus

        mgr = _make_manager()

        # Finalizing session that's idle — should NOT be reaped
        session = MagicMock()
        session.session_id = "s-finalizing"
        session.status = SessionStatus.FINALIZING
        session.last_activity = (datetime.utcnow() - timedelta(seconds=9999)).isoformat()

        mgr._sessions["s-finalizing"] = session
        mgr._finalize_session = AsyncMock()

        count = await mgr.reap_expired_sessions(timeout_s=60)

        assert count == 0



class TestRecoverSessionsWorkerParity:
    """TASK-505 P1 — a recovered inference worker must be wired identically
    to a freshly created one (shared SessionAssembly).

    Recovery previously dropped ``max_segment_text_chars``, both
    hallucination knobs, and the ``enable_prev_text_context`` zeroing —
    recovered sessions silently ran with code defaults.
    """

    @pytest.mark.asyncio
    async def test_recovered_worker_gets_full_inference_config(self):
        from stt_v2.streaming.schemas import SessionMetadata, SessionStatus

        mgr = _make_manager()

        meta = SessionMetadata(
            session_id="recovered-3",
            tenant_id="t-1",
            pipeline_id="pipe-1",
            status=SessionStatus.ACTIVE,
            worker_id="test-worker",
            sample_rate=16000,
        )

        mgr._redis.scan = AsyncMock(return_value=(0, [b"stt:session:recovered-3"]))
        mgr._redis.hgetall = AsyncMock(return_value=meta.to_redis_dict())
        mgr._redis.exists = AsyncMock(return_value=False)

        pipeline_cfg = _make_pipeline_config()
        pipeline_cfg.inference.max_segment_text_chars = 555
        pipeline_cfg.inference.hallucination_rms_threshold = 0.02
        pipeline_cfg.inference.hallucination_short_word_count = 5
        pipeline_cfg.inference.prev_text_context_words = 40
        pipeline_cfg.inference.enable_prev_text_context = False

        mgr._load_pipeline_config = AsyncMock(return_value=pipeline_cfg)
        mgr._load_vad_service = AsyncMock(return_value=MagicMock())
        mgr._load_asr_pipeline = AsyncMock(return_value=(AsyncMock(), None))

        with (
            patch("stt_v2.streaming.session_manager.IngestionConsumer") as MockConsumer,
            patch("stt_v2.streaming.session_manager.ControlListener") as MockListener,
            patch("stt_v2.streaming.session_manager.ResultPublisher"),
        ):
            MockConsumer.return_value = AsyncMock()
            MockListener.return_value = AsyncMock()

            await mgr._recover_sessions()

        worker = mgr._inference_workers["recovered-3"]
        assert worker._max_segment_text_chars == 555
        assert worker._hallucination_rms_threshold == 0.02
        assert worker._hallucination_short_word_count == 5
        # enable_prev_text_context=False must zero the context window.
        assert worker._prev_text_context_words == 0


class TestAssemblyWithRealPipelineSpec:
    """TASK-505 P2-P5 review — the criticals were masked by MagicMock pipeline
    configs (auto-created `.spec.models…` attributes). These tests drive
    `_assemble_session_runtime` with a REAL `PipelineSpec` parsed from the
    actual seeded default-pipeline YAML shape."""

    _SEED_LIKE_YAML = (
        'version: "2.0"\n'
        "models:\n"
        '  asr: "whisper-large-v3-turbo"\n'
        '  vad: "silero-vad-v6"\n'
        "  embedding:\n"
        '    hf_model_id: "speechbrain/spkrec-ecapa-voxceleb"\n'
        '    engine: "pytorch"\n'
        "preprocessing:\n"
        "  vad:\n"
        "    enabled: true\n"
        "diarization:\n"
        "  enabled: true\n"
        "  backend: embedding\n"
        "  max_speakers: 2\n"
        "streaming:\n"
        "  commit_policy: local_agreement_2\n"
    )

    @pytest.mark.asyncio
    async def test_embedding_diarization_session_assembles_on_real_spec(self):
        from stt_v2.pipeline.yaml_parser import PipelineYamlParser

        spec = PipelineYamlParser().parse(self._SEED_LIKE_YAML)

        mgr = _make_manager()
        mgr._load_vad_service = AsyncMock(return_value=MagicMock())
        mgr._load_asr_pipeline = AsyncMock(return_value=(AsyncMock(), None))
        mgr._load_gloss_pipeline = AsyncMock(return_value=None)
        mgr._preseed_speaker = AsyncMock()
        fake_emb = MagicMock()
        mgr._get_pipeline_embedding_service = AsyncMock(return_value=fake_emb)

        with patch("stt_v2.streaming.session_manager.ResultPublisher"):
            runtime = await mgr._assemble_session_runtime(
                session_id="real-spec-1",
                tenant_id="t-1",
                consultation_id="c-1",
                user_id="u-1",
                sample_rate=16000,
                pipeline_config=spec,
                build_speaker_identifier=True,
            )

        # The pipeline's embedding model reached BOTH consumers:
        mgr._get_pipeline_embedding_service.assert_awaited_with(
            "speechbrain/spkrec-ecapa-voxceleb"
        )
        assert runtime.inference_worker._embedding_service is fake_emb
        assert runtime.effective_diarization is True

    @pytest.mark.asyncio
    async def test_slug_asr_ref_resolves_db_config_for_streaming(self):
        # TASK-505 P5 review critical: slug-based seed pipelines must resolve
        # the DB model row on the STREAMING path too (was batch-only).
        from stt_v2.pipeline.yaml_parser import PipelineYamlParser

        spec = PipelineYamlParser().parse(
            'version: "2.0"\nmodels:\n  asr: "whisper-large-v3-turbo"\n'
        )

        mgr = _make_manager()
        db_config = MagicMock()
        mock_reader = MagicMock()
        mock_reader.get_model_by_slug = AsyncMock(return_value=db_config)
        loaded = MagicMock()
        loaded.format = AiModelFormat.SAFETENSOR
        loaded.model_slug = "whisper-large-v3-turbo"
        # AsyncMock (not MagicMock): the loader also awaits `pin_many` while
        # warming/pinning the pipeline's models.
        mock_cache = AsyncMock()
        mock_cache.get_or_load_from_ref = AsyncMock(return_value=loaded)
        mgr._make_asr_callable = MagicMock(return_value=AsyncMock())

        from stt_v2.streaming.session_manager import SessionManager

        with (
            patch("stt_v2.models.get_model_cache", return_value=mock_cache),
            patch(
                "stt_v2.pipeline.config_reader.get_model_reader",
                return_value=mock_reader,
            ),
        ):
            await SessionManager._load_asr_pipeline(
                mgr, spec, "s-1", tenant_id="t-9"
            )

        mock_reader.get_model_by_slug.assert_awaited_once_with(
            "whisper-large-v3-turbo", "t-9"
        )
        kwargs = mock_cache.get_or_load_from_ref.call_args.kwargs
        assert kwargs["db_model_config"] is db_config
