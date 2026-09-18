"""TASK-985 D7 — tests for the new/fixed STT metric contract.

Covers ``stt_streaming_utterances_total`` (M-45), the
``stt_streaming_sessions_total{status}`` finished-status fix (M-19),
``stt_streaming_lock_wait_seconds`` (M-26), the wired
``stt_model_load_latency_seconds`` (M-19), ``stt_ingest_lag_seconds`` (M-03),
and pins the cardinality bounds + deletions from the D7 dossier.

Follows the same pattern as ``test_metrics_task386.py``: exercise the public
helpers in ``stt.core.metrics`` directly against the default Prometheus
``REGISTRY``, reading before/after deltas so tests are order-independent.
"""

from __future__ import annotations

import pytest
from prometheus_client import REGISTRY

from stt.core import metrics as m


def _val(name: str, labels: dict[str, str] | None = None) -> float:
    """Read a single sample from the default registry, treating absent as 0.0."""
    return REGISTRY.get_sample_value(name, labels) or 0.0


class TestUtteranceReasonEnum:
    """Pins the closed 5-value `reason` enum (D7 §1.4) — deliberately NARROWER
    than `EndpointDecision.reason`'s 7 values."""

    def test_utterance_reasons_is_the_closed_five_value_set(self):
        assert m.UTTERANCE_REASONS == frozenset(
            {
                "semantic",
                "silence_timer",
                "max_utterance_smart",
                "max_utterance_overlap",
                "flush",
                "flush_pending_onset",
                "partial",
                "recovery",
            }
        )

    def test_frame_level_endpoint_reasons_are_not_utterance_reasons(self):
        """The 6 per-frame `EndpointDecision.reason` values that are NOT this
        utterance-level enum — never valid on this series."""
        frame_level = {
            "disabled",
            "no_hypothesis",
            "too_short",
            "below_silence_floor",
            "incomplete_trailing_filler",
            "low_confidence",
        }
        assert frame_level.isdisjoint(m.UTTERANCE_REASONS)


class TestRecordUtterance:
    """stt_streaming_utterances_total{is_final,engine,reason} — M-45's ratio denominator."""

    def test_the_reason_set_mirrors_the_code_that_emits_it(self):
        """TASK-985 — the label set follows the implementation, never a guess.

        This enum was first written from a read of the pre-TASK-985 preprocessor
        and named five reasons; the segmentation lane then implemented seven,
        overlapping on exactly `semantic`. Because `record_utterance` validates,
        that mismatch surfaced as 53 hard `ValueError`s the first time the counter
        was wired — loudly, which is the point of the guard, but only after the
        two halves had already merged. Pinning the parity here makes a new emit
        path that forgets this list a CI failure instead.

        `recovery` is emitted by the crash-recovery branch in `session_manager`,
        not by the preprocessor, so it is the one member with no `REASON_*`
        constant on the other side.
        """
        from stt.streaming import preprocessor as pp

        emitted = {
            value
            for name, value in vars(pp).items()
            if name.startswith("REASON_") and isinstance(value, str)
        }
        assert emitted, "preprocessor declares no REASON_* constants — did they move?"
        assert emitted <= m.UTTERANCE_REASONS, (
            f"preprocessor emits reasons the metric would reject: "
            f"{sorted(emitted - m.UTTERANCE_REASONS)}"
        )
        assert m.UTTERANCE_REASONS - emitted == {"recovery"}, (
            f"metric declares reasons nothing emits: "
            f"{sorted(m.UTTERANCE_REASONS - emitted - {'recovery'})}"
        )

    @pytest.mark.parametrize("reason", sorted(m.UTTERANCE_REASONS))
    def test_records_each_closed_reason(self, reason: str):
        labels = {"is_final": "true", "engine": "whisper_cpp", "reason": reason}
        before = _val("stt_streaming_utterances_total", labels)

        m.record_utterance(is_final=True, engine="whisper_cpp", reason=reason)

        assert _val("stt_streaming_utterances_total", labels) == before + 1

    def test_is_final_false_uses_string_label_false(self):
        labels = {"is_final": "false", "engine": "faster_whisper", "reason": "semantic"}
        before = _val("stt_streaming_utterances_total", labels)

        m.record_utterance(is_final=False, engine="faster_whisper", reason="semantic")

        assert _val("stt_streaming_utterances_total", labels) == before + 1

    def test_unknown_reason_raises_instead_of_silently_widening_cardinality(self):
        with pytest.raises(ValueError, match="Unknown utterance reason"):
            m.record_utterance(is_final=True, engine="whisper_cpp", reason="not_a_real_reason")

    def test_frame_level_endpoint_decision_reason_is_rejected(self):
        """The finer 7-value EndpointDecision.reason set must never leak onto
        this label — that would blow the cardinality bound D7 sets."""
        with pytest.raises(ValueError, match="Unknown utterance reason"):
            m.record_utterance(is_final=True, engine="whisper_cpp", reason="no_hypothesis")

    def test_engine_label_is_not_validated_here(self):
        """`engine` is a format-derived enum owned by asr_engines.py /
        resolve_usage_attribution, not this function's to police — passing an
        engine string this module has never seen must not raise."""
        labels = {"is_final": "true", "engine": "some_future_engine", "reason": "flush"}
        before = _val("stt_streaming_utterances_total", labels)

        m.record_utterance(is_final=True, engine="some_future_engine", reason="flush")

        assert _val("stt_streaming_utterances_total", labels) == before + 1


