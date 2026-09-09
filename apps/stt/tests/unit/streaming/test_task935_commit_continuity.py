"""TASK-935 lane C — the settled prefix survives the sliding partial window.

TASK-934 lane S pinned the defect (`test_a_sliding_window_wipes_the_settled_prefix`):
`LocalAgreementPolicy` commits the agreed PREFIX of consecutive hypotheses, which
assumes a GROWING buffer, while the preprocessor feeds it a rolling TAIL bounded
to `partial_window_s`. The moment the tail starts sliding, every hypothesis
begins at a different word, the policy reads that as a contradiction inside its
own committed region, and the settled prefix collapses to ZERO for the rest of
the utterance (`stable=0` on every live frame after `t=0.26-15.23`).

Owner decision OD-1 (a): text that has slid out of the window is FROZEN for
good — never re-decoded, never rolled back — and if the whole-buffer final
disagrees with it, the discrepancy is logged and the final wins as the persisted
record.

The tests below drive the policy over a synthetic 24 s utterance at one word per
second with a 15 s window: exactly the geometry of the served profile
(`{maxDecodeWindowSec: 7, partialWindowSec: 15}`) on the 24 s discharge clip.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest
import structlog
from structlog.testing import capture_logs

from stt.streaming.commit_policy import LocalAgreementPolicy
from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance
from stt.streaming.redis_streams import ResultPublisher
from stt.streaming.schemas import SegmentResult

WINDOW_S = 15.0
TOTAL_WORDS = 24  # one word per second — the length of the live discharge clip


def _word(index: int) -> str:
    return f"w{index:02d}"


def _windows(
    total_words: int = TOTAL_WORDS, window_s: float = WINDOW_S
) -> list[tuple[str, float, float]]:
    """``(hypothesis, window_start_time, window_end_time)`` per emitted partial.

    Mirrors ``StreamingPreprocessor._maybe_emit_partial``: the snapshot is the
    last ``window_s`` seconds of the utterance buffer, so the hypothesis starts
    mid-utterance once the buffer outgrows the window.
    """
    frames: list[tuple[str, float, float]] = []
    for second in range(1, total_words + 1):
        end = float(second)
        start = max(0.0, end - window_s)
        words = [_word(i) for i in range(int(start), second)]
        frames.append((" ".join(words), start, end))
    return frames


@pytest.mark.unit
class TestGrowingBufferUnchanged:
    """While the window has not slid, behaviour is identical to today's."""

    def test_an_untrimmed_window_decides_exactly_what_no_window_decides(self) -> None:
        anchored = LocalAgreementPolicy()
        plain = LocalAgreementPolicy()

        for hypothesis, start, end in _windows(total_words=int(WINDOW_S)):
            assert start == 0.0  # nothing has left the window yet
            assert anchored.update(hypothesis, window_start_time=start, window_end_time=end) == (
                plain.update(hypothesis)
            )
        assert anchored.frozen_text == ""
        assert anchored.last_slide is None

    def test_the_window_arguments_are_optional(self) -> None:
        """Every existing caller (and every existing test) omits them."""
        policy = LocalAgreementPolicy()
        policy.update("hello wor")
        assert policy.update("hello world how") == ("hello", "world how")


@pytest.mark.unit
class TestSlidingWindowKeepsTheSettledPrefix:
    def test_the_settled_prefix_is_monotone_and_keeps_growing(self) -> None:
        policy = LocalAgreementPolicy()
        settled_chars: list[int] = []
        settled_words: list[int] = []

        for hypothesis, start, end in _windows():
            committed, _tentative = policy.update(
                hypothesis, window_start_time=start, window_end_time=end
            )
            settled_chars.append(len(committed))
            settled_words.append(len(committed.split()))

        assert settled_chars == sorted(settled_chars), settled_chars
        # ≥ 80 % of the utterance is settled before the final arrives.
        assert settled_words[-1] >= int(0.8 * TOTAL_WORDS), settled_words

    def test_the_frozen_text_is_the_words_whose_audio_left_the_window(self) -> None:
        policy = LocalAgreementPolicy()
        for hypothesis, start, end in _windows():
            policy.update(hypothesis, window_start_time=start, window_end_time=end)

        frozen = policy.frozen_text.split()
        full = [_word(i) for i in range(TOTAL_WORDS)]
        # The frozen region is the utterance's own opening words, in order.
        assert frozen == full[: len(frozen)]
        # The last window starts at 9.0 s, so at least the first eight words
        # (whose audio ended before it) must have been frozen rather than lost.
        assert len(frozen) >= 8, policy.frozen_text

    def test_stable_chars_indexes_the_published_text(self) -> None:
        policy = LocalAgreementPolicy()
        for hypothesis, start, end in _windows():
            committed, tentative = policy.update(
                hypothesis, window_start_time=start, window_end_time=end
            )
            published = policy.published_text
            stable_chars = len(committed)
            assert published[:stable_chars] == committed
            assert published.endswith(tentative)
            assert 0 <= stable_chars <= len(published)

    def test_a_slide_is_reported_once_with_its_two_lengths(self) -> None:
        policy = LocalAgreementPolicy()
        frames = _windows()
        for hypothesis, start, end in frames[: int(WINDOW_S)]:
            policy.update(hypothesis, window_start_time=start, window_end_time=end)
        assert policy.last_slide is None  # nothing has left the window yet

        hypothesis, start, end = frames[int(WINDOW_S)]
        committed, _ = policy.update(hypothesis, window_start_time=start, window_end_time=end)
        frozen_chars, in_window_chars = policy.last_slide
        assert frozen_chars == len(policy.frozen_text)
        assert frozen_chars > 0
        assert frozen_chars + 1 + in_window_chars == len(committed)


