"""SessionManager ↔ semantic-endpointer wiring (TASK-473 · Theme A3).

Proves the endpointer is built + threaded per session, gated OFF by default, and
overridable per pipeline — mirroring the ``_make_commit_policy`` gating.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt_v2.pipeline.dto import EndpointConfig, PreprocessingConfig
from stt_v2.streaming.semantic_endpointer import SemanticEndpointer


@pytest.fixture
def session_manager():
    with patch("stt_v2.streaming.session_manager.get_settings") as mock_settings:
        mock_settings.side_effect = Exception("no settings in test")
        from stt_v2.streaming.execution_profile import ExecutionProfile
        from stt_v2.streaming.session_manager import SessionManager

        profile = MagicMock(spec=ExecutionProfile)
        profile.max_concurrent_streams = 5
        profile.vad_silence_threshold_ms = 500
        redis = AsyncMock()
        return SessionManager(redis=redis, profile=profile)


def test_make_endpointer_disabled_by_default(session_manager) -> None:
    assert session_manager._make_endpointer(None) is None


def test_make_endpointer_enabled_via_settings(session_manager) -> None:
    session_manager._semantic_endpoint_enabled = True
    ep = session_manager._make_endpointer(None)
    assert isinstance(ep, SemanticEndpointer)
    assert ep.enabled is True


def test_build_preprocessor_vad_kwargs_includes_endpointer(session_manager) -> None:
    kwargs = session_manager._build_preprocessor_vad_kwargs(None)
    assert "endpointer" in kwargs
    # Disabled by default → None (fixed-timer behavior preserved).
    assert kwargs["endpointer"] is None


def test_build_preprocessor_vad_kwargs_threads_enabled_endpointer(session_manager) -> None:
    session_manager._semantic_endpoint_enabled = True
    kwargs = session_manager._build_preprocessor_vad_kwargs(None)
    assert isinstance(kwargs["endpointer"], SemanticEndpointer)


def test_make_endpointer_pipeline_override(session_manager) -> None:
    # Global disabled, but a pipeline explicitly enables endpointing.
    pipeline = MagicMock()
    pipeline.preprocessing = PreprocessingConfig(endpoint=EndpointConfig(enabled=True))
    ep = session_manager._make_endpointer(pipeline)
    assert isinstance(ep, SemanticEndpointer)
    assert ep.enabled is True


def test_make_endpointer_ignores_duck_typed_config(session_manager) -> None:
    # A MagicMock pipeline must NOT accidentally enable (strict type gating,
    # mirrors _make_commit_policy).
    pipeline = MagicMock()  # .preprocessing.endpoint is a MagicMock, not EndpointConfig
    assert session_manager._make_endpointer(pipeline) is None
