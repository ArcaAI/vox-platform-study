"""Unit tests for Transcription DTOs."""

import pytest

from stt_v2.transcription.dto import (
    AudioSegment,
    ProcessedAudio,
    SentenceTimestamp,
    StreamingChunkResult,
    StreamingSession,
    TranscriptionJobContext,
    TranscriptionResult,
    WordTimestamp,
)


class TestWordTimestamp:
    """Tests for WordTimestamp dataclass."""

    def test_basic_creation(self):
        """Test basic word timestamp creation."""
        wt = WordTimestamp(
            word="hello",
            start_time=0.5,
            end_time=0.8,
            confidence=0.95,
        )

        assert wt.word == "hello"
        assert wt.start_time == 0.5
        assert wt.end_time == 0.8
        assert wt.confidence == 0.95

    def test_default_confidence(self):
        """Test default confidence value."""
        wt = WordTimestamp(word="test", start_time=0.0, end_time=0.5)

        assert wt.confidence == 1.0


class TestAudioSegment:
    """Tests for AudioSegment dataclass."""

    def test_duration_property(self):
        """Test duration calculation."""
        segment = AudioSegment(
            start_time=1.5,
            end_time=4.5,
            is_speech=True,
        )

        assert segment.duration == 3.0

    def test_default_values(self):
        """Test default values."""
        segment = AudioSegment(start_time=0.0, end_time=1.0)

        assert segment.is_speech is True
        assert segment.confidence == 1.0


class TestProcessedAudio:
    """Tests for ProcessedAudio dataclass."""

    def test_with_all_flags(self):
        """Test with all processing flags."""
        import numpy as np

        samples = np.zeros(16000, dtype=np.float32)

        processed = ProcessedAudio(
            samples=samples,
            sample_rate=16000,
            duration_seconds=1.0,
            was_resampled=True,
            was_normalized=True,
            vad_applied=True,
            denoise_applied=True,
            segments=[AudioSegment(0.0, 1.0)],
        )

        assert processed.was_resampled is True
        assert processed.was_normalized is True
        assert processed.vad_applied is True
        assert processed.denoise_applied is True
        assert len(processed.segments) == 1


class TestTranscriptionResult:
    """Tests for TranscriptionResult dataclass."""

    @pytest.fixture
    def sample_result(self):
        """Create sample transcription result."""
        return TranscriptionResult(
            text="Hello world, this is a test.",
            language="en",
            language_probability=0.98,
            duration_seconds=3.5,
            processing_time_seconds=1.2,
            word_timestamps=[
                WordTimestamp("Hello", 0.0, 0.5),
                WordTimestamp("world", 0.6, 1.0),
            ],
            sentence_timestamps=[
                SentenceTimestamp(
                    "Hello world, this is a test.",
                    0.0,
                    3.5,
                    english_text="Hello world, this is a test.",
                ),
            ],
            metadata={"model": "whisper-large"},
        )

    def test_to_dict(self, sample_result):
        """Test conversion to dictionary."""
        result_dict = sample_result.to_dict()

        assert result_dict["text"] == "Hello world, this is a test."
        assert result_dict["language"] == "en"
        assert result_dict["language_probability"] == 0.98
        assert result_dict["duration_seconds"] == 3.5
        assert result_dict["processing_time_seconds"] == 1.2
        assert len(result_dict["word_timestamps"]) == 2
        assert len(result_dict["sentence_timestamps"]) == 1
        assert (
            result_dict["sentence_timestamps"][0]["english_text"] == "Hello world, this is a test."
        )
        assert result_dict["metadata"]["model"] == "whisper-large"

    def test_to_dict_word_timestamps_format(self, sample_result):
        """Test word timestamp format in dict."""
        result_dict = sample_result.to_dict()

        first_word = result_dict["word_timestamps"][0]

        assert first_word["word"] == "Hello"
        assert first_word["start_time"] == 0.0
        assert first_word["end_time"] == 0.5
        assert "confidence" in first_word


