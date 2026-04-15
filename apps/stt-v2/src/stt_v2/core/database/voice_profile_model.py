"""Read-only model for UserVoiceProfile table.

Used by STT-v2 to read the active voice profile at session start
for pre-seeding the SpeakerTracker.
"""

from __future__ import annotations

import logging

from sqlalchemy import Boolean, DateTime, String, text
from sqlalchemy.orm import Mapped, mapped_column

from stt_v2.core.database.connection import get_session
from stt_v2.core.database.models import Base, ResourceStatusType

logger = logging.getLogger(__name__)


class UserVoiceProfileRead(Base):
    """Read-only model for UserVoiceProfile table."""

    __tablename__ = "UserVoiceProfile"
    __table_args__ = {"schema": "core"}

    id: Mapped[str] = mapped_column(String, primary_key=True)
    userId: Mapped[str] = mapped_column("userId", String)
    isActive: Mapped[bool] = mapped_column("isActive", Boolean)
    label: Mapped[str | None] = mapped_column(String)
    modelId: Mapped[str | None] = mapped_column("modelId", String)
    resource_status: Mapped[str] = mapped_column("resourceStatus", ResourceStatusType)
    created_at: Mapped[str] = mapped_column("createdAt", DateTime)
    updated_at: Mapped[str] = mapped_column("updatedAt", DateTime)


async def get_voice_embedding(user_id: str) -> list[float] | None:
    """Fetch the active voice profile embedding for a user.

    Returns the 256d embedding as a list of floats, or None if no active profile.
    Uses raw SQL because the embedding column is a pgvector type
    not mapped in SQLAlchemy.
    """
    try:
        async with get_session() as session:
            result = await session.execute(
                text(
                    'SELECT embedding::text FROM core."UserVoiceProfile" '
                    'WHERE "userId" = :user_id '
                    'AND "isActive" = true '
                    "AND \"resourceStatus\" = 'ENABLED' "
                    "LIMIT 1"
                ),
                {"user_id": user_id},
            )
            row = result.fetchone()
            if row is None:
                return None

            raw = row[0]
            if raw.startswith("[") and raw.endswith("]"):
                return [float(x) for x in raw[1:-1].split(",")]
            return None
    except Exception:
        logger.warning(
            "Failed to fetch voice profile for user %s", user_id, exc_info=True
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
    except Exception:
        logger.warning(
            "Failed to fetch display name for user %s", user_id, exc_info=True
        )
        return None


async def get_user_identity(
    consultation_id: str,
    tenant_id: str | None = None,
) -> tuple[str | None, str | None]:
    """Resolve (doctor_user_id, display_name) from a consultation.

    Returns (None, None) when no consultation or doctor is found.
    """
    try:
        async with get_session() as session:
            sql = (
                'SELECT c."doctorId", up."firstName", up."lastName" '
                'FROM core."Consultation" c '
                'LEFT JOIN core."UserProfile" up ON up."userId" = c."doctorId" '
                'WHERE c.id = :consultation_id '
                "AND c.\"resourceStatus\" = 'ENABLED' "
            )
            params: dict[str, str] = {"consultation_id": consultation_id}
            if tenant_id:
                sql += 'AND c."tenantId" = :tenant_id '
                params["tenant_id"] = tenant_id
            sql += "LIMIT 1"

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
    except Exception:
        logger.warning(
            "Failed to resolve doctor identity for consultation %s",
            consultation_id,
            exc_info=True,
        )
        return None, None
