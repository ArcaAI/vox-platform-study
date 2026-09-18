"""TASK-934 lane S — the partial window and the decode window are two knobs.

Measured 2026-09-09 on the served ml-en fine-tune: a PARTIAL decoded from a 6 s
tail window is garbage 31 % of the time, 10 % at 10 s and 0 % at 15 s, while the
FINAL wants short spans — Malayalam CER 0.381 at a 7 s decode window against
0.645 at 30 s. The profile that follows from those two measurements is
``{maxDecodeWindowSec: 7, partialWindowSec: 15}``, i.e. the two windows DISAGREE,
which the runtime did not previously allow:

``WhisperCppAsrAdapter`` froze one window at construction and applied it to every
buffer it was handed, so a 15 s partial was silently re-split into 7 s spans and
decoded exactly like the short window the measurement rejected. The window is now
a per-CALL argument: a final decodes in spans of the model's
``maxDecodeWindowSec``; a partial decodes in ONE span, because the preprocessor
already bounded it to the model's ``partialWindowSec``.

The same change closes G-6 — the window travels with the call rather than with
the adapter instance, so two sessions sharing a pinned model split differently.

The fake whisper.cpp model here is an ORACLE: the synthetic audio encodes one
word per constant-amplitude burst separated by silence, so a decode can be
checked for words LOST or DUPLICATED at a span boundary rather than merely for a
call count.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import AiModelFormat
from stt.pipeline.spec import bundle_from_resolved
from stt.streaming.commit_policy import LocalAgreementPolicy
from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance, StreamingPreprocessor
from stt.streaming.session_manager import SessionManager
from stt.streaming.whisper_cpp_asr import WhisperCppAsrAdapter

SAMPLE_RATE = 16000
WORD_S = 0.3  # speech per word
GAP_S = 0.1  # silence between words — where a span split must land
WORD_PERIOD_S = WORD_S + GAP_S
WORD_COUNT = 60  # 60 * 0.4 s = 24 s, the length of the live discharge clip


# ---------------------------------------------------------------------------
# Synthetic audio + the oracle that decodes it back
# ---------------------------------------------------------------------------


def _word_text(index: int) -> str:
    return f"w{index:02d}"


def _amplitude(index: int) -> float:
    """A per-word DC level, well above the hallucination RMS floor."""
    return 0.2 + 0.005 * index


def _oracle_audio(word_count: int = WORD_COUNT) -> np.ndarray:
    audio = np.zeros(int(word_count * WORD_PERIOD_S * SAMPLE_RATE), dtype=np.float32)
    for index in range(word_count):
        start = int(index * WORD_PERIOD_S * SAMPLE_RATE)
        audio[start : start + int(WORD_S * SAMPLE_RATE)] = _amplitude(index)
    return audio


def _decode_oracle(audio: np.ndarray) -> list[str]:
    """Read the words back out of a slice of oracle audio, in order.

    A word is recovered only from a burst long enough to be recognisable (half a
    word), so a span boundary that cuts a word in half is NOT silently repaired
    by the oracle — a mid-word cut shows up as a lost or doubled word.
    """
    words: list[str] = []
    voiced = np.flatnonzero(audio > 1e-6)
    if voiced.size == 0:
        return words
    breaks = np.flatnonzero(np.diff(voiced) > 1) + 1
    for run in np.split(voiced, breaks):
        if run.size < int(WORD_S * SAMPLE_RATE * 0.5):
            continue
        index = int(round((float(audio[run].mean()) - 0.2) / 0.005))
        words.append(_word_text(index))
    return words


def _full_transcript(word_count: int = WORD_COUNT) -> str:
    return " ".join(_word_text(i) for i in range(word_count))


class _OracleWhisperModel:
    """A pywhispercpp stand-in that transcribes the oracle audio it is handed.

    ``dead_zone_s`` models a MEASURED property of the served ml-en fine-tune
    (2026-09-09, `discharge_summary_01.wav`, q8_0 on Metal): a buffer truncated
    anywhere in 4.50–4.70 s decodes to the EMPTY string, deterministically —
    3 of 3 repeats — while 4.40 s and 4.80 s of the same audio decode normally.
    The engine returns nothing at all for such a span; it is not a short or
    garbled result that a downstream filter could catch.
    """

    def __init__(self, dead_zone_s: tuple[float, float] | None = None) -> None:
        self.calls: list[int] = []  # samples per decode
        self._dead_zone_s = dead_zone_s

    def transcribe(self, audio: np.ndarray, **_kwargs: Any) -> list[SimpleNamespace]:
        self.calls.append(len(audio))
        if self._dead_zone_s is not None:
            low, high = self._dead_zone_s
            if low <= len(audio) / SAMPLE_RATE <= high:
                return []
        return [
            SimpleNamespace(text=f" {word}", t0=0, t1=0, probability=1.0)
            for word in _decode_oracle(audio)
        ]


def _loaded_model(model: object) -> LoadedModel:
    return LoadedModel(
        model_id="task-934-oracle",
        model_slug="arcaai-whisper-large-ml-en-gguf-q8_0",
        model=model,
        format=AiModelFormat.WHISPER_CPP,
        device="cpu",
        extra={"model_path": "/weights/model.gguf", "num_threads": 4},
    )


def _adapter(model: object, *, max_decode_window_sec: float) -> WhisperCppAsrAdapter:
    return WhisperCppAsrAdapter(
        _loaded_model(model),
        SimpleNamespace(language=None, max_decode_window_sec=max_decode_window_sec),
    )


# ---------------------------------------------------------------------------
# 1. The decode window is a per-call argument (S-3 / G-6)
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestPerCallDecodeWindow:
    def test_the_constructed_window_still_governs_when_the_caller_says_nothing(self) -> None:
        model = _OracleWhisperModel()
        adapter = _adapter(model, max_decode_window_sec=7.0)

        result = adapter(_oracle_audio(), SAMPLE_RATE)

        assert len(model.calls) > 1  # 24 s split into <= 7 s spans
        assert result["text"] == _full_transcript()

    def test_a_caller_supplied_window_overrides_the_constructed_one(self) -> None:
        """The 15 s partial the measurement asked for must be ONE decode, even
        though the model's FINAL window is 7 s."""
        model = _OracleWhisperModel()
        adapter = _adapter(model, max_decode_window_sec=7.0)

        result = adapter(_oracle_audio(38), SAMPLE_RATE, max_decode_window_sec=0.0)

        assert len(model.calls) == 1
        assert result["text"] == _full_transcript(38)

    def test_one_pinned_adapter_serves_two_sessions_with_different_windows(self) -> None:
        """G-6 — the window follows the resolved spec, not the process lifetime.

        The adapter (and the weights under it) is shared; the two sessions'
        `AiModel._metadata.asr.maxDecodeWindowSec` values must still produce
        different span splits, with no restart and no second model load.
        """
        model = _OracleWhisperModel()
        adapter = _adapter(model, max_decode_window_sec=7.0)
        audio = _oracle_audio()

        adapter(audio, SAMPLE_RATE, max_decode_window_sec=7.0)
        seven_second_spans = len(model.calls)
        model.calls.clear()
        adapter(audio, SAMPLE_RATE, max_decode_window_sec=30.0)
        thirty_second_spans = len(model.calls)

        assert seven_second_spans > 1
        assert thirty_second_spans == 1

    def test_splits_land_in_silence_so_no_word_is_lost_or_doubled(self) -> None:
        """The span guard exists to protect a fine-tune from long audio; it must
        not cost words. Every 7 s split lands in a word gap."""
        model = _OracleWhisperModel()
        adapter = _adapter(model, max_decode_window_sec=7.0)

        text = adapter(_oracle_audio(), SAMPLE_RATE)["text"]

        assert text.split() == _full_transcript().split()