class TestStreamingChunkResult:
    """Tests for StreamingChunkResult dataclass."""

    def test_partial_result(self):
        """Test partial (non-final) chunk result."""
        result = StreamingChunkResult(
            text="partial text",
            is_final=False,
            segment_id=5,
            start_time=10.0,
            end_time=11.5,
        )

        assert result.is_final is False
        assert result.segment_id == 5

    def test_final_result(self):
        """Test final chunk result."""
        result = StreamingChunkResult(
            text="final segment",
            is_final=True,
            segment_id=10,
        )

        assert result.is_final is True


class TestStreamingSession:
    """Tests for StreamingSession dataclass."""

    @pytest.fixture
    def session(self):
        """Create a streaming session."""
        return StreamingSession(
            session_id="session-123",
            pipeline_id="pipeline-456",
            tenant_id="tenant-789",
            consultation_id="consult-abc",
        )

    def test_initial_state(self, session):
        """Test initial session state."""
        assert session.audio_buffer == b""
        assert session.total_duration_seconds == 0.0
        assert session.chunk_count == 0
        assert session.final_text == ""
        assert session.is_active is True

    def test_add_chunk(self, session):
        """Test adding audio chunk."""
        initial_time = session.last_activity

        session.add_chunk(b"audio data", 1.5)

        assert session.audio_buffer == b"audio data"
        assert session.total_duration_seconds == 1.5
        assert session.chunk_count == 1
        assert session.last_activity >= initial_time

    def test_add_multiple_chunks(self, session):
        """Test adding multiple chunks."""
        session.add_chunk(b"chunk1", 1.0)
        session.add_chunk(b"chunk2", 1.5)
        session.add_chunk(b"chunk3", 2.0)

        assert session.audio_buffer == b"chunk1chunk2chunk3"
        assert session.total_duration_seconds == 4.5
        assert session.chunk_count == 3

    def test_add_result_partial(self, session):
        """Test adding partial result."""
        result = StreamingChunkResult(
            text="partial",
            is_final=False,
            segment_id=0,
        )

        session.add_result(result)

        assert len(session.segments) == 1
        assert session.final_text == ""  # Not final, so not added to final_text

    def test_add_result_final(self, session):
        """Test adding final result."""
        result = StreamingChunkResult(
            text="final segment",
            is_final=True,
            segment_id=0,
        )

        session.add_result(result)

        assert session.final_text == "final segment"

    def test_add_multiple_final_results(self, session):
        """Test adding multiple final results."""
        session.add_result(StreamingChunkResult("First", is_final=True, segment_id=0))
        session.add_result(StreamingChunkResult("Second", is_final=True, segment_id=1))

        assert session.final_text == "First Second"

    def test_finalize(self, session):
        """Test finalizing session."""
        session.add_chunk(b"audio", 2.0)
        session.add_result(StreamingChunkResult("Hello", is_final=True, segment_id=0))
        session.add_result(StreamingChunkResult("World", is_final=True, segment_id=1))

        result = session.finalize()

        assert session.is_active is False
        assert isinstance(result, TranscriptionResult)
        assert result.text == "Hello World"
        assert result.duration_seconds == 2.0
        assert result.metadata["session_id"] == "session-123"


class TestTranscriptionJobContext:
    """Tests for TranscriptionJobContext dataclass."""

    def test_basic_context(self):
        """Test basic job context creation."""
        ctx = TranscriptionJobContext(
            job_id="job-123",
            tenant_id="tenant-456",
            pipeline_id="pipeline-789",
            consultation_id="consult-abc",
            audio_uri="s3://bucket/audio.wav",
        )

        assert ctx.job_id == "job-123"
        assert ctx.tenant_id == "tenant-456"
        assert ctx.pipeline_id == "pipeline-789"
        assert ctx.consultation_id == "consult-abc"

    def test_default_values(self):
        """Test default context values."""
        ctx = TranscriptionJobContext(
            job_id="job-123",
            tenant_id="tenant-456",
            pipeline_id="pipeline-789",
        )

        assert ctx.consultation_id is None
        assert ctx.media_id is None
        assert ctx.worker_id is None
        assert ctx.started_at is None
        assert ctx.max_retries == 3
        assert ctx.retry_count == 0


# =============================================================================
# TIMING METRICS TESTS
# =============================================================================


