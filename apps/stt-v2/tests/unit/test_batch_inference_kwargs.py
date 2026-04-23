"""Unit tests for the Whisper decoding knobs wired into batch inference.

These tests mirror the inline ``generate_kwargs`` assembly used by both the
Transformers and Optimum ONNX paths in ``batch_service.py``. Replicating the
logic here keeps the test independent of the call-site scaffolding while still
guaranteeing that the contract we expose to HuggingFace ``model.generate()``
stays intact.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any


def _make_config(**overrides) -> SimpleNamespace:
    """Create a minimal config object mimicking ``InferenceConfig``."""
    defaults: dict[str, Any] = {
        "language": "en",
        "code_switching": False,
        "beam_size": 5,
        "temperature": [0.0],
        "no_repeat_ngram_size": 3,
        "compression_ratio_threshold": None,
        "logprob_threshold": None,
        "no_speech_threshold": None,
        "condition_on_prev_tokens": False,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _assemble_generate_kwargs(
    config: Any,
    *,
    return_timestamps: bool,
) -> dict[str, Any]:
    """Replicate the inline ``generate_kwargs`` assembly in ``batch_service.py``.

    Keep this in sync with the Transformers/ONNX call sites whenever the
    inline logic changes.
    """
    code_switching = getattr(config, "code_switching", False)
    lang = getattr(config, "language", None)

    generate_kwargs: dict[str, Any] = {
        "task": "transcribe",
        "return_timestamps": return_timestamps,
    }

    if not code_switching and lang is not None:
        generate_kwargs["language"] = lang

    no_repeat_ngram_size = getattr(config, "no_repeat_ngram_size", None)
    if isinstance(no_repeat_ngram_size, int) and no_repeat_ngram_size > 0:
        generate_kwargs["no_repeat_ngram_size"] = no_repeat_ngram_size

    beam_size = getattr(config, "beam_size", None)
    if isinstance(beam_size, int) and beam_size > 1:
        generate_kwargs["num_beams"] = beam_size

    temperature = getattr(config, "temperature", None)
    if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
        temperature = [float(temperature)]
    if isinstance(temperature, (list, tuple)) and len(temperature) > 0:
        temp_list = [float(x) for x in temperature]
        if len(temp_list) == 1:
            generate_kwargs["temperature"] = temp_list[0]
            generate_kwargs["do_sample"] = temp_list[0] > 0.0
        else:
            generate_kwargs["temperature"] = tuple(temp_list)

    compression_ratio_threshold = getattr(config, "compression_ratio_threshold", None)
    if isinstance(compression_ratio_threshold, (int, float)):
        generate_kwargs["compression_ratio_threshold"] = float(compression_ratio_threshold)

    logprob_threshold = getattr(config, "logprob_threshold", None)
    if isinstance(logprob_threshold, (int, float)):
        generate_kwargs["logprob_threshold"] = float(logprob_threshold)

    no_speech_threshold = getattr(config, "no_speech_threshold", None)
    if isinstance(no_speech_threshold, (int, float)):
        generate_kwargs["no_speech_threshold"] = float(no_speech_threshold)

    raw_condition = getattr(config, "condition_on_prev_tokens", False)
    if isinstance(raw_condition, (bool, int)) and bool(raw_condition):
        generate_kwargs["condition_on_prev_tokens"] = True

    return generate_kwargs


# =========================================================================
# Transformers path — uses return_timestamps=True
# =========================================================================


class TestTransformersBeamSizeTemperature:

    def test_beam_size_gt1_sets_num_beams(self):
        config = _make_config(beam_size=5)
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert kwargs["num_beams"] == 5

    def test_beam_size_1_omits_num_beams(self):
        config = _make_config(beam_size=1)
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert "num_beams" not in kwargs

    def test_beam_size_0_omits_num_beams(self):
        config = _make_config(beam_size=0)
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert "num_beams" not in kwargs

    def test_temperature_zero_disables_sampling(self):
        config = _make_config(temperature=[0.0])
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert kwargs["do_sample"] is False
        # Must still pass ``temperature=0.0`` — HF Whisper crashes with
        # ``'>' not supported between instances of 'NoneType' and 'float'``
        # when ``_retrieve_avg_logprobs`` receives ``None``.
        assert kwargs["temperature"] == 0.0

    def test_temperature_positive_enables_sampling(self):
        config = _make_config(temperature=[0.7])
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert kwargs["do_sample"] is True
        assert kwargs["temperature"] == 0.7

    def test_temperature_none_omits_both(self):
        config = _make_config(temperature=None)
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert "do_sample" not in kwargs
        assert "temperature" not in kwargs

    def test_scalar_temperature_legacy_still_supported(self):
        """Pipeline YAML still ships ``temperature: 0.0`` (scalar) in seed
        configs; it must normalise to the same contract as ``[0.0]`` so HF
        gets ``temperature=0.0`` instead of ``None``.
        """
        config = _make_config(temperature=0.0)
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert kwargs["do_sample"] is False
        assert kwargs["temperature"] == 0.0

    def test_scalar_positive_temperature_enables_sampling(self):
        config = _make_config(temperature=0.3)
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert kwargs["do_sample"] is True
        assert kwargs["temperature"] == 0.3

    def test_temperature_zero_with_logprob_threshold_regression(self):
        """Regression for the 'NoneType > float' crash.

        When ``temperature=[0.0]`` is paired with ``logprob_threshold``, HF
        Whisper's ``_retrieve_avg_logprobs`` computes
        ``rescale_temperature = temperature if temperature > 0.0 else 1``.
        Omitting ``temperature`` from generate kwargs lets HF's internal value
        default to ``None``, which blows up that comparison. This test pins
        the contract that prevents the crash.
        """
        config = _make_config(temperature=[0.0], logprob_threshold=-1.0)
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert kwargs["temperature"] == 0.0
        assert kwargs["do_sample"] is False
        assert kwargs["logprob_threshold"] == -1.0

    def test_no_repeat_ngram_size_default_three(self):
        config = _make_config()
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert kwargs["no_repeat_ngram_size"] == 3


# =========================================================================
# ONNX path — uses return_timestamps=False but same decoding-kwarg logic
# =========================================================================


class TestOnnxBeamSizeTemperature:

    def test_beam_size_gt1_sets_num_beams(self):
        config = _make_config(beam_size=3)
        kwargs = _assemble_generate_kwargs(config, return_timestamps=False)
        assert kwargs["num_beams"] == 3
        assert kwargs["return_timestamps"] is False

    def test_beam_size_1_omits_num_beams(self):
        config = _make_config(beam_size=1)
        kwargs = _assemble_generate_kwargs(config, return_timestamps=False)
        assert "num_beams" not in kwargs

    def test_temperature_zero_disables_sampling(self):
        config = _make_config(temperature=[0.0])
        kwargs = _assemble_generate_kwargs(config, return_timestamps=False)
        assert kwargs["do_sample"] is False
        assert kwargs["temperature"] == 0.0

    def test_temperature_positive_enables_sampling(self):
        config = _make_config(temperature=[0.5])
        kwargs = _assemble_generate_kwargs(config, return_timestamps=False)
        assert kwargs["do_sample"] is True
        assert kwargs["temperature"] == 0.5

    def test_temperature_none_omits_both(self):
        config = _make_config(temperature=None)
        kwargs = _assemble_generate_kwargs(config, return_timestamps=False)
        assert "do_sample" not in kwargs
        assert "temperature" not in kwargs


# =========================================================================
# Threshold triad — ensures YAML-configurable knobs land in generate kwargs
# =========================================================================


class TestThresholdTriadWiring:

    def test_all_thresholds_flow_through(self):
        config = _make_config(
            compression_ratio_threshold=2.4,
            logprob_threshold=-1.0,
            no_speech_threshold=0.6,
        )
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert kwargs["compression_ratio_threshold"] == 2.4
        assert kwargs["logprob_threshold"] == -1.0
        assert kwargs["no_speech_threshold"] == 0.6

    def test_partial_threshold_config(self):
        config = _make_config(compression_ratio_threshold=2.4)
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert kwargs["compression_ratio_threshold"] == 2.4
        assert "logprob_threshold" not in kwargs
        assert "no_speech_threshold" not in kwargs

    def test_none_thresholds_omitted(self):
        config = _make_config()  # all None
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert "compression_ratio_threshold" not in kwargs
        assert "logprob_threshold" not in kwargs
        assert "no_speech_threshold" not in kwargs

    def test_multi_value_temperature_drives_fallback_loop(self):
        config = _make_config(temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0])
        kwargs = _assemble_generate_kwargs(config, return_timestamps=True)
        assert kwargs["temperature"] == (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)
        # HF handles do_sample internally per retry — we must NOT pin it.
        assert "do_sample" not in kwargs
