"""stt → apps/api transcript-segment PRODUCER contract.

The consumer half of this contract (``computeSegmentOffsets`` →
``persistTranscriptSegments`` → ``TranscriptSegment`` rows) was correct and wired
on both ingest paths all along. It was starved because the producers here never
emitted a shape it could read:

* streaming emitted no segments at all;
* batch emitted ``metadata.segments`` in the VAD shape — snake_case, SECONDS,
  ``speaker_id``, and **no text** — which the consumer silently coerced to
  all-null, writing rows carrying nothing but an ordinal.

Both suites assert against the SAME checked-in fixture
(``tests/contracts/stt-transcript-segments/transcript-segments.fixture.json``), so
neither side can drift without failing the other. That cross-boundary lock is what
the pre-existing tests lacked: they hand-fed ideal camelCase payloads no producer
ever sent, which is why the producer gap survived review with a green suite.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from stt.streaming.schemas import SegmentResult, SessionMetadata
from stt.streaming.session import StreamSession
from stt.transcription.dto import AudioSegment, SentenceTimestamp, TranscriptionResult


def _load_fixture() -> dict[str, Any]:
    """Locate the shared contract fixture by walking up to the repo root."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = (
            parent
            / "tests"
            / "contracts"
            / "stt-transcript-segments"
            / "transcript-segments.fixture.json"
        )
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared transcript-segment contract fixture not found")


FIXTURE = _load_fixture()


def _strip_comments(payload: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in payload.items() if not k.startswith("$")}


@pytest.fixture
def streaming_expected() -> dict[str, Any]:
    return _strip_comments(FIXTURE["streaming"])


@pytest.fixture
def batch_expected() -> dict[str, Any]:
    return _strip_comments(FIXTURE["batch"])


class TestStreamingProducerContract:
    """StreamSession.build_transcript_segments() == the fixture's streaming payload."""

    def _session(self) -> StreamSession:
        from unittest.mock import MagicMock

        metadata = SessionMetadata(
            session_id="sess-contract",
            tenant_id="tenant-1",
            pipeline_id="pipeline-1",
            consultation_id="cons-1",
        )
        session = StreamSession(metadata=metadata, redis=MagicMock(), persist_interval_s=5.0)
        session.results = [
            SegmentResult(
                text="Patient reports chest pain.",
                speaker_id="doctor",
                start_time=0.0,
                end_time=1.5,
                is_final=True,
            ),
            SegmentResult(
                text="No shortness",
                speaker_id="patient",
                start_time=1.5,
                end_time=2.0,
                is_final=False,
            ),
            SegmentResult(
                text="No shortness of breath.",
                speaker_id="patient",
                start_time=1.5,
                end_time=3.0,
                is_final=True,
            ),
            SegmentResult(
                text="Start amlodipine 5mg daily.",
                speaker_id="doctor",
                start_time=3.1,
                end_time=5.0,
                is_final=True,
            ),
        ]
        return session

    def test_matches_the_shared_fixture(self, streaming_expected: dict[str, Any]) -> None:
        session = self._session()

        assert session.build_transcript_text() == streaming_expected["transcriptText"]
        assert session.build_transcript_segments() == streaming_expected["segments"]

    def test_char_offsets_slice_the_shipped_text(self, streaming_expected: dict[str, Any]) -> None:
        text = streaming_expected["transcriptText"]
        for seg in streaming_expected["segments"]:
            assert text[seg["charStart"] : seg["charEnd"]] == seg["text"]


class TestBatchProducerContract:
    """TranscriptionResult.build_transcript_segments() == the fixture's batch payload."""

    def _result(self) -> TranscriptionResult:
        return TranscriptionResult(
            text="Patient reports chest pain. No shortness of breath. Start amlodipine 5mg daily.",
            language="en",
            sentence_timestamps=[
                SentenceTimestamp(text="Patient reports chest pain.", start_time=0.0, end_time=1.5),
                SentenceTimestamp(text="No shortness of breath.", start_time=1.5, end_time=3.0),
                SentenceTimestamp(text="Start amlodipine 5mg daily.", start_time=3.1, end_time=5.0),
            ],
            # Diarization lives on the VAD segments, which carry NO text — the
            # speaker must be joined onto the sentences by temporal overlap.
            segments=[
                AudioSegment(
                    start_time=0.0, end_time=1.4, speaker_id="doctor", speaker_confidence=0.91
                ),
                AudioSegment(
                    start_time=1.5, end_time=3.0, speaker_id="patient", speaker_confidence=0.88
                ),
                AudioSegment(
                    start_time=3.1, end_time=5.0, speaker_id="doctor", speaker_confidence=0.93
                ),
            ],
        )

    def test_matches_the_shared_fixture(self, batch_expected: dict[str, Any]) -> None:
        result = self._result()

        assert result.text == batch_expected["transcriptText"]
        assert result.build_transcript_segments() == batch_expected["segments"]

    def test_to_dict_exposes_the_consumer_shape_additively(self) -> None:
        """The legacy VAD `segments` key must survive — other consumers read it."""
        payload = self._result().to_dict()

        assert payload["transcript_segments"] == self._result().build_transcript_segments()
        # Unchanged legacy shape, still snake_case/seconds, still no text.
        assert payload["segments"][0]["speaker_id"] == "doctor"
        assert payload["segments"][0]["start_time"] == 0.0
        assert "text" not in payload["segments"][0]

    def test_speaker_is_none_when_no_vad_segment_overlaps(self) -> None:
        result = TranscriptionResult(
            text="Isolated sentence.",
            sentence_timestamps=[
                SentenceTimestamp(text="Isolated sentence.", start_time=10.0, end_time=11.0)
            ],
            segments=[AudioSegment(start_time=0.0, end_time=1.0, speaker_id="doctor")],
        )

        assert result.build_transcript_segments()[0]["speaker"] is None

    def test_picks_the_maximally_overlapping_speaker(self) -> None:
        """A sentence straddling a speaker change is attributed to the dominant one."""
        result = TranscriptionResult(
            text="Straddling sentence.",
            sentence_timestamps=[
                SentenceTimestamp(text="Straddling sentence.", start_time=1.0, end_time=4.0)
            ],
            segments=[
                AudioSegment(start_time=0.0, end_time=1.5, speaker_id="doctor"),  # 0.5s overlap
                AudioSegment(start_time=1.5, end_time=4.0, speaker_id="patient"),  # 2.5s overlap
            ],
        )

        assert result.build_transcript_segments()[0]["speaker"] == "patient"

    def test_is_empty_without_sentence_timestamps(self) -> None:
        """No text-bearing source ⇒ no segments, rather than text-less null rows."""
        result = TranscriptionResult(
            text="Some transcript.",
            segments=[AudioSegment(start_time=0.0, end_time=1.0, speaker_id="doctor")],
        )

        assert result.build_transcript_segments() == []
