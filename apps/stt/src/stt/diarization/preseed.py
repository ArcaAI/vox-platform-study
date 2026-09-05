"""Seed a :class:`~stt.diarization.speaker_tracker.SpeakerTracker` with ENROLLED voice profiles.

TASK-887 — diarization is a declared ASR-agent option, and the profiles that give it real
names are resolved and PUSHED by the gateway: on the session-create body as
``voice_profiles``, and as the ``voice_profiles`` kwarg of the batch Dramatiq message.

This module used to read ``core."UserVoiceProfile"`` (and ``Consultation`` / ``UserProfile``)
directly through ``core.database.voice_profile_model``. That is a Postgres read on the agent
path, which `06-python-services.md` forbids — and it has failed closed since TASK-861 turned
``STT_DATABASE_ENABLED`` off by default, so it was also dead. The gateway already knows the
session's user, the session's tenant and the agent's embedding model; it is the only side that
can filter profiles to the model that will actually match them.

Pure and synchronous: no I/O, no database, no await. It only reshapes what it was handed.

PHI log hygiene: this path handles a clinician's display name and user / profile identifiers.
No log record emitted here may contain any of them — identifiers are redacted via
:func:`stt.core.logging.redact_id` (deterministic hash prefix, so lines stay correlatable) and
the label is only ever logged as a boolean.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

from stt.core.logging import redact_id

logger = logging.getLogger(__name__)


def _failure(skipped_other_model: int = 0) -> dict[str, object]:
    """The backend-echo contract, shaped identically whatever went wrong."""
    return {
        "success": False,
        "profile_id": None,
        "model_id": None,
        "seeded": 0,
        "skipped_other_model": skipped_other_model,
    }


def seed_voice_profiles(
    tracker: Any,
    profiles: list[dict[str, Any]] | None,
    *,
    model_slug: str | None,
    log_context: str | None = None,
) -> dict[str, object]:
    """Register the end-user's enrolled embeddings on ``tracker`` under their labels.

    Only profiles embedded by ``model_slug`` are registered. A profile from ANOTHER model is
    a vector in another space: comparing it would produce a meaningless similarity, so it is
    ignored and counted, never coerced, re-projected or truncated. (The gateway filters too;
    this is the second half of the same rule, applied where the vectors are actually used.)

    Args:
        tracker: the session's :class:`SpeakerTracker`.
        profiles: gateway-pushed rows — ``{profile_id, label, model_id, embedding}``.
        model_slug: the ``AiModel`` slug of the agent's speaker-embedding model
            (``ResolvedAsrSpec.models.embedding.slug``). ``None`` seeds nothing.
        log_context: session id / job id for correlation — redacted before logging.

    Returns:
        ``{"success", "profile_id", "model_id", "seeded", "skipped_other_model"}`` — the
        backend-echo contract, so a caller can report ``voiceProfileSeeded`` either way.
    """
    ctx = redact_id(log_context)
    if not model_slug:
        # Diarization without a declared embedding model cannot label anything. The spec
        # builder refuses that agent, so reaching here means a deprecated-pipeline session.
        return _failure()
    if not profiles:
        logger.info("No enrolled voice profiles pushed for this run (ctx=%s)", ctx)
        return _failure()

    first_profile_id: str | None = None
    seeded = 0
    skipped_other_model = 0

    for profile in profiles:
        profile_model = profile.get("model_id")
        if profile_model != model_slug:
            skipped_other_model += 1
            continue

        raw = profile.get("embedding")
        if not raw:
            continue
        try:
            vector = np.asarray(raw, dtype=np.float32)
        except (TypeError, ValueError):
            logger.warning("Discarding a malformed voice-profile embedding (ctx=%s)", ctx)
            continue
        if vector.ndim != 1 or vector.size == 0:
            logger.warning("Discarding a non-vector voice-profile embedding (ctx=%s)", ctx)
            continue

        label = profile.get("label")
        # NOTE: ``label`` is a clinician display name — never log it.
        registered = tracker.register(
            vector,
            speaker_id=label if isinstance(label, str) and label.strip() else None,
            enrolled=True,
        )
        if registered is None:
            logger.warning("Tracker at capacity; remaining profiles not seeded (ctx=%s)", ctx)
            break
        seeded += 1
        if first_profile_id is None:
            profile_id = profile.get("profile_id")
            first_profile_id = profile_id if isinstance(profile_id, str) else None

    logger.info(
        "Voice-profile seeding: seeded=%d skipped_other_model=%d model=%s (ctx=%s)",
        seeded,
        skipped_other_model,
        model_slug,
        ctx,
    )
    if seeded == 0:
        return _failure(skipped_other_model)
    return {
        "success": True,
        "profile_id": first_profile_id,
        "model_id": model_slug,
        "seeded": seeded,
        "skipped_other_model": skipped_other_model,
    }
