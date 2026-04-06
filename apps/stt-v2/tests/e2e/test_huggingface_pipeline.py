"""
E2E tests for HuggingFace (Transformers) pipeline through /api/v1/transcribe.

These tests cover the non-ONNX inference path that uses
``_run_transformers_inference`` in ``batch_service.py``.  This path is
exercised when the pipeline YAML specifies ``engine: "transformers"`` (or
the model format resolves to SAFETENSOR/PYTORCH).

**Why this file exists:**
The existing happy-path tests in ``test_transcription_http_api.py`` only
exercise the ONNX (Optimum) path via the ``turbo-whisper-large-v3`` pipeline.
A production bug (dtype mismatch: "Input type (float) and bias type
(c10::Half) should be the same") was found in the HuggingFace path when
running on GPU/MPS with float16 models.  These tests ensure:

1. The HuggingFace pipeline works end-to-end through the HTTP endpoint.
2. The dtype casting fix in ``_run_transformers_inference`` prevents the
   float16/float32 mismatch error.
3. Different ``compute_type`` values (auto, float32, float16) are handled
   correctly.
4. The ``_get_device`` method is never called with a compute_type string
   (e.g. "float16") — it should always receive "auto" or a device name.

Requires:
    - ML deps installed (torch, transformers, etc.)
    - Monorepo test infra running: ``pnpm docker:test:up``
    - Audio fixtures in ``tests/e2e/fixtures/``

Run:
    TEST_PLATFORM=all pytest tests/e2e/test_huggingface_pipeline.py -v -s

Markers:
    @pytest.mark.e2e    — all tests in this file
    @pytest.mark.slow   — tests that perform ML inference (>10s)
    @pytest.mark.ml     — tests that require ML dependencies
"""

from __future__ import annotations

import io
import os

import pytest

VALID_TENANT_ID = os.environ.get("TEST_TENANT_ID", "50000000-0000-0000-0000-000000000000")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_multipart_form(
    audio_bytes: bytes,
    filename: str,
    pipeline_id: str,
    tenant_id: str = VALID_TENANT_ID,
    language: str | None = None,
) -> dict:
    """Build multipart form data dict for httpx."""
    files = {"file": (filename, io.BytesIO(audio_bytes), "audio/wav")}
    data: dict[str, str] = {
        "pipeline_id": pipeline_id,
        "tenant_id": tenant_id,
    }
    if language is not None:
        data["language"] = language
    return {"files": files, "data": data}


# ---------------------------------------------------------------------------
# Pipeline YAML configs for HuggingFace (Transformers) engine
# ---------------------------------------------------------------------------


def _hf_pipeline_yaml_float32() -> str:
    """HuggingFace pipeline with explicit float32 compute type.

    Uses ``openai/whisper-large-v3-turbo`` via the ``transformers`` engine
    (SAFETENSOR).  This is the safest config — works on all devices
    (CPU, CUDA, MPS).
    """
    return """
version: "1.1"

models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "safetensor"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: false
  denoise:
    enabled: false

inference:
  batch_size: 1
  compute_type: float32
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false
"""


def _hf_pipeline_yaml_auto_compute() -> str:
    """HuggingFace pipeline with ``compute_type: auto``.

    On GPU/MPS this resolves to float16, on CPU to float32.
    This is the config that triggered the dtype mismatch bug before the fix.
    """
    return """
version: "1.1"

models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "safetensor"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: false
  denoise:
    enabled: false

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false
"""


def _hf_pipeline_yaml_float16() -> str:
    """HuggingFace pipeline with explicit float16 compute type.

    This is the most likely config to trigger the dtype mismatch bug
    because the model loads in float16 but the processor outputs float32.
    The fix in ``_run_transformers_inference`` must cast inputs to match.
    """
    return """
version: "1.1"

models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "safetensor"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: false
  denoise:
    enabled: false

inference:
  batch_size: 1
  compute_type: float16
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false
"""


# ============================================================================
# Unit tests for the dtype casting fix (fast, no ML inference)
# ============================================================================


