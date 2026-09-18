"""SessionManager → StreamingPreprocessor kwargs wiring.

Pins the contract of ``SessionManager._build_preprocessor_vad_kwargs``:

- TASK-985 M-13: the agent's segmentation tuning is read whether or not the
  Silero stage is ENABLED. Only the model is gated by ``vad.enabled``; the
  energy fallback is still a segmenter and obeys the same four numbers. The
  hardware-profile substitute (a literal 500 ms on all five profiles) that used
  to run in the disabled branch is deleted along with the field, so the admin
  UI can no longer show 350 ms while 500 ms runs.
- With no pipeline config at all, the kwargs are OMITTED and the
  preprocessor's own constructor defaults stand.
- TASK-877: the partial-emit CADENCE is a per-session AGENT value, not a setting.
- TASK-880: the partial decode WINDOW is a per-model value (the ASR row's
  `_metadata.asr.partialWindowSec`), not a setting either.
"""

from unittest.mock import MagicMock

from stt.streaming.session_manager import SessionManager


def _make_mgr() -> MagicMock:
    mgr = MagicMock(spec=SessionManager)
    mgr._profile = MagicMock()
    return mgr


def _make_pipeline_config(vad_enabled: bool, **vad_overrides) -> MagicMock:
    config = MagicMock()
    vad = MagicMock(
        spec=[
            "enabled",
            "threshold",
            "min_speech_duration_ms",
            "min_silence_duration_ms",
            "pre_speech_context_ms",
            "force_emit_after_ms",
            "force_emit_lookback_ms",
            "force_emit_overlap_ms",
        ]
    )
    vad.enabled = vad_enabled
    vad.threshold = vad_overrides.get("threshold", 0.6)
    vad.min_speech_duration_ms = vad_overrides.get("min_speech_duration_ms", 350)
    vad.min_silence_duration_ms = vad_overrides.get("min_silence_duration_ms", 700)
    vad.pre_speech_context_ms = vad_overrides.get("pre_speech_context_ms", 500)
    vad.force_emit_after_ms = vad_overrides.get("force_emit_after_ms", 25000)
    vad.force_emit_lookback_ms = vad_overrides.get("force_emit_lookback_ms", 1500)
    vad.force_emit_overlap_ms = vad_overrides.get("force_emit_overlap_ms", 500)
    config.preprocessing.vad = vad
    return config


class TestBuildPreprocessorVadKwargs:
    def test_no_pipeline_config_omits_the_segmentation_kwargs(self):
        """With nothing declared, the preprocessor's own defaults stand.

        TASK-985 M-13 — this used to substitute the hardware profile's
        `vad_silence_threshold_ms`. A hardware profile describes the DEVICE; the
        right silence window is a property of the clinician's speech.
        """
        mgr = _make_mgr()

        kwargs = SessionManager._build_preprocessor_vad_kwargs(mgr, None)

        assert "min_silence_duration_ms" not in kwargs
        assert "threshold" not in kwargs

    def test_the_agents_tuning_is_read_even_when_vad_is_disabled(self):
        """TASK-985 M-13 — the loss was entirely in one `if`.

        The spec mapper writes the agent's threshold / min_speech / min_silence
        / padding into `VadConfig` regardless of `enabled`, so a served session
        really did hold `min_silence_duration_ms == 350` — and the disabled
        branch threw it away for a profile literal of 500. The energy fallback
        reached by a disabled Silero stage is still a segmenter and obeys the
        same numbers.
        """
        mgr = _make_mgr()
        config = _make_pipeline_config(
            vad_enabled=False,
            threshold=0.5,
            min_speech_duration_ms=100,
            min_silence_duration_ms=350,
        )

        kwargs = SessionManager._build_preprocessor_vad_kwargs(mgr, config)

        assert kwargs["threshold"] == 0.5
        assert kwargs["min_speech_duration_ms"] == 100
        assert kwargs["min_silence_duration_ms"] == 350
        assert kwargs["pre_speech_context_ms"] == 500

    def test_pipeline_yaml_wins_when_vad_configured(self):
        """Per-pipeline values reach the preprocessor."""
        mgr = _make_mgr()
        config = _make_pipeline_config(
            vad_enabled=True,
            threshold=0.7,
            min_speech_duration_ms=300,
            min_silence_duration_ms=650,
        )

        kwargs = SessionManager._build_preprocessor_vad_kwargs(mgr, config)

        assert kwargs["threshold"] == 0.7
        assert kwargs["min_speech_duration_ms"] == 300
        assert kwargs["min_silence_duration_ms"] == 650
        # Force-emit settings carried through (parity for create + recovery).
        assert kwargs["max_utterance_duration_ms"] == 25000
        assert kwargs["force_emit_lookback_ms"] == 1500
        assert kwargs["force_emit_overlap_ms"] == 500

    def test_partial_window_is_not_wired_from_a_platform_setting(self):
        """TASK-880 — `stt.streaming.partialWindowS` is deleted.

        It applied one window to every engine on the box. The right tail length is the
        ASR row's force-emit window, so it arrives per session on
        `StreamingConfig.partial_window_s`; with no declaration the kwarg is OMITTED
        and the preprocessor's own `_DEFAULT_PARTIAL_WINDOW_S` stands.
        """
        mgr = _make_mgr()

        without_config = SessionManager._build_preprocessor_vad_kwargs(mgr, None)
        with_config = SessionManager._build_preprocessor_vad_kwargs(
            mgr, _make_pipeline_config(vad_enabled=True)
        )

        assert "partial_window_s" not in without_config
        assert "partial_window_s" not in with_config

    def test_partial_window_comes_from_the_asr_rows_metadata(self):
        """A spec-driven session threads the MODEL's window through
        `StreamingConfig.partial_window_s`."""
        mgr = _make_mgr()
        config = _make_pipeline_config(vad_enabled=True)
        config.streaming = MagicMock(
            spec=["partial_window_s", "partial_interval_s", "max_utterance_sec"]
        )
        config.streaming.partial_window_s = 6.0
        config.streaming.partial_interval_s = None
        config.streaming.max_utterance_sec = None

        kwargs = SessionManager._build_preprocessor_vad_kwargs(mgr, config)

        assert kwargs["partial_window_s"] == 6.0

    def test_partial_interval_is_not_wired_from_a_platform_setting(self):
        """TASK-877 — the cadence is a PER-SESSION agent concept.

        `test_partial_interval_always_present_from_settings` lived here and asserted
        the opposite: that `stt.streaming.partialIntervalS` was always threaded into
        the preprocessor. That key is deleted (it duplicated
        `ResolvedAsrSpec.streaming.partialIntervalMs`), so with no agent opinion the
        kwarg is OMITTED and the preprocessor's own `_PARTIAL_INTERVAL_S` stands.
        The spec-driven path is asserted in `test_task877_session_wiring.py`.
        """
        mgr = _make_mgr()

        without_config = SessionManager._build_preprocessor_vad_kwargs(mgr, None)
        with_config = SessionManager._build_preprocessor_vad_kwargs(
            mgr, _make_pipeline_config(vad_enabled=True)
        )

        assert "partial_interval_s" not in without_config
        assert "partial_interval_s" not in with_config
