"""TASK-1038 D-A — a `core.agent` node pinned to `agentRef.versionNumber` RUNS that version.

Before: the harness resolved the agent's ACTIVE published version (`/internal/agents/resolve`
takes no pin) and, when it differed from the pin, REFUSED (`agent_version_drift`). So a published
workflow pinned to v2 stopped working the moment the agent was republished as v3 — the pin
protected nothing, it only broke.

After (owner rule W3): the pinned version is resolved BY VERSION through
`GET /api/v1/internal/agents/{slug}/versions/{versionNumber}/resolved` (lane A2's route, same
response shape as today's resolve) and runs — with the prompt frozen inside that version — even
when the active version moved or the pinned one is DEPRECATED. An unpinned node keeps today's
behaviour exactly. Version rows are immutable, so the answer is cached per
`(tenantId, slug, versionNumber)`; an answer that carries a credential is never cached.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from harness.services.api_client import ApiClient, ApiClientError
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult, ResolvedAgent
from harness.temporal.interpreter.nodes import agent_version_cache, core

_TENANT = "10000000-0000-0000-0000-000000000001"
_OTHER_TENANT = "10000000-0000-0000-0000-000000000002"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"


def _answer(version: int, prompt: str, *, credential: bool = False) -> dict[str, Any]:
    answer: dict[str, Any] = {
        "agentId": "agent-1",
        "agentVersionId": f"agent-1-v{version}",
        "slug": "discharge-writer",
        "versionNumber": version,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "explicit",
        "compiledConfig": {
            "task": "TEXT_GENERATION",
            "model": {"slug": "llama-local", "provider": "lm-studio"},
            "resolvedPrompt": {"source": "template", "content": prompt, "promptVersionNumber": 4},
            "parameters": {},
        },
        "models": [{"role": "primary", "slug": "llama-local", "provider": "lm-studio"}],
    }
    if credential:
        answer["providerOverride"] = {"provider": "openai", "api_key": "k"}
    return answer


# ---------------------------------------------------------------------------------------------
# The client call
# ---------------------------------------------------------------------------------------------


class TestResolveAgentVersionClient:
    @pytest.mark.asyncio
    async def test_it_calls_the_by_version_route_with_service_token_and_tenant(self):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=_answer(2, "v2 prompt"))

        api = ApiClient(
            "http://api", service_token="svc-token", transport=httpx.MockTransport(handler)
        )
        raw = await api.resolve_agent_version(
            slug="discharge-writer", version_number=2, tenant_id=_TENANT
        )

        assert raw["versionNumber"] == 2
        (request,) = seen
        assert request.method == "GET"
        assert request.url.path == "/api/v1/internal/agents/discharge-writer/versions/2/resolved"
        assert request.url.params["service"] == "harness"
        assert request.url.params["tenantId"] == _TENANT
        assert request.headers["X-Service-Token"] == "svc-token"
        assert request.headers["X-Tenant-Id"] == _TENANT

    @pytest.mark.asyncio
    async def test_a_404_is_a_terminal_client_error(self):
        api = ApiClient(
            "http://api",
            transport=httpx.MockTransport(lambda _r: httpx.Response(404, json={})),
        )
        with pytest.raises(ApiClientError):
            await api.resolve_agent_version(slug="x", version_number=9, tenant_id=_TENANT)

    @pytest.mark.asyncio
    async def test_the_slug_is_path_escaped(self):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=_answer(1, "p"))

        api = ApiClient("http://api", transport=httpx.MockTransport(handler))
        await api.resolve_agent_version(slug="a/b", version_number=1, tenant_id=_TENANT)

        assert seen[0].url.raw_path.startswith(b"/api/v1/internal/agents/a%2Fb/versions/1/")


# ---------------------------------------------------------------------------------------------
# The activity
# ---------------------------------------------------------------------------------------------


class _Gateway:
    """`active` is what /resolve answers; `versions` what the by-version route answers."""

    def __init__(self, active: dict[str, Any], versions: dict[int, dict[str, Any]]) -> None:
        self.active = active
        self.versions = versions
        self.resolve_calls: list[dict[str, Any]] = []
        self.version_calls: list[dict[str, Any]] = []

    async def resolve_agent(self, **kwargs: Any) -> dict[str, Any]:
        self.resolve_calls.append(kwargs)
        return self.active

    async def resolve_agent_version(self, **kwargs: Any) -> dict[str, Any]:
        self.version_calls.append(kwargs)
        return self.versions[kwargs["version_number"]]


def _payload(tenant: str = _TENANT, **ref: Any) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="agent1",
        node_type="core.agent",
        config={"agentRef": {"slug": "discharge-writer", **ref}},
        tenant_id=tenant,
        bound_inputs={"in": "Summarise this."},
        run_id=_RUN,
    )


@pytest.fixture
def gateway(monkeypatch: pytest.MonkeyPatch) -> _Gateway:
    gw = _Gateway(
        active=_answer(3, "v3 prompt (latest)"),
        versions={2: _answer(2, "v2 prompt (frozen)"), 3: _answer(3, "v3 prompt (latest)")},
    )
    monkeypatch.setattr(core, "_api_client", lambda _settings: gw)

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)
    agent_version_cache.clear()
    yield gw
    agent_version_cache.clear()


@pytest.fixture
def ran(monkeypatch: pytest.MonkeyPatch) -> list[ResolvedAgent]:
    seen: list[ResolvedAgent] = []

    async def _generate(
        _payload: NodeActivityInput,
        resolved: ResolvedAgent,
        _started: Any,
        fallback: Any = None,
        primary: Any = None,
    ) -> NodeActivityResult:
        seen.append(resolved)
        return NodeActivityResult(status="SUCCEEDED", output={"text": "ok"})

    monkeypatch.setattr(core, "_run_text_generation", _generate)
    return seen


class TestPinnedVersionRuns:
    @pytest.mark.asyncio
    async def test_the_pinned_version_runs_after_the_agent_was_republished(self, gateway, ran):
        result = await core.interpreter_core_agent(_payload(versionNumber=2))

        assert result.status == "SUCCEEDED"
        assert [r.version_number for r in ran] == [2]
        # The ACTIVE-version route is never asked for a pinned node.
        assert gateway.resolve_calls == []
        assert gateway.version_calls == [
            {"slug": "discharge-writer", "version_number": 2, "tenant_id": _TENANT}
        ]

    @pytest.mark.asyncio
    async def test_the_pinned_version_carries_its_own_frozen_prompt(self, gateway, ran):
        await core.interpreter_core_agent(_payload(versionNumber=2))

        assert ran[0].resolved_prompt is not None
        assert ran[0].resolved_prompt.content == "v2 prompt (frozen)"
        assert core._system_prompt(ran[0], {}, {}) == "v2 prompt (frozen)"

    @pytest.mark.asyncio
    async def test_an_unpinned_node_keeps_resolving_the_active_version(self, gateway, ran):
        result = await core.interpreter_core_agent(_payload())

        assert result.status == "SUCCEEDED"
        assert [r.version_number for r in ran] == [3]
        assert gateway.version_calls == []
        assert gateway.resolve_calls == [{"slug": "discharge-writer", "tenant_id": _TENANT}]

    @pytest.mark.asyncio
    async def test_a_pinned_version_the_gateway_cannot_serve_fails_closed(
        self, gateway, ran, monkeypatch: pytest.MonkeyPatch
    ):
        async def _gone(**_kwargs: Any) -> dict[str, Any]:
            raise ApiClientError("apps/api 404", status_code=404)

        monkeypatch.setattr(gateway, "resolve_agent_version", _gone)
        result = await core.interpreter_core_agent(_payload(versionNumber=7))

        assert result.status == "DEGRADED"
        assert "v7" in (result.reason or "")
        assert ran == []

    @pytest.mark.asyncio
    async def test_an_answer_for_a_different_version_is_refused(self, gateway, ran):
        gateway.versions[2] = _answer(3, "wrong row")
        result = await core.interpreter_core_agent(_payload(versionNumber=2))

        assert result.status == "DEGRADED"
        assert "agent_version_mismatch" in (result.reason or "")
        assert ran == []


class TestImmutableVersionCache:
    @pytest.mark.asyncio
    async def test_a_second_run_of_the_same_pin_reads_the_cache(self, gateway, ran):
        await core.interpreter_core_agent(_payload(versionNumber=2))
        await core.interpreter_core_agent(_payload(versionNumber=2))

        assert len(gateway.version_calls) == 1
        assert [r.version_number for r in ran] == [2, 2]

    @pytest.mark.asyncio
    async def test_the_cache_is_keyed_by_tenant(self, gateway, ran):
        await core.interpreter_core_agent(_payload(versionNumber=2))
        await core.interpreter_core_agent(_payload(tenant=_OTHER_TENANT, versionNumber=2))

        assert [c["tenant_id"] for c in gateway.version_calls] == [_TENANT, _OTHER_TENANT]

    @pytest.mark.asyncio
    async def test_an_answer_carrying_a_credential_is_never_cached(self, gateway, ran):
        gateway.versions[2] = _answer(2, "v2", credential=True)
        await core.interpreter_core_agent(_payload(versionNumber=2))
        await core.interpreter_core_agent(_payload(versionNumber=2))

        assert len(gateway.version_calls) == 2

    def test_the_cache_is_bounded(self):
        agent_version_cache.clear()
        for n in range(agent_version_cache.MAX_ENTRIES + 10):
            agent_version_cache.put(_TENANT, "s", n, {"versionNumber": n})

        assert agent_version_cache.size() == agent_version_cache.MAX_ENTRIES
        assert agent_version_cache.get(_TENANT, "s", 0) is None
        assert agent_version_cache.get(_TENANT, "s", agent_version_cache.MAX_ENTRIES + 9) == {
            "versionNumber": agent_version_cache.MAX_ENTRIES + 9
        }
        agent_version_cache.clear()


def _with_template(answer: dict[str, Any], version_number: int) -> dict[str, Any]:
    """The gateway's per-call `documentTemplate` member (TASK-1036 OD-7 / OD-22): resolved to the
    LATEST approved template version on EVERY call, so it floats while the agent stays pinned."""
    return {
        **answer,
        "documentTemplate": {
            "slug": "discharge-summary",
            "templateId": "tpl-1",
            "versionNumber": version_number,
            "documentTemplateVersionId": f"tpl-1-v{version_number}",
            "compiled": None,
        },
    }


class TestFloatingDocumentTemplateIsNeverCached:
    """TASK-1038 lane E3 (W3 / OD-22) — a pinned agent's answer may be cached, but the document
    template it carries is resolved PER CALL and must reach the very next run after a republish.
    Before: the whole answer — template included — was served from the cache for up to 300 s."""

    @pytest.mark.asyncio
    async def test_a_republished_template_reaches_the_next_pinned_run(self, gateway, ran):
        gateway.versions[2] = _with_template(_answer(2, "v2 prompt (frozen)"), 1)
        await core.interpreter_core_agent(_payload(versionNumber=2))
        # The template is republished; the AGENT version is unchanged.
        gateway.versions[2] = _with_template(_answer(2, "v2 prompt (frozen)"), 2)
        await core.interpreter_core_agent(_payload(versionNumber=2))

        assert len(gateway.version_calls) == 2
        assert [r.version_number for r in ran] == [2, 2]

    def test_the_cache_never_holds_a_per_call_member(self):
        agent_version_cache.clear()
        agent_version_cache.put(_TENANT, "s", 2, _with_template(_answer(2, "p"), 1))

        assert agent_version_cache.get(_TENANT, "s", 2) is None
        agent_version_cache.clear()

    def test_an_answer_without_a_template_is_still_cached(self):
        agent_version_cache.clear()
        agent_version_cache.put(_TENANT, "s", 2, _answer(2, "p"))

        assert agent_version_cache.get(_TENANT, "s", 2) == _answer(2, "p")
        agent_version_cache.clear()
