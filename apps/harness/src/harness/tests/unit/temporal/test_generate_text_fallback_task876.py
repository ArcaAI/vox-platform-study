"""TASK-876 — the DURABLE documentation workflow falls back along the gateway-resolved chain.

Before this, platform HA was a realtime-only capability: the live loop and the `core.agent`
activity walked the resolved chain, while `HarnessDocWorkflow` received only
`textProvider`/`textModel` and failed the whole run on a Text outage.

The seam is the one the owner named:

* the worker's policy read (`GET /internal/harness/policy`) ships the resolved `textFallback`
  block — the SAME shape `/internal/agents/resolve` carries;
* `fetch_policy` maps it onto `HarnessPolicy.text_fallback` (raw, a snapshot);
* the workflow snapshots it into `GenerateInput.text_fallback` — plain activity input, read from
  deterministic workflow state, so the workflow body performs no I/O and makes no selection;
* the `generate` activity walks it with the SAME walker `core.agent` uses
  (`interpreter/nodes/_text_fallback.chain_candidates` + `ActivityBudget`).

Pinned here:

1. The primary serves alone when it works, and its call is byte-identical to pre-876.
2. A `TextServiceError` on the primary switches to the next resolved candidate, on ITS provider
   and ITS provider-native model, with its OWN idempotency key (sharing the primary's would make
   Text replay the failed generation).
3. `autoSwitch` off (already funding-gated by the gateway) ⇒ no switch at all.
4. The PHI egress guard is re-screened PER CANDIDATE — a local primary can lead to a cloud
   fallback — and a blocked FALLBACK is dropped rather than failing the run, while a blocked
   PRIMARY still fails it (the pre-876 contract).
5. An exhausted activity budget fails NON-RETRYABLY: a retryable failure is what makes Temporal
   re-run the activity from the primary and re-bill a generation that already completed.
6. `HarnessPolicy.from_api` carries the block, and an answer without it reads as "primary alone".
"""

from __future__ import annotations

import dataclasses
import datetime
from typing import Any

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from harness.guards.phi import PhiEgressBlocked
from harness.services.api_client import TrajectoryReportResponse
from harness.services.text_client import TextGenerationResult, TextServiceError
from harness.temporal import activities
from harness.temporal.models import GenerateInput, HarnessPolicy, TrajectoryContext

_TENANT = "11111111-1111-1111-1111-111111111111"


def _candidate(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "kind": "platform-default",
        "agent": {
            "slug": "platform-summarization",
            "versionId": "p1",
            "versionNumber": 1,
            "tenantId": "00000000-0000-0000-0000-000000000000",
            "source": "platform-default",
        },
        "modelSlug": "lms-gemma-4-e2b-it-qat",
        "provider": "lm-studio",
        "model": "gemma-4-e2b-it-qat",
        "parameters": {},
        "fundingTier": "platform",
    }
    base.update(over)
    return base


def _block(*, auto_switch: bool = True, chain: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "autoSwitch": auto_switch,
        "chain": [_candidate()] if chain is None else chain,
    }


class _CapTraj:
    def __init__(self) -> None:
        self.steps: list[Any] = []

    async def report_trajectory(self, steps, *, idempotency_key: str | None = None):
        self.steps.extend(steps)
        return TrajectoryReportResponse(accepted=len(steps))


class _Text:
    """Text double: fails the providers in ``failing``, records every call."""

    def __init__(self, failing: set[str], after_send: bool = False) -> None:
        self.failing = failing
        self.after_send = after_send
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(kwargs)
        if kwargs.get("provider") in self.failing:
            raise TextServiceError(f"{kwargs['provider']} down", after_send=self.after_send)
        return TextGenerationResult(
            content="DRAFT",
            model=kwargs.get("model") or "",
            provider=kwargs.get("provider") or "",
            finish_reason="stop",
        )


@pytest.fixture
def env() -> ActivityEnvironment:
    """`ActivityEnvironment` declares a 1-SECOND `start_to_close_timeout`, which the real
    `ActivityBudget` correctly reads as "no room for another 120s call". Give the walk a realistic
    budget here; the budget guard itself is unit-tested in
    `interpreter/test_core_agent_text_fallback_task876.py::TestActivityBudget`."""
    environment = ActivityEnvironment()
    environment.info = dataclasses.replace(
        environment.info, start_to_close_timeout=datetime.timedelta(minutes=30)
    )
    return environment


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch):
    def _install(text: _Text) -> _Text:
        monkeypatch.setattr(activities, "_text_client", lambda _s: text)
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: _CapTraj())
        return text

    return _install


def _input(**over: Any) -> GenerateInput:
    payload: dict[str, Any] = {
        "tenant_id": _TENANT,
        "prompt": "Write the SOAP note.",
        "provider": "azure-openai",
        "model": "gpt-5.4-mini",
        "trajectory": TrajectoryContext(tenant_id=_TENANT, consultation_id="c-1", seq=1),
    }
    payload.update(over)
    return GenerateInput(**payload)


