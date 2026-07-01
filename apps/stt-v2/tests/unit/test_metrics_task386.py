"""TASK-386 — tests proving the (previously dead) STT domain metrics and the
cross-service per-model metrics actually increment on their helper call-sites.

These exercise the public helpers in ``stt_v2.core.metrics`` directly (no model
load / no audio), which is exactly what the real code paths in
``batch_service`` / ``silero_service`` / ``session_manager`` / streaming
``inference`` now call.
"""

from __future__ import annotations

from prometheus_client import REGISTRY

from stt_v2.core import metrics as m


def _val(name: str, labels: dict[str, str] | None = None) -> float:
    """Read a single sample from the default registry, treating absent as 0.0."""
    return REGISTRY.get_sample_value(name, labels) or 0.0


class TestPerModelContractMetrics:
    """model_running_instances gauge + model_inference_latency_seconds histogram."""

    def test_track_model_inference_bumps_gauge_then_restores_and_observes(self):
        labels = {"service": "stt", "model": "whisper-large-v3-turbo"}
        before_gauge = _val("model_running_instances", labels)
        before_count = _val("model_inference_latency_seconds_count", labels)

        with m.track_model_inference("whisper-large-v3-turbo"):
            # gauge is incremented for the duration of the inference
            assert _val("model_running_instances", labels) == before_gauge + 1

        # gauge restored and exactly one latency observation recorded
        assert _val("model_running_instances", labels) == before_gauge
        assert _val("model_inference_latency_seconds_count", labels) == before_count + 1

    def test_track_model_inference_decrements_gauge_on_error(self):
        labels = {"service": "stt", "model": "silero-vad-v5"}
        before_gauge = _val("model_running_instances", labels)

        try:
            with m.track_model_inference("silero-vad-v5"):
                raise RuntimeError("boom")
        except RuntimeError:
            pass

        # gauge must not leak when the wrapped inference raises
        assert _val("model_running_instances", labels) == before_gauge


class TestTranscriptionMetrics:
    """stt_v2_transcription_* — the platform transcription-minutes signal."""

    def test_record_transcription_success_bumps_counter_latency_and_audio(self):
        total_labels = {
            "pipeline": "default",
            "engine": "faster_whisper",
            "status": "success",
        }
        lat_labels = {"pipeline": "default", "engine": "faster_whisper"}

        before_total = _val("stt_v2_transcription_total", total_labels)
        before_lat = _val("stt_v2_transcription_latency_seconds_count", lat_labels)
        before_audio_sum = _val("stt_v2_audio_duration_seconds_sum")

        m.record_transcription(
            pipeline="default",
            engine="faster_whisper",
            status="success",
            latency_seconds=3.2,
            audio_seconds=42.0,
        )

        assert _val("stt_v2_transcription_total", total_labels) == before_total + 1
        assert (
            _val("stt_v2_transcription_latency_seconds_count", lat_labels)
            == before_lat + 1
        )
        # _sum / 60 is the "transcription minutes" platform metric
        assert _val("stt_v2_audio_duration_seconds_sum") == before_audio_sum + 42.0

    def test_record_transcription_error_bumps_error_counter(self):
        labels = {"pipeline": "default", "error_type": "ValueError"}
        before = _val("stt_v2_transcription_errors_total", labels)

        m.record_transcription_error(pipeline="default", error_type="ValueError")

        assert _val("stt_v2_transcription_errors_total", labels) == before + 1


class TestStreamingMetrics:
    """stt_v2_streaming_* — active sessions gauge + per-utterance ASR latency."""

    def test_streaming_session_started_sets_gauge_and_counts(self):
        before_total = _val("stt_v2_streaming_sessions_total", {"status": "started"})

        m.streaming_session_started(active_count=3)

        assert _val("stt_v2_streaming_sessions_active") == 3
        assert (
            _val("stt_v2_streaming_sessions_total", {"status": "started"})
            == before_total + 1
        )

    def test_streaming_session_ended_syncs_active_gauge(self):
        m.streaming_session_started(active_count=3)
        m.streaming_session_ended(active_count=1)

        assert _val("stt_v2_streaming_sessions_active") == 1

    def test_observe_streaming_inference_records_latency(self):
        before = _val("stt_v2_streaming_inference_latency_seconds_count")

        m.observe_streaming_inference(0.42)

        assert _val("stt_v2_streaming_inference_latency_seconds_count") == before + 1