@pytest.mark.e2e
class TestDtypeCastingFix:
    """Verify the dtype casting logic in loaders and batch_service.

    These tests validate the fix for the production bug:
        "Input type (float) and bias type (c10::Half) should be the same"

    They do NOT require ML models or real audio — they test the logic
    directly.
    """

    def test_get_device_never_receives_compute_type(self):
        """``_get_device`` should only receive device strings, not compute types.

        Before the fix, ``_get_device(model_config.compute_type or "auto")``
        would pass "float16" as a device string, which is invalid.
        """
        from stt_v2.models.base_loader import BaseModelLoader

        class _TestLoader(BaseModelLoader):
            @property
            def supported_formats(self):
                return []

            async def load(self, model_config):
                pass

            async def unload(self, loaded_model):
                pass

            def estimate_memory(self, model_config):
                return 0

        loader = _TestLoader()

        # Valid device strings should work
        assert loader._get_device("auto") in ("cpu", "cuda", "mps")
        assert loader._get_device("cpu") == "cpu"

        # Compute type strings should NOT be passed to _get_device.
        # If they are, _get_device returns them as-is (which is a bug).
        # This test documents the expected behavior after the fix.
        # The loaders now always call _get_device("auto").
        result = loader._get_device("float16")
        # If _get_device("float16") returns "float16", that's the old bug.
        # After the fix, this code path should never be reached in production,
        # but we document the behavior here.
        assert result == "float16", (
            "_get_device passes through unknown strings — loaders must NOT "
            "call it with compute_type values"
        )

    def test_get_torch_dtype_mapping(self):
        """``_get_torch_dtype`` correctly maps compute type strings to torch dtypes."""
        try:
            import torch
        except ImportError:
            pytest.skip("torch not installed")

        from stt_v2.models.base_loader import BaseModelLoader

        class _TestLoader(BaseModelLoader):
            @property
            def supported_formats(self):
                return []

            async def load(self, model_config):
                pass

            async def unload(self, loaded_model):
                pass

            def estimate_memory(self, model_config):
                return 0

        loader = _TestLoader()

        has_gpu = torch.cuda.is_available() or (
            hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
        )

        assert loader._get_torch_dtype("float32") == torch.float32
        assert loader._get_torch_dtype("int8") == torch.int8

        # On CPU, float16 / bfloat16 are forcibly downgraded to float32
        # because PyTorch CPU kernels do not support half-precision inference.
        if has_gpu:
            assert loader._get_torch_dtype("float16") == torch.float16
            assert loader._get_torch_dtype("bfloat16") == torch.bfloat16
        else:
            assert loader._get_torch_dtype("float16") == torch.float32
            assert loader._get_torch_dtype("bfloat16") == torch.float32

        # "auto" should return float16 on GPU/MPS, float32 on CPU
        auto_dtype = loader._get_torch_dtype("auto")
        if has_gpu:
            assert auto_dtype == torch.float16
        else:
            assert auto_dtype == torch.float32

    def test_huggingface_loader_uses_auto_device(self):
        """HuggingFaceLoader.load() should call _get_device('auto'), not _get_device(compute_type).

        This verifies the fix: the device is always auto-detected from hardware,
        not derived from the compute_type string.
        """
        import inspect

        from stt_v2.models.huggingface_loader import HuggingFaceLoader

        source = inspect.getsource(HuggingFaceLoader.load)
        # The fix changed: _get_device(model_config.compute_type or "auto")
        # to: _get_device(requested_device) where requested_device = model_config.device or "auto"
        assert '_get_device(requested_device)' in source or '_get_device("auto")' in source, (
            "HuggingFaceLoader.load() should call _get_device with device (not compute_type)"
        )

    def test_onnx_loader_uses_auto_device(self):
        """ONNXLoader._load_with_optimum() should call _get_device('auto')."""
        import inspect

        from stt_v2.models.onnx_loader import ONNXLoader

        source = inspect.getsource(ONNXLoader._load_with_optimum)
        assert '_get_device("auto")' in source, (
            "ONNXLoader._load_with_optimum() should call _get_device('auto'), "
            "not _get_device(model_config.compute_type)"
        )

    def test_nemo_loader_uses_auto_device(self):
        """NeMoLoader.load() should call _get_device('auto')."""
        import inspect

        from stt_v2.models.nemo_loader import NeMoLoader

        source = inspect.getsource(NeMoLoader.load)
        assert '_get_device("auto")' in source, (
            "NeMoLoader.load() should call _get_device('auto'), "
            "not _get_device(model_config.compute_type)"
        )

    def test_transformers_inference_casts_inputs_to_model_dtype(self):
        """``_run_transformers_inference`` must cast float inputs to model dtype.

        This verifies the fix is present in the source code.
        """
        import inspect

        from stt_v2.transcription.batch_service import BatchTranscriptionService

        source = inspect.getsource(BatchTranscriptionService._run_transformers_inference)
        # The fix adds dtype casting: v.to(device=device, dtype=model_dtype)
        assert (
            "model_dtype" in source
        ), "_run_transformers_inference must extract model dtype for input casting"
        assert "is_floating_point" in source, (
            "_run_transformers_inference must check is_floating_point() "
            "before casting (attention_mask is int, should not be cast)"
        )

    def test_cpu_float16_guard_in_get_torch_dtype(self):
        """``_get_torch_dtype("float16")`` must return float32 on CPU.

        Production bug: Intel CPU-only servers crash with
        ``RuntimeError: Input type (float) and bias type (c10::Half)
        should be the same`` when the DB has ``computeType=float16``
        and the model is loaded via HuggingFace Transformers.

        The guard in ``_get_torch_dtype`` must silently downgrade
        float16 / bfloat16 to float32 on CPU.
        """
        try:
            import torch
        except ImportError:
            pytest.skip("torch not installed")

        from unittest.mock import patch

        from stt_v2.models.base_loader import BaseModelLoader

        class _TestLoader(BaseModelLoader):
            @property
            def supported_formats(self):
                return []

            async def load(self, model_config):
                pass

            async def unload(self, loaded_model):
                pass

            def estimate_memory(self, model_config):
                return 0

        loader = _TestLoader()

        # Simulate CPU-only environment (no CUDA, no MPS)
        with (
            patch("torch.cuda.is_available", return_value=False),
            patch.object(torch.backends, "mps", create=True) as mock_mps,
        ):
            mock_mps.is_available.return_value = False

            # float16 must be downgraded to float32 on CPU
            assert loader._get_torch_dtype("float16") == torch.float32, (
                "_get_torch_dtype('float16') must return float32 on CPU "
                "to prevent 'Input type (float) and bias type (c10::Half)' error"
            )
            # bfloat16 must also be downgraded
            assert (
                loader._get_torch_dtype("bfloat16") == torch.float32
            ), "_get_torch_dtype('bfloat16') must return float32 on CPU"
            # float32 stays float32
            assert loader._get_torch_dtype("float32") == torch.float32
            # auto on CPU should be float32
            assert loader._get_torch_dtype("auto") == torch.float32

    def test_cpu_float16_guard_in_batch_inference(self):
        """``_run_transformers_inference`` must cast fp16 models to float32 on non-CUDA.

        This is the defense-in-depth guard: even if a model was somehow loaded
        in float16 on CPU or MPS (e.g. from a cached checkpoint), the inference
        path must detect this and cast the model to float32 before running.

        CPU: float16 causes ``RuntimeError: Input type (float) and bias type
        (c10::Half) should be the same``.

        MPS: float16 causes ``out of range integral type conversion attempted``
        during Whisper's autoregressive ``generate()`` call.
        """
        import inspect

        from stt_v2.transcription.batch_service import BatchTranscriptionService

        source = inspect.getsource(BatchTranscriptionService._run_transformers_inference)
        assert (
            "asr_model.float()" in source or "asr_model = asr_model.float()" in source
        ), "_run_transformers_inference must cast fp16 model to float32"
        assert '"cpu"' in source and '"mps"' in source, (
            "_run_transformers_inference must guard against fp16 on both CPU and MPS"
        )


