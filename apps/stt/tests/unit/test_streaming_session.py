"""Unit tests for StreamSession -- partial filtering + results buffer caps in add_result()."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from stt.streaming import session as session_module
from stt.streaming.schemas import SegmentResult, SessionMetadata, SessionStatus
from stt.streaming.session import StreamSession


def _make_session() -> StreamSession:
    """Create a minimal StreamSession for testing."""
    metadata = SessionMetadata(
        session_id="test-sess",
        tenant_id="t1",
        pipeline_id="p1",
        status=SessionStatus.ACTIVE,
    )
    redis = AsyncMock()
    return StreamSession(metadata=metadata, redis=redis)


def _make_result(is_final: bool, text: str = "hello") -> SegmentResult:
    return SegmentResult(
        text=text,
        start_time=0.0,
        end_time=1.0,
        is_final=is_final,
    )


class TestAddResultFiltering:

    def test_add_result_records_finals(self):
        session = _make_session()
        session.add_result(_make_result(is_final=True))
        assert len(session.results) == 1

    def test_add_result_ignores_partials(self):
        session = _make_session()
        session.add_result(_make_result(is_final=False))
        assert len(session.results) == 0

    def test_transcript_contains_only_finals(self):
        session = _make_session()
        session.add_result(_make_result(is_final=False, text="partial"))
        session.add_result(_make_result(is_final=True, text="final one"))
        session.add_result(_make_result(is_final=False, text="another partial"))
        session.add_result(_make_result(is_final=True, text="final two"))

        assert len(session.results) == 2
        assert all(r.is_final for r in session.results)
        assert session.results[0].text == "final one"
        assert session.results[1].text == "final two"


class TestResultsBufferCap:
    """F-28: unbounded StreamSession.results defensive caps."""

    def test_warns_once_when_finals_exceed_warn_threshold(self):
        session = _make_session()
        with patch.object(session_module, "_RESULTS_WARN_THRESHOLD", 3), patch.object(
            session_module, "_RESULTS_HARD_CAP", 100
        ), patch.object(session_module, "logger") as mock_logger:
            for _ in range(6):
                session.add_result(_make_result(is_final=True))

        assert len(session.results) == 6
        assert mock_logger.warning.call_count == 1
        call_kwargs = mock_logger.warning.call_args
        assert "results" in call_kwargs.args[0].lower() or "buffer" in call_kwargs.args[0].lower()

    def test_does_not_warn_below_threshold(self):
        session = _make_session()
        with patch.object(session_module, "_RESULTS_WARN_THRESHOLD", 10), patch.object(
            session_module, "_RESULTS_HARD_CAP", 100
        ), patch.object(session_module, "logger") as mock_logger:
            for _ in range(5):
                session.add_result(_make_result(is_final=True))

        assert len(session.results) == 5
        assert mock_logger.warning.call_count == 0

    def test_refuses_append_past_hard_cap_with_error_log(self):
        session = _make_session()
        with patch.object(session_module, "_RESULTS_WARN_THRESHOLD", 2), patch.object(
            session_module, "_RESULTS_HARD_CAP", 5
        ), patch.object(session_module, "logger") as mock_logger:
            for _ in range(8):
                session.add_result(_make_result(is_final=True))

        # Refused past the cap -- buffer never exceeds it.
        assert len(session.results) == 5
        assert mock_logger.error.call_count == 1

    def test_partials_never_count_toward_cap(self):
        session = _make_session()
        with patch.object(session_module, "_RESULTS_WARN_THRESHOLD", 2), patch.object(
            session_module, "_RESULTS_HARD_CAP", 3
        ), patch.object(session_module, "logger"):
            for _ in range(10):
                session.add_result(_make_result(is_final=False))

        assert len(session.results) == 0
