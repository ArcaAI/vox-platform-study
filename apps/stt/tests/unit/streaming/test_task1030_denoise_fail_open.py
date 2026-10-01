"""TASK-1030 — a denoise engine that is not ready never breaks the ASR task.

Owner decision OD-2 (2026-10-01, reversing TASK-860 R-5): when the selected engine
cannot initialise — package missing, weights unavailable, checkpoint load failure,
or a library that names no engine — the session/job transcribes WITHOUT denoise.
The degrade is never silent: a WARNING, a ``stt_denoise_degraded_total`` counter
increment, and (on a streaming session) a ``denoise_degraded`` status frame.

DeepFilterNet3 reads its weights from the agent's bound row (``local_path``, the
models bucket). It must never fall back to ``df``'s own downloader.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from stt.pipeline.dto import DenoiseConfig


def _counter_value(engine: str, reason: str) -> float:
    from stt.core.metrics import STT_DENOISE_DEGRADED_TOTAL

    return STT_DENOISE_DEGRADED_TOTAL.labels(engine=engine, reason=reason)._value.get()


def _weights_dir(tmp_path: Path) -> Path:
    """The on-bucket layout `df.enhance.init_df(model_base_dir=…)` reads."""
    (tmp_path / "checkpoints").mkdir()
    (tmp_path / "config.ini").write_text("[train]\n")
    (tmp_path / "checkpoints" / "model_120.ckpt.best").write_bytes(b"x")
    return tmp_path


def _fake_df(init_return: object = None, init_side_effect: Exception | None = None) -> MagicMock:
    fake = MagicMock()
    if init_side_effect is not None:
        fake.enhance.init_df.side_effect = init_side_effect
    else:
        # The REAL 0.5.6 shape: (DfNet, DF, suffix) — three values, not four.
        fake.enhance.init_df.return_value = init_return or (
            MagicMock(),
            MagicMock(),
            "DeepFilterNet3",
        )
    return fake


# ---------------------------------------------------------------------------
# DeepFilterNet3StreamingDenoiser
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestDeepFilterNet3LoadsFromTheBucket:
    def test_initialises_from_the_given_weights_dir_with_the_real_three_tuple(self, tmp_path):
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        weights = _weights_dir(tmp_path)
        fake = _fake_df()
        denoiser = DeepFilterNet3StreamingDenoiser(
            input_sr=16000, strength=1.0, model_dir=str(weights)
        )
        with patch.dict(sys.modules, {"df": fake, "df.enhance": fake.enhance}):
            assert denoiser.initialize() is True

        assert denoiser.is_available is True
        assert denoiser.degraded is None
        kwargs = fake.enhance.init_df.call_args.kwargs
        assert kwargs["model_base_dir"] == str(weights)
        # `init_df` writes `enhance.log` INTO the weights dir by default — never into the bucket.
        assert kwargs["log_file"] is None

    def test_no_weights_dir_degrades_and_never_downloads(self):
        """`init_df()` without `model_base_dir` downloads from GitHub — never at session time."""
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        fake = _fake_df()
        before = _counter_value("deepfilternet3", "weights_unavailable")
        denoiser = DeepFilterNet3StreamingDenoiser(input_sr=16000, strength=1.0, model_dir=None)
        with patch.dict(sys.modules, {"df": fake, "df.enhance": fake.enhance}):
            assert denoiser.initialize() is False

        fake.enhance.init_df.assert_not_called()
        assert denoiser.degraded is not None and denoiser.degraded.reason == "weights_unavailable"
        assert _counter_value("deepfilternet3", "weights_unavailable") == before + 1

    def test_a_weights_dir_without_the_checkpoint_degrades(self, tmp_path):
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        (tmp_path / "config.ini").write_text("[train]\n")  # no checkpoints/
        fake = _fake_df()
        denoiser = DeepFilterNet3StreamingDenoiser(
            input_sr=16000, strength=1.0, model_dir=str(tmp_path)
        )
        with patch.dict(sys.modules, {"df": fake, "df.enhance": fake.enhance}):
            assert denoiser.initialize() is False

        fake.enhance.init_df.assert_not_called()
        assert denoiser.degraded.reason == "weights_unavailable"

    def test_missing_package_degrades_instead_of_raising(self, tmp_path):
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        before = _counter_value("deepfilternet3", "package_missing")
        denoiser = DeepFilterNet3StreamingDenoiser(
            input_sr=16000, strength=1.0, model_dir=str(_weights_dir(tmp_path))
        )
        with patch.dict(sys.modules, {"df": None, "df.enhance": None}):
            assert denoiser.initialize() is False

        assert denoiser.is_available is False
        assert denoiser.degraded.reason == "package_missing"
        assert _counter_value("deepfilternet3", "package_missing") == before + 1

    def test_checkpoint_load_failure_degrades_instead_of_raising(self, tmp_path):
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        fake = _fake_df(init_side_effect=RuntimeError("bad checkpoint"))
        denoiser = DeepFilterNet3StreamingDenoiser(
            input_sr=16000, strength=1.0, model_dir=str(_weights_dir(tmp_path))
        )
        with patch.dict(sys.modules, {"df": fake, "df.enhance": fake.enhance}):
            assert denoiser.initialize() is False

        assert denoiser.degraded.reason == "init_failed"
        assert "bad checkpoint" in denoiser.degraded.detail

    def test_an_enhance_failure_mid_stream_is_reported_once_and_audio_flows(self):
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        denoiser = DeepFilterNet3StreamingDenoiser(input_sr=16000, strength=1.0, model_dir="/w")
        denoiser._available = True
        denoiser._model = MagicMock()
        denoiser._df_state = MagicMock()
        before = _counter_value("deepfilternet3", "enhance_failed")
        block = np.random.randn(denoiser._block_samples_in).astype(np.float32) * 0.1

        with patch.dict(sys.modules, {"df": None, "df.enhance": None}):  # enhance() raises
            first = denoiser.process(block)
            second = denoiser.process(block)

        np.testing.assert_array_equal(first, block)
        np.testing.assert_array_equal(second, block)
        assert _counter_value("deepfilternet3", "enhance_failed") == before + 1


# ---------------------------------------------------------------------------
# RNNoise — its degrade was already graceful; it is now REPORTED
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestRnnoiseDegradeIsReported:
    def test_missing_pyrnnoise_is_reported(self):
        from stt.streaming.denoiser import StreamingDenoiser

        before = _counter_value("rnnoise", "package_missing")
        denoiser = StreamingDenoiser(input_sr=16000, strength=1.0)
        with patch.dict(sys.modules, {"pyrnnoise": None}):
            assert denoiser.initialize() is False

        assert denoiser.degraded is not None and denoiser.degraded.reason == "package_missing"
        assert _counter_value("rnnoise", "package_missing") == before + 1

    def test_a_working_pyrnnoise_is_not_degraded(self):
        from stt.streaming.denoiser import StreamingDenoiser

        fake = MagicMock()
        denoiser = StreamingDenoiser(input_sr=16000, strength=1.0)
        with patch.dict(sys.modules, {"pyrnnoise": fake}):
            assert denoiser.initialize() is True
        assert denoiser.degraded is None


# ---------------------------------------------------------------------------
# The one selection rule both paths share
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestBuildStreamingDenoiser:
    def test_disabled_denoise_builds_nothing_and_reports_nothing(self):
        from stt.streaming.denoise_selection import build_streaming_denoiser

        denoiser, degraded = build_streaming_denoiser(DenoiseConfig(enabled=False), input_sr=16000)
        assert denoiser is None and degraded is None

    def test_deepfilternet3_gets_the_bound_weights_dir(self):
        from stt.streaming.denoise_selection import build_streaming_denoiser

        cfg = DenoiseConfig(
            enabled=True, strength=0.8, engine="deepfilternet3", model_path="/mnt/w/dfn3"
        )
        with patch("stt.streaming.denoise_selection.DeepFilterNet3StreamingDenoiser") as cls:
            cls.return_value.initialize.return_value = True
            denoiser, degraded = build_streaming_denoiser(cfg, input_sr=16000)

        cls.assert_called_once_with(input_sr=16000, strength=0.8, model_dir="/mnt/w/dfn3")
        assert denoiser is cls.return_value and degraded is None

    def test_an_engine_that_cannot_initialise_yields_no_denoiser_and_its_degrade(self):
        from stt.streaming.denoise_selection import build_streaming_denoiser

        cfg = DenoiseConfig(enabled=True, engine="deepfilternet3", model_path=None)
        with patch("stt.streaming.denoise_selection.DeepFilterNet3StreamingDenoiser") as cls:
            cls.return_value.initialize.return_value = False
            cls.return_value.degraded = MagicMock(reason="weights_unavailable")
            denoiser, degraded = build_streaming_denoiser(cfg, input_sr=16000)

        assert denoiser is None
        assert degraded.reason == "weights_unavailable"

    def test_an_engine_this_runtime_does_not_know_runs_nothing_and_is_reported(self):
        """Never RNNoise in place of an engine the admin bound — no denoise, reported."""
        from stt.streaming.denoise_selection import build_streaming_denoiser

        before = _counter_value("unknown:speechbrain", "unknown_engine")
        cfg = DenoiseConfig(enabled=True, engine="unknown:speechbrain")
        with (
            patch("stt.streaming.denoise_selection.StreamingDenoiser") as rnnoise,
            patch("stt.streaming.denoise_selection.DeepFilterNet3StreamingDenoiser") as dfn,
        ):
            denoiser, degraded = build_streaming_denoiser(cfg, input_sr=16000)

        rnnoise.assert_not_called()
        dfn.assert_not_called()
        assert denoiser is None and degraded.reason == "unknown_engine"
        assert _counter_value("unknown:speechbrain", "unknown_engine") == before + 1


# ---------------------------------------------------------------------------
# Spec mapping — the bound row's weights reach DenoiseConfig; no refusal
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestSpecCarriesTheDenoiseWeights:
    def test_local_path_of_the_bound_row_becomes_model_path(self):
        from tests.unit.test_task977_per_agent_front_end import (
            DEEPFILTERNET3_ROW,
            _denoise_config,
            _wire,
        )

        row = {**DEEPFILTERNET3_ROW, "localPath": "/mnt/models-bucket/deepfilternet3/v1"}
        config = _denoise_config(_wire(row=row))

        assert config.engine == "deepfilternet3"
        assert config.model_path == "/mnt/models-bucket/deepfilternet3/v1"

    def test_a_library_that_names_no_engine_no_longer_refuses_the_spec(self):
        from tests.unit.test_task977_per_agent_front_end import (
            DEEPFILTERNET3_ROW,
            _denoise_config,
            _wire,
        )

        config = _denoise_config(_wire(row={**DEEPFILTERNET3_ROW, "libraryName": "speechbrain"}))

        assert config.engine == "unknown:speechbrain"


# ---------------------------------------------------------------------------
# Batch path — same rule: the job completes, the degrade is recorded
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestBatchDeepFilterNet3:
    @pytest.mark.asyncio
    async def test_batch_uses_the_bound_weights_and_the_real_three_tuple(self, tmp_path):
        from stt.transcription.preprocessing import AudioPreprocessor

        weights = _weights_dir(tmp_path)
        fake = _fake_df()
        import torch

        fake.enhance.enhance.return_value = torch.zeros(1, 48000)
        samples = np.random.randn(16000).astype(np.float32) * 0.1
        # Import the resampler's native modules BEFORE patching: `patch.dict` restores the
        # whole of `sys.modules` on exit, and re-importing a native extension it dropped
        # aborts the interpreter later in the run.
        AudioPreprocessor()._resample(samples, 16000, 48000)
        with patch.dict(sys.modules, {"df": fake, "df.enhance": fake.enhance}):
            out, sr = await AudioPreprocessor()._apply_denoise_deepfilternet3(
                samples, 16000, 1.0, model_dir=str(weights)
            )

        assert sr == 48000
        assert fake.enhance.init_df.call_args.kwargs["model_base_dir"] == str(weights)
        assert fake.enhance.init_df.call_args.kwargs["log_file"] is None

    @pytest.mark.asyncio
    async def test_batch_without_weights_returns_the_original_audio_and_reports(self):
        from stt.transcription.preprocessing import AudioPreprocessor

        fake = _fake_df()
        before = _counter_value("deepfilternet3", "weights_unavailable")
        samples = np.random.randn(16000).astype(np.float32) * 0.1
        with patch.dict(sys.modules, {"df": fake, "df.enhance": fake.enhance}):
            out, sr = await AudioPreprocessor()._apply_denoise_deepfilternet3(
                samples, 16000, 1.0, model_dir=None
            )

        fake.enhance.init_df.assert_not_called()
        np.testing.assert_array_equal(out, samples)
        assert sr == 16000
        assert _counter_value("deepfilternet3", "weights_unavailable") == before + 1


# ---------------------------------------------------------------------------
# Health — engine status is VISIBLE, never a readiness gate
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestDenoiseEngineStatus:
    def test_reports_each_engine_by_package_presence(self):
        from stt.streaming.denoise_selection import denoise_engine_status

        with patch.dict(sys.modules, {"pyrnnoise": MagicMock(), "df": None, "df.enhance": None}):
            status = denoise_engine_status()

        assert status["rnnoise"]["status"] == "ok"
        assert status["deepfilternet3"]["status"] == "unavailable"
        assert "package" in status["deepfilternet3"]["detail"]
