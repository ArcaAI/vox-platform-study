"""TASK-985 N-1 — the silent re-decode, and the per-pass hook it blocked.

``_run_inference`` used to call the engine with every optional kwarg and catch
``TypeError`` to mean "this engine has no such argument":

    try:
        result = self._asr_pipeline(samples, sr, prompt=prompt, **window_kwargs)
    except TypeError:
        result = self._asr_pipeline(samples, sr)

A ``TypeError`` raised ANYWHERE inside the decode is indistinguishable from a
signature mismatch, so any such error silently re-ran the utterance **with no
prompt and no decode window** and published the result as if it were normal.
Acceptance is now decided by the engine's signature, probed once at bind time.

This is a hard prerequisite for QW-8: adding ``pass_kind`` to a call site that
swallows kwarg errors would have degraded every decode of every engine that had
not yet grown the parameter, invisibly.
"""

import numpy as np
import pytest

from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance

SAMPLE_RATE = 16000


def _utt(is_final: bool = True) -> AudioUtterance:
    return AudioUtterance(
        samples=np.ones(SAMPLE_RATE, dtype=np.float32) * 0.2,
        sample_rate=SAMPLE_RATE,
        start_time=0.0,
        end_time=1.0,
        utterance_index=0,
        is_final=is_final,
    )


class TestATypeErrorFromInsideTheDecodeIsNotSwallowed:
    async def test_it_propagates_instead_of_re_decoding_prompt_less(self):
        calls: list[dict] = []

        def _asr(samples, sample_rate, *, prompt=None, **kwargs):  # noqa: ANN001
            calls.append({"prompt": prompt, **kwargs})
            raise TypeError("unsupported operand type(s) inside the decode")

        worker = StreamingInferenceWorker(asr_pipeline=_asr, initial_prompt="clinical")

        with pytest.raises(TypeError):
            await worker._run_inference(_utt())

        # Exactly ONE call. The old code made a second, prompt-less one and
        # published its output as a normal result.
        assert len(calls) == 1
        assert calls[0]["prompt"] == "clinical"

    async def test_process_utterance_degrades_visibly_rather_than_quietly(self):
        """The worker still keeps the session alive — but the failure is LOGGED.

        `process_utterance`'s own handler owns that policy; the point of N-1 is
        that a decode error is no longer disguised as a successful unprompted
        decode.
        """

        def _asr(samples, sample_rate, *, prompt=None):  # noqa: ANN001
            raise TypeError("boom")

        worker = StreamingInferenceWorker(asr_pipeline=_asr, initial_prompt="clinical")
        result = await worker.process_utterance("s1", _utt())
        assert result.text == ""


class TestTheProbe:
    def test_an_engine_without_prompt_is_never_sent_one(self):
        def _asr(samples, sample_rate):  # noqa: ANN001
            return "ok"

        worker = StreamingInferenceWorker(asr_pipeline=_asr, initial_prompt="clinical")
        assert worker._asr_accepted_kwargs() == frozenset()

    def test_a_kwargs_engine_is_taken_at_its_word(self):
        def _asr(samples, sample_rate, **kwargs):  # noqa: ANN001
            return "ok"

        worker = StreamingInferenceWorker(asr_pipeline=_asr)
        assert worker._asr_accepted_kwargs() == frozenset({"prompt", "pass_kind"})

    def test_an_uninspectable_callable_gets_nothing_optional(self):
        class _Opaque:
            def __call__(self, *args, **kwargs):
                return "ok"

            @property
            def __signature__(self):
                raise ValueError("no signature")

        worker = StreamingInferenceWorker(asr_pipeline=_Opaque())
        assert worker._asr_accepted_kwargs() == frozenset()

    def test_the_probe_is_redone_when_the_engine_switch_swaps_the_callable(self):
        def _first(samples, sample_rate):  # noqa: ANN001
            return "ok"

        def _second(samples, sample_rate, *, prompt=None, pass_kind=None):  # noqa: ANN001
            return "ok"

        worker = StreamingInferenceWorker(asr_pipeline=_first)
        assert worker._asr_accepted_kwargs() == frozenset()
        # The engine-switch seam reassigns the attribute in place.
        worker._asr_pipeline = _second
        assert worker._asr_accepted_kwargs() == frozenset({"prompt", "pass_kind"})


class TestThePerPassHook:
    async def test_the_pass_kind_names_which_pass_this_is(self):
        seen: list[str] = []

        def _asr(samples, sample_rate, *, prompt=None, pass_kind=None):  # noqa: ANN001
            seen.append(pass_kind)
            return "ok"

        worker = StreamingInferenceWorker(asr_pipeline=_asr)
        await worker._run_inference(_utt(is_final=False))
        await worker._run_inference(_utt(is_final=True))
        assert seen == ["partial", "final"]

    async def test_an_engine_without_the_parameter_sees_todays_call_exactly(self):
        seen: list[dict] = []

        def _asr(samples, sample_rate, *, prompt=None):  # noqa: ANN001
            seen.append({"prompt": prompt})
            return "ok"

        worker = StreamingInferenceWorker(asr_pipeline=_asr)
        await worker._run_inference(_utt(is_final=True))
        assert seen == [{"prompt": None}]
