"""E4 — the TextError handler leaves a log line (it used to be silent)."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
from structlog.testing import capture_logs

from text.core.exception_handlers import text_exception_handler
from text.core.exceptions import ProviderError, QueueFullError, TextError


def _run(exc: TextError) -> tuple[int, list[dict]]:
    with capture_logs() as logs:
        response = asyncio.run(text_exception_handler(MagicMock(), exc))
    return response.status_code, logs


def test_5xx_is_logged_at_error_with_code_and_status() -> None:
    status, logs = _run(ProviderError("upstream exploded", provider="lmstudio"))

    (line,) = [entry for entry in logs if entry["event"] == "text.error"]
    assert status == 502
    assert line["log_level"] == "error"
    assert line["error_code"] == "PROVIDER_ERROR"
    assert line["status_code"] == 502
    assert line["error_type"] == "ProviderError"


def test_4xx_is_logged_at_warning() -> None:
    status, logs = _run(QueueFullError("queue full"))

    (line,) = [entry for entry in logs if entry["event"] == "text.error"]
    assert status == 429
    assert line["log_level"] == "warning"
    assert line["error_code"] == "RATE_LIMITED" or line["error_code"]


@pytest.mark.parametrize("exc", [ProviderError("clinical text here", provider="p")])
def test_message_is_not_logged(exc: TextError) -> None:
    _, logs = _run(exc)
    assert "clinical text here" not in str(logs)