class TestTimingMetrics:
    """Tests for TimingMetrics dataclass."""

    def test_default_values(self):
        """Test all defaults are zero."""
        from stt_v2.transcription.dto import TimingMetrics

        tm = TimingMetrics()

        assert tm.ttfw_seconds == 0.0
        assert tm.model_loading_seconds == 0.0
        assert tm.preprocessing_seconds == 0.0
        assert tm.inference_seconds == 0.0
        assert tm.diarization_seconds == 0.0
        assert tm.postprocessing_seconds == 0.0
        assert tm.total_seconds == 0.0
        assert tm.segment_latencies == []

    def test_to_dict(self):
        """Test serialization to dict."""
        from stt_v2.transcription.dto import TimingMetrics

        tm = TimingMetrics(
            ttfw_seconds=1.2345,
            model_loading_seconds=0.5,
            preprocessing_seconds=0.3,
            inference_seconds=2.1,
            diarization_seconds=0.8,
            postprocessing_seconds=0.05,
            total_seconds=3.9845,
            segment_latencies=[
                {"segment_index": 0, "inference_time_s": 0.5},
            ],
        )

        d = tm.to_dict()

        assert d["ttfw_seconds"] == 1.2345
        assert d["model_loading_seconds"] == 0.5
        assert d["preprocessing_seconds"] == 0.3
        assert d["inference_seconds"] == 2.1
        assert d["diarization_seconds"] == 0.8
        assert d["postprocessing_seconds"] == 0.05
        assert d["total_seconds"] == 3.9845
        assert len(d["segment_latencies"]) == 1

    def test_to_dict_rounds_values(self):
        """Test that to_dict rounds to 4 decimal places."""
        from stt_v2.transcription.dto import TimingMetrics

        tm = TimingMetrics(ttfw_seconds=1.23456789)

        d = tm.to_dict()

        assert d["ttfw_seconds"] == 1.2346

    def test_segment_latencies_list(self):
        """Test segment latencies with multiple entries."""
        from stt_v2.transcription.dto import TimingMetrics

        latencies = [
            {
                "segment_index": 0,
                "start_time": 0.0,
                "end_time": 2.0,
                "duration_s": 2.0,
                "inference_time_s": 0.45,
            },
            {
                "segment_index": 1,
                "start_time": 3.0,
                "end_time": 5.0,
                "duration_s": 2.0,
                "inference_time_s": 0.52,
            },
        ]

        tm = TimingMetrics(segment_latencies=latencies)

        assert len(tm.segment_latencies) == 2
        d = tm.to_dict()
        assert d["segment_latencies"][0]["segment_index"] == 0
        assert d["segment_latencies"][1]["inference_time_s"] == 0.52


class TestTranscriptionResultWithTimingMetrics:
    """Tests for TranscriptionResult.to_dict() with TimingMetrics."""

    def test_to_dict_serializes_timing_metrics(self):
        """TimingMetrics in metadata should be serialized via to_dict()."""
        from stt_v2.transcription.dto import TimingMetrics

        tm = TimingMetrics(
            ttfw_seconds=1.5,
            inference_seconds=2.0,
            total_seconds=4.0,
        )

        result = TranscriptionResult(
            text="Hello",
            metadata={"timing": tm, "job_id": "j-1"},
        )

        d = result.to_dict()

        # TimingMetrics should be serialized as a dict, not the object
        assert isinstance(d["metadata"]["timing"], dict)
        assert d["metadata"]["timing"]["ttfw_seconds"] == 1.5
        assert d["metadata"]["timing"]["inference_seconds"] == 2.0
        # Non-TimingMetrics values should pass through unchanged
        assert d["metadata"]["job_id"] == "j-1"

    def test_to_dict_without_timing_metrics(self):
        """to_dict should work fine without TimingMetrics in metadata."""
        result = TranscriptionResult(
            text="Hello",
            metadata={"job_id": "j-1"},
        )

        d = result.to_dict()

        assert d["metadata"]["job_id"] == "j-1"

    def test_to_dict_with_empty_metadata(self):
        """to_dict should work with empty metadata."""
        result = TranscriptionResult(text="Hello")

        d = result.to_dict()

        assert d["metadata"] == {}


# =============================================================================
# TIMING METRICS EDGE CASES
# =============================================================================


