"""Unit tests for StreamSession -- partial filtering in add_result()."""

from __future__ import annotations

from unittest.mock import AsyncMock

from stt_v2.streaming.schemas import SegmentResult, SessionMetadata, SessionStatus
from stt_v2.streaming.session import StreamSession


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
