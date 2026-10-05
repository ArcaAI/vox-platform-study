"""OD-9 — the harness records every composed LLM request at the gateway, fire-and-forget.

Pinned here:

1. The wire: ``POST {api_base_url}/api/v1/internal/composed-prompts`` with ``X-Service-Token``
   and ``X-Tenant-Id``, body ``{consultationId?, agentSlug?, phase, provider, locality, system,
   user}``. Absent optionals are OMITTED, never sent as ``null``.
2. ``locality`` comes from the text response's ``egress.locality``; anything else is ``cloud``
   (the same fail-closed reading ``apps/text`` uses).
3. It never raises and never delays: scheduling returns at once, a failing gateway (5xx,
   connection refused, timeout) is swallowed, the per-call timeout is at most 2 s, there is ONE
   attempt, and a backlog beyond the cap is dropped rather than queued.
4. A failure is logged with counts only — never the system or user text.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from structlog.testing import capture_logs

from harness.services import composed_prompt_recorder as recorder
from harness.services.api_client import ApiClient, ApiServiceError

_TENANT = "10000000-0000-0000-0000-000000000001"
_SYSTEM_TEXT = "You are a clinical documentation assistant. SECRET-SYSTEM"
_USER_TEXT = (
    '<<<EXTERNAL_DATA section="input">>>\n--- Input ---\nAda Lovelace\n<<<END_EXTERNAL_DATA>>>'
)


def _client(handler: Any) -> ApiClient:
    return ApiClient(
        "http://api.test",
        service_token="svc-token",
        timeout=recorder.RECORD_TIMEOUT_S,
        transport=httpx.MockTransport(handler),
    )


class TestWire:
    @pytest.mark.asyncio
    async def test_posts_the_composed_messages_with_service_token_and_tenant(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(202, json={"accepted": True})

        await _client(handler).record_composed_prompt(
            recorder.composed_prompt_body(
                consultation_id="c-1",
                agent_slug="clinic-summarizer",
                phase="finalize",
                provider="azure",
                egress={"locality": "cloud", "redacted": 2},
                system=_SYSTEM_TEXT,
                user=_USER_TEXT,
            ),
            tenant_id=_TENANT,
        )

        request = seen[0]
        assert request.method == "POST"
        assert request.url.path == "/api/v1/internal/composed-prompts"
        assert request.headers["X-Service-Token"] == "svc-token"
        assert request.headers["X-Tenant-Id"] == _TENANT
        assert json.loads(request.content) == {
            "consultationId": "c-1",
            "agentSlug": "clinic-summarizer",
            "phase": "finalize",
            "provider": "azure",
            "locality": "cloud",
            "system": _SYSTEM_TEXT,
            "user": _USER_TEXT,
        }

    def test_absent_optionals_are_omitted(self) -> None:
        body = recorder.composed_prompt_body(
            consultation_id=None,
            agent_slug=None,
            phase="live",
            provider="lm-studio",
            egress={"locality": "local"},
            system="S",
            user="U",
        )
        assert "consultationId" not in body
        assert "agentSlug" not in body
        assert body["locality"] == "local"

    @pytest.mark.parametrize(
        "egress", [None, {}, {"locality": "on-prem"}, {"locality": None}, "local"]
    )
    def test_an_unknown_locality_is_recorded_as_cloud(self, egress: Any) -> None:
        assert recorder.locality_of(egress) == "cloud"

    @pytest.mark.asyncio
    async def test_a_non_2xx_raises_inside_the_client(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

        with pytest.raises(ApiServiceError):
            await _client(handler).record_composed_prompt({"phase": "live"}, tenant_id=_TENANT)

    def test_the_timeout_is_bounded(self) -> None:
        assert 0 < recorder.RECORD_TIMEOUT_S <= 2.0


class TestFireAndForget:
    @pytest.mark.asyncio
    async def test_scheduling_returns_before_the_post_completes(self, monkeypatch) -> None:
        release = asyncio.Event()
        sent: list[tuple[dict[str, Any], str]] = []

        async def _slow_send(body: dict[str, Any], tenant_id: str) -> None:
            await release.wait()
            sent.append((body, tenant_id))

        monkeypatch.setattr(recorder, "_send", _slow_send)
        recorder.record_composed_prompt(
            tenant_id=_TENANT,
            phase="live",
            provider="lm-studio",
            egress={"locality": "local"},
            system="S",
            user="U",
        )
        assert sent == []  # returned without waiting for the gateway
        release.set()
        await recorder.drain_pending()
        assert sent and sent[0][1] == _TENANT

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "failure",
        [
            ApiServiceError("apps/api /composed-prompts failed: 500"),
            httpx.ConnectError("refused"),
            TimeoutError(),
            RuntimeError("anything"),
        ],
    )
    async def test_a_failing_gateway_is_swallowed_and_logged_without_content(
        self, monkeypatch, failure: BaseException
    ) -> None:
        async def _failing_send(_body: dict[str, Any], _tenant_id: str) -> None:
            raise failure

        monkeypatch.setattr(recorder, "_send", _failing_send)
        with capture_logs() as logs:
            recorder.record_composed_prompt(
                tenant_id=_TENANT,
                phase="finalize",
                provider="azure",
                egress=None,
                system=_SYSTEM_TEXT,
                user=_USER_TEXT,
            )
            await recorder.drain_pending()

        failed = [
            entry for entry in logs if entry["event"] == "harness.composed_prompt.record_failed"
        ]
        assert len(failed) == 1
        assert failed[0]["system_chars"] == len(_SYSTEM_TEXT)
        assert failed[0]["user_chars"] == len(_USER_TEXT)
        rendered = json.dumps(logs, default=str)
        assert "SECRET-SYSTEM" not in rendered
        assert "Ada Lovelace" not in rendered

    @pytest.mark.asyncio
    async def test_one_attempt_only(self, monkeypatch) -> None:
        calls = 0

        async def _failing_send(_body: dict[str, Any], _tenant_id: str) -> None:
            nonlocal calls
            calls += 1
            raise ApiServiceError("down")

        monkeypatch.setattr(recorder, "_send", _failing_send)
        recorder.record_composed_prompt(
            tenant_id=_TENANT, phase="live", provider="p", egress=None, system="S", user="U"
        )
        await recorder.drain_pending()
        assert calls == 1

    @pytest.mark.asyncio
    async def test_a_backlog_beyond_the_cap_is_dropped_not_queued(self, monkeypatch) -> None:
        release = asyncio.Event()
        started = 0

        async def _stuck_send(_body: dict[str, Any], _tenant_id: str) -> None:
            nonlocal started
            started += 1
            await release.wait()

        monkeypatch.setattr(recorder, "_send", _stuck_send)
        with capture_logs() as logs:
            for _ in range(recorder.MAX_PENDING + 5):
                recorder.record_composed_prompt(
                    tenant_id=_TENANT, phase="live", provider="p", egress=None, system="S", user="U"
                )
        for _ in range(5):  # let every scheduled post reach the sender
            await asyncio.sleep(0)
        assert started == recorder.MAX_PENDING
        dropped = [entry for entry in logs if entry["event"] == "harness.composed_prompt.dropped"]
        assert len(dropped) == 5
        release.set()
        await recorder.drain_pending()

    def test_outside_an_event_loop_it_is_a_no_op(self) -> None:
        recorder.record_composed_prompt(
            tenant_id=_TENANT, phase="live", provider="p", egress=None, system="S", user="U"
        )
