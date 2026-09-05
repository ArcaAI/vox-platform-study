"""TASK-871 — the post-receive guardrail gate.

Owner decision (TASK-870 items 5 and 7): guardrail checks every text-generation
request BEFORE it is sent to the provider AND every response AFTER it is received,
for built-in and BYO providers alike. The input half already existed
(`_apply_guardrail_gate`); these tests pin the output half.

Everything here is hermetic: the guardrail client is a stub, exactly as
`test_generate_guardrail_wiring.py` stubs the input gate. Written RED first.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.guardrail_posture import GuardrailPosture
from text.models.requests import GenerateRequest
from text.models.stream import StreamChunk
from text.models.task import TaskStatus
from text.services.circuit_breaker import CircuitState
from text.services.external_guardrail import (
    GUARDRAIL_UNAVAILABLE_REASON,
    ExternalGuardrailClient,
)

_BASE_URL = "http://guardrail.test"
_PROVIDER = "lm-studio"


# ── helpers ──────────────────────────────────────────────────────────────────


def _allow() -> dict[str, Any]:
    return {"allowed": True, "reason": "screened", "raw": {"decision": "allow", "reasons": []}}


def _block(reason: str = "response_safety") -> dict[str, Any]:
    return {
        "allowed": False,
        "reason": reason,
        "raw": {"decision": "block", "reasons": [reason], "checks": []},
    }


def _unavailable() -> dict[str, Any]:
    return {"allowed": False, "reason": GUARDRAIL_UNAVAILABLE_REASON, "error": "boom"}


def _guardrail(*, validate: dict[str, Any] | None = None, screen: dict[str, Any] | None = None):
    """A stub guardrail client: input verdict + output verdict."""
    client = AsyncMock()
    client.validate = AsyncMock(
        return_value=validate if validate is not None else {"allowed": True}
    )
    client.screen_output = AsyncMock(return_value=screen if screen is not None else _allow())
    return client


class _AuditSpy:
    def __init__(self) -> None:
        self.events: list[Any] = []

    def log_generation(self, event: Any) -> None:
        self.events.append(event)


def _appended_chunks(task_manager: Any) -> list[StreamChunk]:
    return [call.args[1] for call in task_manager.append_chunk.await_args_list]


def _breaker() -> MagicMock:
    cb = MagicMock()
    cb.allow_request.return_value = True
    cb.state = CircuitState.CLOSED
    return cb


@pytest.fixture
def mock_provider():
    provider = AsyncMock()
    provider.generate = AsyncMock(
        return_value=("ok", "", {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})
    )

    async def _stream(_request):
        yield StreamChunk(type="chunk", content="hello ")
        yield StreamChunk(type="chunk", content="world")
        yield StreamChunk(
            type="usage", data={"prompt_tokens": 3, "predicted_tokens": 2, "total_tokens": 5}
        )
        yield StreamChunk(type="done", data={"finish_reason": "stop"})

    provider.generate_stream = _stream
    return provider


@pytest.fixture
def mock_registry(mock_provider):
    registry = MagicMock()
    registry.get.return_value = mock_provider
    registry.list_providers.return_value = [_PROVIDER, "azure"]
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "task-1"
    tm.create_task = AsyncMock(return_value=task_state)
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    return tm


def _make_app(registry, task_manager, guardrail_client, *, breaker=None, redis=None):
    from text.main import create_app

    app = create_app()
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    app.state.guardrail_client = guardrail_client
    if breaker is not None:
        app.state.circuit_breakers = {_PROVIDER: breaker}
    if redis is not None:
        app.state.redis = redis
    return app


@pytest_asyncio.fixture
async def client_factory(mock_registry, mock_task_manager):
    clients = []

    async def _build(guardrail_client, **kwargs):
        app = _make_app(mock_registry, mock_task_manager, guardrail_client, **kwargs)
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        clients.append(c)
        return c

    yield _build
    for c in clients:
        await c.aclose()


# ── 1. the client: `screen_output` against guardrail's outbound screen ────────


class _FakeResponse:
    def __init__(self, payload: dict[str, Any], *, status_error: Exception | None = None) -> None:
        self._payload = payload
        self._status_error = status_error

    def raise_for_status(self) -> None:
        if self._status_error is not None:
            raise self._status_error

    def json(self) -> dict[str, Any]:
        return self._payload


class _RecordingHttp:
    def __init__(self, payload: dict[str, Any], *, status_error: Exception | None = None) -> None:
        self.payload = payload
        self.status_error = status_error
        self.calls: list[dict[str, Any]] = []

    async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
        self.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        return _FakeResponse(self.payload, status_error=self.status_error)


class _RaisingHttp:
    def __init__(self) -> None:
        self.calls = 0

    async def post(self, *args: Any, **kwargs: Any):
        self.calls += 1
        raise RuntimeError("guardrail unreachable")


def _client(http: Any, **posture: Any) -> ExternalGuardrailClient:
    posture.setdefault("enabled", True)
    posture.setdefault("retry_backoff_ms", 0)
    state = SimpleNamespace(guardrail_posture=GuardrailPosture(**posture))
    return ExternalGuardrailClient(
        base_url=_BASE_URL, http_client=http, service_token="svc-token", app_state=state
    )


class TestScreenOutputClient:
    @pytest.mark.asyncio
    async def test_posts_response_and_source_to_the_outbound_screen(self) -> None:
        http = _RecordingHttp({"decision": "allow", "direction": "outbound", "reasons": []})
        client = _client(http)

        verdict = await client.screen_output(
            "the model said this", source_context="the prompt", tenant_id="tenant-7"
        )

        assert verdict["allowed"] is True
        assert len(http.calls) == 1
        call = http.calls[0]
        assert call["url"] == f"{_BASE_URL}/api/v1/guardrail/screen/outbound"
        assert call["json"]["response"] == "the model said this"
        assert call["json"]["source_context"] == "the prompt"
        assert call["headers"]["X-Tenant-Id"] == "tenant-7"
        assert call["headers"]["X-Service-Token"] == "svc-token"

    @pytest.mark.asyncio
    async def test_block_is_not_allowed_and_carries_the_first_reason(self) -> None:
        http = _RecordingHttp(
            {"decision": "block", "direction": "outbound", "reasons": ["response_safety", "x"]}
        )
        client = _client(http)

        verdict = await client.screen_output("bad", tenant_id="t")

        assert verdict["allowed"] is False
        assert verdict["reason"] == "response_safety"
        assert verdict["raw"]["decision"] == "block"

    @pytest.mark.asyncio
    async def test_disabled_posture_short_circuits_without_http(self) -> None:
        http = _RecordingHttp({"decision": "block"})
        client = _client(http, enabled=False)

        verdict = await client.screen_output("anything", tenant_id="t")

        assert verdict["allowed"] is True
        assert verdict["reason"] == "external_guardrail_disabled"
        assert http.calls == []

    @pytest.mark.asyncio
    async def test_payload_without_a_decision_fails_closed(self) -> None:
        http = _RecordingHttp({"direction": "outbound"})
        client = _client(http)

        verdict = await client.screen_output("x", tenant_id="t")

        assert verdict["allowed"] is False
        assert verdict["reason"] == "malformed_verdict"

    @pytest.mark.asyncio
    async def test_transport_failure_is_retried_then_fails_closed_as_unavailable(self) -> None:
        http = _RaisingHttp()
        client = _client(http, max_retries=2)

        verdict = await client.screen_output("x", tenant_id="t")

        assert http.calls == 3
        assert verdict["allowed"] is False
        assert verdict["reason"] == GUARDRAIL_UNAVAILABLE_REASON

    @pytest.mark.asyncio
    async def test_http_error_status_is_an_outage_not_a_content_verdict(self) -> None:
        """A guardrail 503 (admission gate, undetermined verdict) must surface as
        retryable, never as `allowed` and never as a content rejection."""
        http = _RecordingHttp({"decision": "allow"}, status_error=RuntimeError("503"))
        client = _client(http, max_retries=1)

        verdict = await client.screen_output("x", tenant_id="t")

        assert len(http.calls) == 2
        assert verdict["allowed"] is False
        assert verdict["reason"] == GUARDRAIL_UNAVAILABLE_REASON


# ── 2. the gate helper: fail posture and the cycle tripwire ──────────────────


class TestGateHelper:
    @pytest.mark.asyncio
    async def test_rejection_is_422_equivalent_and_outage_is_retryable(self) -> None:
        from text.services.output_gate import OutputRejectedError, gate_completion

        with pytest.raises(OutputRejectedError) as rejected:
            await gate_completion(
                _guardrail(screen=_block()),
                completion="x",
                source_context="p",
                tenant_id="t",
                tenant_policy=None,
                app_state=None,
                where="test",
            )
        assert rejected.value.status_code == 422
        assert rejected.value.retryable is False
        assert rejected.value.code == "GUARDRAIL_REJECTED"
        assert rejected.value.reason == "response_safety"

        with pytest.raises(OutputRejectedError) as outage:
            await gate_completion(
                _guardrail(screen=_unavailable()),
                completion="x",
                source_context="p",
                tenant_id="t",
                tenant_policy=None,
                app_state=None,
                where="test",
            )
        assert outage.value.status_code == 503
        assert outage.value.retryable is True
        assert outage.value.code == "GUARDRAIL_UNAVAILABLE"

    @pytest.mark.asyncio
    async def test_missing_allowed_key_fails_closed(self) -> None:
        from text.services.output_gate import OutputRejectedError, gate_completion

        with pytest.raises(OutputRejectedError) as rejected:
            await gate_completion(
                _guardrail(screen={"reason": "malformed"}),
                completion="x",
                source_context=None,
                tenant_id="t",
                tenant_policy=None,
                app_state=None,
                where="test",
            )
        assert rejected.value.status_code == 422

    @pytest.mark.asyncio
    async def test_bypass_when_unwired_and_posture_off_but_closed_when_posture_on(self) -> None:
        from text.services.output_gate import OutputRejectedError, gate_completion

        assert (
            await gate_completion(
                None,
                completion="x",
                source_context=None,
                tenant_id="t",
                tenant_policy=None,
                app_state=SimpleNamespace(guardrail_posture=None),
                where="test",
            )
            is None
        )

        with pytest.raises(OutputRejectedError) as closed:
            await gate_completion(
                None,
                completion="x",
                source_context=None,
                tenant_id="t",
                tenant_policy=None,
                app_state=SimpleNamespace(guardrail_posture=GuardrailPosture(enabled=True)),
                where="test",
            )
        assert closed.value.status_code == 503
        assert closed.value.retryable is True

    @pytest.mark.asyncio
    async def test_empty_completion_is_not_sent_to_guardrail(self) -> None:
        from text.services.output_gate import gate_completion

        guardrail = _guardrail()
        await gate_completion(
            guardrail,
            completion="   ",
            source_context="p",
            tenant_id="t",
            tenant_policy=None,
            app_state=None,
            where="test",
        )
        guardrail.screen_output.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_judge_scope_tripwire_holds_for_the_output_gate(self) -> None:
        from text.services.judge_guard import GuardrailRecursionError, judge_scope
        from text.services.output_gate import gate_completion

        guardrail = _guardrail()
        with judge_scope(), pytest.raises(GuardrailRecursionError):
            await gate_completion(
                guardrail,
                completion="x",
                source_context="p",
                tenant_id="t",
                tenant_policy=None,
                app_state=None,
                where="test",
            )
        guardrail.screen_output.assert_not_awaited()


# ── 3. non-streaming `/generate`: gate AFTER the provider, BEFORE anything persists ──


class TestNonStreamingPath:
    @pytest.mark.asyncio
    async def test_rejected_completion_is_422_and_never_persists_as_success(
        self, client_factory, mock_provider, mock_task_manager
    ) -> None:
        redis = AsyncMock()
        redis.get = AsyncMock(return_value=None)
        breaker = _breaker()
        client = await client_factory(_guardrail(screen=_block()), breaker=breaker, redis=redis)

        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "patient note", "model": "m", "provider": _PROVIDER},
            headers={"Idempotency-Key": "idem-871"},
        )

        assert resp.status_code == 422, resp.text
        assert "guardrail" in resp.json()["detail"].lower()
        assert "response_safety" in resp.json()["detail"]
        # Post-receive: the provider WAS called — this is the output gate, not the input one.
        mock_provider.generate.assert_awaited_once()
        # Nothing persisted as a success, nothing cached, breaker untouched.
        statuses = [c.kwargs.get("status") for c in mock_task_manager.update_task.await_args_list]
        assert TaskStatus.COMPLETED not in statuses
        failed = [
            c.kwargs
            for c in mock_task_manager.update_task.await_args_list
            if c.kwargs.get("status") == TaskStatus.FAILED
        ]
        assert failed and failed[-1]["error"].startswith("guardrail_rejected:")
        redis.set.assert_not_awaited()
        breaker.record_failure.assert_not_called()

    @pytest.mark.asyncio
    async def test_outage_after_receive_is_a_retryable_503(
        self, client_factory, mock_provider
    ) -> None:
        client = await client_factory(_guardrail(screen=_unavailable()))

        resp = await client.post("/api/v1/generate", json={"prompt": "note", "model": "m"})

        assert resp.status_code == 503
        mock_provider.generate.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_malformed_output_verdict_fails_closed(self, client_factory) -> None:
        client = await client_factory(_guardrail(screen={"reason": "malformed"}))

        resp = await client.post("/api/v1/generate", json={"prompt": "note", "model": "m"})

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_allowed_completion_is_returned_and_the_gate_saw_the_content(
        self, client_factory
    ) -> None:
        guardrail = _guardrail()
        client = await client_factory(guardrail)

        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "patient note", "system_prompt": "be brief", "model": "m"},
            headers={"X-Tenant-Id": "tenant-42"},
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["content"] == "ok"
        guardrail.validate.assert_awaited_once()
        guardrail.screen_output.assert_awaited_once()
        kwargs = guardrail.screen_output.await_args.kwargs
        assert kwargs["response"] == "ok"
        assert "patient note" in kwargs["source_context"]
        assert "be brief" in kwargs["source_context"]
        assert kwargs["tenant_id"] == "tenant-42"

    @pytest.mark.asyncio
    async def test_provider_permit_is_released_before_the_output_gate(
        self, mock_registry, mock_task_manager
    ) -> None:
        """The gate is a network call with guardrail's retry ceiling; holding the
        provider's concurrency slot across it would let a guardrail outage starve
        every other request for that provider."""
        from text.services.resizable_semaphore import ResizableSemaphore

        semaphore = ResizableSemaphore(1)
        seen_in_flight: list[int] = []

        async def _screen(**_kwargs: Any) -> dict[str, Any]:
            seen_in_flight.append(semaphore.in_flight)
            return _allow()

        guardrail = _guardrail()
        guardrail.screen_output = AsyncMock(side_effect=_screen)
        app = _make_app(mock_registry, mock_task_manager, guardrail)
        app.state.provider_semaphores = {_PROVIDER: semaphore}

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/api/v1/generate", json={"prompt": "note", "model": "m", "provider": _PROVIDER}
            )

        assert resp.status_code == 200, resp.text
        assert seen_in_flight == [0]
        assert semaphore.in_flight == 0

    @pytest.mark.asyncio
    async def test_unwired_client_with_posture_off_is_the_dev_bypass(
        self, client_factory, mock_provider
    ) -> None:
        client = await client_factory(None)

        resp = await client.post("/api/v1/generate", json={"prompt": "note", "model": "m"})

        assert resp.status_code == 200
        mock_provider.generate.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_byo_provider_overrides_are_gated_identically(self, client_factory) -> None:
        """A BYO request (provider_overrides present) reaches the same gate with the
        same arguments as a built-in one — nothing branches on provider or funding."""
        guardrail_builtin = _guardrail()
        client = await client_factory(guardrail_builtin)
        await client.post("/api/v1/generate", json={"prompt": "note", "model": "m"})

        guardrail_byo = _guardrail()
        client = await client_factory(guardrail_byo)
        resp = await client.post(
            "/api/v1/generate",
            json={
                "prompt": "note",
                "model": "m",
                "provider": "azure",
                "provider_overrides": {
                    "azure": {"api_key": "k", "base_url": "https://x.openai.azure.com"}
                },
            },
        )

        assert resp.status_code == 200, resp.text
        guardrail_byo.validate.assert_awaited_once()
        guardrail_byo.screen_output.assert_awaited_once()
        assert (
            guardrail_byo.screen_output.await_args.kwargs
            == guardrail_builtin.screen_output.await_args.kwargs
        )

        # And a BYO rejection is a rejection.
        client = await client_factory(_guardrail(screen=_block()))
        resp = await client.post(
            "/api/v1/generate",
            json={
                "prompt": "note",
                "model": "m",
                "provider": "azure",
                "provider_overrides": {"azure": {"api_key": "k"}},
            },
        )
        assert resp.status_code == 422


# ── 4. the streaming producer: gate the ASSEMBLED completion before the terminal frame ──


class TestStreamingProducer:
    @pytest.mark.asyncio
    async def test_rejected_stream_ends_with_a_rejection_frame_not_done(
        self, mock_task_manager
    ) -> None:
        from text.api.endpoints.generate import _run_streaming_generation

        async def stream(_request):
            yield StreamChunk(type="reasoning", content="think")
            yield StreamChunk(type="chunk", content="hello ")
            yield StreamChunk(type="chunk", content="world")
            yield StreamChunk(
                type="usage", data={"prompt_tokens": 3, "predicted_tokens": 2, "total_tokens": 5}
            )
            yield StreamChunk(type="done", data={"finish_reason": "stop"})

        provider = AsyncMock()
        provider.generate_stream = stream
        audit = _AuditSpy()
        guardrail = _guardrail(screen=_block())
        breaker = _breaker()

        await _run_streaming_generation(
            mock_task_manager,
            provider,
            "task-rej",
            GenerateRequest(
                prompt="p", system_prompt="s", provider=_PROVIDER, model="m", stream=True
            ),
            provider_name=_PROVIDER,
            model="m",
            generation_audit=audit,
            tenant_id="tenant-rej",
            request_id="req-rej",
            circuit_breakers={_PROVIDER: breaker},
            guardrail_client=guardrail,
        )

        # The gate saw everything the consumer saw: reasoning AND content, assembled.
        kwargs = guardrail.screen_output.await_args.kwargs
        assert kwargs["response"] == "think\n\nhello world"
        assert "p" in kwargs["source_context"] and "s" in kwargs["source_context"]
        assert kwargs["tenant_id"] == "tenant-rej"

        chunks = _appended_chunks(mock_task_manager)
        assert [c.type for c in chunks] == ["error"], chunks
        data = chunks[0].data or {}
        assert data["code"] == "GUARDRAIL_REJECTED"
        assert data["retryable"] is False
        assert "response_safety" in data["error"]
        assert data["guardrail"]["decision"] == "block"
        # The usage the gateway meters from still rides on the terminal frame.
        assert data["usage"]["prompt_tokens"] == 3
        assert data["usage"]["completion_tokens"] == 2

        statuses = {c.kwargs.get("status") for c in mock_task_manager.update_task.await_args_list}
        assert TaskStatus.COMPLETED not in statuses
        assert TaskStatus.FAILED in statuses
        last = mock_task_manager.update_task.await_args_list[-1].kwargs
        assert last["status"] == TaskStatus.FAILED
        assert last["error"].startswith("guardrail_rejected:")

        assert len(audit.events) == 1
        assert audit.events[0].status == "rejected"
        assert audit.events[0].completion_tokens == 2
        breaker.record_failure.assert_not_called()

    @pytest.mark.asyncio
    async def test_outage_after_receive_is_a_retryable_rejection_frame(
        self, mock_task_manager, mock_provider
    ) -> None:
        from text.api.endpoints.generate import _run_streaming_generation

        await _run_streaming_generation(
            mock_task_manager,
            mock_provider,
            "task-out",
            GenerateRequest(prompt="p", provider=_PROVIDER, model="m", stream=True),
            provider_name=_PROVIDER,
            model="m",
            tenant_id="t",
            guardrail_client=_guardrail(screen=_unavailable()),
        )

        chunks = _appended_chunks(mock_task_manager)
        assert [c.type for c in chunks] == ["error"]
        data = chunks[0].data or {}
        assert data["code"] == "GUARDRAIL_UNAVAILABLE"
        assert data["retryable"] is True

    @pytest.mark.asyncio
    async def test_allowed_stream_ends_with_done_exactly_as_before(
        self, mock_task_manager, mock_provider
    ) -> None:
        from text.api.endpoints.generate import _run_streaming_generation

        audit = _AuditSpy()
        await _run_streaming_generation(
            mock_task_manager,
            mock_provider,
            "task-ok",
            GenerateRequest(prompt="p", provider=_PROVIDER, model="m", stream=True),
            provider_name=_PROVIDER,
            model="m",
            generation_audit=audit,
            tenant_id="t",
            guardrail_client=_guardrail(),
        )

        chunks = _appended_chunks(mock_task_manager)
        assert [c.type for c in chunks] == ["done"]
        assert (chunks[0].data or {})["finish_reason"] == "stop"
        assert mock_task_manager.update_task.await_args_list[-1].kwargs["status"] == (
            TaskStatus.COMPLETED
        )
        assert audit.events[0].status == "completed"

    @pytest.mark.asyncio
    async def test_unwired_client_with_posture_on_fails_closed_on_the_stream(
        self, mock_task_manager, mock_provider
    ) -> None:
        from text.api.endpoints.generate import _run_streaming_generation

        await _run_streaming_generation(
            mock_task_manager,
            mock_provider,
            "task-enforce",
            GenerateRequest(prompt="p", provider=_PROVIDER, model="m", stream=True),
            provider_name=_PROVIDER,
            model="m",
            tenant_id="t",
            guardrail_client=None,
            app_state=SimpleNamespace(guardrail_posture=GuardrailPosture(enabled=True)),
        )

        chunks = _appended_chunks(mock_task_manager)
        assert [c.type for c in chunks] == ["error"]
        assert (chunks[0].data or {})["code"] == "GUARDRAIL_UNAVAILABLE"

    @pytest.mark.asyncio
    async def test_unwired_client_with_posture_off_is_the_dev_bypass(
        self, mock_task_manager, mock_provider
    ) -> None:
        from text.api.endpoints.generate import _run_streaming_generation

        await _run_streaming_generation(
            mock_task_manager,
            mock_provider,
            "task-bypass",
            GenerateRequest(prompt="p", provider=_PROVIDER, model="m", stream=True),
            provider_name=_PROVIDER,
            model="m",
            tenant_id="t",
        )

        assert [c.type for c in _appended_chunks(mock_task_manager)] == ["done"]

    @pytest.mark.asyncio
    async def test_an_early_stopped_partial_is_gated_too(
        self, mock_task_manager, monkeypatch
    ) -> None:
        """A cancelled generation delivered its partial; the partial is what gets screened."""
        import text.routing.streaming as streaming
        from text.api.endpoints.generate import _run_streaming_generation

        monkeypatch.setattr(streaming, "_CONTROL_POLL_INTERVAL_S", 0.0)
        mock_task_manager.is_cancel_requested = AsyncMock(return_value=True)

        async def stream(_request):
            yield StreamChunk(type="chunk", content="partial ")
            yield StreamChunk(type="chunk", content="never delivered")

        provider = AsyncMock()
        provider.generate_stream = stream
        guardrail = _guardrail()

        await _run_streaming_generation(
            mock_task_manager,
            provider,
            "task-cancel",
            GenerateRequest(prompt="p", provider=_PROVIDER, model="m", stream=True),
            provider_name=_PROVIDER,
            model="m",
            tenant_id="t",
            guardrail_client=guardrail,
        )

        assert guardrail.screen_output.await_args.kwargs["response"] == "partial "
        chunks = _appended_chunks(mock_task_manager)
        assert [c.type for c in chunks] == ["done"]
        assert (chunks[0].data or {})["stopped_reason"] == "cancelled"


# ── 5. streaming through HTTP: the rejection reaches the subscriber ──────────


class TestStreamingOverHttp:
    @pytest.mark.asyncio
    async def test_rejected_stream_carries_an_error_event_and_no_done(self, client_factory) -> None:
        client = await client_factory(_guardrail(screen=_block()))

        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "note", "model": "m", "provider": _PROVIDER, "stream": True},
        )

        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = resp.text
        assert "event: error" in body
        assert "GUARDRAIL_REJECTED" in body
        assert "event: done" not in body

    @pytest.mark.asyncio
    async def test_allowed_stream_still_ends_with_done(self, client_factory) -> None:
        client = await client_factory(_guardrail())

        resp = await client.post(
            "/api/v1/generate",
            json={"prompt": "note", "model": "m", "provider": _PROVIDER, "stream": True},
        )

        assert resp.status_code == 200
        assert "event: done" in resp.text
        assert "event: error" not in resp.text


# ── 6. the judge lane never reaches the output gate ──────────────────────────


class TestJudgeLaneIsNotGated:
    @pytest.mark.asyncio
    async def test_judge_route_never_screens_its_output(
        self, mock_registry, mock_task_manager
    ) -> None:
        from text.models.stats import build_generation_stats

        provider = AsyncMock()
        provider.generate = AsyncMock(
            return_value=(
                '{"allowed": false}',
                "",
                build_generation_stats(
                    provider=_PROVIDER,
                    model="judge-model",
                    raw_stop_reason="stop",
                    prompt_tokens=1,
                    predicted_tokens=1,
                    total_ms=1,
                ),
            )
        )
        mock_registry.get.return_value = provider
        guardrail = _guardrail(screen=_block())
        app = _make_app(mock_registry, mock_task_manager, guardrail)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/api/v1/generate/internal/judge",
                json={"prompt": "is this safe?", "provider": _PROVIDER, "model": "judge-model"},
            )

        assert resp.status_code == 200, resp.text
        guardrail.validate.assert_not_awaited()
        guardrail.screen_output.assert_not_awaited()