# ---------------------------------------------------------------------------
# 1b. A span the engine drops entirely (S-5)
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestEmptySpanRetry:
    """S-5 — the opening-sentence loss, reproduced and closed.

    Offline through this repo's own adapter and the real q8_0 weights
    (2026-09-09): the discharge fixture decodes fully as ONE buffer (WER 0.081)
    and loses its first 9.7 seconds at a 7 s decode window (WER 0.468). The
    mechanism is not run-to-run variance and not a post-filter — `_split_spans`
    snaps the first cut to the quietest frame at 4.625 s, and this fine-tune
    returns an EMPTY decode for a buffer truncated anywhere in 4.50–4.70 s. The
    span, not the sentence, is what disappears; the whole first span decoded to
    "" and the second to Malayalam noise.

    A span that carries speech and decodes to nothing is therefore retried once
    with its boundary pulled back — and the following span's start moves with
    it, so the audio partition stays exact: nothing skipped, nothing decoded
    twice.
    """

    # `_split_spans` cuts the 24 s oracle buffer into 3.5 / 3.605 ×4 / 6.095 s
    # spans at a 7 s window, so this dead zone drops the four middle ones —
    # 40 % of the transcript — exactly as the live 4.625 s cut dropped the
    # discharge clip's first span.
    DEAD_ZONE = (3.55, 3.65)

    def test_dropped_spans_are_retried_with_a_pulled_back_boundary(self) -> None:
        model = _OracleWhisperModel(dead_zone_s=self.DEAD_ZONE)
        adapter = _adapter(model, max_decode_window_sec=7.0)

        text = adapter(_oracle_audio(), SAMPLE_RATE)["text"]

        assert text.split() == _full_transcript().split()

    def test_the_retry_neither_skips_nor_duplicates_audio(self) -> None:
        """The pulled-back tail is picked up by the NEXT span, not dropped."""
        model = _OracleWhisperModel(dead_zone_s=self.DEAD_ZONE)
        adapter = _adapter(model, max_decode_window_sec=7.0)

        words = adapter(_oracle_audio(), SAMPLE_RATE)["text"].split()

        assert len(words) == len(set(words)) == WORD_COUNT

    def test_a_silent_span_is_not_retried(self) -> None:
        """Silence legitimately decodes to nothing; only speech is retried."""
        model = _OracleWhisperModel(dead_zone_s=(0.0, 1e9))
        adapter = _adapter(model, max_decode_window_sec=7.0)
        silence = np.zeros(int(24 * SAMPLE_RATE), dtype=np.float32)

        assert adapter(silence, SAMPLE_RATE)["text"] == ""
        assert len(model.calls) == len(adapter._split_spans(silence, SAMPLE_RATE, 7.0))

    def test_each_span_is_retried_at_most_once_and_never_the_last(self) -> None:
        """One retry, never two — and the last span has no following span to
        catch a trimmed tail, so trimming it would lose audio outright."""
        model = _OracleWhisperModel(dead_zone_s=(0.0, 1e9))  # every decode empty
        adapter = _adapter(model, max_decode_window_sec=7.0)
        audio = _oracle_audio()

        text = adapter(audio, SAMPLE_RATE)["text"]

        span_count = len(adapter._split_spans(audio, SAMPLE_RATE, 7.0))
        assert text == ""
        assert len(model.calls) == span_count + (span_count - 1)


