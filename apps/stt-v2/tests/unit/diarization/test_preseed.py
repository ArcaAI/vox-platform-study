"""Unit tests for `preseed_speaker` return contract (TASK-296 backend-echo).

Verifies that `preseed_speaker(...)` returns a structured dict with shape
`{"success": bool, "profile_id": str | None, "model_id": str | None}` so that
SessionManager (TASK-298) and BatchTranscriptionService can echo the
`voiceProfileSeeded` event back to the client.

The metadata (profile_id, model_id) is fetched best-effort via the new
`get_voice_profile_metadata` helper, which is purposefully non-fatal: a
failed metadata lookup MUST NOT block the speaker pre-seed.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt_v2.diarization.preseed import preseed_speaker


class _FakeTracker:
    """Minimal SpeakerTracker stand-in used by preseed tests."""

    def __init__(self, register_returns: str | None = "Dr. Alice"):
        self.register = MagicMock(return_value=register_returns)


@pytest.mark.asyncio
async def test_preseed_returns_success_dict_when_profile_found():
    """Active profile -> success=True with profile_id + model_id populated."""
    tracker = _FakeTracker(register_returns="Dr. Alice")

    with (
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_identity",
            new=AsyncMock(return_value=("user-uuid-1", "Dr. Alice")),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_display_name",
            new=AsyncMock(return_value="Dr. Alice"),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_voice_embedding",
            new=AsyncMock(return_value=[0.01] * 256),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_voice_profile_metadata",
            new=AsyncMock(
                return_value={
                    "profile_id": "profile-uuid-1",
                    "model_id": "ecapa-tdnn-v1",
                }
            ),
        ),
    ):
        result = await preseed_speaker(
            tracker,
            consultation_id="cons-1",
            user_id="user-uuid-1",
            log_context="session-x",
        )

    assert isinstance(result, dict)
    assert result == {
        "success": True,
        "profile_id": "profile-uuid-1",
        "model_id": "ecapa-tdnn-v1",
    }


@pytest.mark.asyncio
async def test_preseed_returns_failure_dict_when_no_active_profile():
    """Missing profile -> success=False, profile_id=None, model_id=None."""
    tracker = _FakeTracker()

    with (
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_identity",
            new=AsyncMock(return_value=("user-uuid-1", "Dr. Alice")),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_display_name",
            new=AsyncMock(return_value="Dr. Alice"),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_voice_embedding",
            new=AsyncMock(return_value=None),
        ),
    ):
        result = await preseed_speaker(
            tracker,
            consultation_id="cons-1",
            user_id="user-uuid-1",
        )

    assert result == {"success": False, "profile_id": None, "model_id": None}


@pytest.mark.asyncio
async def test_preseed_returns_failure_dict_when_no_user_identity():
    """No user identity -> success=False, profile_id=None, model_id=None."""
    tracker = _FakeTracker()

    with patch(
        "stt_v2.core.database.voice_profile_model.get_user_identity",
        new=AsyncMock(return_value=(None, None)),
    ):
        result = await preseed_speaker(tracker, consultation_id="cons-1")

    assert result == {"success": False, "profile_id": None, "model_id": None}


@pytest.mark.asyncio
async def test_preseed_returns_failure_dict_when_tracker_at_capacity():
    """Tracker.register returns None -> success=False."""
    tracker = _FakeTracker(register_returns=None)

    with (
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_identity",
            new=AsyncMock(return_value=("user-uuid-1", "Dr. Alice")),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_display_name",
            new=AsyncMock(return_value="Dr. Alice"),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_voice_embedding",
            new=AsyncMock(return_value=[0.01] * 256),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_voice_profile_metadata",
            new=AsyncMock(
                return_value={
                    "profile_id": "profile-uuid-1",
                    "model_id": "ecapa-tdnn-v1",
                }
            ),
        ),
    ):
        result = await preseed_speaker(
            tracker, consultation_id="cons-1", user_id="user-uuid-1"
        )

    assert result == {"success": False, "profile_id": None, "model_id": None}


@pytest.mark.asyncio
async def test_preseed_swallows_db_exception_and_returns_failure_dict():
    """Unexpected exception in identity lookup -> failure dict (non-fatal)."""
    tracker = _FakeTracker()

    with patch(
        "stt_v2.core.database.voice_profile_model.get_user_identity",
        new=AsyncMock(side_effect=RuntimeError("DB down")),
    ):
        result = await preseed_speaker(tracker, consultation_id="cons-1")

    assert result == {"success": False, "profile_id": None, "model_id": None}


@pytest.mark.asyncio
async def test_preseed_returns_success_with_none_metadata_when_metadata_lookup_fails():
    """Metadata lookup failure MUST NOT block speaker registration.

    success=True with profile_id=None / model_id=None when metadata is missing.
    """
    tracker = _FakeTracker(register_returns="Dr. Alice")

    with (
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_identity",
            new=AsyncMock(return_value=("user-uuid-1", "Dr. Alice")),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_display_name",
            new=AsyncMock(return_value="Dr. Alice"),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_voice_embedding",
            new=AsyncMock(return_value=[0.01] * 256),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_voice_profile_metadata",
            new=AsyncMock(return_value=None),
        ),
    ):
        result = await preseed_speaker(
            tracker,
            consultation_id="cons-1",
            user_id="user-uuid-1",
        )

    assert result["success"] is True
    assert result["profile_id"] is None
    assert result["model_id"] is None
