"""Read-only model for UserVoiceProfile table.

Used by STT-v2 to read the active voice profile at session start
for pre-seeding the SpeakerTracker.

PHI posture:
  * The speaker embedding is biometric PHI. Every profile lookup is
    tenant-scoped (``"tenantId" = :tenant_id``) and FAILS CLOSED when no
    tenant scope is supplied — a cross-tenant read returns nothing.
  * Log records never contain raw user / consultation identifiers — they are
    redacted via :func:`stt_v2.core.logging.redact_id`. DB failures log the
    exception type only (no ``exc_info``): SQLAlchemy error strings embed the
    bind parameters, which would leak the identifiers into the log.
"""

from __future__ import annotations

import logging

from sqlalchemy import Boolean, DateTime, String, text
from sqlalchemy.orm import Mapped, mapped_column

from stt_v2.core.database.connection import get_session
from stt_v2.core.database.models import Base, ResourceStatusType
from stt_v2.core.logging import redact_id

logger = logging.getLogger(__name__)


class UserVoiceProfileRead(Base):
    """Read-only model for UserVoiceProfile table."""

    __tablename__ = "UserVoiceProfile"
    __table_args__ = {"schema": "core"}

    id: Mapped[str] = mapped_column(String, primary_key=True)
    tenantId: Mapped[str] = mapped_column("tenantId", String)
    userId: Mapped[str] = mapped_column("userId", String)
    isActive: Mapped[bool] = mapped_column("isActive", Boolean)
    label: Mapped[str | None] = mapped_column(String)
    modelId: Mapped[str | None] = mapped_column("modelId", String)
    resource_status: Mapped[str] = mapped_column("resourceStatus", ResourceStatusType)
    created_at: Mapped[str] = mapped_column("createdAt", DateTime)
    updated_at: Mapped[str] = mapped_column("updatedAt", DateTime)


async def get_voice_embedding(
    user_id: str,
    tenant_id: str | None = None,
) -> list[float] | None:
    """Fetch the active voice profile embedding for a user, tenant-scoped.

    Returns the 256d embedding as a list of floats, or None if no active
    profile exists IN THE GIVEN TENANT. Uses raw SQL because the embedding
    column is a pgvector type not mapped in SQLAlchemy.

    The ``core."UserVoiceProfile"."tenantId"`` column exists and the filter is
    ENFORCED. When ``tenant_id`` is missing the lookup fails closed (returns
    ``None`` without querying) so an unscoped read is structurally impossible.
    """
    if not tenant_id:
        logger.warning(
            "Voice profile lookup refused: missing tenant scope (user=%s)",
            redact_id(user_id),
        )
        return None
    try:
        async with get_session() as session:
            sql = (
                'SELECT embedding::text FROM core."UserVoiceProfile" '
                'WHERE "userId" = :user_id '
                'AND "tenantId" = :tenant_id '
                'AND "isActive" = true '
                "AND \"resourceStatus\" = 'ENABLED' "
                "LIMIT 1"
            )
            params: dict[str, str] = {"user_id": user_id, "tenant_id": tenant_id}

            result = await session.execute(text(sql), params)
            row = result.fetchone()
            if row is None:
                return None

            raw = row[0]
            if raw.startswith("[") and raw.endswith("]"):
                return [float(x) for x in raw[1:-1].split(",")]
            return None
    except Exception as exc:  # noqa: BLE001 — non-fatal by contract
        logger.warning(
            "Failed to fetch voice profile (user=%s tenant=%s): %s",
            redact_id(user_id),
            redact_id(tenant_id),
            type(exc).__name__,
        )
        return None


