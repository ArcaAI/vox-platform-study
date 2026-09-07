"""TASK-890 — the judge's connection, delivered and (failing that) resolved.

Guardrail delegates its LLM judgement to `apps/text`, which holds no endpoint and
no credential of its own: every connection arrives as a `provider_overrides` blob
the gateway resolved. `request.state.provider_overrides` — the slot
`core/dependencies._provider_overrides` reads — was set by NOTHING, so the judge
call carried none and `text` answered 503 `PROVIDER_CREDENTIALS_MISSING` on every
guardrail-enabled generation.

Two independent deliveries, because neither alone is sufficient:

**1. The forward.** `apps/text` now sends the blob it was given on the validate
request, and the route lifts it onto `request.state` so the resolved judge client
carries it. This covers the common case (the tenant's generation and the judge run
on the SAME provider).

**2. The fallback.** The gateway forwards ONLY the entry for the provider the
GENERATION selected (minimal exposure), so a tenant generating on Azure while the
judge runs on the platform's LM Studio still arrives with nothing the judge can
use. For ENGINE-SERVED providers guardrail resolves the connection's `baseUrl`
itself, through the same tenant → SYSTEM cascade as the model selection, and
builds a minimal keyless override. It never reads a KEY: `encryptedApiKey` is
Vault ciphertext guardrail cannot and must not decrypt, which is exactly why a
CLOUD provider gets no fallback and stays fail-closed.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from guardrail.api.endpoints.medical import MedicalValidationRequest, validate_medical_context
from guardrail.core.config import Settings
from guardrail.core.dependencies import get_resolved_guardian_provider
from guardrail.core.tenant_config import (
    KEY_MODEL,
    KEY_PROVIDER,
    KEY_PROVIDER_BASE_URL,
    KEY_PROVIDER_CONNECTION_TENANT,
    SYSTEM_TENANT_ID,
    GuardrailTenantConfig,
    TenantConfigResolver,
    build_judge_client,
)

TENANT = "11111111-1111-1111-1111-111111111111"
_LM_STUDIO = "http://localhost:1234/v1"

_VERDICT = (
    '{"is_medical": true, "confidence": 0.93, "context_type": "clinical", '
    '"reasoning": "chief complaint and vitals"}'
)

_POLICY = {
    "medicalValidationCriteria": "you are a medical context validator",
    "judgeTemperature": 0.05,
    "judgeMaxTokens": 300,
}


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _RecordingClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"url": url, **kwargs})
        return _FakeResponse({"content": _VERDICT, "provider": "lm-studio", "model": "guardian-1"})


class _StubResolver:
    def __init__(self, cfg: GuardrailTenantConfig) -> None:
        self.cfg = cfg

    async def resolve(self, tenant_id, task_key=None):  # noqa: ANN001
        return self.cfg


class _FakeRequest:
    """A request with the two things the dependency reads: `state`, then the
    already-parsed body (FastAPI caches it before dependencies are solved)."""

    def __init__(self, app_state: SimpleNamespace, body: dict[str, Any] | None = None) -> None:
        self.app = SimpleNamespace(state=app_state)
        self.headers = {"X-Tenant-Id": TENANT}
        self.state = SimpleNamespace()
        self._body = body or {}

    async def json(self) -> dict[str, Any]:
        return self._body


def _app_state(http: Any, cfg: GuardrailTenantConfig) -> SimpleNamespace:
    return SimpleNamespace(
        settings=Settings(),
        http_client=http,
        tenant_config_resolver=_StubResolver(cfg),
    )


# ---------------------------------------------------------------------------
# 1. The forward — validate body → request.state → judge wire
# ---------------------------------------------------------------------------


async def _validate(body: dict[str, Any], http: _RecordingClient) -> None:
    """The real seam: the dependency builds the judge from the parsed body, then
    the route runs it. The client is stubbed at the HTTP boundary and nowhere
    above it, so the body → dependency → wire path is the thing under test."""
    cfg = GuardrailTenantConfig(provider="lm-studio", model="guardian-1", policy=_POLICY)
    request = _FakeRequest(_app_state(http, cfg), body)
    guardian = await get_resolved_guardian_provider(request)  # type: ignore[arg-type]
    await validate_medical_context(MedicalValidationRequest(**body), Settings(), guardian)


@pytest.mark.asyncio
async def test_overrides_on_the_validate_body_reach_the_judge_call() -> None:
    http = _RecordingClient()
    overrides = {"lm-studio": {"api_key": "not-needed", "base_url": _LM_STUDIO}}

    await _validate({"text": "chest pain", "provider_overrides": overrides}, http)

    assert http.calls[0]["json"]["provider_overrides"] == overrides


@pytest.mark.asyncio
async def test_request_state_still_wins_over_the_body() -> None:
    """`request.state` remains the documented carrier for an in-process caller or a
    middleware that has already resolved one; the body is the fallback beneath it."""
    http = _RecordingClient()
    cfg = GuardrailTenantConfig(provider="lm-studio", model="guardian-1", policy=_POLICY)
    request = _FakeRequest(
        _app_state(http, cfg), {"text": "x", "provider_overrides": {"lm-studio": {"api_key": "b"}}}
    )
    request.state.provider_overrides = {"lm-studio": {"api_key": "from-state"}}

    guardian = await get_resolved_guardian_provider(request)  # type: ignore[arg-type]

    assert guardian.provider_overrides == {"lm-studio": {"api_key": "from-state"}}


@pytest.mark.asyncio
async def test_a_validate_body_without_overrides_forwards_none() -> None:
    """Absent must stay absent — the fallback below, not an empty dict, answers it."""
    http = _RecordingClient()

    await _validate({"text": "chest pain"}, http)

    assert "provider_overrides" not in http.calls[0]["json"]


# ---------------------------------------------------------------------------
# 2. The fallback — an engine-served connection guardrail resolves for itself
# ---------------------------------------------------------------------------


def _judge(cfg: GuardrailTenantConfig, overrides: dict[str, Any] | None = None) -> Any:
    return build_judge_client(
        Settings(),
        cfg,
        _RecordingClient(),
        TENANT,
        provider_overrides=overrides,
    )


def test_an_engine_served_provider_falls_back_to_the_resolved_base_url() -> None:
    cfg = GuardrailTenantConfig(
        provider="lm-studio",
        model="guardian-1",
        policy=_POLICY,
        provider_base_url=_LM_STUDIO,
        provider_connection_tenant_id=SYSTEM_TENANT_ID,
    )

    client = _judge(cfg)

    # No key is invented — guardrail cannot decrypt one, and the engine needs none.
    # Funding is DERIVED from the row that supplied the endpoint, never stamped.
    assert client.provider_overrides == {
        "lm-studio": {"base_url": _LM_STUDIO, "funding": "platform"}
    }


def test_a_tenant_owned_connection_row_is_funded_to_the_tenant() -> None:
    cfg = GuardrailTenantConfig(
        provider="ollama",
        model="guardian-1",
        policy=_POLICY,
        provider_base_url="http://ollama.test",
        provider_connection_tenant_id=TENANT,
    )

    assert _judge(cfg).provider_overrides["ollama"]["funding"] == "tenant"


def test_an_injected_override_wins_over_the_fallback() -> None:
    """The gateway resolved tenant-first already; guardrail never second-guesses it."""
    cfg = GuardrailTenantConfig(
        provider="lm-studio",
        model="guardian-1",
        policy=_POLICY,
        provider_base_url="http://platform-default.test/v1",
        provider_connection_tenant_id=SYSTEM_TENANT_ID,
    )
    injected = {"lm-studio": {"api_key": "k", "base_url": "http://tenants-own.test/v1"}}

    assert _judge(cfg, injected).provider_overrides == injected


def test_a_foreign_entry_in_the_blob_does_not_suppress_the_fallback() -> None:
    """A generation on Azure forwards only its Azure entry — the judge still needs one."""
    cfg = GuardrailTenantConfig(
        provider="lm-studio",
        model="guardian-1",
        policy=_POLICY,
        provider_base_url=_LM_STUDIO,
        provider_connection_tenant_id=SYSTEM_TENANT_ID,
    )
    injected = {"azure": {"api_key": "tenant-azure-key"}}

    overrides = _judge(cfg, injected).provider_overrides

    assert overrides["azure"] == injected["azure"]
    assert overrides["lm-studio"] == {"base_url": _LM_STUDIO, "funding": "platform"}


def test_a_cloud_provider_gets_no_fallback_and_stays_fail_closed() -> None:
    """A cloud call needs a KEY, and guardrail must never source one from SQL."""
    cfg = GuardrailTenantConfig(
        provider="azure",
        model="gpt-4o",
        policy=_POLICY,
        provider_base_url="https://x.openai.azure.com",
        provider_connection_tenant_id=SYSTEM_TENANT_ID,
    )

    assert _judge(cfg).provider_overrides is None


# ---------------------------------------------------------------------------
# 2b. The SQL read behind the fallback
# ---------------------------------------------------------------------------


class _SeqResult:
    def __init__(self, rows: list) -> None:
        self._rows = rows

    def all(self) -> list:
        return list(self._rows)

    def first(self) -> Any:
        return self._rows[0] if self._rows else None


class _SeqSession:
    """Answers each `execute` with the next queued result set."""

    def __init__(self, batches: list[list]) -> None:
        self._batches = list(batches)

    async def __aenter__(self) -> _SeqSession:
        return self

    async def __aexit__(self, *exc_info: object) -> bool:
        return False

    async def execute(self, stmt: object) -> _SeqResult:
        return _SeqResult(self._batches.pop(0) if self._batches else [])


def _policy_row(provider: str) -> SimpleNamespace:
    return SimpleNamespace(
        default_tenant_id=SYSTEM_TENANT_ID,
        default_resource_status="ENABLED",
        default_enabled=True,
        config_json=None,
        model_tenant_id=SYSTEM_TENANT_ID,
        provider=provider,
        source_uri="guardian-1",
        meta_data={"policy": _POLICY},
        checksum=None,
        source=None,
        source_revision=None,
    )


def _connection_row(
    tenant_id: str, base_url: str | None, resource_status: str = "ENABLED", enabled: bool = True
) -> SimpleNamespace:
    return SimpleNamespace(
        connection_tenant_id=tenant_id,
        base_url=base_url,
        connection_enabled=enabled,
        connection_resource_status=resource_status,
    )


@pytest.mark.asyncio
async def test_load_from_db_surfaces_the_engine_connection_endpoint() -> None:
    session = _SeqSession(
        [[_policy_row("lm-studio")], [_connection_row(SYSTEM_TENANT_ID, _LM_STUDIO)]]
    )
    resolver = TenantConfigResolver(session_factory=lambda: session, cache_ttl_s=60)

    keys = await resolver._load_from_db(TENANT)

    assert keys[KEY_PROVIDER] == "lm-studio"
    assert keys[KEY_MODEL] == "guardian-1"
    assert keys[KEY_PROVIDER_BASE_URL] == _LM_STUDIO
    assert keys[KEY_PROVIDER_CONNECTION_TENANT] == SYSTEM_TENANT_ID


@pytest.mark.asyncio
async def test_the_tenants_own_connection_row_wins_over_the_system_row() -> None:
    session = _SeqSession(
        [
            [_policy_row("lm-studio")],
            [
                _connection_row(SYSTEM_TENANT_ID, "http://platform.test/v1"),
                _connection_row(TENANT, "http://tenants-own.test/v1"),
            ],
        ]
    )
    resolver = TenantConfigResolver(session_factory=lambda: session, cache_ttl_s=60)

    keys = await resolver._load_from_db(TENANT)

    assert keys[KEY_PROVIDER_BASE_URL] == "http://tenants-own.test/v1"
    assert keys[KEY_PROVIDER_CONNECTION_TENANT] == TENANT


@pytest.mark.asyncio
async def test_a_disabled_tenant_connection_row_vetoes_the_fallback() -> None:
    """Three-state parity: the tenant refused this provider, so there is no
    endpoint to widen to — the judge fails closed rather than being served the
    platform's engine behind the tenant's back."""
    session = _SeqSession(
        [
            [_policy_row("lm-studio")],
            [
                _connection_row(SYSTEM_TENANT_ID, "http://platform.test/v1"),
                _connection_row(TENANT, _LM_STUDIO, resource_status="DISABLED"),
            ],
        ]
    )
    resolver = TenantConfigResolver(session_factory=lambda: session, cache_ttl_s=60)

    keys = await resolver._load_from_db(TENANT)

    assert KEY_PROVIDER_BASE_URL not in keys


@pytest.mark.asyncio
async def test_a_cloud_selection_never_reads_a_connection_row_at_all() -> None:
    """One query, not two: there is no fallback to build, so there is nothing to ask."""
    session = _SeqSession([[_policy_row("azure")]])
    resolver = TenantConfigResolver(session_factory=lambda: session, cache_ttl_s=60)

    keys = await resolver._load_from_db(TENANT)

    assert KEY_PROVIDER_BASE_URL not in keys
    assert json.loads(keys["policy"]) == _POLICY
