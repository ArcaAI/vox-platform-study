"""TASK-877 — the session manager and the ASR adapter honour the per-session spec.

Mapping the spec onto ``PipelineSpec`` is only half the wiring; these assert the
consuming half:

* the preprocessor's partial cadence and utterance cap come from the SESSION's spec,
  not from a platform key (both platform keys are deleted by this ticket);
* ``_resolve_endpoint_config`` engages the semantic endpointer purely from the spec —
  the ``stt.semanticEndpoint.*`` fallback branch is gone;
* ``decoding.vadFilter`` reaches the faster-whisper adapter's transcribe kwargs.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt.pipeline.dto import (
    EndpointConfig,
    InferenceConfig,
    PreprocessingConfig,
    StreamingConfig,
    VadConfig,
)


@pytest.fixture
def session_manager():
    """A SessionManager built with NO settings — the platform keys are gone, so the
    per-session spec must be the only thing that decides."""
    with patch("stt.streaming.session_manager.get_settings") as mock_settings:
        mock_settings.side_effect = Exception("no settings in test")
        from stt.streaming.execution_profile import ExecutionProfile
        from stt.streaming.session_manager import SessionManager

        profile = MagicMock(spec=ExecutionProfile)
        profile.max_concurrent_streams = 5
        profile.vad_silence_threshold_ms = 500
        return SessionManager(redis=AsyncMock(), profile=profile)


def _pipeline_config(
    *,
    streaming: StreamingConfig | None = None,
    endpoint: EndpointConfig | None = None,
    vad: VadConfig | None = None,
) -> SimpleNamespace:
    """A duck-typed pipeline config shaped like what `pipeline_spec_from_resolved` builds."""
    return SimpleNamespace(
        preprocessing=PreprocessingConfig(
            vad=vad if vad is not None else VadConfig(enabled=False),
            endpoint=endpoint if endpoint is not None else EndpointConfig(),
        ),
        streaming=streaming if streaming is not None else StreamingConfig(),
    )


# ---------------------------------------------------------------------------
# Preprocessor kwargs
# ---------------------------------------------------------------------------


def test_partial_interval_comes_from_the_session_spec(session_manager) -> None:
    config = _pipeline_config(streaming=StreamingConfig(partial_interval_s=0.25))
    kwargs = session_manager._build_preprocessor_vad_kwargs(config)
    assert kwargs["partial_interval_s"] == pytest.approx(0.25)


def test_absent_partial_interval_leaves_the_preprocessor_default(session_manager) -> None:
    """No agent opinion ⇒ the kwarg is not passed at all.

    `stt.streaming.partialIntervalS` is deleted, so the preprocessor's own
    `_PARTIAL_INTERVAL_S` (0.4 — the value the deleted descriptor carried) is the
    floor. Passing it explicitly would restate an engine default in two places.
    """
    kwargs = session_manager._build_preprocessor_vad_kwargs(_pipeline_config())
    assert "partial_interval_s" not in kwargs


def test_max_utterance_sec_caps_the_utterance(session_manager) -> None:
    config = _pipeline_config(streaming=StreamingConfig(max_utterance_sec=30))
    kwargs = session_manager._build_preprocessor_vad_kwargs(config)
    assert kwargs["max_utterance_duration_ms"] == 30_000


def test_max_utterance_sec_wins_over_the_vad_force_emit_window(session_manager) -> None:
    """The agent's cap is the session's cap, above the front-end's force-emit timer."""
    config = _pipeline_config(
        streaming=StreamingConfig(max_utterance_sec=12),
        vad=VadConfig(enabled=True, force_emit_after_ms=25_000),
    )
    kwargs = session_manager._build_preprocessor_vad_kwargs(config)
    assert kwargs["max_utterance_duration_ms"] == 12_000


# ---------------------------------------------------------------------------
# Endpointing
# ---------------------------------------------------------------------------


def test_spec_endpoint_config_engages_the_endpointer(session_manager) -> None:
    config = _pipeline_config(endpoint=EndpointConfig(enabled=True, min_words=5))
    resolved = session_manager._resolve_endpoint_config(config)
    assert resolved is not None and resolved.min_words == 5
    assert session_manager._make_endpointer(config) is not None


def test_a_disabled_spec_endpoint_has_no_platform_fallback(session_manager) -> None:
    """The `stt.semanticEndpoint.*` family is gone: nothing can re-enable it behind
    the agent's back, not even a stray attribute left on the manager."""
    session_manager._semantic_endpoint_enabled = True  # would have won before
    config = _pipeline_config(endpoint=EndpointConfig(enabled=False))
    assert session_manager._resolve_endpoint_config(config) is None
    assert session_manager._make_endpointer(config) is None


def test_a_duck_typed_config_never_enables_endpointing(session_manager) -> None:
    """Strict `isinstance` — a MagicMock pipeline config must not turn it on."""
    assert session_manager._resolve_endpoint_config(MagicMock()) is None


# ---------------------------------------------------------------------------
# decoding.vadFilter → the adapter
# ---------------------------------------------------------------------------


def test_vad_filter_reaches_the_faster_whisper_decode_kwargs() -> None:
    from stt.streaming.faster_whisper_asr import FasterWhisperAsrAdapter

    kwargs = FasterWhisperAsrAdapter._build_decode_kwargs(InferenceConfig(vad_filter=True))
    assert kwargs["vad_filter"] is True


def test_vad_filter_defaults_off_for_the_streaming_path() -> None:
    from stt.streaming.faster_whisper_asr import FasterWhisperAsrAdapter

    kwargs = FasterWhisperAsrAdapter._build_decode_kwargs(InferenceConfig())
    assert kwargs["vad_filter"] is False
