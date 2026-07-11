"""Unit tests for `preseed_speaker` (TASK-296 backend-echo · TASK-490 PHI/tenant).

Verifies that `preseed_speaker(...)` returns a structured dict with shape
`{"success": bool, "profile_id": str | None, "model_id": str | None}` so that
SessionManager (TASK-298) and BatchTranscriptionService can echo the
`voiceProfileSeeded` event back to the client.

The metadata (profile_id, model_id) is fetched best-effort via the new
`get_voice_profile_metadata` helper, which is purposefully non-fatal: a
failed metadata lookup MUST NOT block the speaker pre-seed.

TASK-490 adds two contracts (TASK-474 findings B-04/B-05):
  * tenant threading — ``tenant_id`` reaches every tenant-aware DB lookup;
  * PHI log hygiene — no clinician name / user id / consultation id ever
    appears in a log record emitted by the preseed path (redacted/hashed
    identifiers, counts and booleans only).
"""

from __future__ import annotations

import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt_v2.diarization.preseed import preseed_speaker

# Realistic PII fixtures for the log-hygiene assertions.
_PII_DISPLAY_NAME = "Dr. Alice Wonderland"
_PII_USER_ID = "018f6b1c-aaaa-7bbb-8ccc-0123456789ab"
_PII_CONSULTATION_ID = "018f6b1c-dddd-7eee-8fff-fedcba987654"


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


# ---------------------------------------------------------------------------
# TASK-490 AC-2 — tenant_id is threaded into every tenant-aware lookup
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_preseed_threads_tenant_id_to_all_lookups():
    """tenant_id reaches identity, embedding AND metadata lookups (B-04)."""
    tracker = _FakeTracker(register_returns="Dr. Alice")
    identity = AsyncMock(return_value=("user-uuid-1", "Dr. Alice"))
    embedding = AsyncMock(return_value=[0.01] * 256)
    metadata = AsyncMock(return_value={"profile_id": "p1", "model_id": "m1"})

    with (
        patch("stt_v2.core.database.voice_profile_model.get_user_identity", new=identity),
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_display_name",
            new=AsyncMock(return_value="Dr. Alice"),
        ),
        patch("stt_v2.core.database.voice_profile_model.get_voice_embedding", new=embedding),
        patch(
            "stt_v2.core.database.voice_profile_model.get_voice_profile_metadata",
            new=metadata,
        ),
    ):
        result = await preseed_speaker(
            tracker,
            consultation_id="cons-1",
            tenant_id="tenant-a",
            log_context="session-x",
        )

    assert result["success"] is True
    identity.assert_awaited_once_with("cons-1", "tenant-a")
    embedding.assert_awaited_once_with("user-uuid-1", "tenant-a")
    metadata.assert_awaited_once_with("user-uuid-1", "tenant-a")


# ---------------------------------------------------------------------------
# TASK-490 AC-1 — no PII/PHI in any log record emitted by the preseed path
# ---------------------------------------------------------------------------


def _assert_no_pii(caplog):
    """No clinician name / raw user id / raw consultation id in any record."""
    assert _PII_DISPLAY_NAME not in caplog.text
    assert "Alice" not in caplog.text  # no fragment of the name either
    assert _PII_USER_ID not in caplog.text
    assert _PII_CONSULTATION_ID not in caplog.text


@pytest.mark.asyncio
async def test_preseed_success_logs_contain_no_pii(caplog):
    """Happy path logs counts/booleans/redacted ids — never name or raw ids."""
    tracker = _FakeTracker(register_returns=_PII_DISPLAY_NAME)

    with (
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_identity",
            new=AsyncMock(return_value=(_PII_USER_ID, _PII_DISPLAY_NAME)),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_display_name",
            new=AsyncMock(return_value=_PII_DISPLAY_NAME),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_voice_embedding",
            new=AsyncMock(return_value=[0.01] * 256),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_voice_profile_metadata",
            new=AsyncMock(return_value={"profile_id": "p1", "model_id": "m1"}),
        ),
        caplog.at_level(logging.DEBUG, logger="stt_v2.diarization.preseed"),
    ):
        result = await preseed_speaker(
            tracker,
            consultation_id=_PII_CONSULTATION_ID,
            tenant_id="tenant-a",
            user_id=_PII_USER_ID,
            log_context="session-x",
        )

    assert result["success"] is True
    assert len(caplog.records) > 0  # the path IS logged...
    _assert_no_pii(caplog)  # ...without PII


@pytest.mark.asyncio
async def test_preseed_no_profile_warning_contains_no_pii(caplog):
    """The 'no active voice profile' warning is redacted."""
    tracker = _FakeTracker()

    with (
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_identity",
            new=AsyncMock(return_value=(_PII_USER_ID, _PII_DISPLAY_NAME)),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_display_name",
            new=AsyncMock(return_value=_PII_DISPLAY_NAME),
        ),
        patch(
            "stt_v2.core.database.voice_profile_model.get_voice_embedding",
            new=AsyncMock(return_value=None),
        ),
        caplog.at_level(logging.DEBUG, logger="stt_v2.diarization.preseed"),
    ):
        result = await preseed_speaker(
            tracker,
            consultation_id=_PII_CONSULTATION_ID,
            tenant_id="tenant-a",
        )

    assert result["success"] is False
    assert any(r.levelno >= logging.WARNING for r in caplog.records)
    _assert_no_pii(caplog)


@pytest.mark.asyncio
async def test_preseed_no_identity_warning_contains_no_pii(caplog):
    """The 'no user identity' warning is redacted."""
    tracker = _FakeTracker()

    with (
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_identity",
            new=AsyncMock(return_value=(None, None)),
        ),
        caplog.at_level(logging.DEBUG, logger="stt_v2.diarization.preseed"),
    ):
        result = await preseed_speaker(
            tracker, consultation_id=_PII_CONSULTATION_ID, tenant_id="tenant-a"
        )

    assert result["success"] is False
    _assert_no_pii(caplog)


@pytest.mark.asyncio
async def test_preseed_exception_path_logs_contain_no_pii(caplog):
    """The catch-all failure log (incl. traceback) is redacted."""
    tracker = _FakeTracker()

    with (
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_identity",
            new=AsyncMock(side_effect=RuntimeError("DB down")),
        ),
        caplog.at_level(logging.DEBUG, logger="stt_v2.diarization.preseed"),
    ):
        result = await preseed_speaker(
            tracker, consultation_id=_PII_CONSULTATION_ID, tenant_id="tenant-a"
        )

    assert result["success"] is False
    _assert_no_pii(caplog)


@pytest.mark.asyncio
async def test_preseed_fallback_log_context_is_not_logged_raw(caplog):
    """When log_context is absent it falls back to consultation/user ids —
    those fallbacks must be redacted in log output too (B-05)."""
    tracker = _FakeTracker()

    with (
        patch(
            "stt_v2.core.database.voice_profile_model.get_user_identity",
            new=AsyncMock(return_value=(None, None)),
        ),
        caplog.at_level(logging.DEBUG, logger="stt_v2.diarization.preseed"),
    ):
        await preseed_speaker(
            tracker,
            consultation_id=_PII_CONSULTATION_ID,
            tenant_id="tenant-a",
            # no log_context -> label falls back to consultation_id
        )

    _assert_no_pii(caplog)
