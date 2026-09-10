"""Tests for the shared self-registration + heartbeat helper.

Contract:
contracts/service-release.api.yaml` `POST /internal/service-releases`
idempotent upsert; a repeat call (heartbeat) is the SAME endpoint.

Critical rule under test: registration must NEVER block or fail process boot
. A down/timeout/500 gateway must not raise past
`start_registration`/`stop_registration`, and the heartbeat task must be
cleanly cancellable with no leaked task.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from hope_env.build_info import BuildInfo
from hope_env.service_registration import (
    build_payload,
    instance_id,
    normalize_environment,
    start_registration,
    stop_registration,
)

SAMPLE_BUILD_INFO = BuildInfo(
    service="text",
    version="2.1.0",
    release_tag="Text-2.1.0",
    git_branch="main",
    git_commit_sha="0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557",
    build_at="2026-08-09T11:22:33Z",
    ci_pipeline_id="12345",
    ci_pipeline_url="https://gitlab.example.com/pipelines/12345",
)


class TestNormalizeEnvironment:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("development", "dev"),
            ("dev", "dev"),
            ("test", "dev"),
            ("staging", "staging"),
            ("production", "prod"),
            ("prod", "prod"),
            ("", "dev"),
            ("Production", "prod"),
        ],
    )
    def test_normalizes_known_conventions(self, raw: str, expected: str) -> None:
        assert normalize_environment(raw) == expected


class TestInstanceId:
    def test_prefers_hostname_env_var(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HOSTNAME", "text-7d8f9c-abcde")
        assert instance_id() == "text-7d8f9c-abcde"

    def test_falls_back_to_hostname_colon_pid(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("HOSTNAME", raising=False)
        result = instance_id()
        assert ":" in result


class TestBuildPayload:
    def test_builds_the_wire_shape_from_build_info_plus_runtime_facts(self) -> None:
        payload = build_payload(SAMPLE_BUILD_INFO, "production", "text-pod-1")

        assert payload == {
            "service": "text",
            "version": "2.1.0",
            "releaseTag": "Text-2.1.0",
            "gitBranch": "main",
            "gitCommitSha": "0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557",
            "buildAt": "2026-08-09T11:22:33Z",
            "ciPipelineId": "12345",
            "ciPipelineUrl": "https://gitlab.example.com/pipelines/12345",
            "environment": "prod",
            "instanceId": "text-pod-1",
        }

    def test_normalizes_environment_inline(self) -> None:
        payload = build_payload(SAMPLE_BUILD_INFO, "development", "text-pod-1")
        assert payload["environment"] == "dev"


class _RecordingTransport(httpx.AsyncBaseTransport):
    """Fake transport recording every request it sees."""

    def __init__(self, responder) -> None:
        self.calls: list[httpx.Request] = []
        self._responder = responder

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        return self._responder(request)


class _RaisingTransport(httpx.AsyncBaseTransport):
    """Fake transport that always raises (simulates a down gateway)."""

    def __init__(self, exc: Exception) -> None:
        self.calls = 0
        self._exc = exc

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        raise self._exc


@pytest.mark.asyncio
class TestStartRegistrationNeverBlocksBoot:
    async def test_gateway_down_does_not_raise(self) -> None:
        transport = _RaisingTransport(httpx.ConnectError("connection refused"))
        client = httpx.AsyncClient(transport=transport)
        try:
            task = start_registration(
                http_client=client,
                gateway_url="http://gateway:8868/api/v1",
                service_token="secret",
                build_info=SAMPLE_BUILD_INFO,
                environment="dev",
                instance_id_="text-pod-1",
                interval_s=9999,
            )
            # Give the fire-and-forget initial POST a chance to run and fail.
            await asyncio.sleep(0.05)
            assert not task.done() or task.exception() is None
        finally:
            await stop_registration(task)
            await client.aclose()

    async def test_gateway_timeout_does_not_raise(self) -> None:
        transport = _RaisingTransport(httpx.TimeoutException("timed out"))
        client = httpx.AsyncClient(transport=transport)
        try:
            task = start_registration(
                http_client=client,
                gateway_url="http://gateway:8868/api/v1",
                service_token="secret",
                build_info=SAMPLE_BUILD_INFO,
                environment="dev",
                instance_id_="text-pod-1",
                interval_s=9999,
            )
            await asyncio.sleep(0.05)
            assert not task.done() or task.exception() is None
        finally:
            await stop_registration(task)
            await client.aclose()

    async def test_gateway_500_does_not_raise(self) -> None:
        transport = _RecordingTransport(lambda req: httpx.Response(500, json={"error": "boom"}))
        client = httpx.AsyncClient(transport=transport)
        try:
            task = start_registration(
                http_client=client,
                gateway_url="http://gateway:8868/api/v1",
                service_token="secret",
                build_info=SAMPLE_BUILD_INFO,
                environment="dev",
                instance_id_="text-pod-1",
                interval_s=9999,
            )
            await asyncio.sleep(0.05)
            assert not task.done() or task.exception() is None
            assert len(transport.calls) == 1
        finally:
            await stop_registration(task)
            await client.aclose()

    async def test_posts_the_expected_payload_and_headers_on_success(self) -> None:
        transport = _RecordingTransport(lambda req: httpx.Response(200, json={"id": "abc"}))
        client = httpx.AsyncClient(transport=transport)
        try:
            task = start_registration(
                http_client=client,
                gateway_url="http://gateway:8868/api/v1",
                service_token="s3cr3t",
                build_info=SAMPLE_BUILD_INFO,
                environment="prod",
                instance_id_="text-pod-1",
                interval_s=9999,
            )
            await asyncio.sleep(0.05)
            assert len(transport.calls) == 1
            request = transport.calls[0]
            assert str(request.url) == "http://gateway:8868/api/v1/internal/service-releases"
            assert request.headers["x-service-token"] == "s3cr3t"
        finally:
            await stop_registration(task)
            await client.aclose()


@pytest.mark.asyncio
class TestHeartbeatScheduling:
    async def test_heartbeats_on_the_configured_interval(self) -> None:
        transport = _RecordingTransport(lambda req: httpx.Response(200, json={"id": "abc"}))
        client = httpx.AsyncClient(transport=transport)
        try:
            task = start_registration(
                http_client=client,
                gateway_url="http://gateway:8868/api/v1",
                service_token="secret",
                build_info=SAMPLE_BUILD_INFO,
                environment="dev",
                instance_id_="text-pod-1",
                interval_s=0.02,
            )
            await asyncio.sleep(0.1)
            # Initial registration + at least 2 heartbeats.
            assert len(transport.calls) >= 3
        finally:
            await stop_registration(task)
            await client.aclose()

    async def test_stop_registration_cancels_the_task_cleanly(self) -> None:
        transport = _RecordingTransport(lambda req: httpx.Response(200, json={"id": "abc"}))
        client = httpx.AsyncClient(transport=transport)
        try:
            task = start_registration(
                http_client=client,
                gateway_url="http://gateway:8868/api/v1",
                service_token="secret",
                build_info=SAMPLE_BUILD_INFO,
                environment="dev",
                instance_id_="text-pod-1",
                interval_s=0.02,
            )
            await asyncio.sleep(0.03)
            await stop_registration(task)

            assert task.cancelled() or task.done()
            calls_at_stop = len(transport.calls)
            await asyncio.sleep(0.1)
            # No further heartbeats after cancellation — no leaked task.
            assert len(transport.calls) == calls_at_stop
        finally:
            await client.aclose()

    async def test_stop_registration_on_a_never_started_task_is_a_noop(self) -> None:
        # None must never raise — a lifespan that skipped start_registration
        # (e.g. because build-info was unreadable) still calls stop unconditionally.
        await stop_registration(None)


class _FailIfCalledTransport(httpx.AsyncBaseTransport):
    """A transport that proves NO request was made."""

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected request to {request.url}")


class TestDegradedBuildInfoSkipsRegistration:
    """TASK-946 — a process with no `/app/build-info.json` (every local dev
    process) has nothing to register: `service` is `unknown` and the gateway
    rejects the payload on every heartbeat (`service_registration.rejected`,
    7 per restart per process on the dev box). Skip, once, at INFO."""

    def _degraded(self) -> BuildInfo:
        return BuildInfo(
            service="unknown",
            version="0.0.0-dev-2-2.eec2daa1",
            release_tag=None,
            git_branch="dev-2.2",
            git_commit_sha="eec2daa1f4f5c8ac3bec39893bf4921d1f91c9de",
            build_at="1970-01-01T00:00:00.000Z",
            ci_pipeline_id=None,
            ci_pipeline_url=None,
        )

    async def test_unknown_service_never_posts_and_returns_none(self) -> None:
        client = httpx.AsyncClient(transport=_FailIfCalledTransport())
        try:
            task = start_registration(
                http_client=client,
                gateway_url="http://gateway:8868/api/v1",
                service_token="secret",
                build_info=self._degraded(),
                environment="dev",
                instance_id_="text-pod-1",
                interval_s=0.01,
            )
            await asyncio.sleep(0.05)
            assert task is None
            await stop_registration(task)  # None is still a safe argument
        finally:
            await client.aclose()

    async def test_real_build_info_still_registers(self) -> None:
        transport = _RecordingTransport(lambda request: httpx.Response(202, json={"ok": True}))
        client = httpx.AsyncClient(transport=transport)
        try:
            task = start_registration(
                http_client=client,
                gateway_url="http://gateway:8868/api/v1",
                service_token="secret",
                build_info=SAMPLE_BUILD_INFO,
                environment="dev",
                instance_id_="text-pod-1",
                interval_s=9999,
            )
            await asyncio.sleep(0.05)
            assert task is not None
            assert len(transport.calls) == 1
        finally:
            await stop_registration(task)
            await client.aclose()