# ---------------------------------------------------------------------------
# 2. The worker asks for the right window per utterance kind (S-2)
# ---------------------------------------------------------------------------


def _utterance(audio: np.ndarray, *, is_final: bool, start_time: float = 0.0) -> AudioUtterance:
    return AudioUtterance(
        samples=audio,
        sample_rate=SAMPLE_RATE,
        start_time=start_time,
        end_time=start_time + len(audio) / SAMPLE_RATE,
        utterance_index=0,
        is_final=is_final,
    )


def _worker(adapter: WhisperCppAsrAdapter, **kwargs: Any) -> StreamingInferenceWorker:
    async def run(samples, sample_rate, *, prompt=None, max_decode_window_sec=None):  # noqa: ANN001
        return adapter(
            samples, sample_rate, prompt=prompt, max_decode_window_sec=max_decode_window_sec
        )

    return StreamingInferenceWorker(result_publisher=None, asr_pipeline=run, **kwargs)


@pytest.mark.unit
class TestWorkerWindowSelection:
    @pytest.mark.asyncio
    async def test_a_partial_is_one_decode_of_the_partial_window(self) -> None:
        """15 s of tail, ONE decode — not two 7 s decodes of the same audio."""
        model = _OracleWhisperModel()
        worker = _worker(_adapter(model, max_decode_window_sec=7.0), max_decode_window_sec=7.0)

        result = await worker.process_partial(
            "s-934", _utterance(_oracle_audio(38), is_final=False)
        )

        assert len(model.calls) == 1
        assert result.text == _full_transcript(38)

    @pytest.mark.asyncio
    async def test_a_final_is_split_at_the_models_decode_window(self) -> None:
        model = _OracleWhisperModel()
        worker = _worker(_adapter(model, max_decode_window_sec=0.0), max_decode_window_sec=7.0)

        result = await worker.process_utterance("s-934", _utterance(_oracle_audio(), is_final=True))

        assert len(model.calls) > 1
        assert result.text == _full_transcript()

    @pytest.mark.asyncio
    async def test_a_worker_with_no_declared_window_leaves_the_adapter_alone(self) -> None:
        """No `maxDecodeWindowSec` on the row ⇒ the runtime default stands, and
        the adapter's own construction-time value is untouched."""
        model = _OracleWhisperModel()
        worker = _worker(_adapter(model, max_decode_window_sec=7.0))

        await worker.process_utterance("s-934", _utterance(_oracle_audio(), is_final=True))

        assert len(model.calls) > 1


# ---------------------------------------------------------------------------
# 3. The partial → final handover with the two windows disagreeing (S-2)
# ---------------------------------------------------------------------------


