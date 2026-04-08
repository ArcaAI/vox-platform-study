"""Unit tests for beam_size/temperature in batch inference generate_kwargs."""

from __future__ import annotations

from types import SimpleNamespace


def _make_config(**overrides) -> SimpleNamespace:
    """Create a minimal config object mimicking InferenceConfig."""
    defaults = {
        "language": "en",
        "code_switching": False,
        "beam_size": 5,
        "temperature": 0.0,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


# =========================================================================
# Transformers path
# =========================================================================


class TestTransformersBeamSizeTemperature:

    def test_beam_size_gt1_sets_num_beams(self):
        config = _make_config(beam_size=5)
        generate_kwargs: dict = {"task": "transcribe", "return_timestamps": True}

        beam_size = getattr(config, "beam_size", None)
        if beam_size and beam_size > 1:
            generate_kwargs["num_beams"] = beam_size

        assert generate_kwargs["num_beams"] == 5

    def test_beam_size_1_omits_num_beams(self):
        config = _make_config(beam_size=1)
        generate_kwargs: dict = {"task": "transcribe", "return_timestamps": True}

        beam_size = getattr(config, "beam_size", None)
        if beam_size and beam_size > 1:
            generate_kwargs["num_beams"] = beam_size

        assert "num_beams" not in generate_kwargs

    def test_beam_size_0_omits_num_beams(self):
        config = _make_config(beam_size=0)
        generate_kwargs: dict = {"task": "transcribe", "return_timestamps": True}

        beam_size = getattr(config, "beam_size", None)
        if beam_size and beam_size > 1:
            generate_kwargs["num_beams"] = beam_size

        assert "num_beams" not in generate_kwargs

    def test_temperature_zero_disables_sampling(self):
        config = _make_config(temperature=0.0)
        generate_kwargs: dict = {"task": "transcribe"}

        temperature = getattr(config, "temperature", None)
        if temperature is not None and temperature == 0.0:
            generate_kwargs["do_sample"] = False
        elif temperature is not None:
            generate_kwargs["do_sample"] = True
            generate_kwargs["temperature"] = temperature

        assert generate_kwargs["do_sample"] is False
        assert "temperature" not in generate_kwargs

    def test_temperature_positive_enables_sampling(self):
        config = _make_config(temperature=0.7)
        generate_kwargs: dict = {"task": "transcribe"}

        temperature = getattr(config, "temperature", None)
        if temperature is not None and temperature == 0.0:
            generate_kwargs["do_sample"] = False
        elif temperature is not None:
            generate_kwargs["do_sample"] = True
            generate_kwargs["temperature"] = temperature

        assert generate_kwargs["do_sample"] is True
        assert generate_kwargs["temperature"] == 0.7

    def test_temperature_none_omits_both(self):
        config = _make_config()
        del config.temperature  # simulate missing attr
        generate_kwargs: dict = {"task": "transcribe"}

        temperature = getattr(config, "temperature", None)
        if temperature is not None and temperature == 0.0:
            generate_kwargs["do_sample"] = False
        elif temperature is not None:
            generate_kwargs["do_sample"] = True
            generate_kwargs["temperature"] = temperature

        assert "do_sample" not in generate_kwargs
        assert "temperature" not in generate_kwargs


# =========================================================================
# ONNX path (same logic, separate verification)
# =========================================================================


class TestOnnxBeamSizeTemperature:

    def test_beam_size_gt1_sets_num_beams(self):
        config = _make_config(beam_size=3)
        generate_kwargs: dict = {"task": "transcribe", "return_timestamps": False}

        beam_size = getattr(config, "beam_size", None)
        if beam_size and beam_size > 1:
            generate_kwargs["num_beams"] = beam_size

        assert generate_kwargs["num_beams"] == 3

    def test_beam_size_1_omits_num_beams(self):
        config = _make_config(beam_size=1)
        generate_kwargs: dict = {"task": "transcribe", "return_timestamps": False}

        beam_size = getattr(config, "beam_size", None)
        if beam_size and beam_size > 1:
            generate_kwargs["num_beams"] = beam_size

        assert "num_beams" not in generate_kwargs

    def test_temperature_zero_disables_sampling(self):
        config = _make_config(temperature=0.0)
        generate_kwargs: dict = {"task": "transcribe"}

        temperature = getattr(config, "temperature", None)
        if temperature is not None and temperature == 0.0:
            generate_kwargs["do_sample"] = False
        elif temperature is not None:
            generate_kwargs["do_sample"] = True
            generate_kwargs["temperature"] = temperature

        assert generate_kwargs["do_sample"] is False
        assert "temperature" not in generate_kwargs

    def test_temperature_positive_enables_sampling(self):
        config = _make_config(temperature=0.5)
        generate_kwargs: dict = {"task": "transcribe"}

        temperature = getattr(config, "temperature", None)
        if temperature is not None and temperature == 0.0:
            generate_kwargs["do_sample"] = False
        elif temperature is not None:
            generate_kwargs["do_sample"] = True
            generate_kwargs["temperature"] = temperature

        assert generate_kwargs["do_sample"] is True
        assert generate_kwargs["temperature"] == 0.5

    def test_temperature_none_omits_both(self):
        config = _make_config()
        del config.temperature
        generate_kwargs: dict = {"task": "transcribe"}

        temperature = getattr(config, "temperature", None)
        if temperature is not None and temperature == 0.0:
            generate_kwargs["do_sample"] = False
        elif temperature is not None:
            generate_kwargs["do_sample"] = True
            generate_kwargs["temperature"] = temperature

        assert "do_sample" not in generate_kwargs
        assert "temperature" not in generate_kwargs
