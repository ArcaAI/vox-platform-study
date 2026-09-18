"""TASK-985 M-09 / D3 §4.3-4.4 — the decoder prompt, bounded by the model's window.

The served composition reached ~922 tokens (pair priming ~70 + agent ~19 + fifty
Malayalam carry-forward words ~833) against a **224-token** prompt window, and
Whisper keeps the LAST tokens of an over-long prompt
(``all_tokens[nignored:][-remaining_prompt_length:]``). So after any
Malayalam-heavy final the configured priming and agent text were silently evicted
and nothing said so — which also means the pair-prompt A/B those arms exist to
measure was not measuring a prompt that survived to the decoder.

Two rules are pinned here:

* the priming text is RESERVED and the carry-forward is truncated from the LEFT;
* a PARTIAL carries no previous text at all.
"""

import numpy as np
import pytest

from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance

SAMPLE_RATE = 16000
PRIMING = "Clinical consultation. Malayalam and English."
MALAYALAM_WORD = "രോഗിക്ക്"


def _utt(*, is_final: bool, index: int = 0, start: float = 0.0, end: float = 2.0):
    n = max(1, int((end - start) * SAMPLE_RATE))
    return AudioUtterance(
        samples=(np.ones(n, dtype=np.float32) * 0.2),
        sample_rate=SAMPLE_RATE,
        start_time=start,
        end_time=end,
        utterance_index=index,
        is_final=is_final,
    )


class _RecordingAsr:
    """Engine callable that records the prompt it was handed.

    Exposes NO budget/tokenizer probe — the shape of every adapter today, which
    is what makes the architectural fallback the path under test.
    """

    def __init__(self, text: str = "ok") -> None:
        self.prompts: list[str | None] = []
        self.pass_kinds: list[str] = []
        self._text = text

    def __call__(self, samples, sample_rate, *, prompt=None, **kwargs):  # noqa: ANN001
        self.prompts.append(prompt)
        if "pass_kind" in kwargs:
            self.pass_kinds.append(kwargs["pass_kind"])
        return {"text": self._text, "word_timestamps": []}


class _ProbingAsr(_RecordingAsr):
    """The shape the decode lane is asked for: the model answers both questions.

    ``count_prompt_tokens`` is one token per word here so the arithmetic in these
    tests is readable; the real one is ``whisper_tokenize`` against the loaded
    context.
    """

    def __init__(self, budget: int, text: str = "ok") -> None:
        super().__init__(text=text)
        self._budget = budget

    def prompt_token_budget(self) -> int:
        return self._budget

    def count_prompt_tokens(self, text: str) -> int:
        return len(text.split())


def _worker(asr, **kwargs) -> StreamingInferenceWorker:
    return StreamingInferenceWorker(result_publisher=None, asr_pipeline=asr, **kwargs)


class TestTheBudgetIsDerivedFromTheModel:
    def test_the_engines_own_answer_wins(self):
        asr = _ProbingAsr(budget=40)
        worker = _worker(asr)
        assert worker._prompt_token_budget() == (40, True)

    def test_an_engine_with_no_probe_falls_back_to_whispers_architecture(self):
        worker = _worker(lambda s, sr, *, prompt=None: "ok")
        budget, derived = worker._prompt_token_budget()
        # 448 // 2 — `n_text_ctx` is 448 on every Whisper checkpoint size.
        assert (budget, derived) == (224, False)

    def test_a_probe_that_raises_does_not_fail_the_session(self):
        class _Broken(_ProbingAsr):
            def prompt_token_budget(self):
                raise RuntimeError("no context")

        worker = _worker(_Broken(budget=40))
        assert worker._prompt_token_budget() == (224, False)