def _partials_from_preprocessor(audio: np.ndarray, partial_window_s: float) -> list[AudioUtterance]:
    """Drive the REAL partial windowing over a growing utterance buffer.

    `_maybe_emit_partial` is wall-clock gated, so the buffer is filled directly
    and the cadence timer reset per emit — the windowing under test is the tail
    trim, not the timer.
    """
    preprocessor = StreamingPreprocessor(
        session_id="s-934", sample_rate=SAMPLE_RATE, partial_window_s=partial_window_s
    )
    frame = preprocessor._frame_size
    state = preprocessor._state
    state.in_speech = True
    state.utterance_start_time = 0.0
    partials: list[AudioUtterance] = []
    for offset in range(0, len(audio) - frame + 1, frame):
        state.utterance_buffer.append(audio[offset : offset + frame])
        state.total_samples_fed += frame
        # Emit at every whole second of buffered audio.
        if state.total_samples_fed % SAMPLE_RATE < frame:
            state.last_partial_emitted_at = 0.0
            partial = preprocessor._maybe_emit_partial()
            if partial is not None:
                partials.append(partial)
    return partials


@pytest.mark.unit
class TestPartialToFinalHandover:
    def test_the_partial_window_bounds_the_partial_audio(self) -> None:
        partials = _partials_from_preprocessor(_oracle_audio(), partial_window_s=15.0)

        durations = [len(p.samples) / SAMPLE_RATE for p in partials]
        assert max(durations) == pytest.approx(15.0, abs=0.05)
        assert durations[-1] == pytest.approx(15.0, abs=0.05)

    @pytest.mark.asyncio
    async def test_settled_text_survives_into_the_final_exactly_once(self) -> None:
        """The last partial (one 15 s decode) and the final (7 s spans over the
        whole 24 s) decode DIFFERENT audio. What LocalAgreement-2 settled — and
        the clinician therefore already read as stable — must still appear in the
        final, contiguously and once: nothing dropped, nothing duplicated at the
        handover.
        """
        model = _OracleWhisperModel()
        worker = _worker(_adapter(model, max_decode_window_sec=0.0), max_decode_window_sec=7.0)
        policy = LocalAgreementPolicy()
        audio = _oracle_audio()

        settled = ""
        for partial in _partials_from_preprocessor(audio, partial_window_s=15.0):
            result = await worker.process_partial("s-934", partial)
            committed, _ = policy.update(result.text)
            if len(committed) > len(settled):
                settled = committed

        final = await worker.process_utterance("s-934", _utterance(audio, is_final=True))

        assert final.text == _full_transcript()
        settled_tokens = settled.split()
        assert settled_tokens, "the policy settled nothing to hand over"
        final_tokens = final.text.split()
        occurrences = [
            i
            for i in range(len(final_tokens) - len(settled_tokens) + 1)
            if final_tokens[i : i + len(settled_tokens)] == settled_tokens
        ]
        assert occurrences == [0]

    @pytest.mark.asyncio
    async def test_the_settled_prefix_survives_the_sliding_window(self) -> None:
        """TASK-935 lane C — the contract that replaced this TASK-934 finding.

        `LocalAgreementPolicy` commits the agreed PREFIX of consecutive
        hypotheses, which assumes a GROWING buffer; the preprocessor feeds it a
        rolling TAIL. Until TASK-935 the first slide read as a contradiction
        inside the policy's own committed region, so the settled prefix
        collapsed to ZERO and never recovered — the `stable=0` of the live frame
        dump, for the whole tail of every utterance longer than
        `partial_window_s`, and a second reason a longer partial window measured
        better (at 15 s the collapse happened 9 s later than at 6 s).

        Owner decision OD-1 (a): the policy now anchors each hypothesis to the
        audio span it decoded, FREEZES the text whose audio has left the window
        (never re-decoded, never rolled back) and runs LocalAgreement-2 on the
        overlap. Driven here through the REAL preprocessor windowing and the
        oracle decoder over the 24 s clip at a 15 s window.
        """
        model = _OracleWhisperModel()
        worker = _worker(_adapter(model, max_decode_window_sec=0.0), max_decode_window_sec=7.0)
        policy = LocalAgreementPolicy()
        audio = _oracle_audio()
        settled_chars: list[int] = []
        sliding_frames = 0

        for partial in _partials_from_preprocessor(audio, partial_window_s=15.0):
            result = await worker.process_partial("s-934", partial)
            committed, _ = policy.update(
                result.text,
                window_start_time=partial.start_time,
                window_end_time=partial.end_time,
            )
            settled_chars.append(len(committed))
            if partial.start_time > 0.5:  # the tail has left the utterance start
                sliding_frames += 1

        assert sliding_frames > 0, "the window never slid — check the geometry"
        # OD-1 (a): monotone through the utterance; no collapse at the slide.
        assert settled_chars == sorted(settled_chars), settled_chars
        # ≥ 80 % of the clip is settled before the final arrives.
        assert len(policy.committed_text.split()) >= int(0.8 * WORD_COUNT)
        # The frozen region is the clip's own opening words, in order.
        frozen = policy.frozen_text.split()
        assert frozen, "nothing was frozen even though the window slid"
        assert frozen == _full_transcript().split()[: len(frozen)]


