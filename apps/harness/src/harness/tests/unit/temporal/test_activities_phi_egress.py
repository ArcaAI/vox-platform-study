"""Activity-wiring tests for the PHI egress guard.

Covers how ``generate`` / ``run_inferential_sensors`` are wired to
the :mod:`harness.guards.phi.egress` chokepoint. Each test runs the *real*
activity body in a Temporal ``ActivityEnvironment`` with the client factories +
``get_settings`` / ``get_runtime_judge_config`` / ``_phi_redactor`` monkeypatched
to deterministic fakes (no model load, no network), and asserts the cloud-bound
call site is gated:

* ``generate`` — T1 cloud+block (Text NOT called), T2 cloud (Text gets CLEANED text),
  T3 local (Text gets ORIGINAL), T4 ``phi_enabled=False`` (bypass), T7 block logs.
* ``run_inferential_sensors`` — T6 cloud safety (Granite gets REDACTED note),
  cloud block (whole pass degrades, Granite NOT called), local (no redaction).
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.core.config import PhiConfig, Settings
from harness.eval.config import JudgeConfig, JudgeProvider
from harness.guards.phi import PhiEgressBlocked
from harness.services.text_client import TextGenerationResult
from harness.temporal import activities
from harness.temporal.models import GenerateInput, RunInferentialSensorsInput


class _FakeText:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.kwargs = kwargs
        return TextGenerationResult(content="DRAFT", model="m", finish_reason="stop")


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
        if provider in settings.phi.local_providers:
            return text
        if self._block:
            raise PhiEgressBlocked(provider=provider, reason="contract block")
        return self._transform(text) if self._transform is not None else text


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


def _gen_settings(*, fail_closed: bool = True) -> Settings:
    return Settings(phi=PhiConfig(enabled=True, fail_closed=fail_closed))


def _infer_settings() -> Settings:
    """No safety provider any more — the screen is a peer-service call (TASK-799 A.1).

    Harness holds no guardian engine, so `ensure_inferential_egress_safe` is passed
    `safety_provider=None`: the note's only destination is `apps/guardrail`, a
    first-party internal service, exactly like the `text`/`nlp` hops this guard has
    never gated. The JUDGE half of the guard is unchanged and is what these tests now
    exercise, because the judge client still posts to its selected provider directly.
    """
    return Settings(phi=PhiConfig(enabled=True, fail_closed=True))


def _infer_input(**kw: Any) -> RunInferentialSensorsInput:
    base: dict[str, Any] = {
        # The safety screen is a tenant-scoped call into apps/guardrail
        # (TASK-737: `X-Tenant-Id` mandatory), so both workflow call sites now thread
        # the tenant onto this input; without it the safety sensor degrades by design.
        "tenant_id": "11111111-1111-1111-1111-111111111111",
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
    async def test_cloud_phi_blocks_generate_and_skips_text(self, env, monkeypatch):
        # T1: cloud + fail-closed block ⇒ Text client never called.
        text_client = _FakeText()
        monkeypatch.setattr(activities, "_text_client", lambda s: text_client)
        monkeypatch.setattr(activities, "get_settings", _gen_settings)
        monkeypatch.setattr(activities, "_phi_redactor", lambda: _ContractRedactor(block=True))

        with pytest.raises(PhiEgressBlocked):
            await env.run(
                activities.generate,
                GenerateInput(
                    tenant_id="11111111-1111-1111-1111-111111111111",
                    prompt="John Smith has HTN",
                    provider="azure",
                ),
            )
        assert text_client.kwargs == {}, "Text must not be called when egress is blocked"

    @pytest.mark.asyncio
    async def test_cloud_calls_text_with_cleaned_text(self, env, monkeypatch):
        # T2: cloud egress ⇒ Text receives the redacted prompt + system prompt.
        text_client = _FakeText()
        monkeypatch.setattr(activities, "_text_client", lambda s: text_client)
        monkeypatch.setattr(activities, "get_settings", _gen_settings)
        monkeypatch.setattr(
            activities,
            "_phi_redactor",
            lambda: _ContractRedactor(transform=lambda t: t.replace("John Smith", "<PERSON>")),
        )

        await env.run(
            activities.generate,
            GenerateInput(
                tenant_id="11111111-1111-1111-1111-111111111111",
                prompt="John Smith has HTN",
                system_prompt="Sys John Smith",
                provider="azure",
            ),
        )
        assert text_client.kwargs["prompt"] == "<PERSON> has HTN"
        assert text_client.kwargs["system_prompt"] == "Sys <PERSON>"

    @pytest.mark.asyncio
    async def test_local_provider_passthrough_to_text(self, env, monkeypatch):
        # T3: a local provider ⇒ Text receives the ORIGINAL text (no redaction).
        text_client = _FakeText()
        monkeypatch.setattr(activities, "_text_client", lambda s: text_client)
        monkeypatch.setattr(activities, "get_settings", _gen_settings)
        monkeypatch.setattr(
            activities,
            "_phi_redactor",
            lambda: _ContractRedactor(transform=lambda t: "SHOULD_NOT_REDACT"),
        )

        await env.run(
            activities.generate,
            GenerateInput(
                tenant_id="11111111-1111-1111-1111-111111111111",
                prompt="John Smith has HTN",
                provider="lm-studio",
            ),
        )
        assert text_client.kwargs["prompt"] == "John Smith has HTN"

    @pytest.mark.asyncio
    async def test_phi_disabled_bypasses_guard(self, env, monkeypatch):
        # T4: phi_enabled=False ⇒ egress allowed unredacted; redactor untouched.
        text_client = _FakeText()
        redactor = _ContractRedactor(block=True)  # would block if ever consulted
        monkeypatch.setattr(activities, "_text_client", lambda s: text_client)
        monkeypatch.setattr(activities, "get_settings", _gen_settings)
        monkeypatch.setattr(activities, "_phi_redactor", lambda: redactor)

        await env.run(
            activities.generate,
            GenerateInput(
                tenant_id="11111111-1111-1111-1111-111111111111",
                prompt="John Smith has HTN",
                provider="azure",
                phi_enabled=False,
            ),
        )
        assert text_client.kwargs["prompt"] == "John Smith has HTN"
        assert redactor.calls == []

    @pytest.mark.asyncio
    async def test_block_emits_structured_log(self, env, monkeypatch, caplog):
        # T7: a block emits a structured ``harness.phi_egress.blocked`` warning.
        text_client = _FakeText()
        monkeypatch.setattr(activities, "_text_client", lambda s: text_client)
        monkeypatch.setattr(activities, "get_settings", _gen_settings)
        monkeypatch.setattr(activities, "_phi_redactor", lambda: _ContractRedactor(block=True))

        with caplog.at_level(logging.WARNING):
            with pytest.raises(PhiEgressBlocked):
                await env.run(
                    activities.generate,
                    GenerateInput(
                        tenant_id="11111111-1111-1111-1111-111111111111",
                        prompt="John Smith has HTN",
                        provider="azure",
                    ),
                )
        assert any("phi_egress" in r.getMessage() for r in caplog.records)


class TestRunInferentialSensorsPhiEgress:
    @pytest.mark.asyncio
    async def test_safety_screen_is_not_cloud_egress_so_the_note_is_not_redacted(
        self, env, monkeypatch
    ):
        """The PHI cloud boundary MOVED into apps/guardrail (TASK-799 A.1, F-02).

        This replaces `test_cloud_safety_redacts_note_before_granite`, which asserted the
        old shape: harness read `HARNESS_SAFETY_PROVIDER`, and when an operator set it to
        `azure`/`bedrock` the note was redacted here before harness posted it at that
        cloud engine itself. Harness no longer posts at any engine — it posts the note to
        `apps/guardrail`, a first-party peer — so there is nothing for THIS guard to gate
        on the safety path, and guardrail owns the PHI posture of whichever engine it
        selects. Deliberate, and recorded rather than left implicit.

        A CLOUD JUDGE is configured so the redactor is demonstrably ACTIVE in this pass:
        the transcript IS redacted while the screened note is NOT.
        """
        judge = _StubJudge()
        granite = _FakeGranite(dimensions={"harm": False})
        redactor = _ContractRedactor(transform=lambda t: t.replace("John Smith", "<PERSON>"))
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(activities, "_safety_screen_client", lambda s, t: granite)
        monkeypatch.setattr(activities, "get_settings", _infer_settings)
        monkeypatch.setattr(
            activities,
            "get_runtime_judge_config",
            lambda: JudgeConfig(provider=JudgeProvider.OPENAI_COMPAT),
        )
        monkeypatch.setattr(activities, "_phi_redactor", lambda: redactor)

        result = await env.run(
            activities.run_inferential_sensors,
            _infer_input(note_text="John Smith stable", judge_provider="azure"),
        )

        # The redactor ran (cloud judge) — but never on the note, and never for a
        # "safety" provider, because the safety path declares no egress target.
        assert redactor.calls, "the cloud judge must still drive the egress guard"
        assert all(provider == "azure" for _, provider in redactor.calls)
        assert granite.screened == ["John Smith stable"]
        assert result.degraded is False

    @pytest.mark.asyncio
    async def test_cloud_block_degrades_whole_pass_and_skips_granite(
        self, env, monkeypatch, caplog
    ):
        # T6/T7: a cloud fail-closed block degrades the pass (reduced
        # assurance) with a PHI reason, never egresses, and logs the block.
        # Driven by the cloud JUDGE now that the safety path declares no egress target
        # (TASK-799 A.1); the property under test — one block degrades the WHOLE pass,
        # and no sensor runs — is unchanged.
        granite = _FakeGranite(dimensions={"harm": False})
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: _StubJudge())
        monkeypatch.setattr(activities, "_safety_screen_client", lambda s, t: granite)
        monkeypatch.setattr(activities, "get_settings", _infer_settings)
        monkeypatch.setattr(
            activities,
            "get_runtime_judge_config",
            lambda: JudgeConfig(provider=JudgeProvider.OPENAI_COMPAT),
        )
        monkeypatch.setattr(activities, "_phi_redactor", lambda: _ContractRedactor(block=True))

        with caplog.at_level(logging.WARNING):
            result = await env.run(
                activities.run_inferential_sensors,
                _infer_input(note_text="John Smith", judge_provider="azure"),
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
        # All-local inferential pass ⇒ Granite gets the ORIGINAL note unchanged.
        judge = _StubJudge()
        granite = _FakeGranite(dimensions={"harm": False})
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(activities, "_safety_screen_client", lambda s, t: granite)
        monkeypatch.setattr(activities, "get_settings", _infer_settings)
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
