"""The internal judge route — `text`'s side of the guardrail-delegation cycle break.

RED before GREEN (TASK-735 Phase 2, items 1 and 5).

Guardrail is being rebuilt to own POLICY only and delegate its LLM judgement
calls to `text`. Naively that closes a cycle: every public `/generate` is gated
on guardrail (fail-closed), so `guardrail -> text/generate` would recurse
`text -> guardrail -> text -> ...` and, under saturation, deadlock the safety
plane behind the very pool it protects.

The break has three structural parts, and each one is pinned here:

1. A SEPARATE route (`POST /api/v1/generate/internal/judge`) rather than a flag
   on the public `/generate` body — a bypass that cannot be reached by shaping a
   public request.
2. A recursion guard, so a FUTURE edit that reintroduces the moderation gate on
   the judge path fails a test instead of shipping a cycle. Two layers: a static
   check that the judge module/route knows nothing about the guardrail client,
   and a runtime tripwire inside the shared gate helper.
3. Resource isolation — the judge has its OWN semaphore and circuit breaker per
   provider, so a saturated user-facing pool cannot starve a judge call and a
   wedged judge call cannot consume the user-facing budget.

Plus metering (item 5): the judge's tokens are safety-plane spend. `costBasis`
is DERIVED from the funding tier of the credential that served the call, never
stamped at the call site.
"""

from __future__ import annotations

import asyncio
import inspect
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
import structlog.testing
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from text.core.config import ExternalGuardrailConfig, JudgeConfig, Settings
from text.models.requests import GenerateRequest
from text.models.stats import build_generation_stats
from text.services.resizable_semaphore import ResizableSemaphore

JUDGE_PATH = "/api/v1/generate/internal/judge"

_PROVIDER = "lm-studio"


