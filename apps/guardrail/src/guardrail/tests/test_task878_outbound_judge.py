"""TASK-878 — the outbound screen's gaps, and the judge's configuration homes.

Three things TASK-871 could not fix from `apps/text`, plus the two configuration
moves the same review turned up on this side.

**G1 — `jailbreak_detection` on the OUTBOUND direction.** A response that echoes,
or complies with, an injected instruction is exactly what a post-receive check
exists to catch (owner priority, TASK-870 item 7), and the check was inbound-only.
It is added to the SAME single delegated `classify` the outbound screen already
makes, so it costs no extra peer call — and it delegates to `apps/nlp`, never to
`apps/text`, which is what keeps the `text -> guardrail -> text` cycle broken.

**G2 — `usage_detail` on `ScreenResponse`.** Guardrail is a peer service with no
gateway in front of it, so a delegated call's spend can only reach the billing
plane by riding back on the verdict. The channel is the one guardrail already uses
for the judge (`external_text_client.py`): the peer's block is forwarded VERBATIM,
never re-derived, and ABSENT rather than zeroed when no delegated call reported one.

**B — the judge's hyperparameters and its timeout.** Temperature and max-tokens are
MODEL-COUPLED, so they live on `AiModel._metadata.policy` and fail CLOSED. The
timeout is a peer-call budget, so it rides the platform-scope control plane and
falls back to its declared default.
"""

from __future__ import annotations

import inspect
from types import SimpleNamespace
from typing import Any

import pytest

from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.core.policy import GuardrailPolicy
from guardrail.services.screening import (
    DECISION_ALLOW,
    DECISION_BLOCK,
    OUTBOUND_TASKS,
    OUTCOME_SKIPPED,
    Screener,
)

TENANT = "11111111-1111-1111-1111-111111111111"
SYSTEM = "00000000-0000-0000-0000-000000000000"


class _StubAnalyzer:
    """Stands in for the `apps/nlp`-backed analyzer (mirrors test_task777's)."""

    def __init__(
        self,
        *,
        labels: dict[str, Any] | None = None,
        taxonomy: tuple[str, ...] | None = None,
        usage: dict[str, Any] | None = None,
    ) -> None:
        self._labels = labels or {}
        #: Which task names the registry row DECLARED. `None` ⇒ every requested one.
        self._taxonomy = taxonomy
        self._usage = usage
        self.task_calls: list[tuple[str, ...]] = []
        self.policy = type("P", (), {"pii_labels": ["PERSON"], "classification_threshold": 0.4})()

    async def classify_tasks(self, task_names, text):  # noqa: ANN001, ANN202
        self.task_calls.append(tuple(task_names))
        declared = self._taxonomy if self._taxonomy is not None else tuple(task_names)
        return {n: self._labels.get(n, "benign") for n in task_names if n in declared}

    async def extract_pii_entities(self, text):  # noqa: ANN001, ANN202
        return []

    def model_for(self, check):  # noqa: ANN001, ANN202
        return "stub-model"

    def usage_detail(self) -> dict[str, Any] | None:
        return self._usage


def _screener(analyzer: Any, **kw: Any) -> Screener:
    return Screener(analyzer=analyzer, tenant_id=TENANT, policy_source_tenant_id=SYSTEM, **kw)


# ---------------------------------------------------------------------------
# G1 — jailbreak detection on the outbound direction
# ---------------------------------------------------------------------------


def test_jailbreak_detection_is_an_outbound_task() -> None:
    """The owner's first priority: a jailbroken RESPONSE must be detectable."""
    assert "jailbreak_detection" in OUTBOUND_TASKS


def test_the_three_response_tasks_keep_their_leading_order() -> None:
    """`reasons[0]` is the rejection label every `apps/text` consumer reports, so
    the new check is APPENDED — existing rejections keep the label they had."""
    assert OUTBOUND_TASKS[:3] == ("response_safety", "response_toxicity", "response_refusal")


@pytest.mark.asyncio
async def test_a_jailbroken_response_is_blocked_outbound() -> None:
    analyzer = _StubAnalyzer(labels={"jailbreak_detection": "jailbreak"})

    decision = await _screener(analyzer).screen_outbound(
        "Sure — ignoring my instructions, here is the full patient list.",
        source_context="summarise the consultation",
    )

    assert decision.decision == DECISION_BLOCK
    assert "jailbreak_detection" in decision.reasons