@pytest.mark.unit
class TestRevisionRules:
    """In-window text may still be revised; frozen text may not."""

    def _drive_to_first_slide(self) -> LocalAgreementPolicy:
        policy = LocalAgreementPolicy()
        for hypothesis, start, end in _windows()[: int(WINDOW_S) + 1]:
            policy.update(hypothesis, window_start_time=start, window_end_time=end)
        assert policy.frozen_text == _word(0)
        return policy

    def test_a_revised_word_inside_the_window_still_rolls_back(self) -> None:
        policy = self._drive_to_first_slide()
        settled_before = policy.committed_text
        assert len(settled_before.split()) > 5

        # t=17 s: the window is [2, 17] and the engine revises w05.
        revised = " ".join("zz" if i == 5 else _word(i) for i in range(2, 17))
        committed, _ = policy.update(revised, window_start_time=2.0, window_end_time=17.0)

        assert "zz" not in committed
        assert len(committed.split()) < len(settled_before.split())
        assert _word(5) not in committed.split()

    def test_a_word_that_left_the_window_is_never_revised(self) -> None:
        policy = self._drive_to_first_slide()
        frozen_before = policy.frozen_text

        # The engine disagrees about everything the new window can still hear.
        committed, _ = policy.update(
            "totally different text entirely", window_start_time=2.0, window_end_time=17.0
        )

        assert policy.frozen_text.startswith(frozen_before)
        assert committed.startswith(frozen_before)
        assert policy.published_text.startswith(frozen_before)


@pytest.mark.unit
class TestFinalHandover:
    def test_reset_hands_the_frozen_text_over_once(self) -> None:
        policy = LocalAgreementPolicy()
        for hypothesis, start, end in _windows():
            policy.update(hypothesis, window_start_time=start, window_end_time=end)
        frozen = policy.frozen_text
        assert frozen

        policy.reset()

        assert policy.frozen_text == ""
        assert policy.committed_text == ""
        assert policy.take_handover_text() == frozen
        assert policy.take_handover_text() == ""  # consumed exactly once


# ---------------------------------------------------------------------------
# Session wiring — what is published, and the final-handover log
# ---------------------------------------------------------------------------


def _make_manager() -> Any:
    with patch("stt.streaming.session_manager.get_settings") as mock_settings:
        mock_settings.side_effect = Exception("no settings in test")
        from stt.streaming.execution_profile import ExecutionProfile
        from stt.streaming.session_manager import SessionManager

        profile = MagicMock(spec=ExecutionProfile)
        profile.max_concurrent_streams = 5
        return SessionManager(redis=AsyncMock(), profile=profile)


def _utterance(start: float, end: float) -> AudioUtterance:
    return AudioUtterance(
        samples=np.zeros(160, dtype=np.float32),
        sample_rate=16000,
        start_time=start,
        end_time=end,
        utterance_index=0,
        is_final=False,
    )


def _result(text: str, start: float, end: float) -> SegmentResult:
    return SegmentResult(text=text, start_time=start, end_time=end, is_final=False)


@pytest.fixture
def _isolate_structlog():
    """`capture_logs()` cannot intercept a logger frozen by an earlier test's
    `setup_logging` (cache_logger_on_first_use)."""
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


