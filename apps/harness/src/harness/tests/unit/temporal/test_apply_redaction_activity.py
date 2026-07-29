"""Activity-wiring tests for ``apply_redaction`` (TASK-551).

Runs the real activity body in a Temporal ``ActivityEnvironment`` with the
client factories + ``get_settings`` / ``_phi_redactor`` monkeypatched to
deterministic fakes (no model load, no network). Pins:

* deterministic-only transform (no SMR call when there are no semantic rewrites);
* the OPTIONAL SMR semantic-rewrite pass — PHI-egress guarded, idempotency key set,
  JSON schema preserved;
* **fail CLOSED** — a malformed rule OR a failed required SMR rewrite sets
  ``failed_closed=True`` (the workflow turns that into a forced FLAG), never a
  silent unredacted delivery;
* the audit manifest never carries removed PHI plaintext.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.core.config import PhiConfig, Settings
from harness.redaction.engine import RedactionRule
from harness.services.smr_client import SmrGenerationResult, SmrServiceError
from harness.temporal import activities
from harness.temporal.models import ApplyRedactionInput, TrajectoryContext


class _FakeSmr:
    def __init__(self, content: str = '{"S": "rewritten"}') -> None:
        self.kwargs: dict[str, Any] = {}
        self._content = content

    async def generate(self, **kwargs: Any) -> SmrGenerationResult:
        self.kwargs = kwargs
        return SmrGenerationResult(content=self._content, model="m", finish_reason="stop")


class _BoomSmr:
    async def generate(self, **kwargs: Any) -> SmrGenerationResult:
        raise SmrServiceError("smr down", after_send=False)


class _ContractRedactor:
    def __init__(self, *, block: bool = False) -> None:
        self.calls: list[tuple[str, str]] = []
        self._block = block

    def ensure_safe_for_cloud(self, text: str, *, provider: str, settings: Settings) -> str:
        self.calls.append((text, provider))
        if provider not in settings.phi.cloud_egress_providers:
            return text
        if self._block:
            from harness.guards.phi import PhiEgressBlocked

            raise PhiEgressBlocked(provider=provider, reason="contract block")
        return text


def _settings() -> Settings:
    return Settings(
        phi=PhiConfig(enabled=True, fail_closed=True, cloud_egress_providers=["azure", "bedrock"])
    )


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


def _input(**kw: Any) -> ApplyRedactionInput:
    base: dict[str, Any] = {"note_text": "Patient works at Acme Corp.", "rules": []}
    base.update(kw)
    return ApplyRedactionInput(**base)


class TestDeterministicOnly:
    @pytest.mark.asyncio
    async def test_no_smr_call_for_deterministic_rules(self, env, monkeypatch):
        smr = _FakeSmr()
        monkeypatch.setattr(activities, "_smr_client", lambda s: smr)
        monkeypatch.setattr(activities, "get_settings", _settings)
        rule = RedactionRule(id="emp", type="remove", match="literal", pattern="Acme Corp")
        out = await env.run(activities.apply_redaction, _input(rules=[rule]))
        assert "Acme Corp" not in out.text
        assert out.changed is True
        assert out.failed_closed is False
        assert smr.kwargs == {}  # SMR never invoked for a deterministic transform

    @pytest.mark.asyncio
    async def test_empty_rules_is_noop(self, env, monkeypatch):
        monkeypatch.setattr(activities, "get_settings", _settings)
        out = await env.run(activities.apply_redaction, _input(rules=[]))
        assert out.text == "Patient works at Acme Corp."
        assert out.changed is False
        assert out.failed_closed is False


class TestFailClosed:
    @pytest.mark.asyncio
    async def test_malformed_regex_fails_closed(self, env, monkeypatch):
        monkeypatch.setattr(activities, "get_settings", _settings)
        rule = RedactionRule(id="bad", type="remove", match="regex", pattern="(")
        out = await env.run(activities.apply_redaction, _input(rules=[rule]))
        assert out.failed_closed is True
        # original text preserved (nothing silently dropped or partially applied)
        assert out.text == "Patient works at Acme Corp."

    @pytest.mark.asyncio
    async def test_required_smr_rewrite_failure_fails_closed(self, env, monkeypatch):
        monkeypatch.setattr(activities, "_smr_client", lambda s: _BoomSmr())
        monkeypatch.setattr(activities, "get_settings", _settings)
        monkeypatch.setattr(activities, "_phi_redactor", lambda: _ContractRedactor())
        # a rewrite rule with NO replacement ⇒ needs the SMR semantic pass
        rule = RedactionRule(
            id="sem", type="rewrite", match="category", pattern="email", note="soften"
        )
        out = await env.run(activities.apply_redaction, _input(rules=[rule], provider="azure"))
        assert out.failed_closed is True


class TestSmrRewritePass:
    @pytest.mark.asyncio
    async def test_smr_called_with_idempotency_key_and_egress_guard(self, env, monkeypatch):
        smr = _FakeSmr(content='{"S": "clean"}')
        redactor = _ContractRedactor()
        monkeypatch.setattr(activities, "_smr_client", lambda s: smr)
        monkeypatch.setattr(activities, "get_settings", _settings)
        monkeypatch.setattr(activities, "_phi_redactor", lambda: redactor)
        # a semantic (category) rewrite with no replacement drives the SMR pass
        rule = RedactionRule(
            id="sem", type="rewrite", match="category", pattern="email", note="soften"
        )
        out = await env.run(
            activities.apply_redaction,
            _input(
                note_text="mail me a@b.com",
                rules=[rule],
                provider="azure",
                response_format={"type": "json_object"},
            ),
        )
        assert out.failed_closed is False
        # idempotency key present + egress guard consulted for the cloud provider
        assert smr.kwargs.get("idempotency_key")
        assert any(p == "azure" for _, p in redactor.calls)


class TestManifestNoPhi:
    @pytest.mark.asyncio
    async def test_manifest_excludes_removed_text(self, env, monkeypatch):
        monkeypatch.setattr(activities, "get_settings", _settings)
        secret = "Acme Corp"
        rule = RedactionRule(id="emp", type="remove", match="literal", pattern=secret)
        out = await env.run(activities.apply_redaction, _input(rules=[rule]))
        blob = json.dumps(out.manifest.model_dump())
        assert secret not in blob


class _CapturingTraj:
    """Captures ``report_trajectory`` batches for step assertions."""

    def __init__(self) -> None:
        self.steps: list[Any] = []

    async def report_trajectory(self, steps, *, idempotency_key: str | None = None):
        self.steps.extend(steps)
        from harness.services.api_client import TrajectoryReportResponse

        return TrajectoryReportResponse(accepted=len(steps))


def _traj_ctx() -> TrajectoryContext:
    return TrajectoryContext(
        tenant_id="tenant-1",
        consultation_id="consult-1",
        seq=5,
        correlation_id="corr-1",
    )


class TestTrajectory:
    @pytest.mark.asyncio
    async def test_emits_guardrail_step_with_manifest_stats(self, env, monkeypatch):
        """A redaction transform emits ONE GUARDRAIL trajectory step carrying the
        manifest stats (counts + rule ids + failed_closed) — never removed PHI text."""
        cap = _CapturingTraj()
        monkeypatch.setattr(activities, "get_settings", _settings)
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)
        secret = "Acme Corp"
        rule = RedactionRule(id="emp", type="remove", match="literal", pattern=secret)
        out = await env.run(
            activities.apply_redaction, _input(rules=[rule], trajectory=_traj_ctx())
        )
        assert out.changed is True
        assert [(s.step_type, s.name) for s in cap.steps] == [("GUARDRAIL", "apply_redaction")]
        step = cap.steps[0]
        assert step.stats["applied"] is True
        assert step.stats["total_hits"] == 1
        assert step.stats["hits_by_rule"] == {"emp": 1}
        assert step.stats["failed_closed"] is False
        # the step must NOT leak removed PHI plaintext
        assert secret not in json.dumps(step.stats)

    @pytest.mark.asyncio
    async def test_no_rules_emits_no_guardrail_step(self, env, monkeypatch):
        cap = _CapturingTraj()
        monkeypatch.setattr(activities, "get_settings", _settings)
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)
        await env.run(activities.apply_redaction, _input(rules=[], trajectory=_traj_ctx()))
        assert cap.steps == []

    @pytest.mark.asyncio
    async def test_fail_closed_still_emits_guardrail_step(self, env, monkeypatch):
        cap = _CapturingTraj()
        monkeypatch.setattr(activities, "get_settings", _settings)
        monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)
        rule = RedactionRule(id="bad", type="remove", match="regex", pattern="(")
        out = await env.run(
            activities.apply_redaction, _input(rules=[rule], trajectory=_traj_ctx())
        )
        assert out.failed_closed is True
        assert [(s.step_type, s.name) for s in cap.steps] == [("GUARDRAIL", "apply_redaction")]
        assert cap.steps[0].stats["failed_closed"] is True
