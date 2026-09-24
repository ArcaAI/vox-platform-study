"""TASK-1003 F-16 — non-fatal Sarvam realtime vendor errors were invisible.

``SarvamDuplexSession._dispatch_error`` handles a vendor ``error`` frame in two
ways, by design: ``is_fatal: true`` fails the session (mapped to a typed
``CloudASR*`` exception and counted on ``stt_cloud_asr_errors_total``);
``is_fatal: false`` is reported to the caller as a ``DuplexError`` and the
session keeps running. That second path had no counter at all — a vendor that
degraded into a stream of non-fatal complaints was invisible in Grafana. This
suite pins the new ``stt_cloud_asr_non_fatal_errors_total{provider, code}``
counter and confirms the non-fatal path still does exactly what it always
did: report, never fail the session or reach the fatal/engine-switch path.
"""

from __future__ import annotations

from pydantic import SecretStr

from stt.core.metrics import STT_CLOUD_ASR_ERRORS_TOTAL, STT_CLOUD_ASR_NON_FATAL_ERRORS_TOTAL
from stt.models.cloud_asr import CloudRestConfig
from stt.streaming.duplex_asr import DuplexError
from stt.streaming.sarvam_realtime_asr import SarvamDuplexSession


def _config() -> CloudRestConfig:
    return CloudRestConfig(
        provider="sarvam",
        api_key=SecretStr("secret-key"),
        base_url="https://api.example.test",
        model_name="saaras:v4",
    )


def _session() -> SarvamDuplexSession:
    return SarvamDuplexSession(_config(), language="en")


def _non_fatal_counter(code: str) -> float:
    return STT_CLOUD_ASR_NON_FATAL_ERRORS_TOTAL.labels(provider="sarvam", code=code)._value.get()


class TestNonFatalErrorCounter:
    def test_increments_by_vendor_code(self) -> None:
        before = _non_fatal_counter("warm_up")
        session = _session()

        ended = session._dispatch_error(
            {"code": "warm_up", "message": "model warming up", "is_fatal": False}
        )

        assert ended is False
        assert _non_fatal_counter("warm_up") == before + 1

    def test_repeated_errors_keep_incrementing(self) -> None:
        before = _non_fatal_counter("buffer_overrun")
        session = _session()

        for _ in range(3):
            session._dispatch_error(
                {"code": "buffer_overrun", "message": "dropped a frame", "is_fatal": False}
            )

        assert _non_fatal_counter("buffer_overrun") == before + 3

    def test_missing_code_falls_back_to_unknown(self) -> None:
        before = _non_fatal_counter("unknown")
        session = _session()

        session._dispatch_error({"message": "no code given", "is_fatal": False})

        assert _non_fatal_counter("unknown") == before + 1

    def test_different_codes_are_labeled_separately(self) -> None:
        before_a = _non_fatal_counter("code_a")
        before_b = _non_fatal_counter("code_b")
        session = _session()

        session._dispatch_error({"code": "code_a", "message": "a", "is_fatal": False})
        session._dispatch_error({"code": "code_b", "message": "b", "is_fatal": False})

        assert _non_fatal_counter("code_a") == before_a + 1
        assert _non_fatal_counter("code_b") == before_b + 1

    def test_a_fatal_error_does_not_touch_the_non_fatal_counter(self) -> None:
        """The two are on structurally different paths — a fatal frame is counted
        (by taxonomy bucket) on `STT_CLOUD_ASR_ERRORS_TOTAL` only."""
        before_non_fatal = _non_fatal_counter("boom")
        session = _session()

        session._dispatch_error({"code": "boom", "message": "fatal thing", "is_fatal": True})

        assert _non_fatal_counter("boom") == before_non_fatal


class TestNonFatalErrorStillJustReports:
    """Non-fatal is non-fatal, unchanged by adding the counter."""

    def test_does_not_fail_the_session(self) -> None:
        session = _session()

        session._dispatch_error(
            {"code": "warm_up", "message": "model warming up", "is_fatal": False}
        )

        assert session._fatal is None

    def test_does_not_terminate_the_session(self) -> None:
        session = _session()

        ended = session._dispatch_error(
            {"code": "warm_up", "message": "model warming up", "is_fatal": False}
        )

        assert ended is False
        assert session._terminated is False

    def test_still_emits_a_non_fatal_duplex_error_to_the_caller(self) -> None:
        session = _session()

        session._dispatch_error(
            {"code": "warm_up", "message": "model warming up", "is_fatal": False}
        )

        event = session._queue.get_nowait()
        assert event == DuplexError(code="warm_up", message="model warming up", is_fatal=False)

    def test_a_fatal_error_still_terminates_as_before(self) -> None:
        """Adding the non-fatal counter must not touch the fatal path's own
        behaviour: it still fails and terminates the session."""
        session = _session()

        ended = session._dispatch_error(
            {"code": "auth_failed", "message": "bad key", "is_fatal": True}
        )

        assert ended is True
        assert session._fatal is not None
        assert session._terminated is True

    def test_a_fatal_error_still_counts_on_the_taxonomy_counter(self) -> None:
        before = STT_CLOUD_ASR_ERRORS_TOTAL.labels(provider="sarvam", **{"class": "auth"})._value.get()
        session = _session()

        session._dispatch_error({"code": "auth_failed", "message": "bad key", "is_fatal": True})

        after = STT_CLOUD_ASR_ERRORS_TOTAL.labels(provider="sarvam", **{"class": "auth"})._value.get()
        assert after == before + 1
