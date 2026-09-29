"""TASK-1016 — the loop activities that call ``apps/text`` must name a provider AND a model.

``apps/text`` has no default model (`/generate` answers 422 without ``model``) and, since
TASK-1012, no default provider either. ``plan_reasoning``, ``run_specialist`` and
``vision_extract_text`` sent neither, so every call they made was refused.

Selection under the agent architecture:

* ``plan_reasoning`` — the consultation's PRIMARY agent (``PlanLoopInput.planner_agent_slug``),
  resolved through the ONE agent resolution (``GET /internal/agents/resolve``), whose
  ``textPrimary`` names the provider + provider-native model + one-hop credential.
* ``run_specialist`` — the specialist's OWN agent (``SpecialistAnalysisInput.agent_slug``).
* ``vision_extract_text`` — no selection plane exists (no vision ``AgentTask``; the
  ``vlm.extract`` routing key has no harness-reachable resolve and deliberately no SYSTEM
  default), so it fails CLOSED with a named reason and never calls ``text``.

Every unresolved selection fails closed with a NAMED reason; none is substituted.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from harness.core.config import PhiConfig, Settings
from harness.guards.phi import PhiEgressBlocked
from harness.services.api_client import ApiServiceError
from harness.services.text_client import TextGenerationResult
from harness.temporal import activities
from harness.temporal.models import (
    DeriveContextInput,
    LoopAgentSpec,
    PlanLoopInput,
    ScopedContextItem,
    SpecialistAnalysisInput,
)

_TENANT = "11111111-1111-1111-1111-111111111111"


def _resolved_text_agent(slug: str, *, provider: str = "lm-studio") -> dict[str, Any]:
    """A TEXT_GENERATION ``ResolvedAgent`` wire answer carrying TASK-876's ``textPrimary``."""
    return {
        "agentId": f"agent-{slug}",
        "agentVersionId": f"agent-{slug}-v1",
        "slug": slug,
        "versionNumber": 1,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "tenant",
        "model": {"slug": f"{slug}-model", "provider": provider, "sourceUri": f"{slug}/native"},
        "textPrimary": {
            "kind": "primary",
            "agent": {"slug": slug, "versionId": f"agent-{slug}-v1", "versionNumber": 1},
            "modelSlug": f"{slug}-model",
            "provider": provider,
            "model": f"{slug}/native",
            "fundingTier": "platform",
            "providerOverride": {"apiKey": "one-hop"} if provider == "openai" else None,
        },
        "textFallback": {"autoSwitch": False, "chain": []},
    }


class _StubApi:
    def __init__(
        self,
        answers: dict[str, dict[str, Any]] | None = None,
        *,
        policy: dict[str, Any] | None = None,
        fail: bool = False,
    ) -> None:
        self.answers = answers or {}
        self.policy = policy or {"phiEnabled": False, "phiFailClosed": True}
        self.fail = fail
        self.resolved: list[str] = []

    async def resolve_agent(self, *, slug: str, tenant_id: str) -> dict[str, Any]:
        self.resolved.append(slug)
        if self.fail or slug not in self.answers:
            raise ApiServiceError("GET /internal/agents/resolve -> 404")
        return self.answers[slug]

    async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return self.policy


class _FakeText:
    def __init__(self, content: str = '{"dispatch": [], "rationale": "ok"}') -> None:
        self.calls: list[dict[str, Any]] = []
        self.content = content

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(kwargs)
        return TextGenerationResult(content=self.content, model=kwargs.get("model") or "")


class _BlockingRedactor:
    def ensure_safe_for_cloud(self, text: str, *, provider: str, settings: Settings) -> str:
        if provider in settings.phi.local_providers:
            return text
        raise PhiEgressBlocked(provider=provider, reason="contract block")


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


@pytest.fixture
def text(monkeypatch: pytest.MonkeyPatch) -> _FakeText:
    fake = _FakeText()
    monkeypatch.setattr(activities, "_text_client", lambda _s: fake)
    return fake


def _use_api(monkeypatch: pytest.MonkeyPatch, api: _StubApi) -> _StubApi:
    monkeypatch.setattr(activities, "_api_client", lambda _s: api)
    return api


def _plan_input(**overrides: Any) -> PlanLoopInput:
    base: dict[str, Any] = {
        "consultation_id": "c-1",
        "tenant_id": _TENANT,
        "trigger_kinds": ["vitals"],
        "candidates": [
            LoopAgentSpec(agent_id="a-cardio", slug="cardiology", subscribed_kinds=["vitals"])
        ],
        "planner_agent_slug": "primary",
    }
    base.update(overrides)
    return PlanLoopInput(**base)


