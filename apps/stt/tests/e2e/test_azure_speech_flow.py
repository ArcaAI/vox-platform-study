"""E2E tests for Azure Speech transcription flow.

Tests the Azure Speech pipeline end-to-end:
- Pipeline YAML parsing with azure_speech engine
- Inline model config conversion for Azure Speech
- Full transcription flow with mocked Azure SDK boundary
- Full transcription flow with REAL Azure SDK (requires credentials)

Test tiers:
1. YAML parsing / config resolution — no mocks, no Azure SDK needed
2. Full pipeline with mocked Azure SDK — validates data flow without credentials
3. Full pipeline with REAL Azure SDK — requires AZURE_SPEECH_KEY and
   AZURE_SPEECH_REGION env vars, marked @pytest.mark.slow

Usage:
    # Tier 1+2 (no Azure credentials required):
    pytest tests/e2e/test_azure_speech_flow.py -v -k "not real_azure"

    # Tier 3 (requires Azure credentials and audio fixture):
    AZURE_SPEECH_KEY=<key> AZURE_SPEECH_REGION=eastus \
    TEST_PLATFORM=all pytest tests/e2e/test_azure_speech_flow.py -v -k "real_azure"
"""

import logging
import os
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

logger = logging.getLogger(__name__)

FIXTURES_DIR = Path(__file__).parent / "fixtures"
OUTPUT_DIR = Path(__file__).parent / "output"
AUDIO_FILE = FIXTURES_DIR / "20260205_52886591770282917_ml.wav"

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_TENANT_ID = "50000000-0000-0000-0000-000000000000"


# =============================================================================
# Pipeline YAML Configurations for Azure Speech
# =============================================================================


def _pipeline_yaml_azure_basic() -> str:
    """Azure Speech pipeline — basic, no VAD, no denoise."""
    return """version: "1.1"

# Azure Speech engine — cloud-based ASR
models:
  asr:
    hf_model_id: "azure/speech-to-text"
    engine: "azure_speech"
    revision: "eastus"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: false
  denoise:
    enabled: false

inference:
  batch_size: 1
  device: auto
  language: en

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  lowercase: false
"""


def _pipeline_yaml_azure_multilingual() -> str:
    """Azure Speech pipeline — Malayalam (ml) language."""
    return """version: "1.1"

# Azure Speech engine — multilingual test (Malayalam)
models:
  asr:
    hf_model_id: "azure/speech-to-text"
    engine: "azure_speech"
    revision: "eastus"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: false
  denoise:
    enabled: false

inference:
  batch_size: 1
  device: auto
  language: ml

postprocessing:
  timestamps:
    word_timestamps: true
  punctuation:
    enabled: true
  lowercase: false
"""


def _pipeline_yaml_azure_alias() -> str:
    """Azure Speech pipeline using 'azure' alias (not 'azure_speech')."""
    return """version: "1.1"

# Uses the 'azure' alias for engine name
models:
  asr:
    hf_model_id: "azure/speech-to-text"
    engine: "azure"
    revision: "westus2"

preprocessing:
  target_sample_rate: 16000
  normalize: true

inference:
  language: en
"""


# =============================================================================
# TIER 1: YAML Parsing and Config Resolution (no mocks needed)
# =============================================================================


@pytest.mark.e2e
class TestAzureSpeechYamlParsing:
    """E2E tests for Azure Speech pipeline YAML parsing and validation."""

    @pytest.mark.asyncio
    async def test_azure_speech_yaml_parses_correctly(self):
        """Test that Azure Speech YAML is parsed with correct engine type."""
        from stt.pipeline.dto import AiModelFormat
        from stt.pipeline.yaml_parser import get_yaml_parser

        parser = get_yaml_parser()
        spec = parser.parse(_pipeline_yaml_azure_basic())

        assert spec.version == "1.1"
        assert spec.models.asr.is_inline is True
        assert spec.models.asr.inline.engine == AiModelFormat.AZURE_SPEECH
        assert spec.models.asr.inline.revision == "eastus"

        # Validate
        result = parser.validate(spec)
        assert result.valid is True, f"Validation failed: {result.get_error_messages()}"

    @pytest.mark.asyncio
    async def test_azure_alias_resolves_to_azure_speech(self):
        """Test that 'azure' alias maps to AZURE_SPEECH format."""
        from stt.pipeline.dto import AiModelFormat
        from stt.pipeline.yaml_parser import get_yaml_parser

        parser = get_yaml_parser()
        spec = parser.parse(_pipeline_yaml_azure_alias())

        assert spec.models.asr.inline.engine == AiModelFormat.AZURE_SPEECH

    @pytest.mark.asyncio
    async def test_azure_speech_inline_model_to_config(self):
        """Test converting Azure Speech inline model to AiModelConfig."""
        from stt.pipeline.dto import (
            AiModelFormat,
            ModelTaskType,
        )
        from stt.pipeline.yaml_parser import get_yaml_parser

        parser = get_yaml_parser()
        spec = parser.parse(_pipeline_yaml_azure_basic())

        inline = spec.models.asr.inline
        config = inline.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)

        assert config.format == AiModelFormat.AZURE_SPEECH
        assert config.source_revision == "eastus"  # Region from revision field
        assert config.task_type == ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION

    @pytest.mark.asyncio
    async def test_azure_multilingual_yaml_parses_language(self):
        """Test that multilingual YAML correctly captures language setting."""
        from stt.pipeline.yaml_parser import get_yaml_parser

        parser = get_yaml_parser()
        spec = parser.parse(_pipeline_yaml_azure_multilingual())

        assert spec.inference.language == "ml"


