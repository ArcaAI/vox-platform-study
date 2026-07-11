"""Shared speaker pre-seed helper for streaming and batch pipelines.

Both SessionManager and BatchTranscriptionService delegate to
``preseed_speaker`` so the logic lives in one place.

PHI log hygiene (TASK-490, TASK-474 finding B-05): this path handles a
clinician's display name and user / consultation identifiers. No log record
emitted here may contain any of them — identifiers are redacted via
:func:`stt_v2.core.logging.redact_id` (deterministic hash prefix, so lines
stay correlatable) and the display name is only ever logged as a boolean.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

from stt_v2.core.logging import redact_id

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

    Tenant scoping (TASK-490): ``tenant_id`` is threaded into every DB lookup.
    The voice-profile queries FAIL CLOSED without it (see
    ``voice_profile_model.py``), so callers must pass the session's tenant —
    a cross-tenant profile is never served.

    Non-fatal: any DB error or missing profile is logged (redacted) and the
    helper returns a structured failure dict (TASK-296 backend-echo contract).

    Returns:
        A dict shaped ``{"success": bool, "profile_id": str | None,
        "model_id": str | None}`` so SessionManager / BatchTranscriptionService
        can echo a ``voiceProfileSeeded`` event back to the SDK regardless of
        outcome. ``profile_id`` and ``model_id`` may be ``None`` even on
        success if the best-effort metadata lookup fails.

    Args:
        tracker: SpeakerTracker instance to pre-register the speaker into.
        consultation_id: Consultation UUID used to resolve the doctor identity.
        tenant_id: Tenant scope applied to every DB query (required for the
            voice-profile lookups to return anything).
        log_context: Optional label (session_id, job_id ...) included in log
            lines — always redacted before logging.
        user_id: Optional authenticated user ID; when set, skips consultation
            identity lookup for the voice embedding.
    """
    # Redacted log context — the fallbacks are identifiers, so the raw value
    # must never reach a log record (B-05).
    ctx = redact_id(log_context or consultation_id or user_id)
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
            "Pre-seed requested: consultation=%s user=%s (ctx=%s)",
            redact_id(consultation_id),
            redact_id(user_id),
            ctx,
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
                "No user identity for consultation=%s (ctx=%s), skipping pre-seed",
                redact_id(consultation_id),
                ctx,
            )
            return dict(_FAILURE_RESULT)

        embedding = await get_voice_embedding(resolved_user_id, tenant_id)
        if not embedding:
            logger.warning(
                "No active voice profile (user=%s consultation=%s ctx=%s), skipping pre-seed",
                redact_id(resolved_user_id),
                redact_id(consultation_id),
                ctx,
            )
            return dict(_FAILURE_RESULT)

        try:
            metadata = await get_voice_profile_metadata(resolved_user_id, tenant_id)
        except Exception as exc:
            # Type name only (no exc_info) — a SQLAlchemy traceback can embed bind
            # params (a user id); PHI-hygiene, uniform with voice_profile_model.
            logger.warning(
                "Voice profile metadata lookup failed (user=%s ctx=%s): %s; continuing",
                redact_id(resolved_user_id),
                ctx,
                type(exc).__name__,
            )
            metadata = None

        profile_id: str | None = metadata.get("profile_id") if metadata else None
        model_id: str | None = metadata.get("model_id") if metadata else None

        logger.info(
            "Pre-seed: resolved user=%s display_name_set=%s embedding_dim=%d (ctx=%s)",
            redact_id(resolved_user_id),
            bool(display_name),
            len(embedding),
            ctx,
        )
        vec = np.array(embedding, dtype=np.float32)
        speaker_id = tracker.register(vec, speaker_id=display_name)
        if speaker_id:
            # NOTE: ``speaker_id`` is the clinician display name — never log it.
            logger.info(
                "Pre-seeded speaker: consultation=%s user=%s registered=True (ctx=%s)",
                redact_id(consultation_id),
                redact_id(resolved_user_id),
                ctx,
            )
            return {
                "success": True,
                "profile_id": profile_id,
                "model_id": model_id,
            }

        logger.warning(
            "Pre-seed skipped for consultation=%s: tracker at capacity (ctx=%s)",
            redact_id(consultation_id),
            ctx,
        )
        return dict(_FAILURE_RESULT)
    except Exception as exc:
        # Type name only (no exc_info) — PHI-hygiene (a traceback can embed ids/bind params).
        logger.warning(
            "Failed to pre-seed speaker (consultation=%s ctx=%s): %s",
            redact_id(consultation_id),
            ctx,
            type(exc).__name__,
        )
        return dict(_FAILURE_RESULT)