class TestStreamingSessionFinished:
    """stt_streaming_sessions_total{status} — the missing `finished` half (M-19)."""

    def test_session_finished_statuses_is_the_closed_four_value_set(self):
        assert m.SESSION_FINISHED_STATUSES == frozenset({"closed", "recovered", "reaped", "failed"})

    @pytest.mark.parametrize("status", sorted(m.SESSION_FINISHED_STATUSES))
    def test_records_each_terminal_status(self, status: str):
        before = _val("stt_streaming_sessions_total", {"status": status})

        m.streaming_session_finished(status)

        assert _val("stt_streaming_sessions_total", {"status": status}) == before + 1

    def test_started_is_rejected_here_started_has_its_own_helper(self):
        with pytest.raises(ValueError, match="Unknown terminal session status"):
            m.streaming_session_finished("started")

    def test_unknown_status_raises(self):
        with pytest.raises(ValueError, match="Unknown terminal session status"):
            m.streaming_session_finished("not_a_real_status")

    def test_slo_ratio_has_a_nonzero_numerator_after_a_finish(self):
        """The concrete bug this fix closes: before it, `status=~"closed|
        recovered|reaped"` was permanently absent/zero, so the SLO ratio's
        numerator never moved."""
        before_started = _val("stt_streaming_sessions_total", {"status": "started"})
        before_closed = _val("stt_streaming_sessions_total", {"status": "closed"})

        m.streaming_session_started(active_count=1)
        m.streaming_session_finished("closed")

        assert _val("stt_streaming_sessions_total", {"status": "started"}) == before_started + 1
        assert _val("stt_streaming_sessions_total", {"status": "closed"}) == before_closed + 1


class TestLockWait:
    """stt_streaming_lock_wait_seconds{model,engine} — M-26 concurrency signal."""

    def test_records_lock_wait_observation(self):
        labels = {"model": "whisper-large-v3-turbo", "engine": "whisper_cpp"}
        before = _val("stt_streaming_lock_wait_seconds_count", labels)

        m.record_lock_wait(model="whisper-large-v3-turbo", engine="whisper_cpp", seconds=0.05)

        assert _val("stt_streaming_lock_wait_seconds_count", labels) == before + 1

    def test_clamps_negative_wait_to_zero(self):
        """prometheus_client's Histogram.observe() does NOT reject a negative
        amount — it silently corrupts `_sum` (a clock/accounting glitch must
        never produce a negative wait observation), so the clamp has to
        happen in this helper, not be assumed away by the library."""
        labels = {"model": "m-neg", "engine": "whisper_cpp"}
        before_sum = _val("stt_streaming_lock_wait_seconds_sum", labels)

        m.record_lock_wait(model="m-neg", engine="whisper_cpp", seconds=-1.0)

        assert _val("stt_streaming_lock_wait_seconds_sum", labels) == before_sum