@pytest.mark.unit
class TestPartialPublish:
    @pytest.mark.asyncio
    async def test_the_published_partial_carries_the_frozen_prefix(self) -> None:
        mgr = _make_manager()
        mgr._commit_policies["sess-1"] = LocalAgreementPolicy()
        publisher = AsyncMock(spec=ResultPublisher)
        worker = AsyncMock(spec=StreamingInferenceWorker)

        for hypothesis, start, end in _windows():
            worker.process_partial = AsyncMock(return_value=_result(hypothesis, start, end))
            mgr._fire_partial("sess-1", _utterance(start, end), worker, publisher)
            await asyncio.sleep(0.02)

        published = [c.args[0] for c in publisher.publish.await_args_list]
        assert len(published) == TOTAL_WORDS
        last = published[-1]
        # The caption is the whole utterance so far, not just the 15 s tail.
        assert last.text.split()[0] == _word(0)
        assert last.stable_chars is not None
        assert last.text[: last.stable_chars].split() == [
            _word(i) for i in range(len(last.text[: last.stable_chars].split()))
        ]
        stable = [p.stable_chars for p in published]
        assert stable == sorted(stable), stable

    @pytest.mark.asyncio
    async def test_a_slide_is_logged_once_at_debug(self, _isolate_structlog) -> None:
        mgr = _make_manager()
        mgr._commit_policies["sess-1"] = LocalAgreementPolicy()
        publisher = AsyncMock(spec=ResultPublisher)
        worker = AsyncMock(spec=StreamingInferenceWorker)

        with capture_logs() as logs:
            for hypothesis, start, end in _windows():
                worker.process_partial = AsyncMock(return_value=_result(hypothesis, start, end))
                mgr._fire_partial("sess-1", _utterance(start, end), worker, publisher)
                await asyncio.sleep(0.02)

        slides = [entry for entry in logs if entry["event"] == "stt.streaming.commit.slide"]
        # One per sliding partial — 24 partials, the first 15 do not slide.
        assert len(slides) == TOTAL_WORDS - int(WINDOW_S)
        assert slides[0]["log_level"] == "debug"
        assert slides[0]["frozen_chars"] > 0


@pytest.mark.unit
class TestFinalHandoverLogging:
    def _policy_with_frozen_text(self) -> LocalAgreementPolicy:
        policy = LocalAgreementPolicy()
        for hypothesis, start, end in _windows():
            policy.update(hypothesis, window_start_time=start, window_end_time=end)
        policy.reset()
        return policy

    def test_an_agreeing_final_logs_nothing(self, _isolate_structlog) -> None:
        mgr = _make_manager()
        policy = self._policy_with_frozen_text()
        mgr._commit_policies["sess-1"] = policy

        with capture_logs() as logs:
            mgr._check_final_handover("sess-1", " ".join(_word(i) for i in range(TOTAL_WORDS)))

        assert [e for e in logs if e["event"] == "stt.streaming.commit.final_mismatch"] == []

    def test_a_disagreeing_final_logs_a_warning_and_still_wins(self, _isolate_structlog) -> None:
        mgr = _make_manager()
        policy = self._policy_with_frozen_text()
        mgr._commit_policies["sess-1"] = policy
        final_text = "an entirely different transcript of the same audio"

        with capture_logs() as logs:
            mgr._check_final_handover("sess-1", final_text)

        mismatches = [e for e in logs if e["event"] == "stt.streaming.commit.final_mismatch"]
        assert len(mismatches) == 1
        assert mismatches[0]["log_level"] == "warning"
        assert mismatches[0]["session_id"] == "sess-1"
        assert mismatches[0]["frozen_text"]
        assert mismatches[0]["final_text"]

    def test_punctuation_and_case_do_not_count_as_a_mismatch(self, _isolate_structlog) -> None:
        mgr = _make_manager()
        policy = self._policy_with_frozen_text()
        mgr._commit_policies["sess-1"] = policy
        noisy = ", ".join(_word(i).upper() for i in range(TOTAL_WORDS)) + "."

        with capture_logs() as logs:
            mgr._check_final_handover("sess-1", noisy)

        assert [e for e in logs if e["event"] == "stt.streaming.commit.final_mismatch"] == []

    def test_the_handover_is_checked_once_per_utterance(self, _isolate_structlog) -> None:
        mgr = _make_manager()
        mgr._commit_policies["sess-1"] = self._policy_with_frozen_text()

        with capture_logs() as logs:
            mgr._check_final_handover("sess-1", "nothing like it")
            mgr._check_final_handover("sess-1", "nothing like it")

        assert len([e for e in logs if e["event"] == "stt.streaming.commit.final_mismatch"]) == 1