# ---------------------------------------------------------------------------
# 4. The session's own window reaches its worker (S-3 wiring)
# ---------------------------------------------------------------------------


def _fixture_pipeline_spec(max_decode_window_sec: float, partial_window_sec: float) -> Any:
    here = Path(__file__).resolve()
    fixture = next(
        parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        for parent in here.parents
        if (parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json").is_file()
    )
    spec = json.loads(fixture.read_text(encoding="utf-8"))["platformDefault"]["expected"]
    spec["models"]["asr"]["metadata"] = {
        "maxDecodeWindowSec": max_decode_window_sec,
        "partialWindowSec": partial_window_sec,
    }
    bundle = bundle_from_resolved(spec)
    return bundle.pipeline_specs[bundle.spec.runtime_key]


async def _assemble(pipeline_spec: Any) -> Any:
    mgr = MagicMock(spec=SessionManager)
    mgr._profile = MagicMock()
    mgr._redis = AsyncMock()
    mgr._make_endpointer = MagicMock(return_value=None)
    mgr._build_preprocessor_vad_kwargs = lambda cfg: SessionManager._build_preprocessor_vad_kwargs(
        mgr, cfg
    )
    mgr._load_vad_service = AsyncMock(return_value=None)
    mgr._load_asr_pipeline = AsyncMock(return_value=(MagicMock(), None))
    mgr._load_gloss_pipeline = AsyncMock(return_value=None)
    mgr._spec_embedding_model_id = MagicMock(return_value=None)
    with patch("stt.streaming.session_manager.ResultPublisher"):
        return await SessionManager._assemble_session_runtime(
            mgr,
            session_id="s-934",
            tenant_id="t1",
            consultation_id=None,
            user_id=None,
            sample_rate=SAMPLE_RATE,
            pipeline_config=pipeline_spec,
            build_speaker_identifier=False,
        )


@pytest.mark.unit
class TestSessionWiring:
    @pytest.fixture(autouse=True)
    def _isolate_structlog_capture(self):
        """`capture_logs()` cannot intercept a logger frozen by an earlier test's
        `setup_logging` (cache_logger_on_first_use); reset structlog and hand the
        module a fresh logger, as `test_streaming_recording.py` does."""
        import structlog

        from stt.streaming import session_manager

        saved_config = structlog.get_config()
        saved_logger = session_manager.logger
        structlog.reset_defaults()
        session_manager.logger = structlog.get_logger("stt.streaming.session_manager")
        try:
            yield
        finally:
            session_manager.logger = saved_logger
            structlog.configure(**saved_config)

    @pytest.mark.asyncio
    async def test_two_sessions_get_their_own_geometry(self) -> None:
        short = await _assemble(_fixture_pipeline_spec(7, 15))
        long = await _assemble(_fixture_pipeline_spec(30, 30))

        assert short.inference_worker._max_decode_window_sec == 7.0
        assert short.preprocessor._partial_window_s == 15.0
        assert long.inference_worker._max_decode_window_sec == 30.0
        assert long.preprocessor._partial_window_s == 30.0

    @pytest.mark.asyncio
    async def test_both_windows_are_logged_once_per_session(self) -> None:
        """S-4 — the answer the 2026-09-09 experiment had to guess at.

        The row said 15 s and the runtime ran 6 s, and nothing in the log said
        so. Both windows are now stated at INFO, beside the ASR row they came
        from, once per session.
        """
        from structlog.testing import capture_logs

        with capture_logs() as logs:
            await _assemble(_fixture_pipeline_spec(7, 15))

        events = [entry for entry in logs if entry.get("event") == "stt.streaming.windows"]
        assert len(events) == 1
        assert events[0]["log_level"] == "info"
        assert events[0]["partial_window_s"] == 15.0
        assert events[0]["max_decode_window_sec"] == 7.0
        assert events[0]["model_slug"] == "arcaai-whisper-large-ml-en-gguf"
        assert events[0]["session_id"] == "s-934"
