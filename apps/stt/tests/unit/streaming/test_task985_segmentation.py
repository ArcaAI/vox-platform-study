"""TASK-985 — segmentation & endpointing (lane L-SEG).

Pins the four behaviours this lane changed, each stated as the property that was
NOT true before:

* **QW-13 / M-07** — the energy gate measures RAW amplitude. It used to measure
  the peak-NORMALIZED frame against a raw-amplitude noise-floor ceiling, so in
  any room quieter than -62 dBFS the "adaptive" floor saturated and the gate
  became an absolute detector at about -53 dBFS of room tone: silence opened an
  utterance, and the downstream hallucination RMS gate could not catch it
  because it reads the same amplified samples.
* **D2-N4** — ``AudioUtterance.start_time`` DESCRIBES ``samples``. The buffer is
  seeded with the pre-speech ring, so deriving the start from the onset frame
  under-stated every utterance by that ring (~320 ms on the served defaults) and
  jumped discontinuously at the first trimmed partial.
* **M-39** — every emit path stamps a PHI-free cut reason, and the endpointer's
  own reason is recorded even when it does NOT cut.
* **ST-2 / D2-N2, N7, N10, N12** — Silero-first split selection, latched degrade
  telemetry, the endpoint floor clamp, the carry partial timer, and the partial
  minimum-audio gate in one sample-rate domain.

All hermetic: synthetic frames at known RMS and a mocked VAD. No model, no
infrastructure, no wall-clock dependence beyond the partial cadence.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import numpy as np
import pytest

from stt.pipeline.dto import EndpointConfig
from stt.streaming import preprocessor as preprocessor_module
from stt.streaming.preprocessor import (
    REASON_FLUSH,
    REASON_FLUSH_PENDING_ONSET,
    REASON_MAX_UTTERANCE_OVERLAP,
    REASON_MAX_UTTERANCE_SMART,
    REASON_PARTIAL,
    REASON_SEMANTIC,
    REASON_SILENCE_TIMER,
    AudioUtterance,
    StreamingPreprocessor,
)
from stt.streaming.semantic_endpointer import (
    REASON_ENDPOINT,
    REASON_LOW_CONFIDENCE,
    REASON_SILENCE_FLOOR,
    EndpointDecision,
    SemanticEndpointer,
)

SR = 16000
FRAME = 512


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _noise(rms: float, rng: np.random.Generator) -> np.ndarray:
    """One frame of Gaussian noise at EXACTLY ``rms`` (float32, raw amplitude)."""
    x = rng.standard_normal(FRAME).astype(np.float32)
    x *= float(rms) / float(np.sqrt(np.mean(np.square(x))))
    return x


def _tone(amplitude: float, n: int = FRAME) -> np.ndarray:
    t = np.linspace(0.0, n / SR, n, endpoint=False)
    return (amplitude * np.sin(2 * np.pi * 440 * t)).astype(np.float32)


def _pcm(frame: np.ndarray) -> bytes:
    return np.clip(frame * 32768.0, -32768, 32767).astype(np.int16).tobytes()


def _silent_pcm(n_frames: int = 1) -> bytes:
    """PCM for ``n_frames`` VAD frames — content irrelevant under a mocked VAD."""
    return np.zeros(n_frames * FRAME, dtype=np.int16).tobytes()


def _sequence_vad(probs: list[float]) -> Any:
    """Mocked Silero returning ``probs`` in order, then its last value forever."""
    state = {"i": 0}

    def _process_chunk(**_kwargs: Any) -> float:
        i = state["i"]
        state["i"] += 1
        return probs[min(i, len(probs) - 1)]

    svc = MagicMock()
    svc.is_loaded = True
    svc.process_chunk = MagicMock(side_effect=_process_chunk)
    return svc


def _fixed_vad(prob: float) -> Any:
    svc = MagicMock()
    svc.is_loaded = True
    svc.process_chunk = MagicMock(return_value=prob)
    return svc


# ===========================================================================
# 1. QW-13 / M-07 — the energy gate measures the ROOM, not the amplified frame
# ===========================================================================


@pytest.mark.unit
class TestEnergyGateMeasuresRawAmplitude:
    async def test_room_tone_does_not_open_an_utterance_with_normalize_on(self) -> None:
        """M-07, exactly: -52 dBFS of room tone under the 20x normalizer.

        Before QW-13 this confirmed an onset within three frames — the noise
        floor was clamped at 0.015 (a RAW number) while the measurement was
        normalized, so the gate tripped at a fixed 0.045 of normalized RMS.
        """
        pp = StreamingPreprocessor(session_id="room-tone", normalize=True)
        rng = np.random.default_rng(985)

        finals: list[AudioUtterance] = []
        for _ in range(200):
            utts = await pp.feed(_pcm(_noise(0.0025, rng)))
            finals.extend(u for u in utts if u.is_final)

        assert pp.in_speech is False
        assert finals == []
        assert pp.segmentation_summary["utterances"] == {}

    def test_energy_gate_is_scale_invariant_under_the_normalizer(self) -> None:
        """The same room produces the same probability, normalizer or not."""
        rng = np.random.default_rng(3)
        frames = [_noise(0.004, rng) for _ in range(40)]

        def _probs(normalize: bool) -> list[float]:
            pp = StreamingPreprocessor(session_id="scale", normalize=normalize)
            out: list[float] = []
            for frame in frames:
                gated = pp._normalize_frame(frame.copy()) if normalize else frame
                out.append(pp._run_energy_fallback(gated))
            return out

        assert _probs(normalize=True) == pytest.approx(_probs(normalize=False), abs=1e-6)

    @pytest.mark.parametrize("normalize", [True, False])
    @pytest.mark.parametrize("ambient_rms", [0.0005, 0.001, 0.0025, 0.005])
    @pytest.mark.parametrize(("factor", "opens"), [(2.0, False), (6.0, True)])
    async def test_the_gate_is_a_relative_detector_in_raw_units(
        self, normalize: bool, ambient_rms: float, factor: float, opens: bool
    ) -> None:
        """Speech must clear the ADAPTED room floor, whatever the room level is.

        The gate needs ``rms >= 3 x floor`` (threshold 0.6, multiplier 2.5), so a
        2x step is room noise and a 6x step is speech — at every ambient level,
        with the normalizer on or off. Normalized, the 0.0025 and 0.005 rooms
        used to saturate the clamped floor and open on the ambient itself.
        """
        pp = StreamingPreprocessor(session_id="relative", normalize=normalize)
        rng = np.random.default_rng(11)

        for _ in range(60):  # ~3 EMA time constants: the floor is adapted
            await pp.feed(_pcm(_noise(ambient_rms, rng)))
        assert pp.in_speech is False, "ambient alone must never confirm an onset"

        for _ in range(5):
            await pp.feed(_pcm(_noise(ambient_rms * factor, rng)))
        assert pp.in_speech is opens

    async def test_the_emitted_utterance_carries_the_normalizer_gain(self) -> None:
        """The gain travels WITH the samples, so raw-amplitude gates downstream
        (``inference.py``'s hallucination RMS gate) can undo it."""
        for normalize, expected in ((True, 20.0), (False, 1.0)):
            pp = StreamingPreprocessor(
                session_id="gain",
                vad_service=_sequence_vad([0.9] * 5 + [0.0] * 6),
                threshold=0.5,
                min_speech_duration_ms=32,
                min_silence_duration_ms=96,
                pre_speech_context_ms=32,
                normalize=normalize,
            )
            finals: list[AudioUtterance] = []
            for _ in range(11):
                # 0.01 peak: below _NORMALIZER_MIN_PEAK, so the divisor floors
                # at 0.05 and the gain is exactly the 20x ceiling.
                utts = await pp.feed(_pcm(_tone(0.01)))
                finals.extend(u for u in utts if u.is_final)

            assert finals, "expected one silence-timer final"
            assert finals[0].normalizer_gain == pytest.approx(expected, rel=1e-6)

    def test_the_default_gain_is_neutral(self) -> None:
        """Every pre-existing constructor of an utterance keeps raw semantics."""
        utt = AudioUtterance(np.zeros(4, dtype=np.float32), SR, 0.0, 0.25, 0)
        assert utt.normalizer_gain == 1.0
        assert utt.endpoint_reason == "unknown"


# ===========================================================================
# 2. D2-N4 — start_time describes the samples
# ===========================================================================


@pytest.mark.unit
class TestStartTimeDescribesTheSamples:
    @staticmethod
    def _preprocessor() -> StreamingPreprocessor:
        return StreamingPreprocessor(
            session_id="span",
            vad_service=_sequence_vad([0.0] * 5 + [0.9] * 6 + [0.0] * 10),
            threshold=0.5,
            min_speech_duration_ms=64,  # 2 frames
            min_silence_duration_ms=96,  # 3 frames
            pre_speech_context_ms=96,  # 3 frames
        )

    async def test_a_final_span_equals_its_own_audio(self) -> None:
        """``end_time - start_time`` must equal ``len(samples) / sample_rate``.

        It did not: the buffer is seeded with the pre-speech ring and the start
        was derived from the onset frame, so the reported span was short by the
        ring on EVERY onset-confirmed utterance.
        """
        pp = self._preprocessor()
        finals: list[AudioUtterance] = []
        for _ in range(21):
            utts = await pp.feed(_silent_pcm())
            finals.extend(u for u in utts if u.is_final)

        assert finals, "expected one silence-timer final"
        final = finals[0]
        assert final.start_time >= 0.0
        assert final.end_time - final.start_time == pytest.approx(
            len(final.samples) / SR, abs=1e-9
        )

    def test_a_partial_span_equals_its_own_audio_trimmed_or_not(self) -> None:
        """The trimmed and untrimmed partial paths obey ONE rule.

        They disagreed by the pre-speech ring: the trimmed branch measured the
        window it had just cut, the untrimmed one reported the onset frame. So
        ``start_time`` JUMPED by the ring at the first trimmed partial — which
        the commit policy reads as a genuine window slide and freezes tokens on.
        """
        pp = StreamingPreprocessor(session_id="partial-span", partial_window_s=0.6)
        state = pp._state
        state.in_speech = True
        state.last_partial_emitted_at = 0.0
        ring_frames = 3  # pre-speech context the buffer is SEEDED with

        for _ in range(16):  # 0.512 s: over the partial floor, inside the window
            state.utterance_buffer.append(_tone(0.2))
            state.total_samples_fed += FRAME
        # What the old rule reported: the ONSET frame, `ring_frames` after the
        # buffered audio actually begins.
        state.utterance_start_time = ring_frames * FRAME / SR

        untrimmed = pp._maybe_emit_partial()
        assert untrimmed is not None
        assert untrimmed.endpoint_reason == REASON_PARTIAL
        assert len(untrimmed.samples) == 16 * FRAME
        assert untrimmed.end_time - untrimmed.start_time == pytest.approx(
            len(untrimmed.samples) / SR, abs=1e-9
        )

        state.last_partial_emitted_at = 0.0
        for _ in range(8):  # 0.768 s: past the 0.6 s window, so the tail trims
            state.utterance_buffer.append(_tone(0.2))
            state.total_samples_fed += FRAME

        trimmed = pp._maybe_emit_partial()
        assert trimmed is not None
        assert len(trimmed.samples) < 24 * FRAME
        assert trimmed.end_time - trimmed.start_time == pytest.approx(
            len(trimmed.samples) / SR, abs=1e-9
        )
        # The window only ever advances — no discontinuity at the first trim.
        assert trimmed.start_time >= untrimmed.start_time


# ===========================================================================
# 3. M-39 — cut-reason telemetry
# ===========================================================================


@pytest.mark.unit
class TestCutReasonTelemetry:
    async def test_the_silence_timer_stamps_its_reason(self) -> None:
        pp = StreamingPreprocessor(
            session_id="timer",
            vad_service=_sequence_vad([0.9] * 4 + [0.0] * 8),
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=96,
        )
        finals = [u for _ in range(12) for u in await pp.feed(_silent_pcm()) if u.is_final]

        assert [u.endpoint_reason for u in finals] == [REASON_SILENCE_TIMER]
        assert pp.segmentation_summary["utterances"] == {REASON_SILENCE_TIMER: 1}

    async def test_a_semantic_cut_stamps_its_reason(self) -> None:
        endpointer = MagicMock()
        endpointer.enabled = True
        endpointer.decide = MagicMock(
            return_value=EndpointDecision(True, 0.95, REASON_ENDPOINT)
        )
        endpointer.reset = MagicMock()

        pp = StreamingPreprocessor(
            session_id="semantic",
            vad_service=_sequence_vad([0.9] * 4 + [0.0] * 8),
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=3200,  # far beyond the run: only semantic can cut
            endpointer=endpointer,
        )
        finals = [u for _ in range(12) for u in await pp.feed(_silent_pcm()) if u.is_final]

        assert [u.endpoint_reason for u in finals] == [REASON_SEMANTIC]
        assert pp.segmentation_summary["endpoint_decisions"][REASON_ENDPOINT] >= 1

    async def test_a_decision_that_does_not_cut_is_still_recorded(self) -> None:
        """D2-N8: the four NEGATIVE tags are the evidence that says whether
        semantic endpointing fires at all — and they were thrown away."""
        endpointer = MagicMock()
        endpointer.enabled = True
        endpointer.decide = MagicMock(
            return_value=EndpointDecision(False, 0.0, REASON_LOW_CONFIDENCE)
        )
        endpointer.reset = MagicMock()

        pp = StreamingPreprocessor(
            session_id="no-cut",
            vad_service=_sequence_vad([0.9] * 4 + [0.0] * 2),
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=3200,
            endpointer=endpointer,
        )
        finals = [u for _ in range(6) for u in await pp.feed(_silent_pcm()) if u.is_final]

        assert finals == []
        assert pp.segmentation_summary["endpoint_decisions"] == {REASON_LOW_CONFIDENCE: 2}

    async def test_both_force_emit_paths_stamp_distinct_reasons(self) -> None:
        """A smart split and the overlap fallback are different products and
        must not share a label — §2.5 class 3 hangs off telling them apart."""
        # Smart split: frame 8 is a zero-energy "plosive closure".
        smart = StreamingPreprocessor(
            session_id="smart",
            vad_service=_fixed_vad(0.9),
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=320,
            max_utterance_duration_ms=320,
            pre_speech_context_ms=32,
        )
        finals: list[AudioUtterance] = []
        for i in range(14):
            frame = np.zeros(FRAME, dtype=np.float32) if i == 8 else _tone(0.3)
            finals.extend(u for u in await smart.feed(_pcm(frame)) if u.is_final)
        assert finals, "expected a force-emitted utterance"
        assert finals[0].endpoint_reason == REASON_MAX_UTTERANCE_SMART

        # Overlap fallback: uniform energy, so no frame clears the split ratio.
        flat = StreamingPreprocessor(
            session_id="flat",
            vad_service=_fixed_vad(0.9),
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=320,
            max_utterance_duration_ms=320,
            pre_speech_context_ms=32,
        )
        flat_finals: list[AudioUtterance] = []
        for _ in range(14):
            flat_finals.extend(u for u in await flat.feed(_pcm(_tone(0.3))) if u.is_final)
        assert flat_finals, "expected a force-emitted utterance"
        assert flat_finals[0].endpoint_reason == REASON_MAX_UTTERANCE_OVERLAP

    async def test_flush_stamps_its_reason_and_logs_one_summary(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        info = MagicMock()
        monkeypatch.setattr(preprocessor_module.logger, "info", info)

        pp = StreamingPreprocessor(
            session_id="flush",
            vad_service=_fixed_vad(0.9),
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=3200,
        )
        for _ in range(6):
            await pp.feed(_silent_pcm())

        final = await pp.flush()
        assert final is not None
        assert final.endpoint_reason == REASON_FLUSH
        assert pp.segmentation_summary["utterances"] == {REASON_FLUSH: 1}

        await pp.flush()  # a retried finalize must not re-log the session
        assert info.call_count == 1
        assert info.call_args.args[0] == "stt.streaming.session_summary"

    async def test_a_pending_onset_flush_stamps_its_own_reason(self) -> None:
        """The last word of a consultation, cut off before onset confirmed."""
        pp = StreamingPreprocessor(
            session_id="pending",
            vad_service=_sequence_vad([0.9]),
            threshold=0.5,
            min_speech_duration_ms=320,  # 10 frames: never confirms in 3
        )
        for _ in range(3):
            await pp.feed(_silent_pcm())

        final = await pp.flush()
        assert final is not None
        assert final.endpoint_reason == REASON_FLUSH_PENDING_ONSET

    async def test_no_emit_path_leaves_the_reason_unknown(self) -> None:
        pp = StreamingPreprocessor(
            session_id="unknown",
            vad_service=_sequence_vad([0.9] * 4 + [0.0] * 8),
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=96,
        )
        emitted = [u for _ in range(12) for u in await pp.feed(_silent_pcm())]
        emitted.append(await pp.flush())

        assert all(u.endpoint_reason != "unknown" for u in emitted if u is not None)


# ===========================================================================
# 4. M-13 — the numbers this preprocessor actually ran on
# ===========================================================================


@pytest.mark.unit
class TestEffectiveSegmentation:
    def test_it_reports_the_constructor_values_not_a_declaration(self) -> None:
        pp = StreamingPreprocessor(
            session_id="eff",
            threshold=0.5,
            min_speech_duration_ms=100,
            min_silence_duration_ms=350,
            pre_speech_context_ms=300,
        )
        eff = pp.effective_segmentation

        assert eff["segmenter"] == "energy"
        assert eff["threshold"] == 0.5
        assert eff["neg_threshold"] == pytest.approx(0.35)
        assert eff["min_speech_ms"] == 100
        assert eff["min_silence_ms"] == 350
        # The FRAME-QUANTISED truth, not the declaration: 300 ms is nine 32 ms
        # frames. Reporting 300 would be the same lie M-13 is about.
        assert eff["pre_speech_context_ms"] == 288
        assert eff["endpointing"] == "fixed"
        assert eff["energy_veto"] is False

    def test_it_reports_what_loaded_not_what_was_declared(self) -> None:
        """A session whose Silero load failed runs on the energy fallback
        however the agent row is configured."""
        unloaded = MagicMock()
        unloaded.is_loaded = False
        degraded = StreamingPreprocessor("a", vad_service=unloaded).effective_segmentation
        assert degraded["segmenter"] == "energy"

        loaded = StreamingPreprocessor("b", vad_service=_fixed_vad(0.9)).effective_segmentation
        assert loaded["segmenter"] == "silero"
        # `fixed` on Silero and `fixed` on the energy proxy are two different
        # products; the report says which one governed the cut.
        assert loaded["endpointing"] == "vad"

    def test_it_reports_the_endpoint_floor_through_the_public_accessor(self) -> None:
        config = EndpointConfig(enabled=True, min_endpoint_silence_ms=200, min_words=3)
        pp = StreamingPreprocessor("c", endpointer=SemanticEndpointer(config))
        eff = pp.effective_segmentation

        assert eff["endpointing"] == "semantic"
        assert eff["endpoint_min_silence_ms"] == 200
        assert eff["endpoint_min_words"] == 3


# ===========================================================================
# 5. ST-2 — Silero-first split, degrade telemetry, the energy veto
# ===========================================================================


@pytest.mark.unit
class TestVadGatedSegmentation:
    @staticmethod
    def _split_buffer() -> list[np.ndarray]:
        """Ten frames whose ENERGY minimum (index 5) and PROBABILITY minimum
        (index 7) are deliberately different frames."""
        buffer = [_tone(0.3) for _ in range(10)]
        buffer[5] = np.zeros(FRAME, dtype=np.float32)
        return buffer

    @staticmethod
    def _fill_ring(pp: StreamingPreprocessor, probs: list[float]) -> None:
        pp._reset_prob_ring()
        for prob in probs:
            pp._state.vad_prob_ring.append(prob)

    def test_the_split_prefers_a_real_pause_over_a_low_energy_frame(self) -> None:
        pp = StreamingPreprocessor("split-vad", vad_service=_fixed_vad(0.9), threshold=0.5)
        self._fill_ring(pp, [0.1 if i == 7 else 0.9 for i in range(10)])

        assert pp._find_best_split_point(self._split_buffer()) == 7

    def test_a_probability_plateau_falls_back_to_the_energy_search(self) -> None:
        """No frame below the off-threshold means no pause in the window — the
        minimum of a plateau is not a boundary, it is an arbitrary index."""
        pp = StreamingPreprocessor("split-flat", vad_service=_fixed_vad(0.9), threshold=0.5)
        self._fill_ring(pp, [0.9] * 10)

        assert pp._find_best_split_point(self._split_buffer()) == 5

    def test_the_energy_search_governs_without_silero(self) -> None:
        pp = StreamingPreprocessor("split-energy", vad_service=None, threshold=0.5)
        self._fill_ring(pp, [0.1 if i == 7 else 0.9 for i in range(10)])

        assert pp._find_best_split_point(self._split_buffer()) == 5

    async def test_a_vad_inference_error_warns_once_and_counts_every_frame(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """D2-N2: this used to be one WARNING per 32 ms — ~31 lines/s/session."""
        warning = MagicMock()
        monkeypatch.setattr(preprocessor_module.logger, "warning", warning)

        broken = MagicMock()
        broken.is_loaded = True
        broken.process_chunk = MagicMock(side_effect=RuntimeError("onnx exploded"))
        pp = StreamingPreprocessor(session_id="broken", vad_service=broken)

        for _ in range(10):
            await pp.feed(_silent_pcm())

        assert pp.segmentation_summary["vad_degraded"] == {"inference": 10}
        assert warning.call_count == 1

    async def test_an_unloaded_model_counts_once_not_once_per_frame(self) -> None:
        """An unloaded model is one true statement about the SESSION; an ONNX
        fault is a per-frame rate. They must not share a counting rule."""
        unloaded = MagicMock()
        unloaded.is_loaded = False
        pp = StreamingPreprocessor(session_id="unloaded", vad_service=unloaded)

        for _ in range(10):
            await pp.feed(_silent_pcm())

        assert pp.segmentation_summary["vad_degraded"] == {"not_loaded": 1}

    async def test_a_declared_off_vad_is_not_reported_as_degraded(self) -> None:
        """No service attached is the DECLARED configuration, not a fault —
        `effective_segmentation` already says the segmenter is the energy path."""
        pp = StreamingPreprocessor(session_id="off", vad_service=None)

        for _ in range(10):
            await pp.feed(_silent_pcm())

        assert pp.segmentation_summary["vad_degraded"] == {}

    async def test_the_energy_veto_is_off_by_default_and_purely_subtractive(self) -> None:
        """Silence that Silero scores as speech: the veto refuses it when it is
        enabled, and nothing changes when it is not."""
        for enabled, opens in ((False, True), (True, False)):
            pp = StreamingPreprocessor(
                session_id="veto",
                vad_service=_fixed_vad(0.99),
                threshold=0.5,
                min_speech_duration_ms=32,
                energy_veto_enabled=enabled,
            )
            for _ in range(6):
                await pp.feed(_silent_pcm())
            assert pp.in_speech is opens

    async def test_the_veto_never_opens_an_utterance_on_its_own(self) -> None:
        """Loud audio that Silero calls silence must stay silence."""
        pp = StreamingPreprocessor(
            session_id="veto-subtractive",
            vad_service=_fixed_vad(0.0),
            threshold=0.5,
            min_speech_duration_ms=32,
            energy_veto_enabled=True,
        )
        for _ in range(6):
            await pp.feed(_pcm(_tone(0.5)))

        assert pp.in_speech is False


# ===========================================================================
# 6. Fragmentation direction (U-11) — the unit suite states it before the A/B
# ===========================================================================


@pytest.mark.unit
class TestFragmentationRate:
    @staticmethod
    def _dialogue_probs() -> list[float]:
        """Six turns of three 320 ms "words" with 400 ms inter-word gaps,
        separated by 800 ms turn gaps."""
        turn = ([0.9] * 10 + [0.0] * 12) * 2 + [0.9] * 10 + [0.0] * 25
        return turn * 6

    async def _finals(self, min_silence_ms: int) -> list[AudioUtterance]:
        probs = self._dialogue_probs()
        pp = StreamingPreprocessor(
            session_id=f"frag-{min_silence_ms}",
            vad_service=_sequence_vad(probs),
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=min_silence_ms,
        )
        finals: list[AudioUtterance] = []
        for _ in range(len(probs)):
            finals.extend(u for u in await pp.feed(_silent_pcm()) if u.is_final)
        return finals

    async def test_a_longer_silence_gap_yields_whole_turns(self) -> None:
        """600 ms rides over the 400 ms inter-word gaps: six turns, six finals."""
        finals = await self._finals(600)

        assert len(finals) == 6
        assert all(u.endpoint_reason == REASON_SILENCE_TIMER for u in finals)

    async def test_a_shorter_silence_gap_fragments_the_same_dialogue(self) -> None:
        """350 ms cuts inside every turn. This is the DIRECTION of BP-4b arm (2);
        the size belongs to the live A/B, not to a synthetic fixture."""
        short = await self._finals(350)
        whole = await self._finals(600)

        assert len(short) > len(whole)
        assert len(short) == 18


# ===========================================================================
# 7. Remaining defects inside this lane's files
# ===========================================================================


@pytest.mark.unit
class TestSmallerDefects:
    async def test_a_force_emit_carry_arms_the_partial_timer(self) -> None:
        """D2-N10: the carry branch left the timer at 0.0 while `in_speech`
        stayed True, so the very next frame published a partial over audio that
        had just gone out as a final."""
        pp = StreamingPreprocessor(
            session_id="carry-timer",
            vad_service=_fixed_vad(0.9),
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=320,
            max_utterance_duration_ms=320,
            pre_speech_context_ms=32,
        )
        finals: list[AudioUtterance] = []
        for _ in range(12):
            finals.extend(u for u in await pp.feed(_pcm(_tone(0.3))) if u.is_final)

        assert finals, "expected a force-emitted utterance"
        assert pp._state.in_speech is True
        assert pp._state.last_partial_emitted_at > 0.0

    def test_the_partial_minimum_audio_gate_uses_one_sample_rate_domain(self) -> None:
        """D2-N12: the buffered frames are POST-resample, so multiplying their
        count by the INPUT-rate frame size overstated the duration 3x on a
        48 kHz uplink — partials fired on 0.17 s instead of 0.5 s."""
        pp = StreamingPreprocessor(
            session_id="rates", sample_rate=48000, target_sample_rate=16000
        )
        assert pp._frame_size == 1536, "input-rate frame size (the trap)"

        state = pp._state
        state.in_speech = True
        state.last_partial_emitted_at = 0.0

        for _ in range(6):  # 6 x 512 / 16000 = 0.192 s — below the 0.5 s floor
            state.utterance_buffer.append(_tone(0.2))
            state.total_samples_fed += FRAME
        assert pp._maybe_emit_partial() is None

        for _ in range(10):  # 16 x 512 / 16000 = 0.512 s — over the floor
            state.utterance_buffer.append(_tone(0.2))
            state.total_samples_fed += FRAME
        partial = pp._maybe_emit_partial()
        assert partial is not None
        assert len(partial.samples) == 16 * FRAME


@pytest.mark.unit
class TestSemanticEndpointerKnobs:
    def test_the_fixed_backstop_clamps_the_semantic_floor(self) -> None:
        """D2-N7: `min_silence_ms` was accepted and never read, so a floor set
        above the backstop made the semantic path unreachable rather than
        merely early — the opposite of what its own docstring promises."""
        endpointer = SemanticEndpointer(
            EndpointConfig(enabled=True, min_endpoint_silence_ms=500, min_words=1)
        )
        endpointer.observe_hypothesis("the patient is stable.")

        decision = endpointer.decide(trailing_silence_ms=260.0, min_silence_ms=250.0)

        assert decision.should_endpoint is True
        assert decision.reason == REASON_ENDPOINT

    def test_the_clamp_is_a_no_op_below_the_backstop(self) -> None:
        """The served pipeline (200 ms floor, 350 ms backstop) is unchanged."""
        endpointer = SemanticEndpointer(
            EndpointConfig(enabled=True, min_endpoint_silence_ms=200, min_words=1)
        )
        endpointer.observe_hypothesis("the patient is stable.")

        assert (
            endpointer.decide(trailing_silence_ms=150.0, min_silence_ms=350.0).reason
            == REASON_SILENCE_FLOOR
        )
        assert endpointer.decide(
            trailing_silence_ms=210.0, min_silence_ms=350.0
        ).should_endpoint

    def test_the_config_is_readable_without_touching_a_private_attribute(self) -> None:
        config = EndpointConfig(enabled=True, min_endpoint_silence_ms=180)
        assert SemanticEndpointer(config).config is config