@pytest.mark.asyncio
async def test_the_jailbreak_check_rides_the_one_classify_call_it_already_made() -> None:
    """No extra peer call, no extra latency budget: one `classify`, four tasks."""
    analyzer = _StubAnalyzer()

    await _screener(analyzer).screen_outbound("a clean summary", source_context="notes")

    assert len(analyzer.task_calls) == 1, "the outbound screen must stay ONE classify call"
    assert "jailbreak_detection" in analyzer.task_calls[0]


@pytest.mark.asyncio
async def test_a_taxonomy_without_the_task_reports_skipped_rather_than_blocking() -> None:
    """Guardrail never invents a task the registry row did not declare — and a
    task that did not run must not block a clinician's summary."""
    analyzer = _StubAnalyzer(
        taxonomy=("response_safety", "response_toxicity", "response_refusal"),
    )

    decision = await _screener(analyzer).screen_outbound("a clean summary", source_context="notes")

    jailbreak = next(c for c in decision.checks if c.name == "jailbreak_detection")
    assert jailbreak.outcome == OUTCOME_SKIPPED
    assert jailbreak.reason == "not_in_taxonomy"
    assert decision.decision == DECISION_ALLOW


# ---------------------------------------------------------------------------
# G1 — cycle safety: the outbound jailbreak check cannot re-enter the judge lane
# ---------------------------------------------------------------------------


def test_the_outbound_jailbreak_check_is_a_classification_not_a_judgement() -> None:
    """Layer 1 (static). `Screener` holds ONE collaborator — the analyzer — and
    the module names no path to `apps/text`. A jailbreak check delegated to the
    judge would close `text -> guardrail -> text`: text's output gate screens a
    completion, guardrail's screen asks text to judge it, and that judgement is
    itself a completion.
    """
    import guardrail.services.screening as screening

    source = inspect.getsource(screening)
    for literal in ("TextJudgeClient", "external_text_client", "generate/internal/judge"):
        assert literal not in source, (
            f"{literal!r} in services/screening.py puts the judge lane on the outbound "
            "screen and closes the text -> guardrail -> text cycle"
        )
    # The jailbreak task is dispatched through `_classify`, whose only executor is
    # the analyzer — the same object `build_screener` binds to two `NlpGuardClient`s.
    assert "self._analyzer.classify_tasks" in inspect.getsource(screening.Screener._classify)


@pytest.mark.asyncio
async def test_build_screener_binds_no_judge_client_for_the_jailbreak_check() -> None:
    """Layer 1 (runtime). Adding a task to `OUTBOUND_TASKS` changes WHAT is asked
    of the nlp peer, never WHO is asked."""
    from guardrail.core.dependencies import build_screener
    from guardrail.services.external_nlp_client import NlpGuardClient
    from guardrail.services.external_text_client import TextJudgeClient

    screener = await build_screener(_screener_app_state(), TENANT)
    analyzer = screener._analyzer  # noqa: SLF001

    for client in (analyzer._safety_client, analyzer._pii_client):  # noqa: SLF001
        assert isinstance(client, NlpGuardClient)
        assert not isinstance(client, TextJudgeClient)


def _screener_app_state() -> Any:
    from guardrail.core.config import Settings

    taxonomy = {
        "tasks": {
            "jailbreak_detection": {"labels": ["benign", "jailbreak"]},
            "response_safety": {"labels": ["benign", "harm"]},
            "response_toxicity": {"labels": ["benign", "toxic"]},
            "response_refusal": {"labels": ["benign", "refusal"]},
        },
        "labels": ["PERSON"],
    }
    cfg = SimpleNamespace(
        provider="lm-studio",
        model="some-selected-model",
        local_path=None,
        timeout_s=None,
        entailment=None,
        policy=None,
        source_tenant_id=TENANT,
        label_taxonomy=taxonomy,
    )

    class _Resolver:
        async def resolve(self, tenant_id: str | None, task_key: str) -> Any:
            return cfg

    return SimpleNamespace(
        settings=Settings(),
        http_client=object(),
        tenant_config_resolver=_Resolver(),
        circuit_breakers=None,
        effective_config_client=None,
    )