class TestTimingMetricsEdgeCases:
    """Edge-case tests for TimingMetrics behaviour and serialization."""

    def test_all_zeros_to_dict(self):
        """All-zero TimingMetrics should serialize cleanly (no NaN, no None)."""
        from stt_v2.transcription.dto import TimingMetrics

        tm = TimingMetrics()
        d = tm.to_dict()

        for key in (
            "ttfw_seconds",
            "model_loading_seconds",
            "preprocessing_seconds",
            "inference_seconds",
            "diarization_seconds",
            "postprocessing_seconds",
            "total_seconds",
        ):
            assert d[key] == 0.0, f"{key} should be 0.0, got {d[key]}"
        assert d["segment_latencies"] == []

    def test_to_dict_all_fields_are_float(self):
        """Every numeric field in to_dict output must be a float (not int)."""
        from stt_v2.transcription.dto import TimingMetrics

        tm = TimingMetrics(
            ttfw_seconds=1,
            model_loading_seconds=2,
            preprocessing_seconds=3,
            inference_seconds=4,
        )
        d = tm.to_dict()

        for key in (
            "ttfw_seconds",
            "model_loading_seconds",
            "preprocessing_seconds",
            "inference_seconds",
            "diarization_seconds",
            "postprocessing_seconds",
            "total_seconds",
        ):
            assert isinstance(d[key], float), f"{key} should be float, got {type(d[key])}"

    def test_segment_latencies_independent_of_other_fields(self):
        """Segment latencies should be serialized even when all other fields are zero."""
        from stt_v2.transcription.dto import TimingMetrics

        tm = TimingMetrics(
            segment_latencies=[
                {"segment_index": 0, "inference_time_s": 0.0},
            ],
        )
        d = tm.to_dict()

        assert d["ttfw_seconds"] == 0.0
        assert len(d["segment_latencies"]) == 1

    def test_multiple_timing_metrics_in_metadata_serialize_independently(self):
        """Multiple TimingMetrics in metadata should each be serialized."""
        from stt_v2.transcription.dto import TimingMetrics

        tm1 = TimingMetrics(ttfw_seconds=1.0)
        tm2 = TimingMetrics(ttfw_seconds=2.0)

        result = TranscriptionResult(
            text="Hello",
            metadata={"timing_a": tm1, "timing_b": tm2, "plain": "value"},
        )

        d = result.to_dict()

        assert isinstance(d["metadata"]["timing_a"], dict)
        assert isinstance(d["metadata"]["timing_b"], dict)
        assert d["metadata"]["timing_a"]["ttfw_seconds"] == 1.0
        assert d["metadata"]["timing_b"]["ttfw_seconds"] == 2.0
        assert d["metadata"]["plain"] == "value"


class TestProcessedAudioEdgeCases:
    """Edge cases for ProcessedAudio dataclass completeness."""

    def test_default_flags_are_false(self):
        """All processing flags default to False/empty."""
        import numpy as np

        pa = ProcessedAudio(
            samples=np.zeros(100, dtype=np.float32),
            sample_rate=16000,
            duration_seconds=0.00625,
        )

        assert pa.was_resampled is False
        assert pa.was_normalized is False
        assert pa.vad_applied is False
        assert pa.denoise_applied is False
        assert pa.segments == []

    def test_complete_construction_all_fields(self):
        """Construct with ALL fields to verify nothing is missing."""
        import numpy as np

        pa = ProcessedAudio(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            duration_seconds=1.0,
            was_resampled=True,
            was_normalized=True,
            vad_applied=True,
            denoise_applied=True,
            segments=[AudioSegment(0.0, 0.5, is_speech=True, confidence=0.9)],
        )

        assert pa.was_resampled is True
        assert pa.was_normalized is True
        assert pa.vad_applied is True
        assert pa.denoise_applied is True
        assert len(pa.segments) == 1
        assert pa.segments[0].confidence == 0.9


# =============================================================================
# VAD MERGED WAV SILENCE PADDING TESTS
# =============================================================================


