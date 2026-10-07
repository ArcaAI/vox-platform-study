"""TASK-1050 W2f — the text client reads the guardrail additions of ``/api/v1/generate`` (lane W2c).

* a 200 body carries ``guardrail_notices`` (warn / unverified) and ``guardrail_evaluation_ids``;
* a 422 ``urn:hope:problem:guardrail-blocked`` body is a :class:`TextGuardrailBlocked` (the notice
  and the evaluation ids on it), never re-POSTed;
* ``EGRESS_REDACTION_UNAVAILABLE`` is the same error, ``kind == "redaction_unavailable"``;
* the correlation headers (``X-Hope-Run-Id`` / ``-Run-Key`` / ``-Node-Id`` / ``-Consultation-Id``)
  and the hold override (``X-Hope-Guardrail-Override``) are forwarded;
* the SSE lane collects ``guardrail.notice`` frames and refuses a blocked ``error`` frame.

The W2c wire is not merged yet: these bodies are written from the frozen contract
(``@arcaai/types`` ``GuardrailResponseAdditions`` / ``GuardrailBlockedProblem``).
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from harness.services.text_client import (
    TextClient,
    TextGuardrailBlocked,
    TextServiceError,
)

_TENANT = "11111111-1111-1111-1111-111111111111"

_NOTICE: dict[str, Any] = {
    "schemaVersion": 1,
    "noticeId": "01927f6e-9999-7000-8000-0000000000aa",
    "type": "guardrail.warning",
    "direction": "inbound",
    "action": "warn",
    "checks": [{"checkId": "unsafe_content_judge", "category": "violence", "severity": "medium"}],
    "itemIds": [],
    "messageKey": "guardrail.warning.generic",
    "defaultMessage": "A safety check flagged this content. Review it before you rely on it.",
    "requiresAcknowledgement": True,
    "resumable": False,
    "policyVersion": "pv-1",
    "occurredAt": "2026-10-07T09:15:00.000Z",
}
_BLOCK_NOTICE: dict[str, Any] = {
    **_NOTICE,
    "noticeId": "01927f6e-9999-7000-8000-0000000000ab",
    "type": "guardrail.blocked",
    "action": "block",
    "messageKey": "guardrail.blocked.inbound",
    "defaultMessage": (
        "A safety check stopped this request. Review the flagged input to continue."
    ),
    "resumable": True,
}


def _ok(**extra: Any) -> dict[str, Any]:
    return {"content": "note", "provider": "lm-studio", "model": "m", "usage": {}, **extra}


def _transport(status: int, body: Any, seen: list[httpx.Request]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json=body)

    return httpx.MockTransport(handler)


@pytest.fixture(autouse=True)
def _one_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    # The governor's own bounded retry would sleep between attempts; a redaction outage is a
    # retryable 503, so pin one attempt to keep the suite fast.
    monkeypatch.setenv("HARNESS_LLM_MAX_ATTEMPTS", "1")


class TestSuccessBody:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("notices_key", "ids_key"),
        [
            ("guardrail_notices", "guardrail_evaluation_ids"),
            ("guardrailNotices", "guardrailEvaluationIds"),
        ],
    )
    async def test_notices_and_evaluation_ids_are_parsed(
        self, notices_key: str, ids_key: str
    ) -> None:
        seen: list[httpx.Request] = []
        client = TextClient(
            "http://text",
            transport=_transport(
                200, _ok(**{notices_key: [_NOTICE], ids_key: ["ev-1", "ev-2"]}), seen
            ),
        )
        result = await client.generate(tenant_id=_TENANT, prompt="p")
        assert result.guardrail_notices == [_NOTICE]
        assert result.guardrail_evaluation_ids == ["ev-1", "ev-2"]

    @pytest.mark.asyncio
    async def test_an_older_text_service_reports_none(self) -> None:
        seen: list[httpx.Request] = []
        client = TextClient("http://text", transport=_transport(200, _ok(), seen))
        result = await client.generate(tenant_id=_TENANT, prompt="p")
        assert result.guardrail_notices == []
        assert result.guardrail_evaluation_ids == []


class TestBlocked:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("wrapped", [False, True], ids=["problem", "fastapi-detail"])
    async def test_a_422_problem_is_a_typed_block_and_is_not_re_posted(self, wrapped: bool) -> None:
        problem = {
            "type": "urn:hope:problem:guardrail-blocked",
            "title": "Guardrail blocked",
            "status": 422,
            "error_code": "CONTENT_BLOCKED",
            "guardrailNotice": _BLOCK_NOTICE,
            "guardrailEvaluationIds": ["ev-9"],
        }
        seen: list[httpx.Request] = []
        client = TextClient(
            "http://text",
            transport=_transport(422, {"detail": problem} if wrapped else problem, seen),
        )
        with pytest.raises(TextGuardrailBlocked) as caught:
            await client.generate(tenant_id=_TENANT, prompt="p")
        blocked = caught.value
        assert isinstance(blocked, TextServiceError)
        assert blocked.kind == "blocked"
        assert blocked.notice == _BLOCK_NOTICE
        assert blocked.evaluation_ids == ["ev-9"]
        assert blocked.error_code == "CONTENT_BLOCKED"
        assert len(seen) == 1

    @pytest.mark.asyncio
    async def test_a_plain_422_is_still_an_ordinary_text_error(self) -> None:
        seen: list[httpx.Request] = []
        client = TextClient("http://text", transport=_transport(422, {"detail": "bad"}, seen))
        with pytest.raises(TextServiceError) as caught:
            await client.generate(tenant_id=_TENANT, prompt="p")
        assert not isinstance(caught.value, TextGuardrailBlocked)

    @pytest.mark.asyncio
    async def test_egress_redaction_unavailable_is_a_resumable_hold_kind(self) -> None:
        seen: list[httpx.Request] = []
        client = TextClient(
            "http://text",
            transport=_transport(
                503,
                {"detail": {"error_code": "EGRESS_REDACTION_UNAVAILABLE", "message": "down"}},
                seen,
            ),
        )
        with pytest.raises(TextGuardrailBlocked) as caught:
            await client.generate(tenant_id=_TENANT, prompt="p")
        assert caught.value.kind == "redaction_unavailable"
        assert caught.value.notice is None
        assert caught.value.error_code == "EGRESS_REDACTION_UNAVAILABLE"


class TestHeaders:
    @pytest.mark.asyncio
    async def test_correlation_and_override_headers_are_forwarded(self) -> None:
        seen: list[httpx.Request] = []
        client = TextClient("http://text", transport=_transport(200, _ok(), seen))
        await client.generate(
            tenant_id=_TENANT,
            prompt="p",
            correlation={
                "runId": "run-1",
                "runKey": "trajectory:wf:r:17",
                "nodeId": "n_note",
                "consultationId": "c-1",
                "bogus": "ignored",
            },
            guardrail_override="01927f6e-9999-7000-8000-0000000000ab",
        )
        headers = seen[0].headers
        assert headers["X-Hope-Run-Id"] == "run-1"
        assert headers["X-Hope-Run-Key"] == "trajectory:wf:r:17"
        assert headers["X-Hope-Node-Id"] == "n_note"
        assert headers["X-Hope-Consultation-Id"] == "c-1"
        assert headers["X-Hope-Guardrail-Override"] == "01927f6e-9999-7000-8000-0000000000ab"
        assert "bogus" not in {k.lower() for k in headers}

    @pytest.mark.asyncio
    async def test_nothing_is_sent_when_nothing_is_known(self) -> None:
        seen: list[httpx.Request] = []
        client = TextClient("http://text", transport=_transport(200, _ok(), seen))
        await client.generate(tenant_id=_TENANT, prompt="p", correlation={"runId": ""})
        assert not any(k.lower().startswith("x-hope-") for k in seen[0].headers)


def _sse(*frames: tuple[str, dict[str, Any]]) -> str:
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in frames)


class TestStream:
    @pytest.mark.asyncio
    async def test_notice_frames_and_done_ids_are_collected(self) -> None:
        body = _sse(
            ("chunk", {"type": "chunk", "content": "Hi"}),
            ("guardrail.notice", {"type": "guardrail.notice", "data": _NOTICE}),
            (
                "done",
                {
                    "type": "done",
                    "data": {"finish_reason": "stop", "guardrail_evaluation_ids": ["ev-1"]},
                },
            ),
        )

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

        client = TextClient("http://text", transport=httpx.MockTransport(handler))
        deltas: list[str] = []

        async def on_delta(text: str) -> None:
            deltas.append(text)

        result = await client.generate_stream(tenant_id=_TENANT, prompt="p", on_delta=on_delta)
        assert deltas == ["Hi"]
        assert result.guardrail_notices == [_NOTICE]
        assert result.guardrail_evaluation_ids == ["ev-1"]

    @pytest.mark.asyncio
    async def test_a_blocked_error_frame_is_a_typed_block(self) -> None:
        body = _sse(
            (
                "error",
                {
                    "type": "error",
                    "data": {
                        "error": "blocked",
                        "error_code": "CONTENT_BLOCKED",
                        "guardrailNotice": _BLOCK_NOTICE,
                        "guardrailEvaluationIds": ["ev-3"],
                    },
                },
            )
        )

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

        client = TextClient("http://text", transport=httpx.MockTransport(handler))

        async def on_delta(text: str) -> None:
            return None

        with pytest.raises(TextGuardrailBlocked) as caught:
            await client.generate_stream(tenant_id=_TENANT, prompt="p", on_delta=on_delta)
        assert caught.value.notice == _BLOCK_NOTICE
        assert caught.value.evaluation_ids == ["ev-3"]

    @pytest.mark.asyncio
    async def test_a_422_before_the_stream_is_a_typed_block(self) -> None:
        problem = {
            "type": "urn:hope:problem:guardrail-blocked",
            "status": 422,
            "error_code": "CONTENT_BLOCKED",
            "guardrailNotice": _BLOCK_NOTICE,
            "guardrailEvaluationIds": [],
        }

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(422, json=problem)

        client = TextClient("http://text", transport=httpx.MockTransport(handler))

        async def on_delta(text: str) -> None:
            return None

        with pytest.raises(TextGuardrailBlocked):
            await client.generate_stream(tenant_id=_TENANT, prompt="p", on_delta=on_delta)