def _stats(**overrides):
    return build_generation_stats(
        provider=_PROVIDER,
        model="judge-model",
        raw_stop_reason="stop",
        prompt_tokens=11,
        predicted_tokens=7,
        total_ms=12,
        engine_native={"usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18}},
        **overrides,
    )


@pytest.fixture
def mock_provider():
    provider = AsyncMock()
    provider.generate = AsyncMock(return_value=('{"allowed": false}', "", _stats()))
    return provider


@pytest.fixture
def mock_registry(mock_provider):
    registry = MagicMock()
    registry.get.return_value = mock_provider
    registry.list_providers.return_value = [_PROVIDER]
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


def _hermetic_settings(**overrides) -> Settings:
    """Settings that do not depend on this machine's `.env.dev`.

    `create_app()` calls `get_settings()`, which loads the env file into
    `os.environ`; a developer token there would otherwise 401 every request in
    this module.
    """
    base = {
        "service_token": SecretStr(""),
        "external_guardrail": ExternalGuardrailConfig(enabled=False),
    }
    base.update(overrides)
    return Settings(**base)


def _make_app(registry, task_manager, *, guardrail_client=None, settings=None):
    from text.main import create_app

    app = create_app()
    app.state.settings = settings if settings is not None else _hermetic_settings()
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    app.state.guardrail_client = guardrail_client
    return app


@pytest_asyncio.fixture
async def client_factory(mock_registry, mock_task_manager):
    clients = []

    async def _build(*, guardrail_client=None, settings=None, configure=None):
        app = _make_app(
            mock_registry, mock_task_manager, guardrail_client=guardrail_client, settings=settings
        )
        if configure is not None:
            configure(app)
        transport = ASGITransport(app=app)
        c = AsyncClient(transport=transport, base_url="http://test")
        clients.append(c)
        return c, app

    yield _build
    for c in clients:
        await c.aclose()


def _payload(**overrides):
    body = {
        "prompt": "Is this clinical text safe?",
        "provider": _PROVIDER,
        "model": "judge-model",
    }
    body.update(overrides)
    return body


# --------------------------------------------------------------------------
# 1. The route is structural, not a flag on the public contract
# --------------------------------------------------------------------------


class TestJudgeRouteIsStructural:
    def test_route_is_registered(self):
        from text.main import create_app

        app = create_app()
        assert JUDGE_PATH in app.openapi()["paths"]

    def test_public_generate_body_carries_no_judge_bypass_flag(self):
        """A bypass reachable by shaping a public request would defeat the point."""
        fields = set(GenerateRequest.model_fields)
        assert not {f for f in fields if "judge" in f or "bypass" in f or "internal" in f}

    @pytest.mark.asyncio
    async def test_judge_returns_content_stats_and_usage(self, client_factory, mock_provider):
        client, _ = await client_factory()

        resp = await client.post(JUDGE_PATH, json=_payload())

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["content"] == '{"allowed": false}'
        assert body["provider"] == _PROVIDER
        assert body["model"] == "judge-model"
        assert body["stats"]["prompt_tokens"] == 11
        assert body["usage_detail"]["prompt_tokens"] == 11
        assert body["usage_detail"]["completion_tokens"] == 7
        mock_provider.generate.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_missing_model_fails_closed(self, client_factory, mock_provider):
        """Model SELECTION is fail-closed everywhere in this service."""
        client, _ = await client_factory()

        resp = await client.post(JUDGE_PATH, json={"prompt": "x", "provider": _PROVIDER})

        assert resp.status_code == 422
        mock_provider.generate.assert_not_called()


# --------------------------------------------------------------------------
# 2. Auth — same X-Service-Token posture as every other non-exempt route
# --------------------------------------------------------------------------


class TestJudgeRouteAuth:
    def test_judge_path_is_not_auth_exempt(self):
        from text.api.middleware.auth import EXEMPT_PATHS

        assert JUDGE_PATH not in EXEMPT_PATHS

    @pytest.mark.asyncio
    async def test_missing_service_token_is_rejected(self, client_factory, mock_provider):
        settings = _hermetic_settings(service_token=SecretStr("judge-token"))
        client, _ = await client_factory(settings=settings)

        resp = await client.post(JUDGE_PATH, json=_payload())

        assert resp.status_code == 401
        mock_provider.generate.assert_not_called()

    @pytest.mark.asyncio
    async def test_valid_service_token_is_accepted(self, client_factory):
        settings = _hermetic_settings(service_token=SecretStr("judge-token"))
        client, _ = await client_factory(settings=settings)

        resp = await client.post(
            JUDGE_PATH, json=_payload(), headers={"X-Service-Token": "judge-token"}
        )

        assert resp.status_code == 200, resp.text


# --------------------------------------------------------------------------
# 3. The cycle guard
# --------------------------------------------------------------------------


class TestCycleGuard:
    @pytest.mark.asyncio
    async def test_judge_never_invokes_the_guardrail_gate(self, client_factory):
        guardrail = AsyncMock()
        guardrail.validate = AsyncMock(return_value={"allowed": True})
        client, _ = await client_factory(guardrail_client=guardrail)

        resp = await client.post(JUDGE_PATH, json=_payload())

        assert resp.status_code == 200, resp.text
        guardrail.validate.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_judge_runs_even_under_the_enforce_posture(self, client_factory):
        """`external_guardrail.enabled` fails the PUBLIC path closed when the
        client is unwired. The judge path is outside that gate by construction —
        otherwise a guardrail outage could never be judged its way out of."""
        settings = _hermetic_settings(external_guardrail=ExternalGuardrailConfig(enabled=True))
        client, _ = await client_factory(settings=settings, guardrail_client=None)

        resp = await client.post(JUDGE_PATH, json=_payload())

        assert resp.status_code == 200, resp.text

    def test_judge_module_references_no_guardrail_client(self):
        """Static layer: the judge module cannot call what it cannot name."""
        from text.api.endpoints import judge

        source = Path(judge.__file__).read_text()
        assert "ExternalGuardrailClient" not in source
        assert "get_guardrail_client" not in source
        assert "guardrail_client" not in source

    def test_judge_route_declares_no_guardrail_dependency(self):
        from text.api.endpoints.judge import router
        from text.core.dependencies import get_guardrail_client

        route = next(r for r in router.routes if r.path == "/generate/internal/judge")
        calls = {dep.call for dep in route.dependant.dependencies}
        assert get_guardrail_client not in calls
        assert calls  # the route does declare dependencies — this is not a vacuous pass

    @pytest.mark.asyncio
    async def test_gate_helper_trips_inside_a_judge_scope(self):
        """Runtime layer: if a future edit routes the SHARED gate helper onto the
        judge path, it raises instead of closing the cycle."""
        from text.api.endpoints.generate import _apply_guardrail_gate
        from text.services.judge_guard import GuardrailRecursionError, judge_scope

        guardrail = AsyncMock()
        guardrail.validate = AsyncMock(return_value={"allowed": True})
        request_body = GenerateRequest(prompt="hi", provider=_PROVIDER, model="m")

        with judge_scope():
            with pytest.raises(GuardrailRecursionError):
                await _apply_guardrail_gate(
                    guardrail,
                    request_body=request_body,
                    tenant_id=None,
                    settings=_hermetic_settings(),
                )

        guardrail.validate.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_gate_helper_is_unchanged_outside_a_judge_scope(self):
        from text.api.endpoints.generate import _apply_guardrail_gate

        guardrail = AsyncMock()
        guardrail.validate = AsyncMock(return_value={"allowed": True})
        request_body = GenerateRequest(prompt="hi", provider=_PROVIDER, model="m")

        usage = await _apply_guardrail_gate(
            guardrail,
            request_body=request_body,
            tenant_id="t-1",
            settings=_hermetic_settings(),
        )

        assert usage is None  # verdict carried no stats
        guardrail.validate.assert_awaited_once()

    def test_judge_scope_does_not_leak_out_of_its_block(self):
        from text.services.judge_guard import in_judge_scope, judge_scope

        assert in_judge_scope() is False
        with judge_scope():
            assert in_judge_scope() is True
        assert in_judge_scope() is False


# --------------------------------------------------------------------------
# 4. Resource isolation
# --------------------------------------------------------------------------


class TestPoolIsolation:
    @pytest.mark.asyncio
    async def test_saturated_user_facing_pool_still_admits_a_judge_call(self, client_factory):
        user_sem = ResizableSemaphore(1)
        await user_sem.acquire()  # user-facing pool fully saturated

        def configure(app):
            app.state.provider_semaphores = {_PROVIDER: user_sem}

        client, _ = await client_factory(configure=configure)

        resp = await asyncio.wait_for(client.post(JUDGE_PATH, json=_payload()), timeout=5)

        assert resp.status_code == 200, resp.text
        assert user_sem.in_flight == 1  # judge took nothing from it

    @pytest.mark.asyncio
    async def test_wedged_judge_call_does_not_consume_the_user_facing_budget(
        self, client_factory, mock_provider
    ):
        judge_sem = ResizableSemaphore(1)
        await judge_sem.acquire()  # a judge call is wedged, holding the only judge permit
        user_sem = ResizableSemaphore(1)

        def configure(app):
            app.state.judge_semaphores = {_PROVIDER: judge_sem}
            app.state.provider_semaphores = {_PROVIDER: user_sem}
            app.state.settings = app.state.settings.model_copy(
                update={"judge": JudgeConfig(acquire_timeout_s=0.05)}
            )

        client, _ = await client_factory(configure=configure)

        judge_resp = await client.post(JUDGE_PATH, json=_payload())
        assert judge_resp.status_code == 503
        assert judge_resp.json()["error_code"] == "CONCURRENCY_LIMIT"

        generate_resp = await client.post(
            "/api/v1/generate", json={"prompt": "patient note", "model": "m", "provider": _PROVIDER}
        )
        assert generate_resp.status_code == 200, generate_resp.text
        assert user_sem.in_flight == 0  # acquired and released by the public path

    @pytest.mark.asyncio
    async def test_judge_pool_state_survives_across_requests(self, client_factory):
        """The budget must live on `app.state`, not be rebuilt per request.

        A per-request dict would hand every judge call its own fresh semaphore —
        which looks like it works and means no concurrency bound at all.
        """

        def configure(app):
            app.state.judge_semaphores = None  # unwired, as in a hand-built app

        client, app = await client_factory(configure=configure)

        await client.post(JUDGE_PATH, json=_payload())
        first = app.state.judge_semaphores[_PROVIDER]
        await client.post(JUDGE_PATH, json=_payload())

        assert app.state.judge_semaphores[_PROVIDER] is first

    @pytest.mark.asyncio
    async def test_judge_failures_do_not_open_the_user_facing_breaker(
        self, client_factory, mock_provider
    ):
        from text.services.circuit_breaker import CircuitBreaker

        user_breaker = CircuitBreaker(failure_threshold=1)
        mock_provider.generate = AsyncMock(side_effect=RuntimeError("judge engine down"))

        def configure(app):
            app.state.circuit_breakers = {_PROVIDER: user_breaker}

        client, app = await client_factory(configure=configure)

        resp = await client.post(JUDGE_PATH, json=_payload())

        assert resp.status_code == 502
        assert user_breaker.failure_count == 0
        assert user_breaker.allow_request() is True
        assert app.state.judge_circuit_breakers[_PROVIDER].failure_count == 1

    @pytest.mark.asyncio
    async def test_judge_pool_state_is_a_separate_keyspace(self, client_factory):
        client, app = await client_factory()

        await client.post(JUDGE_PATH, json=_payload())

        assert app.state.judge_semaphores[_PROVIDER] is not app.state.provider_semaphores.get(
            _PROVIDER
        )
        assert app.state.judge_circuit_breakers[_PROVIDER] is not app.state.circuit_breakers.get(
            _PROVIDER
        )


# --------------------------------------------------------------------------
# 5. BYO credentials
# --------------------------------------------------------------------------


class TestProviderOverrides:
    @pytest.mark.asyncio
    async def test_overrides_reach_the_provider_adapter_and_are_never_logged(
        self, client_factory, mock_provider
    ):
        secret = "byo-judge-secret-value"
        client, _ = await client_factory()

        with structlog.testing.capture_logs() as logs:
            resp = await client.post(
                JUDGE_PATH,
                json=_payload(
                    provider_overrides={
                        _PROVIDER: {"api_key": secret, "funding": "tenant", "base_url": "http://x"}
                    }
                ),
            )

        assert resp.status_code == 200, resp.text
        sent = mock_provider.generate.await_args.args[0]
        assert sent.provider_overrides[_PROVIDER].api_key.get_secret_value() == secret
        assert sent.provider_overrides[_PROVIDER].base_url == "http://x"
        assert secret not in json.dumps(logs, default=str)
        assert secret not in resp.text


# --------------------------------------------------------------------------
# 6. Metering attribution (item 5)
# --------------------------------------------------------------------------


class TestJudgeMetering:
    def test_cost_basis_cannot_be_stamped_at_a_call_site(self):
        from text.models.usage import build_usage_detail

        assert "cost_basis" not in inspect.signature(build_usage_detail).parameters

    def test_cost_basis_is_derived_from_the_funding_tier(self):
        from text.models.usage import build_usage_detail

        platform = build_usage_detail(
            task_id="t",
            request_id=None,
            provider="azure",
            model="m",
            prompt_tokens=1,
            completion_tokens=1,
            byok=False,
        )
        tenant = build_usage_detail(
            task_id="t",
            request_id=None,
            provider="azure",
            model="m",
            prompt_tokens=1,
            completion_tokens=1,
            byok=True,
        )
        assert platform.cost_basis == "INTERNAL"
        assert tenant.cost_basis == "BYOK_NOTIONAL"

    @pytest.mark.asyncio
    async def test_platform_funded_judge_call_meters_internal(self, client_factory):
        client, _ = await client_factory()

        resp = await client.post(
            JUDGE_PATH,
            json=_payload(provider_overrides={_PROVIDER: {"api_key": "k", "funding": "platform"}}),
        )

        detail = resp.json()["usage_detail"]
        assert detail["byok"] is False
        assert detail["cost_basis"] == "INTERNAL"

    @pytest.mark.asyncio
    async def test_tenant_funded_judge_call_meters_byok_notional(self, client_factory):
        client, _ = await client_factory()

        resp = await client.post(
            JUDGE_PATH,
            json=_payload(provider_overrides={_PROVIDER: {"api_key": "k", "funding": "tenant"}}),
        )

        detail = resp.json()["usage_detail"]
        assert detail["byok"] is True
        assert detail["cost_basis"] == "BYOK_NOTIONAL"

    @pytest.mark.asyncio
    async def test_judge_call_with_no_override_meters_internal(self, client_factory):
        client, _ = await client_factory()

        resp = await client.post(JUDGE_PATH, json=_payload())

        assert resp.json()["usage_detail"]["cost_basis"] == "INTERNAL"

    def test_ride_back_prefers_the_judge_usage_detail_and_rederives_cost_basis(self):
        """The `guardrail_usage_from_verdict` ride-back is REPOINTED, not
        duplicated: guardrail now forwards the judge's own `usage_detail`, and a
        peer-stamped `cost_basis` is re-derived rather than trusted."""
        from text.models.usage import guardrail_usage_from_verdict

        verdict = {
            "allowed": False,
            "raw": {
                "usage_detail": {
                    "task_id": "judge-1",
                    "request_id": "req-1",
                    "provider": "azure",
                    "model": "judge-model",
                    "endpoint_kind": "openai.chat",
                    "byok": True,
                    "cost_basis": "INTERNAL",  # a lie — must be re-derived
                    "prompt_tokens": 5,
                    "completion_tokens": 2,
                    "total_tokens": 7,
                    "raw": {"prompt_tokens": 5},
                }
            },
        }

        usage = guardrail_usage_from_verdict(verdict)

        assert usage is not None
        assert usage.provider == "azure"
        assert usage.prompt_tokens == 5
        assert usage.byok is True
        assert usage.cost_basis == "BYOK_NOTIONAL"

    def test_legacy_stats_ride_back_still_works(self):
        from text.models.usage import guardrail_usage_from_verdict

        verdict = {
            "raw": {
                "stats": {
                    "provider": "lm-studio",
                    "model": "guardian",
                    "request_id": "r-9",
                    "prompt_tokens": 3,
                    "predicted_tokens": 4,
                    "total_tokens": 7,
                }
            }
        }

        usage = guardrail_usage_from_verdict(verdict)

        assert usage is not None
        assert usage.provider == "lm-studio"
        assert usage.completion_tokens == 4
        assert usage.cost_basis == "INTERNAL"

    def test_no_stats_and_no_usage_detail_is_silence(self):
        from text.models.usage import guardrail_usage_from_verdict

        assert guardrail_usage_from_verdict({"allowed": True}) is None
        assert guardrail_usage_from_verdict(None) is None


# --------------------------------------------------------------------------
# 7. Regression lock on the PUBLIC path
# --------------------------------------------------------------------------


class TestPublicGeneratePathUnchanged:
    """The gate moved into a helper; its observable behaviour must not."""

    @pytest.mark.asyncio
    async def test_content_rejection_is_422(self, client_factory, mock_provider):
        guardrail = AsyncMock()
        guardrail.validate = AsyncMock(return_value={"allowed": False, "reason": "not_medical"})
        client, _ = await client_factory(guardrail_client=guardrail)

        resp = await client.post("/api/v1/generate", json={"prompt": "hello", "model": "m"})

        assert resp.status_code == 422
        assert "guardrail" in resp.json()["detail"].lower()
        mock_provider.generate.assert_not_called()

    @pytest.mark.asyncio
    async def test_sustained_outage_is_503(self, client_factory, mock_provider):
        guardrail = AsyncMock()
        guardrail.validate = AsyncMock(
            return_value={"allowed": False, "reason": "external_guardrail_unavailable"}
        )
        client, _ = await client_factory(guardrail_client=guardrail)

        resp = await client.post("/api/v1/generate", json={"prompt": "hello", "model": "m"})

        assert resp.status_code == 503
        mock_provider.generate.assert_not_called()

    @pytest.mark.asyncio
    async def test_missing_allowed_key_fails_closed(self, client_factory, mock_provider):
        guardrail = AsyncMock()
        guardrail.validate = AsyncMock(return_value={"reason": "malformed"})
        client, _ = await client_factory(guardrail_client=guardrail)

        resp = await client.post("/api/v1/generate", json={"prompt": "hello", "model": "m"})

        assert resp.status_code == 422
        mock_provider.generate.assert_not_called()

    @pytest.mark.asyncio
    async def test_enforce_posture_with_unwired_client_is_503(self, client_factory, mock_provider):
        settings = _hermetic_settings(external_guardrail=ExternalGuardrailConfig(enabled=True))
        client, _ = await client_factory(settings=settings, guardrail_client=None)

        resp = await client.post("/api/v1/generate", json={"prompt": "hello", "model": "m"})

        assert resp.status_code == 503
        mock_provider.generate.assert_not_called()

    @pytest.mark.asyncio
    async def test_guardrail_usage_still_rides_back_on_the_response(self, client_factory):
        guardrail = AsyncMock()
        guardrail.validate = AsyncMock(
            return_value={
                "allowed": True,
                "raw": {
                    "stats": {
                        "provider": "lm-studio",
                        "model": "guardian",
                        "request_id": "r-1",
                        "prompt_tokens": 2,
                        "predicted_tokens": 1,
                    }
                },
            }
        )
        client, _ = await client_factory(guardrail_client=guardrail)

        resp = await client.post("/api/v1/generate", json={"prompt": "hello", "model": "m"})

        assert resp.status_code == 200, resp.text
        assert resp.json()["guardrail_usage"]["provider"] == "lm-studio"
