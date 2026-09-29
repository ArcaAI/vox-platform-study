"""
Tests for the HuggingFace (Transformers) inference path.

These tests cover the non-ONNX inference path that uses
``_run_transformers_inference`` in ``batch_service.py``.  This path is
exercised when the resolved ASR model's engine is ``transformers`` (or
the model format resolves to SAFETENSOR/PYTORCH).

**Why this file exists:**
A production bug (dtype mismatch: "Input type (float) and bias type
(c10::Half) should be the same") was found in the HuggingFace path when
running on GPU/MPS with float16 models.  These tests ensure:

1. The dtype casting fix in ``_run_transformers_inference`` prevents the
   float16/float32 mismatch error.
2. Different ``compute_type`` values (auto, float32, float16) are handled
   correctly.
3. The ``_get_device`` method is never called with a compute_type string
   (e.g. "float16") — it should always receive "auto" or a device name.

Requires:
    - ML deps installed (torch, transformers, etc.) for the loader checks

TASK-1006 — the end-to-end class that drove this path through the removed
``POST /api/v1/transcribe`` route (a DB-seeded pipeline) was deleted with it.

Run:
    TEST_PLATFORM=all pytest tests/e2e/test_huggingface_pipeline.py -v -s

Markers:
    @pytest.mark.e2e    — all tests in this file
    @pytest.mark.ml     — tests that require ML dependencies
"""

from __future__ import annotations

import pytest

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
        from stt.models.base_loader import BaseModelLoader

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

        from stt.models.base_loader import BaseModelLoader

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

        from stt.models.huggingface_loader import HuggingFaceLoader

        source = inspect.getsource(HuggingFaceLoader.load)
        # The fix changed: _get_device(model_config.compute_type or "auto")
        # to: _get_device(requested_device) where requested_device = model_config.device or "auto"
        assert (
            "_get_device(requested_device)" in source or '_get_device("auto")' in source
        ), "HuggingFaceLoader.load() should call _get_device with device (not compute_type)"

    def test_onnx_loader_uses_auto_device(self):
        """ONNXLoader._load_with_optimum() should call _get_device('auto')."""
        import inspect

        from stt.models.onnx_loader import ONNXLoader

        source = inspect.getsource(ONNXLoader._load_with_optimum)
        assert '_get_device("auto")' in source, (
            "ONNXLoader._load_with_optimum() should call _get_device('auto'), "
            "not _get_device(model_config.compute_type)"
        )

    def test_nemo_loader_uses_auto_device(self):
        """NeMoLoader.load() should call _get_device('auto')."""
        import inspect

        from stt.models.nemo_loader import NeMoLoader

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

        from stt.transcription.batch_service import BatchTranscriptionService

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

        from stt.models.base_loader import BaseModelLoader

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

        from stt.transcription.batch_service import BatchTranscriptionService

        source = inspect.getsource(BatchTranscriptionService._run_transformers_inference)
        assert (
            "asr_model.float()" in source or "asr_model = asr_model.float()" in source
        ), "_run_transformers_inference must cast fp16 model to float32"
        assert (
            '"cpu"' in source and '"mps"' in source
        ), "_run_transformers_inference must guard against fp16 on both CPU and MPS"


# ============================================================================
# compute_type default
# ============================================================================


@pytest.mark.e2e
class TestComputeTypeDefaults:
    """Verify that the DTO uses a safe default for compute_type."""

    def test_inference_config_default_is_auto(self):
        """InferenceConfig.compute_type should default to 'auto', not 'float16'.

        The old default of 'float16' caused dtype mismatches on CPU where
        float16 is emulated and slower.
        """
        from stt.pipeline.dto import InferenceConfig

        config = InferenceConfig()
        assert config.compute_type == "auto", (
            f"InferenceConfig.compute_type should default to 'auto', "
            f"got '{config.compute_type}'"
        )
