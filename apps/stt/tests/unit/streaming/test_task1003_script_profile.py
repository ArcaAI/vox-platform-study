"""TASK-1003 F-15 — script-profile telemetry for the ml-en code-switch fine-tune.

`_is_script_mismatch` (TASK-946) only ever fires for a session PINNED to a
Latin-script language (`en`, `vi`): an unpinned code-switch pair
(`language=None`) has nothing to contradict, so a session that answers ENTIRELY
in Malayalam script never trips it. This suite pins the observability signal
that covers that gap: a per-script (latin / malayalam / other) letter count,
folded into a running per-session total, reported through a bounded-cadence
structured log line AND a Prometheus counter labeled only by script class.

Owner decision OD-6 (TASK-1003, README §7.1): **no routing**. The signal must
never change the language, trigger an engine switch or fallback, or alter the
published transcript — `TestNoRouting` pins that directly.
"""

from __future__ import annotations

import numpy as np
import pytest
import structlog
from structlog.testing import capture_logs

from stt.core.metrics import STREAMING_SCRIPT_PROFILE_CHARS_TOTAL
from stt.pipeline.language_modes import classify_script_chars
from stt.streaming import inference as inference_module
from stt.streaming.engine_switch import SWITCHABLE_ASR_ERRORS
from stt.streaming.inference import _SCRIPT_PROFILE_LOG_EVERY_N_FINALS, StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance

MALAYALAM = "രോഗിക്ക് നെഞ്ചുവേദന ഉണ്ട് രണ്ട് ദിവസമായി"
ENGLISH = "the patient reports severe chest pain for two days"
MIXED = f"{ENGLISH} {MALAYALAM}"


def _worker(texts: list[str], *, language: str | None) -> StreamingInferenceWorker:
    calls = {"n": 0}

    def _asr(samples, sample_rate):  # noqa: ANN001
        text = texts[min(calls["n"], len(texts) - 1)]
        calls["n"] += 1
        return {"text": text, "word_timestamps": []}

    return StreamingInferenceWorker(asr_pipeline=_asr, language=language)


def _utt(index: int, *, is_final: bool = True, start: float = 0.0, end: float = 5.0):
    n = max(1, int((end - start) * 16000))
    return AudioUtterance(
        samples=(np.random.randn(n) * 0.1).astype(np.float32),
        sample_rate=16000,
        start_time=start,
        end_time=end,
        utterance_index=index,
        is_final=is_final,
    )


def _counter_value(script: str) -> float:
    return STREAMING_SCRIPT_PROFILE_CHARS_TOTAL.labels(script=script)._value.get()


@pytest.fixture
def _isolate_structlog():
    """`capture_logs()` cannot intercept a logger frozen by an earlier test's
    `setup_logging` (cache_logger_on_first_use)."""
    saved_config = structlog.get_config()
    saved_logger = inference_module.logger
    structlog.reset_defaults()
    inference_module.logger = structlog.get_logger("stt.streaming.inference")
    try:
        yield
    finally:
        inference_module.logger = saved_logger
        structlog.configure(**saved_config)


class TestCountsAccumulateRegardlessOfPin:
    async def test_an_unpinned_code_switch_session_is_still_classified(self) -> None:
        """The whole reason this exists: a code-switch pair (`language=None`) is
        UNPINNED, so `_is_script_mismatch` never runs for it — but the profile must."""
        worker = _worker([MALAYALAM], language=None)
        await worker.process_utterance("s1", _utt(0))

        expected_latin, expected_malayalam, expected_other = classify_script_chars(MALAYALAM)
        assert worker._script_profile_malayalam_chars == expected_malayalam
        assert worker._script_profile_latin_chars == expected_latin
        assert worker._script_profile_other_chars == expected_other
        assert worker._script_profile_finals == 1

    async def test_a_pinned_session_is_classified_too(self) -> None:
        worker = _worker([ENGLISH], language="en")
        await worker.process_utterance("s1", _utt(0))

        expected_latin, _, _ = classify_script_chars(ENGLISH)
        assert worker._script_profile_latin_chars == expected_latin
        assert worker._script_profile_finals == 1

    async def test_mixed_text_splits_across_both_classes(self) -> None:
        worker = _worker([MIXED], language=None)
        await worker.process_utterance("s1", _utt(0))

        assert worker._script_profile_latin_chars > 0
        assert worker._script_profile_malayalam_chars > 0

    async def test_counts_are_cumulative_across_finals(self) -> None:
        worker = _worker([ENGLISH, MALAYALAM], language=None)
        await worker.process_utterance("s1", _utt(0))
        after_first_latin = worker._script_profile_latin_chars
        await worker.process_utterance("s1", _utt(1, start=5.0, end=10.0))

        assert worker._script_profile_latin_chars == after_first_latin
        assert worker._script_profile_malayalam_chars > 0
        assert worker._script_profile_finals == 2

    async def test_a_non_final_utterance_does_not_count(self) -> None:
        """Only FINALS carry a settled decode worth counting."""
        worker = _worker(["the patient rep"], language=None)
        await worker.process_utterance("s1", _utt(0, is_final=False))

        assert worker._script_profile_finals == 0

    async def test_an_empty_final_does_not_count(self) -> None:
        worker = _worker([""], language=None)
        await worker.process_utterance("s1", _utt(0))

        assert worker._script_profile_finals == 0


