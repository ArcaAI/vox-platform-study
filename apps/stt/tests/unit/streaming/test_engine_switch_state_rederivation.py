"""TASK-985 M-34 — an engine switch must swap the ENGINE, not just the callable.

`_apply` assigned `worker._asr_pipeline` and `worker._active_pipeline_id` and
stopped there, so every other decoder input stayed the primary's:

    _initial_prompt          composed for the PRIMARY engine
    _max_decode_window_sec   the PRIMARY model row's window
    _lexicon_corrector       built from the PRIMARY's postprocessing spec
    _punctuation_config      "
    _partial_lexicon_corrector / _uses_cadence_fast / _republish_punctuated
                             DERIVED from the two configs above, and stale for
                             the same reason unless re-derived with them
    _language (+ script guard derived from it)  the PRIMARY's pin
    front-end geometry       the PRIMARY's partial window / utterance cap

The prompt case is the sharpest: `_load_asr_pipeline` composes a BILINGUAL
priming prompt for a whisper.cpp code-switch pair, and handing that to a CT2
model that wants a pinned language is the M-32-shaped trap — so a failover would
degrade the session it was supposed to rescue.

The data was never missing. `_build_fallback_asr_callable` already loaded the
fallback's own `PipelineSpec` (from the in-memory `ResolvedSpecBundle`, so no DB
read) and already resolved its own prompt against the engine that actually
loaded — and then discarded everything but the callable. This is re-derivation,
not re-resolution.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


def _make_manager():
    from stt.streaming.execution_profile import ExecutionProfile, PlatformType
    from stt.streaming.session_manager import SessionManager

    profile = ExecutionProfile(
        platform=PlatformType.CPU,
        device_name="cpu-test",
        gpu_count=0,
        total_vram_gb=0,
        total_ram_gb=16,
        cpu_cores=4,
        asr_device="cpu",
        asr_compute_type="float32",
        asr_max_batch_size=2,
        asr_model_quantization="fp16",
        embedding_device="cpu",
        embedding_batch_size=2,
        preprocess_pool_size=2,
        max_concurrent_streams=10,
        batch_scheduler_max_wait_ms=500,
        multi_gpu_strategy="none",
    )
    redis_mock = AsyncMock()
    redis_mock.scan = AsyncMock(return_value=(0, []))
    return SessionManager(redis=redis_mock, profile=profile, worker_id="test-worker")


def _fake_worker():
    """A stand-in with the attributes `_apply` re-derives, at PRIMARY values."""
    worker = SimpleNamespace(
        _asr_pipeline="primary-callable",
        _active_pipeline_id="primary",
        _initial_prompt="PRIMARY bilingual priming prompt",
        _max_decode_window_sec=7.0,
        _language=None,
        _expects_latin_script=False,
        _postprocessing_config=SimpleNamespace(punctuation="primary-punct"),
        _punctuation_config="primary-punct",
        _lexicon_corrector="primary-lexicon",
        _partial_lexicon_corrector="primary-lexicon-partial",
        _gloss_callable="primary-gloss",
        _uses_cadence_fast=True,
        _republish_punctuated=True,
    )
    worker._build_lexicon_corrector = (
        lambda cfg, single_token_only=False: (
            f"lexicon-for:{cfg.name}" + (":partial" if single_token_only else "")
        )
    )
    # `_uses_cadence_fast` is DERIVED from `_punctuation_config`, so the double
    # has to re-derive it the way the real worker does — a double that answers a
    # constant cannot show a stale field.
    worker._resolve_uses_cadence_fast = lambda: worker._punctuation_config == "cadence-fast"
    return worker


def _fallback_binding():
    from stt.streaming.session_manager import _EngineBinding

    postprocessing = SimpleNamespace(name="fallback", punctuation="fallback-punct")
    return _EngineBinding(
        asr_callable="fallback-callable",
        pipeline_config=SimpleNamespace(),
        initial_prompt="FALLBACK prompt",
        postprocessing_config=postprocessing,
        max_decode_window_sec=30.0,
        language="ml",
        gloss_callable="fallback-gloss",
        partial_window_s=9.0,
        max_utterance_sec=25.0,
    )


def _apply_of(mgr, session_id: str = "s1"):
    """The `_apply` closure the controller would be given."""
    controller = mgr._make_switch_controller(
        session_id=session_id,
        tenant_id="t1",
        primary_pipeline_id="primary",
        fallback_pipeline_id="fallback",
    )
    return controller._apply_callable


class TestApplyRederivesWorkerState:
    def test_every_decoder_input_moves_with_the_callable(self):
        mgr = _make_manager()
        worker = _fake_worker()
        mgr._inference_workers["s1"] = worker

        _apply_of(mgr)(_fallback_binding(), "fallback")

        assert worker._asr_pipeline == "fallback-callable"
        assert worker._active_pipeline_id == "fallback"
        assert worker._initial_prompt == "FALLBACK prompt"
        assert worker._max_decode_window_sec == 30.0
        assert worker._language == "ml"
        assert worker._postprocessing_config.name == "fallback"
        assert worker._punctuation_config == "fallback-punct"
        assert worker._lexicon_corrector == "lexicon-for:fallback"
        # The PARTIAL path has its own width-1 corrector (D5-N7) and it moves too.
        assert worker._partial_lexicon_corrector == "lexicon-for:fallback:partial"
        assert worker._gloss_callable == "fallback-gloss"

    def test_the_script_guard_follows_the_language_pin(self):
        """`_expects_latin_script` is DERIVED; reassigning only the pin is half a fix."""
        mgr = _make_manager()
        worker = _fake_worker()
        worker._language = "en"
        worker._expects_latin_script = True
        mgr._inference_workers["s1"] = worker

        _apply_of(mgr)(_fallback_binding(), "fallback")

        assert worker._language == "ml"
        assert worker._expects_latin_script is False

    def test_front_end_geometry_is_deferred_to_the_next_utterance_boundary(self):
        """Changing the tail length mid-utterance corrupts the LocalAgreement window."""
        mgr = _make_manager()
        mgr._inference_workers["s1"] = _fake_worker()

        _apply_of(mgr)(_fallback_binding(), "fallback")

        stashed = mgr._pending_front_end_geometry.get("s1")
        assert stashed is not None
        assert stashed.partial_window_s == 9.0
        assert stashed.max_utterance_sec == 25.0

    def test_the_deferred_geometry_is_applied_at_the_boundary(self):
        mgr = _make_manager()
        mgr._inference_workers["s1"] = _fake_worker()
        _apply_of(mgr)(_fallback_binding(), "fallback")

        applied: list[tuple[float | None, float | None]] = []
        preprocessor = SimpleNamespace(
            apply_geometry=lambda *, partial_window_s, max_utterance_sec: applied.append(
                (partial_window_s, max_utterance_sec)
            )
        )

        mgr._adopt_pending_front_end_geometry("s1", preprocessor)

        assert applied == [(9.0, 25.0)]
        # Adopted once, not on every subsequent boundary.
        mgr._adopt_pending_front_end_geometry("s1", preprocessor)
        assert applied == [(9.0, 25.0)]

    def test_a_manual_mid_utterance_switch_resets_the_commit_policy(self):
        """N-2 — a manual switch arrives on the control stream MID-utterance.

        `LocalAgreementPolicy` would otherwise compute `stable_chars` as the
        agreed prefix of one hypothesis from engine A and one from engine B.
        """
        mgr = _make_manager()
        mgr._inference_workers["s1"] = _fake_worker()

        reset: list[str] = []
        cancelled: list[str] = []
        mgr._reset_commit_policy = lambda sid: reset.append(sid)
        mgr._cancel_partial = lambda sid: cancelled.append(sid)

        _apply_of(mgr)(_fallback_binding(), "fallback")

        assert reset == ["s1"]
        assert cancelled == ["s1"]

    def test_the_empty_decode_streak_starts_clean_on_the_new_engine(self):
        """M-24's streak is evidence about the engine that just left."""
        mgr = _make_manager()
        mgr._inference_workers["s1"] = _fake_worker()
        mgr._empty_decode_streaks["s1"] = 2

        _apply_of(mgr)(_fallback_binding(), "fallback")

        assert "s1" not in mgr._empty_decode_streaks