class TestPolicyCarriesTheChain:
    def test_from_api_reads_the_block_and_tolerates_its_absence(self) -> None:
        policy = HarnessPolicy.from_api({"textProvider": "lm-studio", "textFallback": _block()})
        assert policy.text_fallback is not None
        assert policy.text_fallback["chain"][0]["provider"] == "lm-studio"
        assert HarnessPolicy.from_api({}).text_fallback is None
        assert HarnessPolicy.from_api({"textFallback": "nope"}).text_fallback is None

    def test_generate_input_defaults_to_no_chain_so_an_old_history_replays(self) -> None:
        assert GenerateInput(prompt="p").text_fallback is None


class TestGenerateWalksTheChain:
    @pytest.mark.asyncio
    async def test_the_primary_serves_alone_when_it_works(self, env, wired) -> None:
        text = wired(_Text(failing=set()))

        await env.run(activities.generate, _input(text_fallback=_block()))

        assert [c["provider"] for c in text.calls] == ["azure-openai"]

    @pytest.mark.asyncio
    async def test_switches_to_the_resolved_candidate_with_its_own_idempotency_key(
        self, env, wired
    ) -> None:
        text = wired(_Text(failing={"azure-openai"}))

        result = await env.run(activities.generate, _input(text_fallback=_block()))

        assert result.content == "DRAFT"
        assert [c["provider"] for c in text.calls] == ["azure-openai", "lm-studio"]
        assert text.calls[1]["model"] == "gemma-4-e2b-it-qat"
        # A fallback is a DIFFERENT generation inside the same activity: sharing the primary's
        # key would make Text replay the primary's (failed) result instead of generating.
        assert text.calls[0]["idempotency_key"] != text.calls[1]["idempotency_key"]

    @pytest.mark.asyncio
    async def test_auto_switch_off_never_switches(self, env, wired) -> None:
        text = wired(_Text(failing={"azure-openai"}))

        with pytest.raises(TextServiceError):
            await env.run(activities.generate, _input(text_fallback=_block(auto_switch=False)))

        assert len(text.calls) == 1

    @pytest.mark.asyncio
    async def test_no_chain_at_all_is_byte_identical_to_pre_876(self, env, wired) -> None:
        text = wired(_Text(failing={"azure-openai"}))

        with pytest.raises(TextServiceError):
            await env.run(activities.generate, _input())

        assert len(text.calls) == 1

    @pytest.mark.asyncio
    async def test_an_after_send_loss_on_the_LAST_candidate_stays_non_retryable(
        self, env, wired
    ) -> None:
        wired(_Text(failing={"azure-openai", "lm-studio"}, after_send=True))

        with pytest.raises(ApplicationError) as excinfo:
            await env.run(activities.generate, _input(text_fallback=_block()))

        assert excinfo.value.type == "TextResponseLost"
        assert excinfo.value.non_retryable is True


class TestGuardsOnTheWalk:
    @pytest.mark.asyncio
    async def test_phi_egress_is_re_screened_per_candidate_and_a_blocked_fallback_is_dropped(
        self, env, wired, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A local primary can lead to a CLOUD fallback, so one screening of the primary's
        provider would be no screening at all. A fallback that may not legally receive the
        prompt is simply not a usable candidate."""
        text = wired(_Text(failing={"azure-openai"}))
        seen: list[str | None] = []

        def _guard(value, *, provider=None, **_kwargs):
            seen.append(provider)
            if provider == "lm-studio":
                raise PhiEgressBlocked(provider="lm-studio", reason="phi_detected")
            return value

        monkeypatch.setattr(activities, "ensure_egress_safe", _guard)

        with pytest.raises(TextServiceError):
            await env.run(activities.generate, _input(text_fallback=_block()))

        # Screened for BOTH providers; only the primary was ever dispatched, and the blocked
        # fallback failed the run with the PRIMARY's error, not a PHI raise.
        assert seen == ["azure-openai", "lm-studio"]
        assert [c["provider"] for c in text.calls] == ["azure-openai"]

    @pytest.mark.asyncio
    async def test_a_blocked_PRIMARY_still_fails_the_run(
        self, env, wired, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        wired(_Text(failing=set()))

        def _guard(_value, *, provider=None, **_kwargs):
            raise PhiEgressBlocked(provider=provider or "", reason="phi_detected")

        monkeypatch.setattr(activities, "ensure_egress_safe", _guard)

        with pytest.raises(PhiEgressBlocked):
            await env.run(activities.generate, _input(text_fallback=_block()))

    @pytest.mark.asyncio
    async def test_an_exhausted_budget_fails_NON_retryably(
        self, env, wired, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A retryable failure is exactly what makes Temporal re-run this activity from the
        primary and re-bill a generation that already completed."""
        text = wired(_Text(failing={"azure-openai"}))

        class _Spent:
            @classmethod
            def for_activity(cls, _per_call: float) -> _Spent:
                return cls()

            @property
            def remaining_seconds(self) -> float:
                return 0.0

            def allows_another(self) -> bool:
                return False

        monkeypatch.setattr(activities, "ActivityBudget", _Spent)

        with pytest.raises(ApplicationError) as excinfo:
            await env.run(activities.generate, _input(text_fallback=_block()))

        assert excinfo.value.type == "TextBudgetExhausted"
        assert excinfo.value.non_retryable is True
        assert len(text.calls) == 1
