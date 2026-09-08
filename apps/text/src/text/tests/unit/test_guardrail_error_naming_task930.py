"""An exhausted guardrail call must SAY what failed (TASK-930 D-7).

Measured on the dev stack: `apps/text` generated fine (LM Studio, ~37 s), then
screened the output through guardrail, and all three attempts failed with an
EMPTY error — `external_guardrail.attempt_failed … error=` followed by
`exhausted_fail_closed … error=`, then `GUARDRAIL_UNAVAILABLE` and a 502 at the
gateway. Nothing in that chain named a cause.

The reason is that httpx's timeout exceptions carry no message: `str(exc)` is
`""` for a `ReadTimeout` raised by the transport, and the client logged `str(exc)`
verbatim. "The screen failed and we cannot say how" is the single most expensive
log line in an incident — connect-refused, read-timeout and a malformed payload
demand three different responses.

The verdict's `error` field and the two log lines share one string, so pinning
the field pins the log.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from text.core.guardrail_posture import GuardrailPosture
from text.services.external_guardrail import (
    GUARDRAIL_UNAVAILABLE_REASON,
    ExternalGuardrailClient,
)

_BASE_URL = "http://guardrail.test"


class _RaisingClient:
    def __init__(self, exc: BaseException) -> None:
        self._exc = exc
        self.calls = 0

    async def post(self, *args: Any, **kwargs: Any) -> Any:
        self.calls += 1
        raise self._exc


def _client(exc: BaseException) -> tuple[ExternalGuardrailClient, _RaisingClient]:
    http = _RaisingClient(exc)
    posture = GuardrailPosture(enabled=True, max_retries=0, retry_backoff_ms=0)
    client = ExternalGuardrailClient(
        base_url=_BASE_URL,
        http_client=http,  # type: ignore[arg-type]
        app_state=type("S", (), {"guardrail_posture": posture})(),
    )
    return client, http


@pytest.mark.asyncio
async def test_a_message_less_timeout_is_still_named() -> None:
    """`httpx.ReadTimeout("")` stringifies to nothing — the CLASS must carry it."""
    client, http = _client(httpx.ReadTimeout(""))

    verdict = await client.screen_output("some completion")

    assert verdict["allowed"] is False
    assert verdict["reason"] == GUARDRAIL_UNAVAILABLE_REASON
    assert verdict["error"], "an exhausted screen must never report an empty cause"
    assert "ReadTimeout" in verdict["error"]
    assert http.calls == 1


@pytest.mark.asyncio
async def test_an_exception_with_a_message_keeps_both_class_and_message() -> None:
    client, _ = _client(httpx.ConnectError("All connection attempts failed"))

    verdict = await client.validate("some prompt")

    assert verdict["allowed"] is False
    assert verdict["reason"] == GUARDRAIL_UNAVAILABLE_REASON
    assert "ConnectError" in verdict["error"]
    assert "All connection attempts failed" in verdict["error"]