class TestModelLoadLatency:
    """stt_model_load_latency_seconds{model,engine} — M-19: wired, not dead."""

    def test_track_model_load_latency_observes_on_success(self):
        labels = {"model": "cadence-fast", "engine": "whisper_cpp"}
        before = _val("stt_model_load_latency_seconds_count", labels)

        with m.track_model_load_latency(model="cadence-fast", engine="whisper_cpp"):
            pass

        assert _val("stt_model_load_latency_seconds_count", labels) == before + 1

    def test_track_model_load_latency_observes_and_reraises_on_error(self):
        labels = {"model": "cadence-broken", "engine": "whisper_cpp"}
        before = _val("stt_model_load_latency_seconds_count", labels)

        with pytest.raises(RuntimeError):
            with m.track_model_load_latency(model="cadence-broken", engine="whisper_cpp"):
                raise RuntimeError("load failed")

        # The load duration up to the failure is still observed — a load
        # that times out or errors is exactly the case M-17's cold-start
        # story needs visibility into.
        assert _val("stt_model_load_latency_seconds_count", labels) == before + 1


class TestIngestLag:
    """stt_ingest_lag_seconds — M-03, deliberately unlabelled."""

    def test_observe_ingest_lag_records_unlabelled_observation(self):
        before = _val("stt_ingest_lag_seconds_count")

        m.observe_ingest_lag(0.12)

        assert _val("stt_ingest_lag_seconds_count") == before + 1

    def test_clamps_negative_lag_to_zero(self):
        before_sum = _val("stt_ingest_lag_seconds_sum")

        m.observe_ingest_lag(-3.0)

        assert _val("stt_ingest_lag_seconds_sum") == before_sum


class TestDeadMetricsDeleted:
    """M-19 — confirmed-dead metrics were deleted, not just left unwired.

    Guards against a future re-add under the same name: `REGISTRY` raises at
    *registration* time on a name collision, so if any of these ever come
    back while this module is imported, `stt.core.metrics` itself fails to
    import — but this test also pins that the module no longer exposes the
    symbols at all, which a bare Prometheus name check would miss.
    """

    @pytest.mark.parametrize(
        "symbol",
        [
            "VAD_SEGMENTS_DETECTED",
            "VAD_PROCESSING_LATENCY",
            "MODEL_CACHE_HITS",
            "MODEL_CACHE_MISSES",
        ],
    )
    def test_symbol_no_longer_defined(self, symbol: str):
        assert not hasattr(m, symbol)

    @pytest.mark.parametrize(
        "metric_name",
        [
            "stt_vad_segments_total",  # Counter — exact name is the sample name
            "stt_model_cache_hits_total",  # Counter
            "stt_model_cache_misses_total",  # Counter
        ],
    )
    def test_counter_name_not_registered(self, metric_name: str):
        # get_sample_value returns None for a metric name the registry has
        # never seen at all (as opposed to 0.0 for a registered-but-unobserved
        # series).
        assert REGISTRY.get_sample_value(metric_name) is None

    def test_vad_processing_latency_histogram_not_registered(self):
        # A Histogram's samples carry _count/_sum/_bucket suffixes, not the
        # bare name.
        assert REGISTRY.get_sample_value("stt_vad_processing_latency_seconds_count") is None
        assert REGISTRY.get_sample_value("stt_vad_processing_latency_seconds_sum") is None