# =============================================================================
# TIER 2: Full Pipeline with Mocked Azure SDK
# =============================================================================


@pytest.mark.e2e
class TestAzureSpeechFullFlowMocked:
    """E2E tests for the full Azure Speech pipeline with mocked Azure SDK.

    These tests exercise the real pipeline code (YAML parsing → model config →
    loader → batch service → result) but mock the Azure SDK at the network
    boundary to avoid requiring real credentials.
    """

    # Azure Speech is BYOK-only — the key arrives via the gateway
    # provider override, never env. Only the (non-secret) region is env-set.
    _BYOK_OVERRIDE = {"azure-speech": {"api_key": "e2e-test-key-12345"}}

    @pytest.fixture
    def mock_azure_env(self):
        """Set up the mock Azure REGION in environment (the key is BYOK)."""
        with patch.dict(
            os.environ,
            {
                "AZURE_SPEECH_REGION": "eastus",
            },
        ):
            # Clear settings cache
            from stt.core.config.settings import get_settings

            get_settings.cache_clear()
            yield
            get_settings.cache_clear()

    @pytest.mark.asyncio
    async def test_full_azure_pipeline_with_mocked_sdk(self, mock_azure_env):
        """Test complete pipeline: YAML → config → load → inference → result.

        All real code runs except the Azure ConversationTranscriber which is
        mocked to return a realistic transcription response.
        """
        from stt.models.azure_speech_loader import AzureSpeechLoader
        from stt.pipeline.dto import (
            AiModelFormat,
            ModelTaskType,
        )
        from stt.pipeline.yaml_parser import get_yaml_parser
        from stt.transcription.batch_service import BatchTranscriptionService
        from stt.transcription.dto import RawTranscription

        # Step 1: Parse YAML (real code)
        parser = get_yaml_parser()
        spec = parser.parse(_pipeline_yaml_azure_basic())
        assert spec.models.asr.inline.engine == AiModelFormat.AZURE_SPEECH

        # Step 2: Build model config (real code)
        inline = spec.models.asr.inline
        model_config = inline.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)

        # Step 3: Load model through AzureSpeechLoader (real code, mocked SpeechConfig)
        mock_speech_config = MagicMock()
        with patch(
            "stt.models.azure_speech_loader.SpeechConfig",
            return_value=mock_speech_config,
        ):
            loader = AzureSpeechLoader()
            loaded_model = await loader.load(model_config, provider_overrides=self._BYOK_OVERRIDE)

        assert loaded_model.format == AiModelFormat.AZURE_SPEECH
        assert loaded_model.device == "cloud"
        assert loaded_model.model is mock_speech_config

        # Step 4: Run inference (real dispatch, mocked sync transcription)
        service = BatchTranscriptionService()
        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()
        config.language = "en"

        mock_result = RawTranscription(
            text="Hello this is an end-to-end test.",
            language="en-US",
            language_probability=0.95,
            segments=[
                {
                    "text": "Hello this is an end-to-end test.",
                    "start": 0.0,
                    "end": 2.5,
                    "speaker_id": None,
                    "confidence": 0.95,
                },
            ],
            word_timestamps=[
                {
                    "text": "Hello",
                    "word": "Hello",
                    "start": 0.0,
                    "end": 0.3,
                    "start_time": 0.0,
                    "end_time": 0.3,
                    "confidence": 0.98,
                },
                {
                    "text": "this",
                    "word": "this",
                    "start": 0.35,
                    "end": 0.5,
                    "start_time": 0.35,
                    "end_time": 0.5,
                    "confidence": 0.95,
                },
                {
                    "text": "is",
                    "word": "is",
                    "start": 0.55,
                    "end": 0.65,
                    "start_time": 0.55,
                    "end_time": 0.65,
                    "confidence": 0.97,
                },
                {
                    "text": "an",
                    "word": "an",
                    "start": 0.7,
                    "end": 0.8,
                    "start_time": 0.7,
                    "end_time": 0.8,
                    "confidence": 0.96,
                },
                {
                    "text": "end-to-end",
                    "word": "end-to-end",
                    "start": 0.85,
                    "end": 1.3,
                    "start_time": 0.85,
                    "end_time": 1.3,
                    "confidence": 0.92,
                },
                {
                    "text": "test.",
                    "word": "test.",
                    "start": 1.35,
                    "end": 1.6,
                    "start_time": 1.35,
                    "end_time": 1.6,
                    "confidence": 0.94,
                },
            ],
        )

        with patch.object(service, "_azure_transcribe_sync", return_value=mock_result):
            result = await service._run_inference(samples, 16000, loaded_model, config)

        # Step 5: Verify full result structure
        assert result.text == "Hello this is an end-to-end test."
        assert result.language == "en-US"
        assert result.language_probability == pytest.approx(0.95)
        assert len(result.segments) == 1
        assert len(result.word_timestamps) == 6
        assert result.word_timestamps[0]["text"] == "Hello"

    @pytest.mark.asyncio
    async def test_multilingual_pipeline_normalizes_language(self, mock_azure_env):
        """Test that multilingual config correctly normalizes language codes."""
        from stt.models.azure_speech_loader import AzureSpeechLoader
        from stt.pipeline.dto import ModelTaskType
        from stt.pipeline.yaml_parser import get_yaml_parser
        from stt.transcription.batch_service import BatchTranscriptionService
        from stt.transcription.dto import RawTranscription

        # Parse multilingual YAML
        parser = get_yaml_parser()
        spec = parser.parse(_pipeline_yaml_azure_multilingual())
        assert spec.inference.language == "ml"

        # Load model
        model_config = spec.models.asr.inline.to_ai_model_config(
            ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
        )

        mock_speech_config = MagicMock()
        with patch(
            "stt.models.azure_speech_loader.SpeechConfig",
            return_value=mock_speech_config,
        ):
            loader = AzureSpeechLoader()
            loaded_model = await loader.load(model_config, provider_overrides=self._BYOK_OVERRIDE)

        # Run inference — verify "ml" is normalized to "ml-IN"
        service = BatchTranscriptionService()
        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()
        config.language = "ml"

        with patch.object(
            service,
            "_azure_transcribe_sync",
            return_value=RawTranscription(text="Test", language="ml-IN"),
        ) as mock_sync:
            await service._run_inference(samples, 16000, loaded_model, config)

            # Verify the BCP-47 normalized language was passed
            assert mock_sync.call_args[0][3] == "ml-IN"

    @pytest.mark.asyncio
    async def test_missing_credentials_raises_auth_error(self):
        """Test that missing Azure credentials surface as CloudASRAuthError."""
        # Clear any cached settings
        from stt.core.config.settings import get_settings
        from stt.core.exceptions import CloudASRAuthError
        from stt.models.azure_speech_loader import AzureSpeechLoader
        from stt.pipeline.dto import ModelTaskType
        from stt.pipeline.yaml_parser import get_yaml_parser

        get_settings.cache_clear()

        parser = get_yaml_parser()
        spec = parser.parse(_pipeline_yaml_azure_basic())
        model_config = spec.models.asr.inline.to_ai_model_config(
            ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
        )

        # Ensure no credentials in env AND override get_settings so
        # pydantic-settings cannot read credentials from the .env file.
        fake_settings = MagicMock()
        fake_settings.azure_speech_key = None
        fake_settings.azure_speech_region = None

        with (
            patch.dict(os.environ, {}, clear=True),
            patch("stt.models.azure_speech_loader.get_settings", return_value=fake_settings),
        ):
            get_settings.cache_clear()
            loader = AzureSpeechLoader()

            with pytest.raises(CloudASRAuthError) as exc_info:
                await loader.load(model_config)

            assert exc_info.value.details["has_key"] is False