class TestBindingConstruction:
    @pytest.mark.asyncio
    async def test_the_binding_reads_the_target_engines_own_spec(self):
        mgr = _make_manager()

        async def _no_gloss(pipeline_config, session_id):  # noqa: ANN001 - test double
            return None

        mgr._load_gloss_pipeline = _no_gloss

        pipeline_config = SimpleNamespace(
            inference=SimpleNamespace(max_decode_window_sec=12, language="  ml  "),
            postprocessing=SimpleNamespace(punctuation="p"),
            streaming=SimpleNamespace(partial_window_s=8, max_utterance_sec=0),
        )

        binding = await mgr._binding_from_pipeline_config(
            "s1", "callable", pipeline_config, "prompt"
        )

        assert binding.max_decode_window_sec == 12.0
        # Coerced exactly as the worker's own constructor coerces it.
        assert binding.language == "ml"
        assert binding.partial_window_s == 8.0
        # A non-positive geometry value is "unset", not "zero".
        assert binding.max_utterance_sec is None


class TestApplyRederivesDERIVEDState:
    """The fields the reassigned ones are DERIVED from must move too.

    ``_apply`` reassigns ``_postprocessing_config`` and ``_punctuation_config``,
    but three worker fields are computed FROM those at construction and are read
    every utterance afterwards:

        _partial_lexicon_corrector   the width-1 corrector the PARTIAL path uses
        _uses_cadence_fast           exact-name match on the punctuation model
        _republish_punctuated        the punctuated-final follow-up frame gate

    Leaving them behind is the same half-applied switch ``_apply``'s own comment
    forbids ("a HALF-APPLIED switch is worse than none"), just one level down:
    the session would run the new engine's finals through the new lexicon while
    its PARTIALS still snap to the old engine's terms, and would keep judging the
    new engine's punctuation model against the old one's identity.

    These use a REAL ``StreamingInferenceWorker``; the ``SimpleNamespace`` double
    above cannot see the gap, because a field nobody assigned is a field nobody
    misses.
    """

    @staticmethod
    def _postprocessing(*, punctuation_model, punctuation_enabled, terms):
        from stt.pipeline.dto import LexiconConfig, PostprocessingConfig, PunctuationConfig

        return PostprocessingConfig(
            punctuation=PunctuationConfig(
                enabled=punctuation_enabled, model=punctuation_model
            ),
            lexicon=LexiconConfig(enabled=bool(terms), terms=list(terms)),
        )

    def _worker(self, postprocessing):
        from stt.streaming.inference import StreamingInferenceWorker

        return StreamingInferenceWorker(
            asr_pipeline=lambda samples, sr: "primary",
            postprocessing_config=postprocessing,
            active_pipeline_id="primary",
        )

    def _binding(self, postprocessing):
        from stt.streaming.session_manager import _EngineBinding

        return _EngineBinding(
            asr_callable=lambda samples, sr: "fallback",
            pipeline_config=SimpleNamespace(),
            initial_prompt=None,
            postprocessing_config=postprocessing,
        )

    def test_the_partial_lexicon_corrector_follows_the_config(self):
        mgr = _make_manager()
        worker = self._worker(
            self._postprocessing(
                punctuation_model="cadence-fast",
                punctuation_enabled=True,
                terms=["atorvastatin"],
            )
        )
        mgr._inference_workers["s1"] = worker
        assert worker._partial_lexicon_corrector is not None

        # The fallback engine configures NO clinical vocabulary.
        _apply_of(mgr)(
            self._binding(
                self._postprocessing(
                    punctuation_model=None, punctuation_enabled=False, terms=[]
                )
            ),
            "fallback",
        )

        assert worker._lexicon_corrector is None
        assert worker._partial_lexicon_corrector is None

    def test_the_cadence_fast_verdict_follows_the_punctuation_model(self):
        mgr = _make_manager()
        worker = self._worker(
            self._postprocessing(
                punctuation_model="cadence-fast", punctuation_enabled=True, terms=[]
            )
        )
        mgr._inference_workers["s1"] = worker
        assert worker._uses_cadence_fast is True

        _apply_of(mgr)(
            self._binding(
                self._postprocessing(
                    punctuation_model="cadence-fast", punctuation_enabled=False, terms=[]
                )
            ),
            "fallback",
        )

        assert worker._punctuation_config.enabled is False
        assert worker._uses_cadence_fast is False
        assert worker._republish_punctuated is False