class TestEvictionOrder:
    async def test_the_priming_text_survives_and_the_carry_is_cut_from_the_left(self):
        # Budget 10 "tokens" = 10 words under the stub tokenizer. PRIMING is 5
        # words, so 5 carry-forward words fit — and they must be the LAST five.
        asr = _ProbingAsr(budget=10)
        worker = _worker(asr, initial_prompt=PRIMING)
        worker._previous_text = "one two three four five six seven eight nine ten"

        await worker._run_inference(_utt(is_final=True))

        prompt = asr.prompts[-1]
        assert prompt is not None
        assert prompt.startswith(PRIMING)
        assert prompt.endswith("seven eight nine ten")
        assert "one two three" not in prompt

    async def test_a_priming_text_that_alone_exceeds_the_budget_drops_the_carry(self):
        asr = _ProbingAsr(budget=3)  # PRIMING is 5 stub tokens
        worker = _worker(asr, initial_prompt=PRIMING)
        worker._previous_text = "alpha beta gamma"

        await worker._run_inference(_utt(is_final=True))

        # The configured prompt is served WHOLE — truncating it mid-sentence is
        # worse than serving it — and the carry-forward is dropped entirely.
        assert asr.prompts[-1] == PRIMING

    async def test_a_malayalam_carry_is_bounded_without_an_engine_tokenizer(self):
        """The estimator must recognise that non-Latin script is token-expensive.

        Fifty Malayalam words composed to ~833 tokens in production. With no
        engine tokenizer the fallback estimate has to over-count them, or the
        budget is a bound in name only.
        """
        asr = _RecordingAsr()  # no budget probe -> 224, fallback estimator
        worker = _worker(asr, initial_prompt=PRIMING)
        worker._previous_text = " ".join([MALAYALAM_WORD] * 50)

        await worker._run_inference(_utt(is_final=True))

        prompt = asr.prompts[-1]
        assert prompt is not None
        assert prompt.startswith(PRIMING)
        assert prompt.count(MALAYALAM_WORD) < 50
        assert worker._count_prompt_tokens(prompt) <= 224

    async def test_a_carry_that_fits_is_not_touched(self):
        asr = _ProbingAsr(budget=100)
        worker = _worker(asr, initial_prompt=PRIMING)
        worker._previous_text = "alpha beta gamma"

        await worker._run_inference(_utt(is_final=True))

        assert asr.prompts[-1] == f"{PRIMING} alpha beta gamma"


class TestPartialsCarryNoPreviousText:
    async def test_a_partial_gets_the_priming_prompt_only(self):
        asr = _ProbingAsr(budget=100)
        worker = _worker(asr, initial_prompt=PRIMING)
        worker._previous_text = "alpha beta gamma"

        await worker._run_inference(_utt(is_final=False))
        assert asr.prompts[-1] == PRIMING

        await worker._run_inference(_utt(is_final=True))
        assert asr.prompts[-1] == f"{PRIMING} alpha beta gamma"

    async def test_no_prompt_at_all_stays_none(self):
        asr = _ProbingAsr(budget=100)
        worker = _worker(asr)
        await worker._run_inference(_utt(is_final=False))
        assert asr.prompts[-1] is None


class TestTheCarryForwardItself:
    async def test_an_empty_final_clears_the_carry(self):
        """A final that publishes nothing carries nothing.

        The old code only ASSIGNED on a non-empty final, so the previous final's
        words survived a gated or empty one and primed a decode they no longer
        sit next to in time.
        """
        texts = ["the patient reports chest pain", ""]
        calls = {"n": 0}

        def _asr(samples, sample_rate, *, prompt=None):  # noqa: ANN001
            text = texts[min(calls["n"], len(texts) - 1)]
            calls["n"] += 1
            return {"text": text, "word_timestamps": []}

        worker = _worker(_asr)
        await worker.process_utterance("s1", _utt(is_final=True, index=0))
        assert worker._previous_text
        await worker.process_utterance("s1", _utt(is_final=True, index=1, start=8.0, end=10.0))
        assert worker._previous_text == ""

    def test_a_configured_value_beyond_the_declared_range_is_clamped(self):
        worker = _worker(_RecordingAsr(), prev_text_context_words=5000)
        assert worker._prev_text_context_words == 200

    @pytest.mark.parametrize("configured,expected", [(0, 0), (10, 10), (200, 200)])
    def test_an_in_range_value_is_honoured_exactly(self, configured, expected):
        worker = _worker(_RecordingAsr(), prev_text_context_words=configured)
        assert worker._prev_text_context_words == expected