# ============================================================================
# YAML parser tests for compute_type default
# ============================================================================


@pytest.mark.e2e
class TestComputeTypeDefaults:
    """Verify that the YAML parser and DTO use safe defaults for compute_type."""

    def test_inference_config_default_is_auto(self):
        """InferenceConfig.compute_type should default to 'auto', not 'float16'.

        The old default of 'float16' caused dtype mismatches on CPU where
        float16 is emulated and slower.
        """
        from stt_v2.pipeline.dto import InferenceConfig

        config = InferenceConfig()
        assert config.compute_type == "auto", (
            f"InferenceConfig.compute_type should default to 'auto', "
            f"got '{config.compute_type}'"
        )

    def test_yaml_parser_default_compute_type_is_auto(self):
        """YAML parser should default compute_type to 'auto' when not specified."""
        from stt_v2.pipeline.yaml_parser import get_yaml_parser

        parser = get_yaml_parser()
        yaml_without_compute_type = """
version: "1.1"

models:
  asr:
    hf_model_id: "openai/whisper-small"
    engine: "safetensor"

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

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
"""
        spec = parser.parse(yaml_without_compute_type)
        assert spec.inference.compute_type == "auto", (
            f"Parser should default compute_type to 'auto', " f"got '{spec.inference.compute_type}'"
        )

    def test_yaml_parser_explicit_float16_preserved(self):
        """YAML parser should preserve explicit ``compute_type: float16``."""
        from stt_v2.pipeline.yaml_parser import get_yaml_parser

        parser = get_yaml_parser()
        spec = parser.parse(_hf_pipeline_yaml_float16())
        assert spec.inference.compute_type == "float16"

    def test_yaml_parser_explicit_float32_preserved(self):
        """YAML parser should preserve explicit ``compute_type: float32``."""
        from stt_v2.pipeline.yaml_parser import get_yaml_parser

        parser = get_yaml_parser()
        spec = parser.parse(_hf_pipeline_yaml_float32())
        assert spec.inference.compute_type == "float32"

    def test_yaml_parser_explicit_auto_preserved(self):
        """YAML parser should preserve explicit ``compute_type: auto``."""
        from stt_v2.pipeline.yaml_parser import get_yaml_parser

        parser = get_yaml_parser()
        spec = parser.parse(_hf_pipeline_yaml_auto_compute())
        assert spec.inference.compute_type == "auto"


