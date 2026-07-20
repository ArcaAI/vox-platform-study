"""Streaming transcript SEGMENTS reach the gateway (TASK-533 D-22).

The evidence-grounding pillar (harness ``segment_citations`` → click-to-source)
depends on ``TranscriptSegment`` rows. The NestJS ingest side was built and wired
on both paths — and starved, because the stt-v2 producers never sent segments:

* streaming sent NONE at all (``_persist_streaming_transcript`` and the outbox
  re-drive both posted transcript TEXT only), and
* the outbox payload had no place to carry them across a restart.

These tests lock the producer half of the contract:

  session.results -> build_transcript_segments() -> gateway.create_transcript(segments=)

The consumer half (offset resolution → persisted rows) is locked by
``tests/contracts/stt-transcript-segments/`` against the SAME fixture, so the two
sides cannot drift apart silently again.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from stt_v2.streaming.schemas import SegmentResult, SessionMetadata
from stt_v2.streaming.session import StreamSession


def _build_session(session_id: str = "sess-1") -> StreamSession:
    metadata = SessionMetadata(
        session_id=session_id,
        tenant_id="tenant-1",
        pipeline_id="pipeline-1",
        consultation_id="cons-1",
    )
    return StreamSession(metadata=metadata, redis=MagicMock(), persist_interval_s=5.0)


def _session_with_results() -> StreamSession:
    """A session whose finals interleave with partials and an empty utterance."""
    session = _build_session()
    session.results = [
        SegmentResult(text="Patient reports chest pain.", speaker_id="doctor", start_time=0.0, end_time=1.5, is_final=True),
        # Partial hypothesis — excluded from the transcript text, so excluded here.
        SegmentResult(text="No shortness", speaker_id="patient", start_time=1.5, end_time=2.0, is_final=False),
        SegmentResult(text="  No shortness of breath.  ", speaker_id="patient", start_time=1.5, end_time=3.0, is_final=True),
        # Whitespace-only final — dropped by build_transcript_text, so dropped here.
        SegmentResult(text="   ", speaker_id="patient", start_time=3.0, end_time=3.1, is_final=True),
        SegmentResult(text="Start amlodipine 5mg daily.", speaker_id="doctor", start_time=3.1, end_time=5.0, is_final=True),
    ]
    return session


class TestBuildTranscriptSegments:
    def test_emits_the_consumer_shape(self) -> None:
        segments = _session_with_results().build_transcript_segments()

        assert [s["idx"] for s in segments] == [0, 1, 2]
        assert [s["speaker"] for s in segments] == ["doctor", "patient", "doctor"]
        # Milliseconds as INTS — the consumer column is Int, not seconds-as-float.
        assert segments[0]["t0Ms"] == 0
        assert segments[0]["t1Ms"] == 1500
        assert segments[1]["t1Ms"] == 3000
        assert all(isinstance(s["t0Ms"], int) and isinstance(s["t1Ms"], int) for s in segments)

    def test_excludes_partials_and_blank_finals(self) -> None:
        segments = _session_with_results().build_transcript_segments()

        assert len(segments) == 3
        assert not any(s["text"] == "No shortness" for s in segments)
        assert not any(s["text"].strip() == "" for s in segments)

    def test_char_offsets_index_exactly_into_the_transcript_text(self) -> None:
        """The load-bearing invariant: offsets must slice the SAME string that ships."""
        session = _session_with_results()
        text = session.build_transcript_text()

        for seg in session.build_transcript_segments():
            assert text[seg["charStart"] : seg["charEnd"]] == seg["text"]

    def test_is_empty_when_the_transcript_is_empty(self) -> None:
        session = _build_session("sess-empty")
        session.results = [SegmentResult(text="partial only", start_time=0.0, end_time=1.0, is_final=False)]

        assert session.build_transcript_text() == ""
        assert session.build_transcript_segments() == []

    def test_speaker_is_none_when_diarization_did_not_label(self) -> None:
        session = _build_session("sess-nospk")
        session.results = [SegmentResult(text="hello", start_time=0.0, end_time=1.0, is_final=True)]

        assert session.build_transcript_segments()[0]["speaker"] is None


class TestPersistSendsSegments:
    @pytest.mark.asyncio
    async def test_inline_persist_attaches_segments(self) -> None:
        from stt_v2.streaming.session_manager import SessionManager

        session = _session_with_results()
        gateway = MagicMock()
        gateway.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-1"})

        mgr = MagicMock(spec=SessionManager)
        mgr._get_api_client = MagicMock(return_value=gateway)
        # Instance attributes are not on the class spec — set the retry knobs the
        # method reads so the first attempt succeeds without backoff.
        mgr._transcript_persist_max_attempts = 1
        mgr._transcript_persist_backoff_s = 0
        mgr._transcript_idempotency_key = MagicMock(return_value="idem-1")

        await SessionManager._persist_streaming_transcript(mgr, session)

        gateway.create_transcript.assert_awaited_once()
        segments = gateway.create_transcript.await_args.kwargs["segments"]
        assert [s["text"] for s in segments] == [
            "Patient reports chest pain.",
            "No shortness of breath.",
            "Start amlodipine 5mg daily.",
        ]

    @pytest.mark.asyncio
    async def test_outbox_entry_carries_segments_across_a_restart(self) -> None:
        """A queued transcript must survive with its segments, or the re-drive starves."""
        import json

        from stt_v2.streaming.session_manager import SessionManager

        session = _session_with_results()
        mgr = MagicMock(spec=SessionManager)
        mgr._redis = MagicMock()
        mgr._redis.hset = AsyncMock()

        await SessionManager._enqueue_transcript_outbox(
            mgr,
            session,
            session.build_transcript_text(),
            session.build_transcript_segments(),
            "idem-1",
            None,
        )

        payload = json.loads(mgr._redis.hset.await_args.args[2])
        assert len(payload["segments"]) == 3
        assert payload["segments"][0]["text"] == "Patient reports chest pain."

    @pytest.mark.asyncio
    async def test_outbox_redrive_forwards_stored_segments(self) -> None:
        """The re-drive must resend segments, not just text (else a retry starves)."""
        from stt_v2.streaming.session_manager import SessionManager

        gateway = MagicMock()
        gateway.create_transcript = AsyncMock(return_value={"contextItemId": "ctx-1"})
        mgr = MagicMock(spec=SessionManager)
        mgr._get_api_client = MagicMock(return_value=gateway)
        mgr._worker_id = "worker-1"
        mgr._redis = MagicMock()
        mgr._redis.hdel = AsyncMock()
        mgr._redis.hset = AsyncMock()

        stored = {
            "transcript_text": "Patient reports chest pain.",
            "consultation_id": "cons-1",
            "tenant_id": "tenant-1",
            "transcription_source": "streaming",
            "idempotency_key": "idem-1",
            "attempts": 0,
            "segments": [
                {"idx": 0, "t0Ms": 0, "t1Ms": 1500, "speaker": "doctor", "text": "Patient reports chest pain.", "charStart": 0, "charEnd": 27},
            ],
        }

        await SessionManager._redrive_outbox_entry(mgr, "idem-1", stored, 0.0)

        gateway.create_transcript.assert_awaited_once()
        assert gateway.create_transcript.await_args.kwargs["segments"] == stored["segments"]
