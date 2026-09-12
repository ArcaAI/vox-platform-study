"""SessionManager → StreamingPreprocessor kwargs wiring.

Pins the contract of ``SessionManager._build_preprocessor_vad_kwargs``:

- H4: when the pipeline has NO VAD config, ``min_silence_duration_ms`` comes
  from the hardware ``ExecutionProfile`` (500 ms on every profile) instead of
  the preprocessor's legacy hardcoded 700 ms.
- Pipeline YAML still wins when VAD is configured (per-pipeline override).
- TASK-877: the partial-emit CADENCE is a per-session AGENT value, not a setting.
- TASK-880: the partial decode WINDOW is a per-model value (the ASR row's
  `_metadata.asr.partialWindowSec`), not a setting either.
"""

from unittest.mock import MagicMock

from stt.streaming.session_manager import SessionManager


def _make_mgr(vad_silence_threshold_ms: int = 500) -> MagicMock:
    mgr = MagicMock(spec=SessionManager)
    mgr._profile = MagicMock()
    mgr._profile.vad_silence_threshold_ms = vad_silence_threshold_ms
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
    def test_no_pipeline_config_uses_profile_silence_threshold(self):
        """H4: without a pipeline, the profile's 500 ms applies (not 700)."""
        mgr = _make_mgr(vad_silence_threshold_ms=500)

        kwargs = SessionManager._build_preprocessor_vad_kwargs(mgr, None)

        assert kwargs["min_silence_duration_ms"] == 500

    def test_vad_disabled_uses_profile_silence_threshold(self):
        """VAD disabled in YAML → energy-fallback segmentation still uses the
        profile silence threshold."""
        mgr = _make_mgr(vad_silence_threshold_ms=500)
        config = _make_pipeline_config(vad_enabled=False)

        kwargs = SessionManager._build_preprocessor_vad_kwargs(mgr, config)

        assert kwargs["min_silence_duration_ms"] == 500

    def test_pipeline_yaml_wins_when_vad_configured(self):
        """Per-pipeline YAML values override the profile default."""
        mgr = _make_mgr(vad_silence_threshold_ms=500)
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
