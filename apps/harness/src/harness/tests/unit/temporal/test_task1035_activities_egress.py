"""TASK-1035 — the durable activities' `/generate` calls under the new egress contract.

* `generate`, `apply_redaction` (semantic rewrite), `plan_reasoning` and `run_specialist` no
  longer run the Presidio egress redactor: the prompt reaches `apps/text` verbatim and text
  pseudonymizes / fails closed.
* A candidate stamps `provider_locality` ONLY from its own deployment kind (the durable primary,
  resolved by name from the policy snapshot, carries none ⇒ no stamp).
* The response `egress` object lands on the `generate` LLM_CALL step as counts only.
* What stays on Presidio — the MCP tool-arg screen and the DIRECT judge hop — keeps its own local
  set as code, not the retired `HARNESS_PHI_LOCAL_PROVIDERS` env.
"""

from __future__ import annotations

import dataclasses
import datetime
from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.core.config import Settings
from harness.services.api_client import TrajectoryReportResponse
from harness.services.text_client import TextGenerationResult
from harness.temporal import activities
from harness.temporal.models import (
    ApplyRedactionInput,
    GenerateInput,
    PlanLoopInput,
    TrajectoryContext,
)

_TENANT = "11111111-1111-1111-1111-111111111111"
_EGRESS = {
    "locality": "cloud",
    "detected": {"person": 1},
    "redacted": 1,
    "restored": 1,
    "images_unredacted": 0,
    "pii_leak_blocked": False,
}


class _RefusingRedactor:
    """Any call means a `/generate` site still runs the retired Presidio egress pass."""

    def ensure_safe_for_cloud(self, *_args: Any, **_kwargs: Any) -> str:
        raise AssertionError("the Presidio egress redactor must not run on a /generate call")

    def redact(self, *_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("the Presidio egress redactor must not run on a /generate call")


class _Text:
    def __init__(self, content: str = "DRAFT", egress: dict[str, Any] | None = None) -> None:
        self.content = content
        self.egress = egress
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(kwargs)
        return TextGenerationResult(
            content=self.content,
            model=kwargs.get("model") or "",
            provider=kwargs.get("provider") or "",
            finish_reason="stop",
            egress=self.egress,
        )


class _CapTraj:
    def __init__(self) -> None:
        self.steps: list[Any] = []

    async def report_trajectory(self, steps, *, idempotency_key: str | None = None):
        self.steps.extend(steps)
        return TrajectoryReportResponse(accepted=len(steps))


@pytest.fixture
def env() -> ActivityEnvironment:
    environment = ActivityEnvironment()
    environment.info = dataclasses.replace(
        environment.info, start_to_close_timeout=datetime.timedelta(minutes=30)
    )
    return environment


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch):
    traj = _CapTraj()

    def _install(text: _Text) -> tuple[_Text, _CapTraj]:
        monkeypatch.setattr(activities, "_text_client", lambda _s: text)
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: traj)
        monkeypatch.setattr(activities, "_phi_redactor", lambda: _RefusingRedactor())
        return text, traj

    return _install


def _candidate(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "kind": "platform-default",
        "agent": {"slug": "p", "versionId": "p1", "versionNumber": 1, "source": "platform"},
        "modelSlug": "lms-gemma",
        "provider": "lm-studio",
        "model": "gemma",
        "parameters": {},
        "fundingTier": "platform",
    }
    base.update(over)
    return base


def test_activities_no_longer_carry_the_generate_egress_helpers() -> None:
    assert not hasattr(activities, "ensure_egress_safe")
    assert not hasattr(activities, "_loop_egress_safe")


def test_the_phi_env_subconfig_is_gone() -> None:
    assert "phi" not in Settings.model_fields


