"""Activity-wiring tests for the PHI egress guard.

Covers how ``run_inferential_sensors`` is wired to the :mod:`harness.guards.phi.egress`
screen. Each test runs the *real* activity body in a Temporal ``ActivityEnvironment`` with the
client factories + ``get_settings`` / ``get_runtime_judge_config`` / ``_phi_redactor``
monkeypatched to deterministic fakes (no model load, no network), and asserts the cloud-bound
judge hop is gated: cloud safety, cloud block (whole pass degrades), local (no redaction).

TASK-1035 removed the ``generate`` half of this file: every ``apps/text`` ``/generate`` call is
redacted by text itself (see ``test_task1035_activities_egress.py``). The judge stays here because
it posts to its provider DIRECTLY.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.core.config import Settings
from harness.core.llm_egress import is_local_direct_transport
from harness.eval.config import JudgeConfig, JudgeProvider
from harness.guards.phi import PhiEgressBlocked
from harness.temporal import activities
from harness.temporal.models import RunInferentialSensorsInput


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

    def ensure_safe_for_cloud(self, text: str, *, provider: str, fail_closed: bool) -> str:
        self.calls.append((text, provider))
        if is_local_direct_transport(provider):
            return text
        if self._block:
            raise PhiEgressBlocked(provider=provider, reason="contract block")
        return self._transform(text) if self._transform is not None else text


@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


def _infer_settings() -> Settings:
    """No safety provider any more — the screen is a peer-service call ( A.1).

    Harness holds no guardian engine, so `ensure_inferential_egress_safe` is passed
    `safety_provider=None`: the note's only destination is `apps/guardrail`, a
    first-party internal service, exactly like the `text`/`nlp` hops this guard has
    never gated. The JUDGE half of the guard is unchanged and is what these tests now
    exercise, because the judge client still posts to its selected provider directly.
    """
    return Settings()


def _infer_input(**kw: Any) -> RunInferentialSensorsInput:
    base: dict[str, Any] = {
        # The safety screen is a tenant-scoped call into apps/guardrail
        # (`X-Tenant-Id` mandatory), so both workflow call sites now thread
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


class TestRunInferentialSensorsPhiEgress:
    @pytest.mark.asyncio
    async def test_safety_screen_is_not_cloud_egress_so_the_note_is_not_redacted(
        self, env, monkeypatch
    ):
        """The PHI cloud boundary MOVED into apps/guardrail ( A.1, F-02).

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
        # ; the property under test — one block degrades the WHOLE pass,
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

    @pytest.mark.asyncio
    async def test_the_screened_note_never_reaches_the_cloud_judge(self, env, monkeypatch):
        """The note is the ONE field the judge must never see.

        ``safety_provider=None`` means the note leaves this activity UNREDACTED. That is
        only safe while its sole destination is the ``apps/guardrail`` peer. The judge —
        which under a cloud selection posts straight at a vendor from THIS process — must
        therefore never receive it, directly or folded into a premise.

        The guard cannot catch that on its own: it gates ``note_text`` on the SAFETY
        consumer, so anything that put the note on the judge-bound payload would ship it
        to the vendor raw, past a guard that believes that field is already cleared.
        """
        judge = _StubJudge()
        screen = _FakeGranite(dimensions={"harm": False})
        redactor = _ContractRedactor(transform=lambda t: t.replace("Marla Quintrell", "<PERSON>"))
        monkeypatch.setattr(activities, "_build_runtime_judge", lambda *a, **k: judge)
        monkeypatch.setattr(activities, "_safety_screen_client", lambda s, t: screen)
        monkeypatch.setattr(activities, "get_settings", _infer_settings)
        monkeypatch.setattr(
            activities,
            "get_runtime_judge_config",
            lambda: JudgeConfig(provider=JudgeProvider.OPENAI_COMPAT),
        )
        monkeypatch.setattr(activities, "_phi_redactor", lambda: redactor)

        note = "Marla Quintrell presents with chest pain."
        await env.run(
            activities.run_inferential_sensors,
            _infer_input(
                note_text=note,
                transcript_text="Marla Quintrell reports chest pain.",
                judge_provider="azure",
                citations_map={
                    "claims": [
                        {
                            "id": "c1",
                            "text": "Marla Quintrell has chest pain",
                            "section": "assessment",
                            "evidence": [{"quote": "Marla Quintrell reports chest pain."}],
                        }
                    ]
                },
            ),
        )

        # The peer got the note verbatim — a moderation model must read real text.
        assert screen.screened == [note]
        # ...and the cloud judge never saw it, in any message, on any premise.
        assert judge.calls, "the judge must actually have run for this to prove anything"
        sent_to_judge = "\n".join(
            str(m.get("content", "")) for messages in judge.calls for m in messages
        )
        assert "Marla Quintrell" not in sent_to_judge, (
            "the raw note identifier reached the CLOUD judge — the egress guard gates "
            "note_text on the safety consumer, so it went out unredacted"
        )
        # The note was never even offered to the redactor: it is not judge-bound.
        assert note not in [text for text, _ in redactor.calls]

    def test_the_safety_screen_client_is_the_guardrail_peer_not_an_engine(self):
        """What makes ``safety_provider=None`` legitimate, asserted rather than commented.

        The literal is correct ONLY because the screen's destination is a first-party
        in-boundary peer. Re-introducing a direct-to-engine safety client (the F-02 shape:
        harness posting the note at a vendor endpoint itself) would turn that same literal
        into a silent unredacted cloud egress — the guard would still be told there is no
        egress target.

        The other half of the chain — that guardrail's outbound screen is itself
        in-boundary, and does not redact — is pinned in guardrail's own suite:
        ``guardrail/tests/test_task799_outbound_screen_boundary.py``.
        """
        from harness.sensors.inferential.guardrail_screen import GuardrailSafetyScreen
        from harness.services.guardrail_client import GuardrailClient

        settings = Settings()
        client = activities._safety_screen_client(settings, "11111111-1111-1111-1111-111111111111")

        assert isinstance(client, GuardrailSafetyScreen)
        peer = client._client
        assert isinstance(peer, GuardrailClient)
        assert peer._base_url == settings.guardrail_base_url.rstrip("/"), (
            "the safety screen must post to the apps/guardrail peer; any other endpoint "
            "makes safety_provider=None an unredacted egress"
        )