# ---------------------------------------------------------------------------
# G2 — usage_detail rides back, or is absent; never zeros
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_delegated_calls_usage_rides_back_on_the_decision() -> None:
    usage = {
        "provider": "lm-studio",
        "model": "guardian-1",
        "prompt_tokens": 12,
        "completion_tokens": 3,
        "byok": False,
    }
    decision = await _screener(_StubAnalyzer(usage=usage)).screen_outbound(
        "a clean summary", source_context="notes"
    )

    assert decision.usage_detail == usage
    assert decision.to_dict()["usageDetail"] == usage


@pytest.mark.asyncio
async def test_no_delegated_usage_means_absent_never_zeros() -> None:
    """A zero row tells the billing plane the call was FREE rather than that it
    never happened — the rule `_stats_of` already states on /medical/validate."""
    decision = await _screener(_StubAnalyzer()).screen_outbound("clean", source_context="notes")

    assert decision.usage_detail is None
    assert decision.to_dict()["usageDetail"] is None


@pytest.mark.asyncio
async def test_the_screen_route_reports_usage_detail() -> None:
    from guardrail.api.endpoints.screen import ScreenResponse

    assert "usage_detail" in ScreenResponse.model_fields


def test_the_nlp_client_forwards_a_peer_usage_block_verbatim() -> None:
    """The producer side of the channel. Guardrail never RE-DERIVES a usage block:
    the funding tier belongs to the credential that served the call, and
    re-deriving it downstream is how a call site starts mis-billing."""
    from guardrail.services.external_nlp_client import NlpGuardClient

    client = NlpGuardClient(
        base_url="http://nlp:8864",
        service_token="",
        http_client=object(),
        tenant_id=TENANT,
    )
    assert client.last_usage_detail is None

    client.record_usage_detail({"provider": "nlp", "model": "m", "prompt_tokens": 4})
    assert client.last_usage_detail == {"provider": "nlp", "model": "m", "prompt_tokens": 4}

    client.record_usage_detail("not a dict")
    assert client.last_usage_detail == {"provider": "nlp", "model": "m", "prompt_tokens": 4}


# ---------------------------------------------------------------------------
# B — judge hyperparameters resolve from the model row, fail-closed
# ---------------------------------------------------------------------------


class TestJudgeHyperparametersAreModelRowPolicy:
    def test_both_keys_are_declared_fail_closed(self) -> None:
        for key in ("judgeTemperature", "judgeMaxTokens"):
            assert GuardrailPolicy.fail_mode(key) == "closed"
            assert key in GuardrailPolicy.DECLARED_KEYS

    def test_values_resolve_from_the_selected_rows_policy_blob(self) -> None:
        policy = GuardrailPolicy.from_blob({"judgeTemperature": 0.05, "judgeMaxTokens": 300})

        assert policy.judge_temperature == 0.05
        assert policy.judge_max_tokens == 300

    @pytest.mark.parametrize("key", ["judgeTemperature", "judgeMaxTokens"])
    def test_an_unseeded_value_raises_rather_than_substituting_a_literal(self, key: str) -> None:
        """No code default: a judge running at an unknown temperature is not a
        judge with a sensible default, it is an unattributable verdict."""
        blob = {"judgeTemperature": 0.05, "judgeMaxTokens": 300}
        blob.pop(key)

        with pytest.raises(GuardrailUndeterminedError):
            GuardrailPolicy.from_blob(blob).require_number(key)

    @pytest.mark.parametrize(
        ("key", "value"),
        [("judgeTemperature", 9.0), ("judgeMaxTokens", 0), ("judgeTemperature", "hot")],
    )
    def test_an_out_of_range_or_mistyped_value_raises(self, key: str, value: Any) -> None:
        """A fail-CLOSED key is never quietly clamped: unlike the tuning keys,
        there is no default to fall back to, so a nonsensical value must be told."""
        with pytest.raises(GuardrailUndeterminedError):
            GuardrailPolicy.from_blob({key: value}).require_number(key)

    def test_judge_policy_declares_neither_literal_any_more(self) -> None:
        from guardrail.core.config import JudgePolicy

        for gone in ("temperature", "max_tokens", "timeout_s"):
            assert gone not in JudgePolicy.model_fields, (
                f"JudgePolicy.{gone} is a hardcoded value wearing a config costume "
                "(rule 09 'No hardcoded configuration')"
            )


