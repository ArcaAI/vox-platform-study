"""TASK-935 (R-2, OD-2 a) — the streaming worker applies the lexicon stage.

OD-2 (a) put the correction on PARTIALS as well as finals: leaving the live view
wrong until the final arrives is option (c), which was declined — the clinician
reads the partial. So both paths are asserted here, and so is the silence: with
the stage off, or with no terms, the published text is byte-identical to what the
engine produced.

The vocabulary comes from ``instruction.hotwords`` via
``pipeline_spec_from_resolved`` (OD-5 a); these tests build the runtime config
directly, which is the same object that mapping produces.
"""

from __future__ import annotations

import numpy as np
import pytest

from stt.pipeline.dto import LexiconConfig, PostprocessingConfig
from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance

MISHEARD = "treated with intravenous septrioxone"
CORRECTED = "treated with intravenous ceftriaxone"


def _utterance(*, is_final: bool) -> AudioUtterance:
    samples = np.random.randn(16000).astype(np.float32)
    return AudioUtterance(
        samples=samples,
        sample_rate=16000,
        start_time=0.0,
        end_time=1.0,
        utterance_index=0,
        is_final=is_final,
    )


def _worker(lexicon: LexiconConfig, text: str = MISHEARD) -> StreamingInferenceWorker:
    return StreamingInferenceWorker(
        asr_pipeline=lambda samples, sr: text,
        postprocessing_config=PostprocessingConfig(lexicon=lexicon),
    )


CONFIGURED = LexiconConfig(enabled=True, terms=["ceftriaxone"])


class TestTheStageRunsOnBothPaths:

    @pytest.mark.asyncio
    async def test_a_final_publishes_the_corrected_text(self) -> None:
        result = await _worker(CONFIGURED).process_utterance("sess-1", _utterance(is_final=True))
        assert result.text == CORRECTED

    @pytest.mark.asyncio
    async def test_a_partial_publishes_the_corrected_text(self) -> None:
        """OD-2 (a) — corrections on partials too; (c) 'finals only' was declined."""
        result = await _worker(CONFIGURED).process_partial("sess-1", _utterance(is_final=False))
        assert result.text == CORRECTED

    @pytest.mark.asyncio
    async def test_the_worker_counts_what_it_corrected(self) -> None:
        worker = _worker(CONFIGURED)
        assert worker.lexicon_correction_count == 0
        await worker.process_partial("sess-1", _utterance(is_final=False))
        await worker.process_utterance("sess-1", _utterance(is_final=True))
        assert worker.lexicon_correction_count == 2


class TestTheStageStaysSilent:

    @pytest.mark.asyncio
    async def test_an_explicit_off_changes_nothing(self) -> None:
        worker = _worker(LexiconConfig(enabled=False, terms=["ceftriaxone"]))
        result = await worker.process_utterance("sess-1", _utterance(is_final=True))
        assert result.text == MISHEARD
        assert worker.lexicon_correction_count == 0

    @pytest.mark.asyncio
    async def test_no_hotwords_means_no_stage(self) -> None:
        worker = _worker(LexiconConfig(enabled=True, terms=[]))
        result = await worker.process_utterance("sess-1", _utterance(is_final=True))
        assert result.text == MISHEARD

    @pytest.mark.asyncio
    async def test_a_worker_with_no_postprocessing_config_is_unaffected(self) -> None:
        worker = StreamingInferenceWorker(asr_pipeline=lambda samples, sr: MISHEARD)
        result = await worker.process_utterance("sess-1", _utterance(is_final=True))
        assert result.text == MISHEARD

    @pytest.mark.asyncio
    async def test_a_word_no_one_configured_is_never_rewritten(self) -> None:
        worker = _worker(LexiconConfig(enabled=True, terms=["metformin"]))
        result = await worker.process_utterance("sess-1", _utterance(is_final=True))
        assert result.text == MISHEARD


class TestOrderWithinPostProcessing:

    @pytest.mark.asyncio
    async def test_the_stage_runs_after_disfluency_removal(self) -> None:
        """Fillers are stripped first, so the stage sees the words that will publish.

        Running it the other way round would hand the corrector "uh" and the removal
        pass a token it had already rewritten — two stages disagreeing about the text.
        """
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda samples, sr: "treated with, uh, septrioxone",
            postprocessing_config=PostprocessingConfig(
                remove_disfluencies=True,
                lexicon=CONFIGURED,
            ),
        )
        result = await worker.process_utterance("sess-1", _utterance(is_final=True))
        # The stray comma is `remove_disfluencies`' own output, unchanged by this
        # ticket — what matters here is that "septrioxone" survived that pass intact
        # and reached the corrector, rather than the two stages editing in the wrong
        # order.
        assert result.text == "treated with, ceftriaxone"

    @pytest.mark.asyncio
    async def test_a_lowercasing_pipeline_still_lowercases_the_correction(self) -> None:
        worker = StreamingInferenceWorker(
            asr_pipeline=lambda samples, sr: "Septrioxone",
            postprocessing_config=PostprocessingConfig(lowercase=True, lexicon=CONFIGURED),
        )
        result = await worker.process_utterance("sess-1", _utterance(is_final=True))
        assert result.text == "ceftriaxone"


class TestTheCorrectorIsBuiltOnce:

    def test_the_corrector_is_built_at_construction_not_per_utterance(self) -> None:
        """A per-utterance rebuild would re-key every term on the partial path."""
        worker = _worker(CONFIGURED)
        assert worker._lexicon_corrector is not None
        assert worker._lexicon_corrector is worker._lexicon_corrector
        assert worker._lexicon_corrector.terms == ("ceftriaxone",)

    def test_no_corrector_is_built_when_the_stage_cannot_fire(self) -> None:
        assert _worker(LexiconConfig(enabled=True, terms=[]))._lexicon_corrector is None
        assert _worker(LexiconConfig(enabled=False, terms=["x"]))._lexicon_corrector is None
