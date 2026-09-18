"""TASK-985 M-13 / CL-2 / CL-4 — the agent's segmentation numbers must arrive.

M-13: the admin UI showed `minSilenceMs: 350` while 500 ms ran, for a year.

The mapper was NOT at fault — `spec.py` writes the agent's threshold,
min_speech, min_silence and padding into `VadConfig` whether or not the Silero
stage is enabled, so the served session really did hold 350. The loss was
entirely in one `if` in `_build_preprocessor_vad_kwargs`, whose `else`
substituted `ExecutionProfile.vad_silence_threshold_ms` — a literal 500 on all
five hardware profiles. The seed comment recording the change to 350 therefore
described something that had never executed.

That profile field is deleted here, not merely bypassed: it had exactly one
production reader (the branch that is gone) and a hardware profile describes the
DEVICE, never the clinician's speech.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from stt.streaming.session_manager import SessionManager


def _vad_config(**overrides):
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
    vad.enabled = overrides.get("enabled", False)
    vad.threshold = overrides.get("threshold", 0.5)
    vad.min_speech_duration_ms = overrides.get("min_speech_duration_ms", 100)
    vad.min_silence_duration_ms = overrides.get("min_silence_duration_ms", 350)
    vad.pre_speech_context_ms = overrides.get("pre_speech_context_ms", 500)
    vad.force_emit_after_ms = overrides.get("force_emit_after_ms", 25000)
    vad.force_emit_lookback_ms = overrides.get("force_emit_lookback_ms", 1500)
    vad.force_emit_overlap_ms = overrides.get("force_emit_overlap_ms", 500)
    return vad


def _mgr():
    mgr = MagicMock(spec=SessionManager)
    mgr._profile = MagicMock()
    return mgr


class TestSegmentationTuningSurvivesADisabledVadStage:
    def test_the_seeded_350ms_reaches_the_preprocessor(self):
        """The exact served configuration that produced the M-13 symptom."""
        mgr = _mgr()
        config = MagicMock()
        config.preprocessing.vad = _vad_config(enabled=False, min_silence_duration_ms=350)

        kwargs = SessionManager._build_preprocessor_vad_kwargs(mgr, config)

        assert kwargs["min_silence_duration_ms"] == 350

    def test_the_hardware_profile_no_longer_has_an_opinion(self):
        """The field is GONE, not just unread — a dead default is a live trap."""
        from stt.streaming.execution_profile import ExecutionProfile

        assert "vad_silence_threshold_ms" not in ExecutionProfile.__dataclass_fields__

    def test_all_four_tuning_values_travel_together(self):
        """Four values differed between the branches, not one.

        threshold 0.6 -> 0.5, min_speech 100 -> 100, min_silence 500 -> 350 and
        pre_speech_context 300 -> 500. Asserting only the silence window would
        have left three of them still substituted.
        """
        mgr = _mgr()
        config = MagicMock()
        config.preprocessing.vad = _vad_config(enabled=False)

        kwargs = SessionManager._build_preprocessor_vad_kwargs(mgr, config)

        assert kwargs["threshold"] == 0.5
        assert kwargs["min_speech_duration_ms"] == 100
        assert kwargs["min_silence_duration_ms"] == 350
        assert kwargs["pre_speech_context_ms"] == 500

    def test_an_absent_vad_block_leaves_the_preprocessor_defaults_standing(self):
        mgr = _mgr()

        kwargs = SessionManager._build_preprocessor_vad_kwargs(mgr, None)

        assert "threshold" not in kwargs
        assert "min_silence_duration_ms" not in kwargs

    @pytest.mark.parametrize("enabled", [True, False])
    def test_the_stage_flag_does_not_change_the_numbers(self, enabled: bool):
        """`vad.enabled` gates the MODEL, never the tuning."""
        mgr = _mgr()
        config = MagicMock()
        config.preprocessing.vad = _vad_config(enabled=enabled, min_silence_duration_ms=350)

        kwargs = SessionManager._build_preprocessor_vad_kwargs(mgr, config)

        assert kwargs["min_silence_duration_ms"] == 350