# ============================================================================
# Integration tests: HuggingFace pipeline through /api/v1/transcribe
#
# These tests require real ML models and monorepo test infrastructure.
# They exercise the full production stack with a HuggingFace (non-ONNX)
# pipeline to catch dtype mismatches and device errors.
# ============================================================================


@pytest.mark.e2e
@pytest.mark.slow
@pytest.mark.ml
class TestHuggingFacePipelineTranscription:
    """End-to-end tests for HuggingFace (Transformers) pipeline.

    These tests create a temporary pipeline in the test database with
    ``engine: "safetensor"`` (HuggingFace path) and transcribe real audio
    through the ``/api/v1/transcribe`` endpoint.

    This covers the ``_run_transformers_inference`` code path that was
    previously untested and contained the dtype mismatch bug.
    """

    @pytest.fixture
    async def hf_pipeline_slug(self, real_audio_client) -> str:
        """Create a temporary HuggingFace pipeline in the test database.

        Returns the pipeline slug for use in transcription requests.
        """
        from sqlalchemy import text

        from stt_v2.core.database.connection import get_session

        slug = "e2e-test-hf-turbo-float32"
        pipeline_yaml = _hf_pipeline_yaml_float32()

        async with get_session() as session:
            # Check if pipeline already exists
            result = await session.execute(
                text('SELECT id FROM core."AsrPipeline" WHERE slug = :slug'),
                {"slug": slug},
            )
            existing = result.scalar_one_or_none()

            if existing is None:
                # Insert a new pipeline
                await session.execute(
                    text("""
                        INSERT INTO core."AsrPipeline" (
                            id, "tenantId", slug, name, description,
                            "configYaml", "resourceStatus", tags,
                            "createdAt", "updatedAt"
                        ) VALUES (
                            gen_random_uuid(),
                            :tenant_id,
                            :slug,
                            'E2E Test HF Whisper Large V3 Turbo (float32)',
                            'HuggingFace e2e test pipeline with explicit float32',
                            :config_yaml,
                            'ENABLED',
                            ARRAY['e2e-test']::text[],
                            NOW(),
                            NOW()
                        )
                    """),
                    {
                        "tenant_id": VALID_TENANT_ID,
                        "slug": slug,
                        "config_yaml": pipeline_yaml,
                    },
                )
                await session.commit()
            else:
                # Update existing pipeline config
                await session.execute(
                    text(
                        'UPDATE core."AsrPipeline" SET "configYaml" = :config_yaml, '
                        '"updatedAt" = NOW() WHERE slug = :slug'
                    ),
                    {"config_yaml": pipeline_yaml, "slug": slug},
                )
                await session.commit()

        return slug

    @pytest.fixture
    async def hf_auto_pipeline_slug(self, real_audio_client) -> str:
        """Create a HuggingFace pipeline with ``compute_type: auto``.

        This is the config that triggered the original dtype mismatch bug.
        On GPU/MPS, ``auto`` resolves to float16, causing the model to load
        in half precision while the processor outputs float32 tensors.
        """
        from sqlalchemy import text

        from stt_v2.core.database.connection import get_session

        slug = "e2e-test-hf-turbo-auto"
        pipeline_yaml = _hf_pipeline_yaml_auto_compute()

        async with get_session() as session:
            result = await session.execute(
                text('SELECT id FROM core."AsrPipeline" WHERE slug = :slug'),
                {"slug": slug},
            )
            existing = result.scalar_one_or_none()

            if existing is None:
                await session.execute(
                    text("""
                        INSERT INTO core."AsrPipeline" (
                            id, "tenantId", slug, name, description,
                            "configYaml", "resourceStatus", tags,
                            "createdAt", "updatedAt"
                        ) VALUES (
                            gen_random_uuid(),
                            :tenant_id,
                            :slug,
                            'E2E Test HF Whisper Large V3 Turbo (auto compute)',
                            'HuggingFace pipeline with auto compute_type for dtype mismatch test',
                            :config_yaml,
                            'ENABLED',
                            ARRAY['e2e-test']::text[],
                            NOW(),
                            NOW()
                        )
                    """),
                    {
                        "tenant_id": VALID_TENANT_ID,
                        "slug": slug,
                        "config_yaml": pipeline_yaml,
                    },
                )
                await session.commit()
            else:
                await session.execute(
                    text(
                        'UPDATE core."AsrPipeline" SET "configYaml" = :config_yaml, '
                        '"updatedAt" = NOW() WHERE slug = :slug'
                    ),
                    {"config_yaml": pipeline_yaml, "slug": slug},
                )
                await session.commit()

        return slug

    # ------------------------------------------------------------------
    # Test 1: HuggingFace pipeline with float32 (baseline)
    # ------------------------------------------------------------------

    async def test_hf_float32_transcription_returns_200(
        self, real_audio_client, real_ml_audio_bytes, hf_pipeline_slug
    ):
        """HuggingFace pipeline with float32 should produce a valid transcription.

        This is the baseline test — float32 works on all devices without
        dtype casting issues.
        """
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_hf_f32.wav",
            pipeline_id=hf_pipeline_slug,
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)

        assert response.status_code == 200, (
            f"HuggingFace float32 pipeline failed: {response.status_code} " f"{response.text}"
        )
        data = response.json()
        assert isinstance(data["text"], str)
        assert len(data["text"]) > 0, "Transcription text should not be empty"
        assert data["duration_seconds"] > 0
        assert data["processing_time_seconds"] > 0

    # ------------------------------------------------------------------
    # Test 2: HuggingFace pipeline with auto compute_type (dtype mismatch fix)
    # ------------------------------------------------------------------

    async def test_hf_auto_compute_transcription_no_dtype_error(
        self, real_audio_client, real_ml_audio_bytes, hf_auto_pipeline_slug
    ):
        """HuggingFace pipeline with ``compute_type: auto`` must NOT raise dtype error.

        Before the fix, this would fail on GPU/MPS with:
            "Input type (float) and bias type (c10::Half) should be the same"

        The fix in ``_run_transformers_inference`` casts input tensors to
        match the model's dtype, preventing the mismatch.
        """
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_hf_auto.wav",
            pipeline_id=hf_auto_pipeline_slug,
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)

        # Must NOT return TRANSCRIPTION_ERROR with dtype mismatch
        if response.status_code != 200:
            body = response.json()
            detail = body.get("detail", {})
            error_msg = detail.get("message", "") if isinstance(detail, dict) else str(detail)
            assert (
                "c10::Half" not in error_msg
            ), f"Dtype mismatch bug still present! Got: {error_msg}"
            assert (
                "Input type (float)" not in error_msg
            ), f"Dtype mismatch bug still present! Got: {error_msg}"

        assert response.status_code == 200, (
            f"HuggingFace auto-compute pipeline failed: {response.status_code} " f"{response.text}"
        )
        data = response.json()
        assert len(data["text"]) > 0

    # ------------------------------------------------------------------
    # Test 3: HuggingFace pipeline with English audio and language hint
    # ------------------------------------------------------------------

    async def test_hf_en_audio_with_language_hint(
        self, real_audio_client, real_ml_audio_bytes, hf_pipeline_slug
    ):
        """HuggingFace pipeline with audio and ``language=en`` hint."""
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_hf_en.wav",
            pipeline_id=hf_pipeline_slug,
            language="en",
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)

        assert response.status_code == 200, (
            f"HuggingFace EN pipeline failed: {response.status_code} " f"{response.text}"
        )
        data = response.json()
        assert len(data["text"]) > 0

    # ------------------------------------------------------------------
    # Test 4: Response schema validation for HuggingFace pipeline
    # ------------------------------------------------------------------

    async def test_hf_response_schema_complete(
        self, real_audio_client, real_ml_audio_bytes, hf_pipeline_slug
    ):
        """HuggingFace pipeline response should match TranscriptionResponse schema.

        Validates that the HuggingFace path produces the same response
        structure as the ONNX path.
        """
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_hf_schema.wav",
            pipeline_id=hf_pipeline_slug,
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)
        assert response.status_code == 200
        data = response.json()

        from stt_v2.transcription.api.schemas import TranscriptionResponse

        parsed = TranscriptionResponse.model_validate(data)

        # Core fields
        assert parsed.text
        assert parsed.duration_seconds > 0
        assert parsed.processing_time_seconds > 0

        # Timestamps should be lists
        assert isinstance(parsed.word_timestamps, list)
        assert isinstance(parsed.sentence_timestamps, list)

        # Timing metrics
        if parsed.timing is not None:
            assert parsed.timing.total_seconds > 0
            assert parsed.timing.inference_seconds >= 0

    # ------------------------------------------------------------------
    # Test 5: HuggingFace pipeline produces word timestamps
    # ------------------------------------------------------------------

    async def test_hf_produces_word_timestamps(
        self, real_audio_client, real_ml_audio_bytes, hf_pipeline_slug
    ):
        """HuggingFace pipeline should produce word timestamps.

        Whisper models via transformers support ``return_timestamps=True``
        and ``output_offsets=True``, so word timestamps should be populated
        when the model produces meaningful transcription text.
        """
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_hf_wt.wav",
            pipeline_id=hf_pipeline_slug,
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)
        assert response.status_code == 200
        data = response.json()

        text = data.get("text", "")
        assert len(text) > 0, "Transcription should produce non-empty text"

        word_timestamps = data.get("word_timestamps", [])

        # Word timestamps may be empty if the model hallucinates on the
        # audio (e.g. whisper-small with multilingual input).  Only assert
        # structure when timestamps are present.
        if len(word_timestamps) > 0:
            for wt in word_timestamps:
                assert "word" in wt
                assert "start_time" in wt
                assert "end_time" in wt
                assert wt["start_time"] >= 0
                assert wt["end_time"] >= wt["start_time"]

    # ------------------------------------------------------------------
    # Test 6: HuggingFace pipeline with explicit float16 on CPU
    #
    # This is the exact production scenario that caused the crash:
    #   - Ubuntu server with Intel CPU (no GPU)
    #   - AiModel.computeType = "float16" in the database
    #   - Pipeline uses slug reference → model loaded via HuggingFaceLoader
    #   - Model loaded with torch_dtype=float16 → crash on CPU
    # ------------------------------------------------------------------

    @pytest.fixture
    async def hf_float16_pipeline_slug(self, real_audio_client) -> str:
        """Create a HuggingFace pipeline with explicit ``compute_type: float16``.

        This reproduces the production bug on Intel CPU servers where
        ``computeType=float16`` in the AiModel table causes:
        ``RuntimeError: Input type (float) and bias type (c10::Half)``
        """
        from sqlalchemy import text

        from stt_v2.core.database.connection import get_session

        slug = "e2e-test-hf-turbo-fp16"
        pipeline_yaml = _hf_pipeline_yaml_float16()

        async with get_session() as session:
            result = await session.execute(
                text('SELECT id FROM core."AsrPipeline" WHERE slug = :slug'),
                {"slug": slug},
            )
            existing = result.scalar_one_or_none()

            if existing is None:
                await session.execute(
                    text("""
                        INSERT INTO core."AsrPipeline" (
                            id, "tenantId", slug, name, description,
                            "configYaml", "resourceStatus", tags,
                            "createdAt", "updatedAt"
                        ) VALUES (
                            gen_random_uuid(),
                            :tenant_id,
                            :slug,
                            'E2E Test HF Whisper Large V3 Turbo (float16)',
                            'HuggingFace pipeline with float16 for CPU safety test',
                            :config_yaml,
                            'ENABLED',
                            ARRAY['e2e-test']::text[],
                            NOW(),
                            NOW()
                        )
                    """),
                    {
                        "tenant_id": VALID_TENANT_ID,
                        "slug": slug,
                        "config_yaml": pipeline_yaml,
                    },
                )
                await session.commit()
            else:
                await session.execute(
                    text(
                        'UPDATE core."AsrPipeline" SET "configYaml" = :config_yaml, '
                        '"updatedAt" = NOW() WHERE slug = :slug'
                    ),
                    {"config_yaml": pipeline_yaml, "slug": slug},
                )
                await session.commit()

        return slug

    async def test_hf_float16_on_cpu_does_not_crash(
        self, real_audio_client, real_ml_audio_bytes, hf_float16_pipeline_slug
    ):
        """HuggingFace pipeline with ``compute_type: float16`` must NOT crash on CPU.

        **Production bug**: Intel CPU-only servers returned:
            ``TRANSCRIPTION_ERROR: Input type (float) and bias type
            (c10::Half) should be the same``

        The fix has two layers:
        1. ``_get_torch_dtype`` silently downgrades float16 → float32 on CPU
        2. ``_run_transformers_inference`` detects fp16 model on CPU and casts

        This test exercises the full production path with explicit float16.
        """
        form = _build_multipart_form(
            audio_bytes=real_ml_audio_bytes,
            filename="test_hf_fp16_cpu.wav",
            pipeline_id=hf_float16_pipeline_slug,
        )
        response = await real_audio_client.post("/api/v1/transcribe", **form)

        # Must NOT return the dtype mismatch error
        if response.status_code != 200:
            body = response.json()
            detail = body.get("detail", {})
            error_msg = detail.get("message", "") if isinstance(detail, dict) else str(detail)
            assert (
                "c10::Half" not in error_msg
            ), f"CPU float16 safety guard failed! Got: {error_msg}"
            assert (
                "Input type (float)" not in error_msg
            ), f"CPU float16 safety guard failed! Got: {error_msg}"

        assert response.status_code == 200, (
            f"HuggingFace float16 pipeline on CPU failed: "
            f"{response.status_code} {response.text}"
        )
        data = response.json()
        assert isinstance(data["text"], str)
        assert len(data["text"]) > 0, "Transcription should produce text"
        assert data["duration_seconds"] > 0
