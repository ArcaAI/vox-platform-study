"""Resolve SYSTEM PromptTemplate content by UUID for Whisper initial_prompt."""

from __future__ import annotations

import structlog
from sqlalchemy import select

from stt.core.database.connection import get_db_session
from stt.core.database.models import PromptTemplateRead

logger = structlog.get_logger(__name__)


async def get_initial_prompt(template_id: str) -> str | None:
    """Fetch a SYSTEM PromptTemplate by UUID. Returns content or None."""
    try:
        async with get_db_session() as session:
            stmt = select(PromptTemplateRead).where(
                PromptTemplateRead.id == template_id,
                PromptTemplateRead.resource_status == "ENABLED",
                PromptTemplateRead.category == "SYSTEM",
            )
            result = await session.execute(stmt)
            template = result.scalar_one_or_none()
            if template is None:
                logger.warning(
                    "Prompt template not found or inactive",
                    template_id=template_id,
                )
                return None
            return template.content
    except Exception:
        logger.error(
            "Failed to fetch prompt template",
            template_id=template_id,
            exc_info=True,
        )
        return None


def compose_prompt(
    initial_prompt: str | None,
    previous_text: str | None,
) -> str | None:
    """Concatenate initial prompt text with previous transcription carry-forward."""
    parts: list[str] = []
    if initial_prompt and initial_prompt.strip():
        parts.append(initial_prompt.strip())
    if previous_text and previous_text.strip():
        parts.append(previous_text.strip())
    return " ".join(parts) if parts else None
