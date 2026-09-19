"""Batch transcript segments must carry a real speaker and a real end time.

Measured live (TASK-991 wave 2) on an 11.72 s single-speaker clip against a
diarizing agent, with the REALTIME path correct on both counts:

* **W2-2** — ``resultMetadata.metadata.diarization`` said
  ``{"speakers_detected": 1, "new_speakers_created": 0, "speaker_ids": ["Dr Manoj
  Johnson (doctor-1)"]}`` (diarization AND voice-profile matching both worked), yet
  every ``transcript_segments[].speaker`` was ``null`` and ``resultMetadata.segments``
  was ``[]``. Two independent breaks: ``_attach_speaker_metadata_to_segments`` read
  ``start_time``/``end_time`` from segments that spell their times ``start``/``end``,
  so it skipped every one of them and wrote nothing; and ``_postprocess`` never put
  the raw segments onto ``TranscriptionResult.segments``, so the sentence → speaker
  overlap join in ``build_transcript_segments()`` had nothing to join against.
* **W2-3** — every ``t1Ms`` came back as ``t0Ms + 30000`` (``30000`` and ``35075`` on
  that clip): whisper-family engines pad their input to a 30 s context window and
  report the padded window's end, and batch shipped it verbatim.

The pre-existing producer contract test hand-built a ``TranscriptionResult`` with
its ``segments`` already populated, which is precisely the state the pipeline never
reached — so it stayed green throughout. These tests start from what an ENGINE
returns and run the real projection, the real postprocess and the real builder.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import (
    AiModelFormat,
    InferenceConfig,
    ModelRef,
    ModelRefs,
    PipelineConfig,
    PipelineSpec,
    PostprocessingConfig,
    PreprocessingConfig,
    PunctuationConfig,
    SegmentMergeConfig,
    TimestampConfig,
)
from stt.transcription.batch_service import (
    BatchTranscriptionService,
    _clamp_segment_times,
    _segment_bounds,
)
from stt.transcription.dto import AudioSegment, ProcessedAudio, RawTranscription

pytestmark = pytest.mark.unit

SAMPLE_RATE = 16000
# The live clip: two VAD speech segments, 11.744 s of audio in total.
CLIP_DURATION_S = 11.744
SEG_A = (0.0, 4.5)
SEG_B = (5.075, 11.744)
DOCTOR = "Dr Manoj Johnson (doctor-1)"

# What whisper.cpp actually returns for a short buffer: ONE segment spanning its
# padded 30 s context window, regardless of how much audio it was given.
PADDED_WINDOW_S = 30.0


def _postprocessing_config() -> PostprocessingConfig:
    """Sentence timestamps on, punctuation off (it would load a real model)."""
    return PostprocessingConfig(
        timestamps=TimestampConfig(word_timestamps=False, sentence_timestamps=True),
        punctuation=PunctuationConfig(enabled=False, model=None),
    )


def _service() -> BatchTranscriptionService:
    return BatchTranscriptionService()


def _engine_segments() -> list[dict[str, Any]]:
    """Raw engine output for the clip, timed against the padded window (W2-3).

    This is what reached ``_postprocess`` in production: ``0 → 30`` and
    ``5.075 → 35.075`` on an 11.744 s recording.
    """
    return [
        {"text": "Patient reports chest pain.", "start": 0.0, "end": PADDED_WINDOW_S},
        {
            "text": "No shortness of breath.",
            "start": SEG_B[0],
            "end": SEG_B[0] + PADDED_WINDOW_S,
        },
    ]


def _bounded_segments() -> list[dict[str, Any]]:
    """The same output once each segment is bounded by the audio it was decoded from.

    What the fixed per-segment path emits — see
    :class:`TestPerSegmentInferenceEndTimes`, which proves this is what comes out.
    """
    return [
        {"text": "Patient reports chest pain.", "start": SEG_A[0], "end": SEG_A[1]},
        {"text": "No shortness of breath.", "start": SEG_B[0], "end": SEG_B[1]},
    ]


def _diarized_spans() -> list[dict[str, Any]]:
    """What the diarizer determined: doctor first, a second speaker after."""
    return [
        {
            "start": SEG_A[0],
            "end": SEG_A[1],
            "speaker_id": DOCTOR,
            "speaker_confidence": 0.91,
        },
        {
            "start": SEG_B[0],
            "end": SEG_B[1],
            "speaker_id": "Speaker 2",
            "speaker_confidence": 0.77,
        },
    ]


class TestSegmentBounds:
    """Both time spellings this file mixes must read the same way (W2-2 cause 1)."""

    def test_reads_the_per_segment_result_spelling(self) -> None:
        assert _segment_bounds({"start_time": 1.5, "end_time": 4.25}) == (1.5, 4.25)

    def test_reads_the_engine_segment_spelling(self) -> None:
        assert _segment_bounds({"start": 1.5, "end": 4.25}) == (1.5, 4.25)

    def test_an_unlocatable_segment_collapses_rather_than_claiming_zero_to_zero(self) -> None:
        """No readable end ⇒ end == start, which callers skip instead of mislabelling."""
        assert _segment_bounds({"start": 2.0}) == (2.0, 2.0)
        assert _segment_bounds({"text": "no timing at all"}) == (0.0, 0.0)

    def test_non_numeric_values_are_not_coerced(self) -> None:
        assert _segment_bounds({"start": None, "end": "4.25"}) == (0.0, 0.0)


class TestClampSegmentTimes:
    """A segment can never end after the audio that produced it (W2-3)."""

    def test_clips_the_padded_window_end_to_the_audio(self) -> None:
        segments = [{"start": 0.0, "end": PADDED_WINDOW_S}]

        _clamp_segment_times(segments, 4.5)

        assert segments[0] == {"start": 0.0, "end": 4.5}

    def test_leaves_an_honest_engine_timing_exactly_as_measured(self) -> None:
        segments = [{"start": 0.5, "end": 3.9}]

        _clamp_segment_times(segments, 4.5)

        assert segments[0] == {"start": 0.5, "end": 3.9}

    def test_never_produces_an_end_before_its_own_start(self) -> None:
        segments = [{"start": 2.0, "end": 1.0}]

        _clamp_segment_times(segments, 4.5)

        assert segments[0]["end"] == 2.0

    def test_leaves_unreadable_timings_untouched(self) -> None:
        segments = [{"text": "no timing"}, {"start": None, "end": None}]

        _clamp_segment_times(segments, 4.5)

        assert segments == [{"text": "no timing"}, {"start": None, "end": None}]

    def test_an_unknown_duration_clamps_nothing(self) -> None:
        segments = [{"start": 0.0, "end": PADDED_WINDOW_S}]

        _clamp_segment_times(segments, 0.0)

        assert segments[0]["end"] == PADDED_WINDOW_S


class TestPerSegmentInferenceEndTimes:
    """W2-3 where it was produced: per-VAD-segment ASR."""

    async def _run(self, engine_segments_factory: Any) -> RawTranscription:
        service = _service()
        samples = np.zeros(int(CLIP_DURATION_S * SAMPLE_RATE), dtype=np.float32)

        async def _fake_inference(*_args: Any, **_kwargs: Any) -> RawTranscription:
            # A fresh dict per call: the production path mutates these in place.
            return RawTranscription(text="spoken words", segments=engine_segments_factory())

        with patch.object(service, "_run_inference", new=AsyncMock(side_effect=_fake_inference)):
            return await service._run_per_segment_inference(
                samples,
                SAMPLE_RATE,
                [
                    AudioSegment(start_time=SEG_A[0], end_time=SEG_A[1]),
                    AudioSegment(start_time=SEG_B[0], end_time=SEG_B[1]),
                ],
                MagicMock(),
                InferenceConfig(),
                job_id="job-991",
                # Explicit: merging is otherwise decided by a global setting, and a
                # merge would change how many segments this test is reasoning about.
                segment_merge_config=SegmentMergeConfig(enabled=False),
            )

    @pytest.mark.asyncio
    async def test_the_padded_window_never_reaches_the_transcript(self) -> None:
        """Each segment is bounded by the buffer the engine was handed, not by 30 s."""
        result = await self._run(lambda: [{"text": "spoken words", "start": 0.0, "end": 30.0}])

        spans = [(seg["start"], seg["end"]) for seg in result.segments]
        assert len(spans) == 2
        assert spans[0][0] == pytest.approx(SEG_A[0], abs=1e-3)
        assert spans[0][1] == pytest.approx(SEG_A[1], abs=1e-3)
        assert spans[1][0] == pytest.approx(SEG_B[0], abs=1e-3)
        assert spans[1][1] == pytest.approx(SEG_B[1], abs=1e-3)
        # The shape of the defect, stated directly: 30 s apart, past the recording.
        for start, end in spans:
            assert end - start < PADDED_WINDOW_S
            assert end <= CLIP_DURATION_S + 1e-3

    @pytest.mark.asyncio
    async def test_an_engine_that_times_honestly_is_reported_verbatim(self) -> None:
        """Clamping bounds fabricated ends; it must not rewrite measured ones."""
        result = await self._run(lambda: [{"text": "spoken words", "start": 0.5, "end": 3.9}])

        assert result.segments[0]["start"] == pytest.approx(0.5, abs=1e-3)
        assert result.segments[0]["end"] == pytest.approx(3.9, abs=1e-3)
        # Second VAD segment: the same offsets applied from its own start.
        assert result.segments[1]["start"] == pytest.approx(SEG_B[0] + 0.5, abs=1e-3)
        assert result.segments[1]["end"] == pytest.approx(SEG_B[0] + 3.9, abs=1e-3)


class TestSpeakerReachesTheWire:
    """W2-2 across the whole chain: diarizer → raw segments → result → wire shape."""

    def test_the_diarized_speaker_survives_to_the_transcript_segments(self) -> None:
        service = _service()
        raw = RawTranscription(
            text="Patient reports chest pain. No shortness of breath.",
            segments=_bounded_segments(),
        )

        # Exactly what `transcribe()` does, in order, once inference has bounded
        # each segment: project the diarizer's labels, then postprocess.
        service._attach_speaker_metadata_to_segments(raw.segments, _diarized_spans())
        result = service._postprocess(raw, _postprocessing_config(), CLIP_DURATION_S)

        wire = result.build_transcript_segments()
        # `speaker` is the field the gateway normaliser reads
        # (packages/applications/src/services/consultation/lib/transcript-segments.ts).
        assert [seg["speaker"] for seg in wire] == [DOCTOR, "Speaker 2"]
        assert [seg["t0Ms"] for seg in wire] == [0, 5075]
        assert [seg["t1Ms"] for seg in wire] == [4500, 11744]

    def test_the_padded_span_would_have_stolen_the_second_speakers_label(self) -> None:
        """Why the clamp runs BEFORE diarization is projected, not after.

        A 0–30 s span overlaps every turn in the clip, so the max-overlap rule hands
        the first sentence whichever speaker spoke LONGEST anywhere in the recording.
        """
        service = _service()
        unclamped = _engine_segments()

        service._attach_speaker_metadata_to_segments(unclamped, _diarized_spans())

        assert unclamped[0]["speaker_id"] == "Speaker 2"  # the doctor's line, mislabelled

    def test_postprocess_publishes_the_segments_other_consumers_read(self) -> None:
        """`resultMetadata.segments` shipped `[]` on every batch job."""
        service = _service()
        raw = RawTranscription(text="Patient reports chest pain.", segments=_bounded_segments()[:1])
        service._attach_speaker_metadata_to_segments(raw.segments, _diarized_spans()[:1])

        payload = service._postprocess(raw, _postprocessing_config(), CLIP_DURATION_S).to_dict()

        assert payload["segments"], "TranscriptionResult.segments must not be empty"
        assert payload["segments"][0]["speaker_id"] == DOCTOR
        assert payload["segments"][0]["speaker_confidence"] == pytest.approx(0.91, abs=1e-4)
        assert payload["segments"][0]["end_time"] == pytest.approx(SEG_A[1], abs=1e-3)

    def test_an_undiarized_job_reports_no_speaker_rather_than_a_guess(self) -> None:
        service = _service()
        raw = RawTranscription(text="Patient reports chest pain.", segments=_bounded_segments()[:1])

        result = service._postprocess(raw, _postprocessing_config(), CLIP_DURATION_S)

        assert result.build_transcript_segments()[0]["speaker"] is None
        # ...but the span itself is still published: timing does not depend on it.
        assert result.segments[0].end_time == pytest.approx(SEG_A[1], abs=1e-3)


class TestTranscribeWiresBothThrough:
    """The orchestration seam both defects lived in, driven end to end."""

    def _pipeline_config(self) -> PipelineConfig:
        spec = PipelineSpec(
            version="1.0",
            models=ModelRefs(asr=ModelRef(slug="whisper-test"), vad=None, denoise=None),
            preprocessing=PreprocessingConfig(target_sample_rate=SAMPLE_RATE, normalize=True),
            inference=InferenceConfig(language="en", compute_type="float32", device="cpu"),
            postprocessing=_postprocessing_config(),
        )
        return PipelineConfig(
            id="p-991",
            tenant_id="t-991",
            slug="test-dia",
            name="Diarizing test agent",
            description=None,
            spec=spec,
            tags=[],
            created_at=datetime(2026, 9, 19),
            updated_at=datetime(2026, 9, 19),
        )

    def _loaded_model(self) -> LoadedModel:
        return LoadedModel(
            model_id="m-whisper",
            model_slug="whisper-test",
            model=MagicMock(),
            processor=MagicMock(),
            format=AiModelFormat.WHISPER_CPP,  # the engine that serves a GGUF artifact
            memory_mb=80,
            device="cpu",
        )

    @pytest.mark.asyncio
    async def test_transcribe_emits_speakers_and_ends_inside_the_recording(self) -> None:
        service = _service()
        # Inference returns what inline diarization leaves behind: segments labelled
        # with their speaker. The second one keeps the engine's padded end, so this
        # also exercises `transcribe`'s backstop clamp for the full-audio path.
        annotated = _bounded_segments()
        annotated[0]["speaker_id"] = DOCTOR
        annotated[1]["speaker_id"] = "Speaker 2"
        annotated[1]["end"] = SEG_B[0] + PADDED_WINDOW_S

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt.transcription.batch_service.get_preprocessor") as mock_get_preproc,
            patch.object(service, "_run_per_segment_inference") as mock_inference,
        ):
            mock_load.return_value = {"asr": self._loaded_model(), "vad": None, "denoise": None}

            preprocessor = AsyncMock()
            preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(int(CLIP_DURATION_S * SAMPLE_RATE), dtype=np.float32),
                    sample_rate=SAMPLE_RATE,
                    duration_seconds=CLIP_DURATION_S,
                    segments=[
                        AudioSegment(start_time=SEG_A[0], end_time=SEG_A[1]),
                        AudioSegment(start_time=SEG_B[0], end_time=SEG_B[1]),
                    ],
                    vad_applied=True,
                )
            )
            mock_get_preproc.return_value = preprocessor

            mock_inference.return_value = RawTranscription(
                text="Patient reports chest pain. No shortness of breath.",
                language="en",
                segments=annotated,
            )

            result = await service.transcribe(
                job_id="job-991",
                audio_bytes=b"\x00" * 64,
                pipeline_config=self._pipeline_config(),
            )

        wire = result.build_transcript_segments()
        assert [seg["speaker"] for seg in wire] == [DOCTOR, "Speaker 2"]
        assert [seg["t0Ms"] for seg in wire] == [0, 5075]
        # 35075 before the fix — the padded window, 23 s past the end of the audio.
        assert [seg["t1Ms"] for seg in wire] == [4500, 11744]
