"""Shared speaker pre-seed helper for streaming and batch pipelines.

Both SessionManager and BatchTranscriptionService delegate to
``preseed_speaker`` so the logic lives in one place.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


_FAILURE_RESULT: dict[str, object] = {
    "success": False,
    "profile_id": None,
    "model_id": None,
}


async def preseed_speaker(
    tracker: Any,
    consultation_id: str | None,
    *,
    tenant_id: str | None = None,
    log_context: str | None = None,
    user_id: str | None = None,
) -> dict[str, object]:
    """Pre-seed a SpeakerTracker with the consultation doctor's voice profile.

    Looks up the consultation doctor and their active voice embedding from the
    database then registers the embedding so diarization output uses the real
    display name instead of a generic "Speaker N" label.

    When ``user_id`` is provided directly, the consultation lookup for user
    identity is skipped and the voice embedding is fetched for that user
    immediately (display name is still resolved from the consultation when
    available).

    Non-fatal: any DB error or missing profile is logged and the helper
    returns a structured failure dict (TASK-296 backend-echo contract).

    Returns:
        A dict shaped ``{"success": bool, "profile_id": str | None,
        "model_id": str | None}`` so SessionManager / BatchTranscriptionService
        can echo a ``voiceProfileSeeded`` event back to the SDK regardless of
        outcome. ``profile_id`` and ``model_id`` may be ``None`` even on
        success if the best-effort metadata lookup fails.

    Args:
        tracker: SpeakerTracker instance to pre-register the speaker into.
        consultation_id: Consultation UUID used to resolve the doctor identity.
        tenant_id: Optional tenant scope added to the DB query.
        log_context: Optional label (session_id, job_id ...) included in log lines.
        user_id: Optional authenticated user ID; when set, skips consultation
            identity lookup for the voice embedding.
    """
    label = log_context or consultation_id or user_id
    try:
        from ..core.database.voice_profile_model import (
            get_user_display_name,
            get_user_identity,
            get_voice_embedding,
            get_voice_profile_metadata,
        )

        resolved_user_id = user_id
        display_name: str | None = None

        logger.info(
            "Pre-seed requested: consultation_id=%s user_id=%s (%s)",
            consultation_id,
            user_id,
            label,
        )

        if consultation_id:
            cid_user_id, cid_display_name = await get_user_identity(consultation_id, tenant_id)
            if not resolved_user_id:
                resolved_user_id = cid_user_id
            display_name = cid_display_name

        if not display_name and resolved_user_id:
            display_name = await get_user_display_name(resolved_user_id)

        if not resolved_user_id:
            logger.warning(
                "No user identity for consultation %s (%s), skipping pre-seed",
                consultation_id,
                label,
            )
            return dict(_FAILURE_RESULT)

        embedding = await get_voice_embedding(resolved_user_id, tenant_id)
        if not embedding:
            logger.warning(
                "No active voice profile for user %s (consultation %s / %s), skipping pre-seed",
                resolved_user_id,
                consultation_id,
                label,
            )
            return dict(_FAILURE_RESULT)

        try:
            metadata = await get_voice_profile_metadata(resolved_user_id, tenant_id)
        except Exception:
            logger.warning(
                "Voice profile metadata lookup failed for user %s (%s); continuing",
                resolved_user_id,
                label,
                exc_info=True,
            )
            metadata = None

        profile_id: str | None = metadata.get("profile_id") if metadata else None
        model_id: str | None = metadata.get("model_id") if metadata else None

        logger.info(
            "Pre-seed: resolved user=%s display_name=%r embedding_dim=%d (%s)",
            resolved_user_id,
            display_name,
            len(embedding),
            label,
        )
        vec = np.array(embedding, dtype=np.float32)
        speaker_id = tracker.register(vec, speaker_id=display_name)
        if speaker_id:
            logger.info(
                "Pre-seeded speaker from consultation %s: user %s registered as %s (%s)",
                consultation_id,
                resolved_user_id,
                speaker_id,
                label,
            )
            return {
                "success": True,
                "profile_id": profile_id,
                "model_id": model_id,
            }

        logger.warning(
            "Pre-seed skipped for consultation %s: tracker at capacity (%s)",
            consultation_id,
            label,
        )
        return dict(_FAILURE_RESULT)
    except Exception:
        logger.warning(
            "Failed to pre-seed speaker from consultation %s (%s)",
            consultation_id,
            label,
            exc_info=True,
        )
        return dict(_FAILURE_RESULT)