class TestVadMergedWavSilencePadding:
    """Tests for get_vad_merged_wav_bytes() silence padding.

    When diarization is enabled, 500ms of silence is added before and after
    each VAD speech segment during the merge-for-storage step.
    """

    @pytest.fixture
    def _make_processed_audio(self):
        """Factory to create a ProcessedAudio with speech segments."""
        import numpy as np

        def _factory(
            duration_s: float = 2.0,
            sample_rate: int = 16000,
            segments: list | None = None,
        ) -> ProcessedAudio:
            num_samples = int(duration_s * sample_rate)
            # Use a recognisable non-zero signal so silence (zeros) is detectable
            samples = np.sin(np.linspace(0, 2 * np.pi * 440, num_samples)).astype(np.float32) * 0.5

            if segments is None:
                segments = [AudioSegment(0.2, 0.8, is_speech=True)]

            return ProcessedAudio(
                samples=samples,
                sample_rate=sample_rate,
                duration_seconds=duration_s,
                segments=segments,
                vad_applied=True,
            )

        return _factory

    # ------------------------------------------------------------------
    # Backward compatibility — default (no padding)
    # ------------------------------------------------------------------

    def test_default_no_padding(self, _make_processed_audio):
        """Default call (silence_padding_ms=0) produces no extra silence."""
        import io
        import wave

        pa = _make_processed_audio(
            segments=[AudioSegment(0.0, 0.5, is_speech=True)],
        )
        wav_bytes = pa.get_vad_merged_wav_bytes()
        assert wav_bytes is not None

        # Decode WAV to check sample count
        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            n_frames = wf.getnframes()

        # 0.5s at 16 kHz = 8000 samples — no padding
        expected_samples = int(0.5 * 16000)
        assert n_frames == expected_samples

    def test_explicit_zero_padding_matches_default(self, _make_processed_audio):
        """silence_padding_ms=0 is identical to the default call."""
        pa = _make_processed_audio(
            segments=[AudioSegment(0.0, 0.5, is_speech=True)],
        )
        default_bytes = pa.get_vad_merged_wav_bytes()
        zero_bytes = pa.get_vad_merged_wav_bytes(silence_padding_ms=0)
        assert default_bytes == zero_bytes

    # ------------------------------------------------------------------
    # Single segment with padding
    # ------------------------------------------------------------------

    def test_single_segment_with_500ms_padding(self, _make_processed_audio):
        """500ms silence before + after a single segment."""
        import io
        import wave

        pa = _make_processed_audio(
            segments=[AudioSegment(0.0, 0.5, is_speech=True)],
        )
        wav_bytes = pa.get_vad_merged_wav_bytes(silence_padding_ms=500)
        assert wav_bytes is not None

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            n_frames = wf.getnframes()

        speech_samples = int(0.5 * 16000)  # 8000
        padding_samples = int(0.5 * 16000)  # 8000 per side
        expected = speech_samples + 2 * padding_samples  # 24000
        assert n_frames == expected

    def test_silence_regions_are_zeros(self, _make_processed_audio):
        """The padded silence regions must contain zero-valued samples."""
        import io
        import wave

        import numpy as np

        pa = _make_processed_audio(
            segments=[AudioSegment(0.0, 0.5, is_speech=True)],
        )
        wav_bytes = pa.get_vad_merged_wav_bytes(silence_padding_ms=500)
        assert wav_bytes is not None

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            raw = wf.readframes(wf.getnframes())

        int16_samples = np.frombuffer(raw, dtype=np.int16)
        padding_len = int(0.5 * 16000)  # 8000 samples

        # Leading silence
        leading = int16_samples[:padding_len]
        assert np.all(leading == 0), "Leading silence should be all zeros"

        # Trailing silence
        trailing = int16_samples[-padding_len:]
        assert np.all(trailing == 0), "Trailing silence should be all zeros"

        # Speech in the middle should NOT be all zeros
        speech = int16_samples[padding_len:-padding_len]
        assert not np.all(speech == 0), "Speech region should contain non-zero samples"

    # ------------------------------------------------------------------
    # Multiple segments with padding
    # ------------------------------------------------------------------

    def test_multiple_segments_with_padding(self, _make_processed_audio):
        """Each segment gets its own before/after padding."""
        import io
        import wave

        seg1 = AudioSegment(0.0, 0.3, is_speech=True)
        seg2 = AudioSegment(0.5, 0.8, is_speech=True)

        pa = _make_processed_audio(segments=[seg1, seg2])
        wav_bytes = pa.get_vad_merged_wav_bytes(silence_padding_ms=500)
        assert wav_bytes is not None

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            n_frames = wf.getnframes()

        sr = 16000
        speech1 = int(0.3 * sr)  # 4800
        speech2 = int(0.3 * sr)  # 4800
        padding = int(0.5 * sr)  # 8000 per pad
        # 2 segments x 2 pads each = 4 pads
        expected = speech1 + speech2 + 4 * padding
        assert n_frames == expected

    def test_non_speech_segments_are_skipped(self, _make_processed_audio):
        """Segments with is_speech=False should not appear in output."""
        import io
        import wave

        segments = [
            AudioSegment(0.0, 0.3, is_speech=True),
            AudioSegment(0.3, 0.5, is_speech=False),  # silence segment
            AudioSegment(0.5, 0.8, is_speech=True),
        ]

        pa = _make_processed_audio(segments=segments)
        wav_bytes = pa.get_vad_merged_wav_bytes(silence_padding_ms=500)
        assert wav_bytes is not None

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            n_frames = wf.getnframes()

        sr = 16000
        speech1 = int(0.3 * sr)
        speech2 = int(0.3 * sr)
        padding = int(0.5 * sr)
        # Only 2 speech segments, non-speech skipped
        expected = speech1 + speech2 + 4 * padding
        assert n_frames == expected

    # ------------------------------------------------------------------
    # Custom padding values
    # ------------------------------------------------------------------

    def test_custom_padding_250ms(self, _make_processed_audio):
        """Custom 250ms padding produces correct sample count."""
        import io
        import wave

        pa = _make_processed_audio(
            segments=[AudioSegment(0.0, 1.0, is_speech=True)],
        )
        wav_bytes = pa.get_vad_merged_wav_bytes(silence_padding_ms=250)
        assert wav_bytes is not None

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            n_frames = wf.getnframes()

        sr = 16000
        speech = int(1.0 * sr)
        padding = int(0.25 * sr)
        expected = speech + 2 * padding
        assert n_frames == expected

    def test_custom_padding_1000ms(self, _make_processed_audio):
        """1000ms (1 second) padding per side."""
        import io
        import wave

        pa = _make_processed_audio(
            segments=[AudioSegment(0.0, 0.5, is_speech=True)],
        )
        wav_bytes = pa.get_vad_merged_wav_bytes(silence_padding_ms=1000)
        assert wav_bytes is not None

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            n_frames = wf.getnframes()

        sr = 16000
        expected = int(0.5 * sr) + 2 * int(1.0 * sr)
        assert n_frames == expected

    # ------------------------------------------------------------------
    # Edge cases
    # ------------------------------------------------------------------

    def test_no_vad_returns_none(self):
        """When VAD was not applied, returns None regardless of padding."""
        import numpy as np

        pa = ProcessedAudio(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            duration_seconds=1.0,
            vad_applied=False,
        )
        assert pa.get_vad_merged_wav_bytes(silence_padding_ms=500) is None

    def test_empty_segments_returns_none(self):
        """When segments list is empty, returns None."""
        import numpy as np

        pa = ProcessedAudio(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            duration_seconds=1.0,
            vad_applied=True,
            segments=[],
        )
        assert pa.get_vad_merged_wav_bytes(silence_padding_ms=500) is None

    def test_only_non_speech_segments_returns_none(self):
        """When all segments are non-speech, returns None."""
        import numpy as np

        pa = ProcessedAudio(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            duration_seconds=1.0,
            vad_applied=True,
            segments=[AudioSegment(0.0, 0.5, is_speech=False)],
        )
        assert pa.get_vad_merged_wav_bytes(silence_padding_ms=500) is None

    def test_padding_with_8khz_sample_rate(self, _make_processed_audio):
        """Silence padding works correctly at 8kHz sample rate."""
        import io
        import wave

        pa = _make_processed_audio(
            sample_rate=8000,
            segments=[AudioSegment(0.0, 0.5, is_speech=True)],
        )
        wav_bytes = pa.get_vad_merged_wav_bytes(silence_padding_ms=500)
        assert wav_bytes is not None

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            n_frames = wf.getnframes()
            assert wf.getframerate() == 8000

        sr = 8000
        expected = int(0.5 * sr) + 2 * int(0.5 * sr)
        assert n_frames == expected