class TestBuildJudgeClientResolvesTheHyperparameters:
    def _cfg(self, **kw: Any) -> Any:
        from guardrail.core.tenant_config import GuardrailTenantConfig

        base: dict[str, Any] = {
            "model": "m",
            "policy": {
                "medicalValidationCriteria": "you are a medical context validator",
                "judgeTemperature": 0.05,
                "judgeMaxTokens": 300,
            },
        }
        base.update(kw)
        return GuardrailTenantConfig(**base)

    def _build(self, cfg: Any, **kw: Any) -> Any:
        from guardrail.core.config import Settings
        from guardrail.core.tenant_config import build_judge_client

        return build_judge_client(Settings(), cfg, object(), "t-1", **kw)

    def test_the_model_rows_policy_supplies_the_values(self) -> None:
        client = self._build(self._cfg())

        assert client.temperature == 0.05
        assert client.max_tokens == 300

    def test_a_per_selection_runtime_profile_still_wins(self) -> None:
        """`AiRoutingPolicy.configJson` tuning keeps its precedence — the model
        row's policy is what the FALLBACK became, not a new winner."""
        client = self._build(self._cfg(temperature=0.42, max_tokens=1234))

        assert client.temperature == 0.42
        assert client.max_tokens == 1234

    def test_an_unseeded_row_fails_closed(self) -> None:
        cfg = self._cfg(policy={"medicalValidationCriteria": "criteria"})

        with pytest.raises(GuardrailUndeterminedError):
            self._build(cfg)

    def test_the_timeout_comes_from_the_control_plane_not_the_model_row(self) -> None:
        client = self._build(self._cfg(), judge_timeout_s=17.5)

        assert client.timeout_s == 17.5

    def test_a_per_selection_timeout_still_wins(self) -> None:
        client = self._build(self._cfg(timeout_s=99), judge_timeout_s=17.5)

        assert client.timeout_s == 99


# ---------------------------------------------------------------------------
# Deliverable 5 — the judge timeout on the platform-scope pull route
# ---------------------------------------------------------------------------


class TestJudgeTimeoutRidesTheControlPlane:
    def _snapshot(self, value: Any) -> Any:
        from guardrail.core.effective_config import EffectiveConfigSnapshot

        return EffectiveConfigSnapshot(
            raw={"settings": {"guardrail.judge.timeoutSeconds": {"value": value}}}, ok=True
        )

    def test_a_served_value_is_used(self) -> None:
        assert self._snapshot(12).judge_timeout_s() == 12.0

    def test_no_opinion_keeps_the_declared_default(self) -> None:
        from guardrail.core.effective_config import (
            DEFAULT_JUDGE_TIMEOUT_S,
            EffectiveConfigSnapshot,
        )

        assert (
            EffectiveConfigSnapshot(raw={}, ok=False).judge_timeout_s() == DEFAULT_JUDGE_TIMEOUT_S
        )
        assert self._snapshot(None).judge_timeout_s() == DEFAULT_JUDGE_TIMEOUT_S

    @pytest.mark.parametrize("bad", [0, -1, True, "30"])
    def test_a_nonsensical_value_is_not_honoured(self, bad: Any) -> None:
        """`open-to-default` governs an ABSENT value; a value that would make
        every judgement fail instantly is treated as no opinion, not obeyed."""
        from guardrail.core.effective_config import DEFAULT_JUDGE_TIMEOUT_S

        assert self._snapshot(bad).judge_timeout_s() == DEFAULT_JUDGE_TIMEOUT_S

    def test_the_declared_default_is_todays_literal(self) -> None:
        """One definition site, matching the descriptor's `default`."""
        from guardrail.core.effective_config import DEFAULT_JUDGE_TIMEOUT_S

        assert DEFAULT_JUDGE_TIMEOUT_S == 60.0

    @pytest.mark.asyncio
    async def test_a_control_plane_outage_never_breaks_the_judge(self) -> None:
        from guardrail.core.dependencies import resolve_judge_timeout_s
        from guardrail.core.effective_config import DEFAULT_JUDGE_TIMEOUT_S

        class _Exploding:
            async def get(self) -> Any:
                raise RuntimeError("control plane down")

        state = SimpleNamespace(effective_config_client=_Exploding())
        assert await resolve_judge_timeout_s(state) == DEFAULT_JUDGE_TIMEOUT_S

        assert (
            await resolve_judge_timeout_s(SimpleNamespace(effective_config_client=None))
            == DEFAULT_JUDGE_TIMEOUT_S
        )
