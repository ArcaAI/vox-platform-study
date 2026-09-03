"""TDD tests for Prometheus metric definitions."""

from __future__ import annotations

from prometheus_client import REGISTRY, generate_latest

from tts.core import metrics as m


def test_metric_names() -> None:
    assert m.TTS_TTFA._name == "tts_ttfa_seconds"
    assert m.TTS_RTF._name == "tts_rtf"
    assert m.TTS_ACTIVE_STREAMS._name == "tts_active_streams"
    assert m.TTS_REQUESTS._name == "tts_requests"
    assert m.TTS_FAILOVER._name == "tts_failover"
    assert m.TTS_PROVIDER_ERRORS._name == "tts_provider_errors"


def test_metric_labels() -> None:
    assert m.TTS_TTFA._labelnames == ("provider", "locale")
    assert m.TTS_REQUESTS._labelnames == ("provider", "locale", "status")
    assert m.TTS_FAILOVER._labelnames == ("from_provider", "to_provider")
    assert m.TTS_PROVIDER_ERRORS._labelnames == ("provider", "type")


def test_counter_total_suffix_exposed() -> None:
    m.TTS_REQUESTS.labels(provider="x", locale="en-IN", status="ok").inc()
    out = generate_latest(REGISTRY).decode()
    assert "tts_requests_total" in out


class TestUsageMeteringMetrics:
    """TTS was the one service missing the standardized
    {service, model} pair (current-state-review; it also gets its
    own character/audio-second counters ("""

    def test_metric_names(self) -> None:
        # No `_total` in the base name — prometheus_client appends it at
        # export time (see test_exposed_with_total_suffix below).
        assert m.TTS_CHARACTERS_TOTAL._name == "tts_characters"
        assert m.TTS_SYNTHESIZED_SECONDS_TOTAL._name == "tts_synthesized_seconds"

    def test_exposed_with_total_suffix(self) -> None:
        m.TTS_CHARACTERS_TOTAL.labels(provider="x", locale="en-IN", status="ok").inc()
        m.TTS_SYNTHESIZED_SECONDS_TOTAL.labels(provider="x", locale="en-IN", status="ok").inc()
        out = generate_latest(REGISTRY).decode()
        assert "tts_characters_total" in out
        assert "tts_synthesized_seconds_total" in out

    def test_metric_labels(self) -> None:
        assert m.TTS_CHARACTERS_TOTAL._labelnames == ("provider", "locale", "status")
        assert m.TTS_SYNTHESIZED_SECONDS_TOTAL._labelnames == ("provider", "locale", "status")

    def test_counters_increment(self) -> None:
        labels = {"provider": "kokoro", "locale": "en-IN", "status": "ok"}
        before_chars = REGISTRY.get_sample_value("tts_characters_total", labels) or 0.0
        before_secs = REGISTRY.get_sample_value("tts_synthesized_seconds_total", labels) or 0.0

        m.TTS_CHARACTERS_TOTAL.labels(**labels).inc(12)
        m.TTS_SYNTHESIZED_SECONDS_TOTAL.labels(**labels).inc(1.5)

        assert REGISTRY.get_sample_value("tts_characters_total", labels) == before_chars + 12
        assert (
            REGISTRY.get_sample_value("tts_synthesized_seconds_total", labels) == before_secs + 1.5
        )


class TestCrossServiceModelPair:
    """Byte-identical to STT/TEXT/NLP/Guardrail — see stt/core/metrics.py."""

    def test_service_name(self) -> None:
        assert m.SERVICE_NAME == "tts"

    def test_metric_names_and_labels(self) -> None:
        assert m.MODEL_RUNNING_INSTANCES._name == "model_running_instances"
        assert m.MODEL_RUNNING_INSTANCES._labelnames == ("service", "model")
        assert m.MODEL_INFERENCE_LATENCY._name == "model_inference_latency_seconds"
        assert m.MODEL_INFERENCE_LATENCY._labelnames == ("service", "model")

    def test_track_model_inference_bumps_then_restores_and_observes(self) -> None:
        labels = {"service": "tts", "model": "kokoro"}
        before_gauge = REGISTRY.get_sample_value("model_running_instances", labels) or 0.0
        before_count = (
            REGISTRY.get_sample_value("model_inference_latency_seconds_count", labels) or 0.0
        )

        with m.track_model_inference("kokoro"):
            assert REGISTRY.get_sample_value("model_running_instances", labels) == before_gauge + 1

        assert REGISTRY.get_sample_value("model_running_instances", labels) == before_gauge
        assert (
            REGISTRY.get_sample_value("model_inference_latency_seconds_count", labels)
            == before_count + 1
        )

    def test_gauge_decremented_even_on_error(self) -> None:
        labels = {"service": "tts", "model": "azure"}
        before_gauge = REGISTRY.get_sample_value("model_running_instances", labels) or 0.0
        try:
            with m.track_model_inference("azure"):
                raise RuntimeError("boom")
        except RuntimeError:
            pass
        assert REGISTRY.get_sample_value("model_running_instances", labels) == before_gauge