class TestGenerate:
    @pytest.mark.asyncio
    async def test_cloud_prompt_reaches_text_verbatim(self, env, wired) -> None:
        text, _ = wired(_Text())

        await env.run(
            activities.generate,
            GenerateInput(
                tenant_id=_TENANT,
                prompt="John Smith has HTN",
                system_prompt="Sys John Smith",
                provider="azure-openai",
                model="gpt",
            ),
        )

        assert text.calls[0]["prompt"] == "John Smith has HTN"
        assert text.calls[0]["system_prompt"] == "Sys John Smith"
        # The durable primary is resolved by NAME — no deployment kind, so no stamp.
        assert text.calls[0].get("provider_locality") is None

    @pytest.mark.asyncio
    async def test_a_fallback_stamps_its_own_deployment_kind(self, env, wired) -> None:
        class _FailPrimary(_Text):
            async def generate(self, **kwargs: Any) -> TextGenerationResult:
                if kwargs["provider"] == "azure-openai":
                    self.calls.append(kwargs)
                    from harness.services.text_client import TextServiceError

                    raise TextServiceError("down")
                return await super().generate(**kwargs)

        text, _ = wired(_FailPrimary())

        await env.run(
            activities.generate,
            GenerateInput(
                tenant_id=_TENANT,
                prompt="p",
                provider="azure-openai",
                model="gpt",
                text_fallback={
                    "autoSwitch": True,
                    "chain": [_candidate(deploymentKind="SELF_HOSTED")],
                },
            ),
        )

        assert [c["provider"] for c in text.calls] == ["azure-openai", "lm-studio"]
        assert text.calls[1]["provider_locality"] == {"lm-studio": "local"}

    @pytest.mark.asyncio
    async def test_egress_counts_land_on_the_llm_call_step(self, env, wired) -> None:
        _text, traj = wired(_Text(egress=_EGRESS))

        await env.run(
            activities.generate,
            GenerateInput(
                tenant_id=_TENANT,
                prompt="p",
                provider="azure-openai",
                model="gpt",
                trajectory=TrajectoryContext(tenant_id=_TENANT, consultation_id="c-1"),
            ),
        )

        llm_steps = [s for s in traj.steps if getattr(s, "step_type", None) == "LLM_CALL"]
        assert llm_steps, traj.steps
        assert llm_steps[0].stats["egress"] == _EGRESS


class TestApplyRedactionSemanticRewrite:
    @pytest.mark.asyncio
    async def test_rewrite_prompt_reaches_text_verbatim(self, env, wired) -> None:
        text, _ = wired(_Text(content="rewritten"))

        result = await env.run(
            activities.apply_redaction,
            ApplyRedactionInput(
                tenant_id=_TENANT,
                note_text="John Smith has HTN",
                # A `rewrite` rule with no literal replacement ⇒ the Text semantic pass.
                rules=[{"id": "r1", "type": "rewrite", "match": "category", "pattern": "names"}],
                provider="azure-openai",
                model="gpt",
            ),
        )

        assert result.failed_closed is False
        assert "John Smith has HTN" in text.calls[0]["prompt"]


class TestLoopActivities:
    @pytest.mark.asyncio
    async def test_plan_reasoning_stamps_the_agent_deployment_kind(
        self, env, wired, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        text, _ = wired(_Text(content='{"dispatch": [], "rationale": "none"}'))

        class _Api:
            async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
                return {
                    "textPrimary": _candidate(
                        kind="primary", provider="azure", model="gpt", deploymentKind="BYOK"
                    )
                }

            async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
                return {"phiEnabled": True, "phiFailClosed": True}

        monkeypatch.setattr(activities, "_api_client", lambda _s: _Api())

        await env.run(
            activities.plan_reasoning,
            PlanLoopInput(
                tenant_id=_TENANT,
                consultation_id="c-1",
                plan_seq=1,
                planner_agent_slug="primary-agent",
                candidates=[
                    {
                        "agent_id": "a-1",
                        "slug": "cardio",
                        "subscribed_kinds": ["vitals"],
                        "write_scope": ["finding"],
                    }
                ],
                reasoning=False,
                trigger_kinds=["vitals"],
            ),
        )

        assert text.calls[0]["provider_locality"] == {"azure-openai": "cloud"}