class TestPrometheusCounter:
    async def test_labeled_only_by_script_class(self) -> None:
        before_latin = _counter_value("latin")
        before_malayalam = _counter_value("malayalam")

        worker = _worker([MIXED], language=None)
        await worker.process_utterance("s1", _utt(0))

        expected_latin, expected_malayalam, _ = classify_script_chars(MIXED)
        assert _counter_value("latin") == before_latin + expected_latin
        assert _counter_value("malayalam") == before_malayalam + expected_malayalam

    async def test_accumulates_across_sessions(self) -> None:
        """A fleet-wide Counter, not a per-session gauge — two sessions add up."""
        before = _counter_value("malayalam")
        worker_a = _worker([MALAYALAM], language=None)
        worker_b = _worker([MALAYALAM], language=None)
        await worker_a.process_utterance("s1", _utt(0))
        await worker_b.process_utterance("s2", _utt(0))

        one_session_chars = classify_script_chars(MALAYALAM)[1]
        assert _counter_value("malayalam") == before + 2 * one_session_chars


class TestBoundedCadenceLog:
    async def test_no_log_before_the_cadence_is_reached(self, _isolate_structlog) -> None:
        worker = _worker([ENGLISH], language=None)
        with capture_logs() as logs:
            for i in range(_SCRIPT_PROFILE_LOG_EVERY_N_FINALS - 1):
                await worker.process_utterance(
                    "s1", _utt(i, start=float(5 * i), end=float(5 * i + 5))
                )

        profiles = [e for e in logs if e["event"] == "stt.streaming.script_profile"]
        assert profiles == []

    async def test_logs_once_the_cadence_is_hit_with_cumulative_counts(
        self, _isolate_structlog
    ) -> None:
        worker = _worker([ENGLISH], language=None)
        with capture_logs() as logs:
            for i in range(_SCRIPT_PROFILE_LOG_EVERY_N_FINALS):
                await worker.process_utterance(
                    "s1", _utt(i, start=float(5 * i), end=float(5 * i + 5))
                )

        profiles = [e for e in logs if e["event"] == "stt.streaming.script_profile"]
        assert len(profiles) == 1
        entry = profiles[0]
        assert entry["finals"] == _SCRIPT_PROFILE_LOG_EVERY_N_FINALS
        assert entry["latin_chars"] == worker._script_profile_latin_chars
        assert entry["malayalam_chars"] == worker._script_profile_malayalam_chars
        assert entry["other_chars"] == worker._script_profile_other_chars
        assert entry["language"] is None
        assert entry["session_id"] == "s1"

    async def test_logs_again_at_the_next_multiple(self, _isolate_structlog) -> None:
        worker = _worker([ENGLISH], language="en")
        total = 2 * _SCRIPT_PROFILE_LOG_EVERY_N_FINALS
        with capture_logs() as logs:
            for i in range(total):
                await worker.process_utterance(
                    "s1", _utt(i, start=float(5 * i), end=float(5 * i + 5))
                )

        profiles = [e for e in logs if e["event"] == "stt.streaming.script_profile"]
        assert len(profiles) == 2
        assert profiles[0]["finals"] == _SCRIPT_PROFILE_LOG_EVERY_N_FINALS
        assert profiles[1]["finals"] == total


class TestNoRouting:
    """OD-6 (TASK-1003): this signal counts, it never decides."""

    async def test_a_malayalam_only_final_on_an_unpinned_session_still_publishes_verbatim(
        self,
    ) -> None:
        worker = _worker([MALAYALAM], language=None)
        pipeline_before = worker._asr_pipeline

        result = await worker.process_utterance("s1", _utt(0))

        assert result.text.strip() == MALAYALAM
        assert worker._asr_pipeline is pipeline_before
        assert worker._language is None

    async def test_no_switchable_asr_error_is_raised(self) -> None:
        """`process_utterance` only maps `SWITCHABLE_ASR_ERRORS` to a fallback path —
        the script-profile bookkeeping must never be a source of one."""
        worker = _worker([MALAYALAM], language=None)
        try:
            await worker.process_utterance("s1", _utt(0))
        except SWITCHABLE_ASR_ERRORS:
            pytest.fail("script-profile recording triggered an engine-switchable error")

    async def test_repeated_all_malayalam_finals_never_flip_the_pin(self) -> None:
        worker = _worker([MALAYALAM, MALAYALAM, MALAYALAM], language=None)
        for i in range(3):
            await worker.process_utterance("s1", _utt(i, start=float(5 * i), end=float(5 * i + 5)))

        assert worker._language is None
        assert worker._expects_latin_script is False
