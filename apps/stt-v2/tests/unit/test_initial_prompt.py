"""Unit tests for initial_prompt module."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from stt_v2.core.initial_prompt import (
    compose_prompt,
    get_initial_prompt,
)


class TestComposePrompt:

    def test_both_none(self):
        assert compose_prompt(None, None) is None

    def test_both_empty(self):
        assert compose_prompt("", "") is None

    def test_both_whitespace(self):
        assert compose_prompt("   ", "  ") is None

    def test_initial_prompt_only(self):
        assert compose_prompt("medical terms", None) == "medical terms"

    def test_previous_text_only(self):
        assert compose_prompt(None, "prior context") == "prior context"

    def test_both_present(self):
        result = compose_prompt("medical terms", "prior context")
        assert result == "medical terms prior context"

    def test_strips_whitespace(self):
        result = compose_prompt("  medical terms  ", "  prior context  ")
        assert result == "medical terms prior context"

    def test_initial_prompt_empty_previous_present(self):
        assert compose_prompt("", "prior context") == "prior context"

    def test_initial_prompt_present_previous_empty(self):
        assert compose_prompt("medical terms", "") == "medical terms"


class TestResolveInitialPrompt:

    @pytest.mark.asyncio
    async def test_returns_content(self):
        mock_template = MagicMock()
        mock_template.content = "Hypertension, diabetes"

        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_template

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch("stt_v2.core.initial_prompt.get_db_session", return_value=mock_session):
            result = await get_initial_prompt("test-uuid")

        assert result == "Hypertension, diabetes"

    @pytest.mark.asyncio
    async def test_returns_none_for_missing(self):
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None

        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=mock_result)
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch("stt_v2.core.initial_prompt.get_db_session", return_value=mock_session):
            result = await get_initial_prompt("missing-uuid")

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_on_db_error(self):
        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(side_effect=Exception("DB connection failed"))
        mock_session.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session.__aexit__ = AsyncMock(return_value=False)

        with patch("stt_v2.core.initial_prompt.get_db_session", return_value=mock_session):
            result = await get_initial_prompt("error-uuid")

        assert result is None
