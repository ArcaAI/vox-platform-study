"""The delegated judge makes ONE attempt, inside a budget TEXT outlasts.

Measured over three days (n ~ 695 calls to `apps/text`'s judge lane): p50 2.9 s,
p90 13.6 s, **p99 50.6 s**, max 60 s. The 60 s `guardrail.judge.timeoutSeconds`
therefore stays; what changes is that a judgement which timed out is not asked
again. Nothing cancels across the hop, so the first judgement is still running on
the one shared GPU when a retry arrives — the retry does not recover the verdict,
it doubles the load that caused the timeout.

`apps/text` sizes its own moderation deadline (`text.externalGuardrail.timeoutS`)
to ONE validation here, and reads this service's 503 detail to tell "the judge
timed out" (not retried there either) from other outages. Both couplings are
pinned below, from this side.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from guardrail.core.config import JudgePolicy, Settings, TransportPolicy
from guardrail.core.effective_config import DEFAULT_JUDGE_TIMEOUT_S
from guardrail.core.errors import REASON_TIMEOUT, GuardrailUndeterminedError
from guardrail.services.external_text_client import TextJudgeClient

_REPO_ROOT = Path(__file__).resolve().parents[5]
_DESCRIPTORS = _REPO_ROOT / "packages/applications/src/services/settings-registry/descriptors"

#: Resolution, serialisation and scheduling on top of the declared waits.
_SLACK_S = 5.0


class _TimingOutText:
    """`apps/text`'s judge lane, answering later than the budget allows."""

    def __init__(self) -> None:
        self.calls = 0

    async def post(self, url: str, **kwargs: Any) -> Any:
        self.calls += 1
        raise httpx.ReadTimeout("", request=httpx.Request("POST", url))


def _judge(http: Any, **kw: Any) -> TextJudgeClient:
    kw.setdefault("policy", Settings().judge)
    return TextJudgeClient(
        base_url="http://text.test",
        http_client=http,
        service_token="",
        provider="lmstudio",
        model="guardian",
        tenant_id="11111111-1111-1111-1111-111111111111",
        criteria="clinical context criteria",
        temperature=0.05,
        max_tokens=300,
        timeout_s=DEFAULT_JUDGE_TIMEOUT_S,
        **kw,
    )


def _ts_default(file: str, pattern: str) -> float:
    source = (_DESCRIPTORS / file).read_text(encoding="utf-8")
    match = re.search(pattern, source)
    assert match, f"{file}: the default is no longer a literal"
    return float(match.group(1).replace("_", ""))


class TestOneJudgeAttempt:
    def test_the_contract_is_one_attempt(self) -> None:
        assert JudgePolicy().max_attempts == 1
        # The production call site (`build_judge_client`) passes `settings.judge`.
        assert Settings().judge.max_attempts == 1

    @pytest.mark.asyncio
    async def test_a_judge_timeout_is_one_call_and_fails_closed_as_a_timeout(self) -> None:
        http = _TimingOutText()

        with pytest.raises(GuardrailUndeterminedError) as raised:
            await _judge(http).validate_medical_context("patient note")

        assert http.calls == 1
        assert raised.value.reason == REASON_TIMEOUT

    @pytest.mark.asyncio
    async def test_the_default_client_also_makes_one_attempt(self) -> None:
        """No `policy` at all — the class default is the same contract."""
        http = _TimingOutText()

        with pytest.raises(GuardrailUndeterminedError):
            await _judge(http, policy=None).validate_medical_context("patient note")

        assert http.calls == 1


class TestTheBudgetTextDependsOn:
    def test_the_declared_default_matches_the_descriptor(self) -> None:
        declared = _ts_default(
            "guardrail-judge.descriptors.ts",
            r"GUARDRAIL_JUDGE_DEFAULTS = \{\s*\[GUARDRAIL_JUDGE_TIMEOUT_KEY\]:\s*([0-9_.]+)",
        )
        assert declared == DEFAULT_JUDGE_TIMEOUT_S == 90.0  # TASK-1059 OD-6 (was 60)

    def test_one_validation_fits_inside_texts_moderation_deadline(self) -> None:
        """If this fails, TEXT abandons validations guardrail is still judging."""
        text_timeout = _ts_default(
            "text-provider-connections.descriptors.ts",
            r"'text\.externalGuardrail\.timeoutS':\s*([0-9_.]+),",
        )
        policy = JudgePolicy()
        worst_case = (
            TransportPolicy().max_queue_wait_s
            + DEFAULT_JUDGE_TIMEOUT_S * policy.max_attempts
            + policy.retry_backoff_s * sum(range(1, policy.max_attempts))
        )

        assert text_timeout >= worst_case + _SLACK_S

    def test_the_timeout_detail_text_reads_is_stable(self) -> None:
        """`apps/text` does not retry a 503 carrying this marker."""
        detail = GuardrailUndeterminedError(REASON_TIMEOUT, "ReadTimeout").as_detail()
        assert "undetermined (timeout)" in detail