async def get_voice_profile_metadata(
    user_id: str,
    tenant_id: str | None = None,
) -> dict[str, str | None] | None:
    """Fetch the active voice profile metadata (id, modelId), tenant-scoped.

    Returns ``{"profile_id": str, "model_id": str | None}`` or ``None`` when
    no active profile exists in the given tenant. Non-fatal on DB errors —
    returns ``None`` so callers can degrade gracefully (this powers the
    ``voiceProfileSeeded`` echo payload sent to the SDK).

    Tenant filter enforced; missing ``tenant_id`` fails closed (same contract
    as :func:`get_voice_embedding`).
    """
    if not tenant_id:
        logger.warning(
            "Voice profile metadata lookup refused: missing tenant scope (user=%s)",
            redact_id(user_id),
        )
        return None
    try:
        async with get_session() as session:
            sql = (
                'SELECT id, "modelId" FROM core."UserVoiceProfile" '
                'WHERE "userId" = :user_id '
                'AND "tenantId" = :tenant_id '
                'AND "isActive" = true '
                "AND \"resourceStatus\" = 'ENABLED' "
                "LIMIT 1"
            )
            params: dict[str, str] = {"user_id": user_id, "tenant_id": tenant_id}

            result = await session.execute(text(sql), params)
            row = result.fetchone()
            if row is None:
                return None
            return {"profile_id": row[0], "model_id": row[1]}
    except Exception as exc:  # noqa: BLE001 — non-fatal by contract
        logger.warning(
            "Failed to fetch voice profile metadata (user=%s tenant=%s): %s",
            redact_id(user_id),
            redact_id(tenant_id),
            type(exc).__name__,
        )
        return None


async def get_user_display_name(user_id: str) -> str | None:
    """Resolve display name directly from UserProfile by user ID.

    Returns "firstName lastName" or None when the profile is missing.
    """
    try:
        async with get_session() as session:
            result = await session.execute(
                text(
                    'SELECT "firstName", "lastName" '
                    'FROM core."UserProfile" '
                    'WHERE "userId" = :user_id '
                    "AND \"resourceStatus\" = 'ENABLED' "
                    'LIMIT 1'
                ),
                {"user_id": user_id},
            )
            row = result.fetchone()
            if row is None:
                return None
            parts = [p for p in (row[0], row[1]) if p and p.strip()]
            return " ".join(parts) if parts else None
    except Exception as exc:  # noqa: BLE001 — non-fatal by contract
        logger.warning(
            "Failed to fetch display name (user=%s): %s",
            redact_id(user_id),
            type(exc).__name__,
        )
        return None


async def get_user_identity(
    consultation_id: str,
    tenant_id: str | None = None,
) -> tuple[str | None, str | None]:
    """Resolve (doctor_user_id, display_name) from a consultation.

    Returns (None, None) when no consultation or doctor is found. When
    ``tenant_id`` is provided the consultation read is tenant-scoped (a
    cross-tenant consultation resolves to nothing). Fails closed (returns
    ``(None, None)`` without querying) when ``tenant_id`` is missing, uniform with
    ``get_voice_embedding`` — an unscoped identity read is structurally impossible.
    """
    if not tenant_id:
        logger.warning(
            "Doctor identity lookup refused: missing tenant scope (consultation=%s)",
            redact_id(consultation_id),
        )
        return None, None
    try:
        async with get_session() as session:
            sql = (
                'SELECT c."doctorId", up."firstName", up."lastName" '
                'FROM core."Consultation" c '
                'LEFT JOIN core."UserProfile" up ON up."userId" = c."doctorId" '
                'WHERE c.id = :consultation_id '
                "AND c.\"resourceStatus\" = 'ENABLED' "
                'AND c."tenantId" = :tenant_id '
                "LIMIT 1"
            )
            params: dict[str, str] = {
                "consultation_id": consultation_id,
                "tenant_id": tenant_id,
            }

            result = await session.execute(
                text(sql),
                params,
            )
            row = result.fetchone()
            if row is None:
                return None, None

            doctor_user_id = row[0]
            parts = [p for p in (row[1], row[2]) if p and p.strip()]
            display_name = " ".join(parts) if parts else None
            return doctor_user_id, display_name
    except Exception as exc:  # noqa: BLE001 — non-fatal by contract
        logger.warning(
            "Failed to resolve doctor identity (consultation=%s): %s",
            redact_id(consultation_id),
            type(exc).__name__,
        )
        return None, None
