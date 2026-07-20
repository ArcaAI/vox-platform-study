"""Activity-wiring tests for the PHI egress guard (TASK-357).

RED-first: written before ``generate`` / ``run_inferential_sensors`` are wired to
the :mod:`harness.guards.phi.egress` chokepoint. Each test runs the *real*
activity body in a Temporal ``ActivityEnvironment`` with the client factories +
``get_settings`` / ``get_runtime_judge_config`` / ``_phi_redactor`` monkeypatched
to deterministic fakes (no model load, no network), and asserts the cloud-bound
call site is gated:

* ``generate`` — T1 cloud+block (SMR NOT called), T2 cloud (SMR gets CLEANED text),
  T3 local (SMR gets ORIGINAL), T4 ``phi_enabled=False`` (bypass), T7 block logs.
* ``run_inferential_sensors`` — T6 cloud safety (Granite gets REDACTED note),
  cloud block (whole pass degrades, Granite NOT called), local (no redaction).
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.core.config import PhiConfig, SafetyGuardConfig, Settings
from harness.eval.config import JudgeConfig, JudgeProvider
from harness.guards.phi import PhiEgressBlocked
from harness.services.smr_client import SmrGenerationResult
from harness.temporal import activities
from harness.temporal.models import GenerateInput, RunInferentialSensorsInput


class _FakeSmr:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}

    async def generate(self, **kwargs: Any) -> SmrGenerationResult:
        self.kwargs = kwargs
        return SmrGenerationResult(content="DRAFT", model="m", finish_reason="stop")


class _StubJudge:
    model = "stub-judge"

    def __init__(self) -> None:
        self.calls: list[list[dict[str, str]]] = []

    async def complete(self, messages: list[dict[str, str]], **kwargs: Any) -> str:
        self.calls.append(messages)
        return '{"supported": true}'


class _FakeGranite:
    def __init__(self, *, dimensions: dict[str, bool] | None = None) -> None:
        self.model = "granite-fake"
        self._dimensions = dimensions or {}
        self.screened: list[str] = []

    async def screen(self, text: str) -> dict[str, bool]:
        self.screened.append(text)
        return dict(self._dimensions)


class _ContractRedactor:
    """Mirrors ``PhiRedactor.ensure_safe_for_cloud`` (local pass-through; cloud
    transform/block) without loading a model — records every call."""

    def __init__(self, *, transform: Any = None, block: bool = False) -> None:
        self.calls: list[tuple[str, str]] = []
        self._transform = transform
        self._block = block

    def ensure_safe_for_cloud(self, text: str, *, provider: str, settings: Settings) -> str:
        self.calls.append((text, provider))
        if provider not in settings.phi.cloud_egress_providers:
            return text
        if self._block:
            raise PhiEgressBlocked(provider=provider, reason="contract block")
        return self._transform(text) if self._transform is not None else text


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


def _gen_settings(*, fail_closed: bool = True) -> Settings:
    return Settings(
        phi=PhiConfig(
            enabled=True, fail_closed=fail_closed, cloud_egress_providers=["azure", "bedrock"]
        )
    )


def _infer_settings(*, safety_provider: str = "lm-studio") -> Settings:
    return Settings(
        safety=SafetyGuardConfig(provider=safety_provider),
        phi=PhiConfig(enabled=True, fail_closed=True, cloud_egress_providers=["azure", "bedrock"]),
    )


def _infer_input(**kw: Any) -> RunInferentialSensorsInput:
    base: dict[str, Any] = {
        "note_text": "Patient John Smith stable.",
        "transcript_text": "John Smith has hypertension.",
        # SYSTEM harness.judge selection (a LOCAL judge here ⇒ the egress
        # guard redacts only for the cloud SAFETY provider, never for the judge).
        "judge_provider": "openai_compat",
        "judge_model": "stub-judge",
        "citations_map": {"claims": []},
    }
    base.update(kw)
    return RunInferentialSensorsInput(**base)


class TestGeneratePhiEgress:
    @pytest.mark.asyncio
    async def test_cloud_phi_blocks_generate_and_skips_smr(self, env, monkeypatch):
        # T1 (AC-1, AC-2): cloud + fail-closed block ⇒ SMR client never called.
        smr = _FakeSmr()
        monkeypatch.setattr(activities, "_smr_client", lambda s: smr)
        monkeypatch.setattr(activities, "get_settings", _gen_settings)
        monkeypatch.setattr(activities, "_phi_redactor", lambda: _ContractRedactor(block=True))

        with pytest.raises(PhiEgressBlocked):
            await env.run(
                activities.generate,
                GenerateInput(prompt="John Smith has HTN", provider="azure"),
            )
        assert smr.kwargs == {}, "SMR must not be called when egress is blocked"

    @pytest.mark.asyncio
    async def test_cloud_calls_smr_with_cleaned_text(self, env, monkeypatch):
        # T2 (AC-1): cloud egress ⇒ SMR receives the redacted prompt + system prompt.
        smr = _FakeSmr()
        monkeypatch.setattr(activities, "_smr_client", lambda s: smr)
        monkeypatch.setattr(activities, "get_settings", _gen_settings)
        monkeypatch.setattr(
            activities,
            "_phi_redactor",
            lambda: _ContractRedactor(transform=lambda t: t.replace("John Smith", "<PERSON>")),
        )

        await env.run(
            activities.generate,
            GenerateInput(
                prompt="John Smith has HTN", system_prompt="Sys John Smith", provider="azure"
            ),
        )
        assert smr.kwargs["prompt"] == "<PERSON> has HTN"
        assert smr.kwargs["system_prompt"] == "Sys <PERSON>"

    @pytest.mark.asyncio
    async def test_local_provider_passthrough_to_smr(self, env, monkeypatch):
        # T3 (AC-3): a local provider ⇒ SMR receives the ORIGINAL text (no redaction).
        smr = _FakeSmr()
        monkeypatch.setattr(activities, "_smr_client", lambda s: smr)
        monkeypatch.setattr(activities, "get_settings", _gen_settings)
        monkeypatch.setattr(
            activities,
            "_phi_redactor",
            lambda: _ContractRedactor(transform=lambda t: "SHOULD_NOT_REDACT"),
        )

        await env.run(
            activities.generate,
            GenerateInput(prompt="John Smith has HTN", provider="lm-studio"),
        )
        assert smr.kwargs["prompt"] == "John Smith has HTN"

    @pytest.mark.asyncio
    async def test_phi_disabled_bypasses_guard(self, env, monkeypatch):
        # T4 (AC-4): phi_enabled=False ⇒ egress allowed unredacted; redactor untouched.
        smr = _FakeSmr()
        redactor = _ContractRedactor(block=True)  # would block if ever consulted
        monkeypatch.setattr(activities, "_smr_client", lambda s: smr)
        monkeypatch.setattr(activities, "get_settings", _gen_settings)
        monkeypatch.setattr(activities, "_phi_redactor", lambda: redactor)

        await env.run(
            activities.generate,
            GenerateInput(prompt="John Smith has HTN", provider="azure", phi_enabled=False),
        )
        assert smr.kwargs["prompt"] == "John Smith has HTN"
        assert redactor.calls == []

    @pytest.mark.asyncio
    async def test_block_emits_structured_log(self, env, monkeypatch, caplog):
        # T7 (AC-5): a block emits a structured ``harness.phi_egress.blocked`` warning.
        smr = _FakeSmr()
        monkeypatch.setattr(activities, "_smr_client", lambda s: smr)
        monkeypatch.setattr(activities, "get_settings", _gen_settings)
        monkeypatch.setattr(activities, "_phi_redactor", lambda: _ContractRedactor(block=True))

        with caplog.at_level(logging.WARNING):
            with pytest.raises(PhiEgressBlocked):
                await env.run(
                    activities.generate,
                    GenerateInput(prompt="John Smith has HTN", provider="azure"),
                )
        assert any("phi_egress" in r.getMessage() for r in caplog.records)


class TestRunInferentialSensorsPhiEgress:
    @pytest.mark.asyncio
    async def test_cloud_safety_redacts_note_before_granite(self, env, monkeypatch):
        # T6 (AC-1): cloud Granite ⇒ the note is redacted before the safety screen.
        judge = _StubJudge()
        granite = _FakeGranite(dimensions={"harm": False})
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(activities, "_granite_client", lambda s: granite)
        monkeypatch.setattr(
            activities, "get_settings", lambda: _infer_settings(safety_provider="azure")
        )
        monkeypatch.setattr(
            activities,
            "get_runtime_judge_config",
            lambda: JudgeConfig(provider=JudgeProvider.OPENAI_COMPAT),
        )
        monkeypatch.setattr(
            activities,
            "_phi_redactor",
            lambda: _ContractRedactor(transform=lambda t: t.replace("John Smith", "<PERSON>")),
        )

        result = await env.run(
            activities.run_inferential_sensors, _infer_input(note_text="John Smith stable")
        )

        assert granite.screened == ["<PERSON> stable"]
        assert "John Smith" not in granite.screened[0]
        assert result.degraded is False

    @pytest.mark.asyncio
    async def test_cloud_block_degrades_whole_pass_and_skips_granite(
        self, env, monkeypatch, caplog
    ):
        # T6/T7 (AC-2, AC-5): a cloud fail-closed block degrades the pass (reduced
        # assurance) with a PHI reason, never egresses, and logs the block.
        granite = _FakeGranite(dimensions={"harm": False})
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: _StubJudge())
        monkeypatch.setattr(activities, "_granite_client", lambda s: granite)
        monkeypatch.setattr(
            activities, "get_settings", lambda: _infer_settings(safety_provider="azure")
        )
        monkeypatch.setattr(
            activities,
            "get_runtime_judge_config",
            lambda: JudgeConfig(provider=JudgeProvider.OPENAI_COMPAT),
        )
        monkeypatch.setattr(activities, "_phi_redactor", lambda: _ContractRedactor(block=True))

        with caplog.at_level(logging.WARNING):
            result = await env.run(
                activities.run_inferential_sensors, _infer_input(note_text="John Smith")
            )

        assert result.degraded is True
        gd = result.guardrail_decisions
        assert gd["groundedness"]["decision"] == "DEGRADED"
        assert gd["safety"]["decision"] == "DEGRADED"
        assert "phi" in (gd["groundedness"]["reason"] or "").lower()
        assert granite.screened == [], "Granite must not be screened when egress is blocked"
        assert any("phi_egress" in r.getMessage() for r in caplog.records)

    @pytest.mark.asyncio
    async def test_local_providers_no_redaction(self, env, monkeypatch):
        # AC-3: all-local inferential pass ⇒ Granite gets the ORIGINAL note unchanged.
        judge = _StubJudge()
        granite = _FakeGranite(dimensions={"harm": False})
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(activities, "_granite_client", lambda s: granite)
        monkeypatch.setattr(
            activities, "get_settings", lambda: _infer_settings(safety_provider="lm-studio")
        )
        monkeypatch.setattr(
            activities,
            "get_runtime_judge_config",
            lambda: JudgeConfig(provider=JudgeProvider.OPENAI_COMPAT),
        )
        monkeypatch.setattr(
            activities,
            "_phi_redactor",
            lambda: _ContractRedactor(transform=lambda t: "SHOULD_NOT_REDACT"),
        )

        result = await env.run(
            activities.run_inferential_sensors, _infer_input(note_text="John Smith stable")
        )

        assert granite.screened == ["John Smith stable"]
        assert result.degraded is False