def _specialist_input(**overrides: Any) -> SpecialistAnalysisInput:
    base: dict[str, Any] = {
        "consultation_id": "c-1",
        "tenant_id": _TENANT,
        "plan_id": "c-1:0",
        "agent_id": "a-cardio",
        "agent_slug": "cardiology",
        "kind_key": "vitals",
        "write_scope": ["cardiac_risk"],
        "context": [ScopedContextItem(context_item_id="i-1", kind_key="vitals", text="BP 120/80")],
    }
    base.update(overrides)
    return SpecialistAnalysisInput(**base)


class TestPlannerSelection:
    @pytest.mark.asyncio
    async def test_the_planner_names_the_primary_agents_provider_and_model(
        self, env: ActivityEnvironment, text: _FakeText, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        api = _use_api(monkeypatch, _StubApi({"primary": _resolved_text_agent("primary")}))

        decision = await env.run(activities.plan_reasoning, _plan_input())

        assert api.resolved == ["primary"]
        assert len(text.calls) == 1
        assert text.calls[0]["provider"] == "lm-studio"
        assert text.calls[0]["model"] == "primary/native"
        assert decision.degraded is False

    @pytest.mark.asyncio
    async def test_no_planner_agent_fails_closed_with_a_named_reason(
        self, env: ActivityEnvironment, text: _FakeText, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _use_api(monkeypatch, _StubApi())

        decision = await env.run(activities.plan_reasoning, _plan_input(planner_agent_slug=None))

        assert text.calls == []
        assert decision.degraded is True
        assert decision.dispatch == []
        assert decision.rationale.startswith("planner_agent_unresolved")

    @pytest.mark.asyncio
    async def test_an_unresolvable_planner_agent_fails_closed(
        self, env: ActivityEnvironment, text: _FakeText, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _use_api(monkeypatch, _StubApi(fail=True))

        decision = await env.run(activities.plan_reasoning, _plan_input())

        assert text.calls == []
        assert decision.degraded is True
        assert decision.rationale.startswith("planner_agent_unresolved")

    @pytest.mark.asyncio
    async def test_a_cloud_planner_is_screened_by_the_phi_egress_guard(
        self, env: ActivityEnvironment, text: _FakeText, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A resolved CLOUD agent must pass the same fail-closed PHI guard ``generate`` uses."""
        _use_api(
            monkeypatch,
            _StubApi(
                {"primary": _resolved_text_agent("primary", provider="openai")},
                policy={"phiEnabled": True, "phiFailClosed": True},
            ),
        )
        monkeypatch.setattr(activities, "get_settings", lambda: Settings(phi=PhiConfig()))
        monkeypatch.setattr(activities, "_phi_redactor", lambda: _BlockingRedactor())

        decision = await env.run(activities.plan_reasoning, _plan_input())

        assert text.calls == []
        assert decision.degraded is True
        assert decision.rationale.startswith("phi_egress_blocked")


class TestSpecialistSelection:
    @pytest.mark.asyncio
    async def test_a_specialist_runs_on_its_own_agents_provider_and_model(
        self, env: ActivityEnvironment, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake = _FakeText(content='{"findings": []}')
        monkeypatch.setattr(activities, "_text_client", lambda _s: fake)
        api = _use_api(
            monkeypatch,
            _StubApi({"cardiology": _resolved_text_agent("cardiology", provider="openai")}),
        )

        await env.run(activities.run_specialist, _specialist_input())

        assert api.resolved == ["cardiology"]
        assert len(fake.calls) == 1
        assert fake.calls[0]["provider"] == "openai"
        assert fake.calls[0]["model"] == "cardiology/native"
        # TASK-958 G3 — the candidate's own one-hop credential rides along.
        assert fake.calls[0]["provider_override"] == {"apiKey": "one-hop"}

    @pytest.mark.asyncio
    async def test_a_specialist_without_an_agent_fails_closed_non_retryably(
        self, env: ActivityEnvironment, text: _FakeText, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _use_api(monkeypatch, _StubApi())

        with pytest.raises(ApplicationError) as exc_info:
            await env.run(activities.run_specialist, _specialist_input(agent_slug=None))

        assert text.calls == []
        assert exc_info.value.type == "specialist_agent_unresolved"
        assert exc_info.value.non_retryable is True


class TestVisionSelection:
    @pytest.mark.asyncio
    async def test_vision_extract_fails_closed_without_calling_text(
        self, env: ActivityEnvironment, text: _FakeText
    ) -> None:
        result = await env.run(
            activities.vision_extract_text,
            DeriveContextInput(
                consultation_id="c-1",
                tenant_id=_TENANT,
                action="vision.extract_text",
                context_item_id="img-1",
                kind_key="photo",
                text="caption",
            ),
        )

        assert text.calls == []
        assert result.derived is False
        assert result.reason == "vision_model_unselected"