# =============================================================================
# TIER 3: Full Pipeline with REAL Azure SDK (requires credentials)
# =============================================================================


def _has_azure_credentials() -> bool:
    """Check if Azure Speech credentials are available."""
    return bool(os.environ.get("AZURE_SPEECH_KEY") and os.environ.get("AZURE_SPEECH_REGION"))


def _skip_if_azure_platform_unsupported(exc: BaseException) -> None:
    """Skip (don't fail) when the native Azure Speech SDK can't run here.

    On macOS / Apple Silicon the Speech SDK's diagnostics layer raises
    ``RuntimeError: GetCallStack not implemented on this platform`` while
    initialising or running recognition. That is a platform limitation of the
    SDK, not a defect in our code, so the real-Azure E2E should skip cleanly
    instead of failing. Any other error is re-raised by the caller.
    """
    message = str(exc)
    if "not implemented on this platform" in message or "GetCallStack" in message:
        pytest.skip(f"Azure Speech SDK is not supported on this platform: {exc}")


@pytest.mark.e2e
@pytest.mark.slow
@pytest.mark.skipif(
    not _has_azure_credentials(),
    reason="AZURE_SPEECH_KEY and AZURE_SPEECH_REGION env vars required",
)
class TestAzureSpeechRealTranscription:
    """E2E tests using the REAL Azure Speech API.

    Requirements:
    - AZURE_SPEECH_KEY env var set to a valid Azure subscription key
    - AZURE_SPEECH_REGION env var set to the region (e.g., "eastus")
    - Audio fixture: tests/e2e/fixtures/20260205_52886591770282917_ml.wav

    These tests make real API calls to Azure Cognitive Services.
    They are marked @slow and will be skipped unless credentials are provided.
    """

    @pytest.fixture(scope="class")
    def real_audio_bytes(self) -> bytes:
        """Load real audio for Azure transcription."""
        if not AUDIO_FILE.exists():
            pytest.skip(f"Audio fixture not found: {AUDIO_FILE}")
        return AUDIO_FILE.read_bytes()

    @pytest.mark.asyncio
    async def test_real_azure_transcription(self, real_audio_bytes: bytes):
        """Test real Azure Speech transcription with actual audio.

        This test:
        1. Parses the Azure pipeline YAML (no mocks)
        2. Loads a real SpeechConfig with real credentials
        3. Sends real audio to Azure for transcription
        4. Validates the returned text and timestamps
        5. Writes a report to tests/e2e/output/
        """
        from stt.core.config.settings import get_settings
        from stt.models.azure_speech_loader import AzureSpeechLoader
        from stt.pipeline.dto import (
            AiModelFormat,
            ModelTaskType,
        )
        from stt.pipeline.yaml_parser import get_yaml_parser
        from stt.transcription.batch_service import BatchTranscriptionService

        get_settings.cache_clear()

        # Step 1: Parse YAML
        parser = get_yaml_parser()
        spec = parser.parse(_pipeline_yaml_azure_multilingual())

        # Step 2: Build config and load (uses real AZURE_SPEECH_KEY)
        model_config = spec.models.asr.inline.to_ai_model_config(
            ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
        )
        loader = AzureSpeechLoader()
        # Azure Speech is BYOK-only — pass the real key (from the env the
        # skipif gate requires) as a gateway-shaped provider override, not via
        # settings.
        real_override = {"azure-speech": {"api_key": os.environ["AZURE_SPEECH_KEY"]}}
        try:
            loaded_model = await loader.load(model_config, provider_overrides=real_override)
        except RuntimeError as exc:
            _skip_if_azure_platform_unsupported(exc)
            raise

        assert loaded_model.format == AiModelFormat.AZURE_SPEECH
        assert loaded_model.device == "cloud"

        # Step 3: Run real transcription
        service = BatchTranscriptionService()

        # Convert audio bytes to float32 samples
        import io
        import wave

        wav_buf = io.BytesIO(real_audio_bytes)
        with wave.open(wav_buf, "rb") as wf:
            sample_rate = wf.getframerate()
            n_frames = wf.getnframes()
            pcm_bytes = wf.readframes(n_frames)

        pcm_int16 = np.frombuffer(pcm_bytes, dtype=np.int16)
        samples = pcm_int16.astype(np.float32) / 32768.0

        config = MagicMock()
        config.language = "ml"  # Malayalam

        try:
            result = await service._run_azure_speech_inference(
                samples, sample_rate, loaded_model, config
            )
        except RuntimeError as exc:
            _skip_if_azure_platform_unsupported(exc)
            raise

        # Step 4: Validate result
        assert result is not None
        assert isinstance(result.text, str)
        assert len(result.text) > 0, "Azure should return transcribed text"
        assert result.language == "ml-IN"

        logger.info(f"Azure real transcription ({len(result.text)} chars): {result.text[:300]}...")

        if result.word_timestamps:
            logger.info(f"Word timestamps: {len(result.word_timestamps)} words")

        if result.segments:
            logger.info(f"Segments: {len(result.segments)}")

        # Step 5: Write report
        report_path = (
            OUTPUT_DIR / f"azure_real_transcription_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
        )
        lines = [
            "# Azure Speech Real Transcription Report",
            "",
            f"**Generated**: {datetime.now().isoformat()}",
            f"**Region**: {os.environ.get('AZURE_SPEECH_REGION', 'unknown')}",
            "**Language**: ml-IN (Malayalam)",
            "",
            "## Result",
            "",
            result.text,
            "",
            f"**Confidence**: {result.language_probability}",
            f"**Segments**: {len(result.segments)}",
            f"**Words**: {len(result.word_timestamps)}",
        ]
        report_path.write_text("\n".join(lines), encoding="utf-8")
        logger.info(f"Report written to: {report_path}")
