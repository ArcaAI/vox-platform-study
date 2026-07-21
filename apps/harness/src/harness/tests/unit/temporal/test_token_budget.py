"""Per-run token budget — graceful regen stop.

The budget must bound the regen loop WITHOUT changing the command sequence, so it
is folded from values already recorded in activity outputs (`generated.stats`) and
consulted as an extra conjunct on the two EXISTING `if ... regens_used <
gate.max_regen` branches. Taking an existing branch emits no new command, reads no
clock/env, and therefore needs no ``workflow.patched`` marker and no new replay
fixture — the posture the codebase already uses for the WS-1 verdict cache.

Pinned here:
  * `token_budget_per_run = 0` ⇒ UNBOUNDED (the shipped default), so the loop is
    byte-identical to before the budget was added;
  * an old history whose stats carry no usage ⇒ zero spend ⇒ also inert;
  * both the flat and the nested `usage` token shapes are counted;
  * exhaustion is `>=`, so a run that exactly meets its budget stops.

The end-to-end "regen actually stops" behaviour rides on the existing workflow
suite (`test_doc_workflow*`) plus `test_replay_compat`, which must stay green —
that is the real proof no era was added.
"""

from __future__ import annotations

import pytest

from harness.temporal.models import HarnessGateConfig
from harness.temporal.workflows import _budget_exhausted, _tokens_from_stats


class TestTokensFromStats:
    def test_reads_the_flat_snake_case_shape(self) -> None:
        assert _tokens_from_stats({"prompt_tokens": 1200, "completion_tokens": 300}) == 1500

    def test_reads_camel_case(self) -> None:
        assert _tokens_from_stats({"promptTokens": 10, "completionTokens": 5}) == 15

    def test_reads_the_nested_usage_block(self) -> None:
        assert _tokens_from_stats({"usage": {"prompt_tokens": 7, "completion_tokens": 3}}) == 10

    def test_reads_the_input_output_aliases(self) -> None:
        assert _tokens_from_stats({"input_tokens": 4, "output_tokens": 6}) == 10

    def test_counts_a_partial_report(self) -> None:
        assert _tokens_from_stats({"prompt_tokens": 100}) == 100

    def test_old_history_without_stats_costs_nothing(self) -> None:
        """The replay-safety hinge: no stats ⇒ zero spend ⇒ the budget is inert."""
        assert _tokens_from_stats(None) == 0
        assert _tokens_from_stats({}) == 0

    def test_ignores_non_numeric_values(self) -> None:
        assert _tokens_from_stats({"prompt_tokens": "lots"}) == 0


class TestBudgetExhausted:
    def test_zero_budget_is_unbounded(self) -> None:
        # The shipped default. Nothing can exhaust it — pre-B4 behaviour exactly.
        assert _budget_exhausted(0, 10_000_000) is False

    def test_negative_budget_is_treated_as_unbounded(self) -> None:
        assert _budget_exhausted(-1, 10_000_000) is False

    def test_under_budget_keeps_regenerating(self) -> None:
        assert _budget_exhausted(1000, 999) is False

    def test_exactly_at_budget_stops(self) -> None:
        assert _budget_exhausted(1000, 1000) is True

    def test_over_budget_stops(self) -> None:
        assert _budget_exhausted(1000, 1500) is True


class TestGateConfigDefault:
    def test_defaults_to_unbounded(self) -> None:
        """A workflow started before B4 (or with no budget configured) is unbounded."""
        assert HarnessGateConfig().token_budget_per_run == 0

    def test_accepts_a_configured_budget(self) -> None:
        assert HarnessGateConfig(token_budget_per_run=5000).token_budget_per_run == 5000


class TestPolicyParsing:
    def test_parses_the_budget_off_the_effective_policy(self) -> None:
        from harness.temporal.models import HarnessPolicy

        policy = HarnessPolicy.from_api({"tokenBudgetPerRun": 4096})

        assert policy.token_budget_per_run == 4096

    def test_absent_budget_is_none_so_the_gate_default_governs(self) -> None:
        from harness.temporal.models import HarnessPolicy

        # An older gateway that does not serve the field must not force a budget on.
        policy = HarnessPolicy.from_api({})

        assert policy.token_budget_per_run is None


@pytest.mark.parametrize(
    ("budget", "spend", "expected"),
    [
        (0, 999_999, False),
        (100, 0, False),
        (100, 100, True),
        (100, 101, True),
    ],
)
def test_budget_matrix(budget: int, spend: int, expected: bool) -> None:
    assert _budget_exhausted(budget, spend) is expected


class TestEveryRegenSiteRespectsTheBudget:
    """Structural guard over the regen branches in ``workflows.py``.

    The pure-helper tests above cannot catch the defect that actually shipped:
    B4 added ``and not budget_stopped`` to the two PRE-delivery regen branches
    and missed the third, post-delivery Q1 rerun — so a budget-exhausted run
    could still buy one more generate. A unit test of ``_budget_exhausted``
    passes happily in that world.

    Asserting over the source keeps the guard cheap and, more importantly, makes
    it fire for a FOURTH regen site added later, which is the recurrence this
    class of bug actually has.
    """

    @staticmethod
    def _workflow_source() -> str:
        from pathlib import Path

        import harness.temporal.workflows as wf

        return Path(wf.__file__).read_text(encoding="utf-8")

    def test_every_max_regen_branch_carries_the_budget_conjunct(self) -> None:
        source = self._workflow_source()
        # Each regen branch spans several lines; take a window after the guard
        # so a conjunct on the following line still counts.
        lines = source.splitlines()
        sites = [i for i, line in enumerate(lines) if "regens_used < gate.max_regen" in line]

        assert sites, "no regen branch found — did the guard expression get renamed?"

        unguarded = [
            i + 1
            for i in sites
            if "budget_stopped" not in "\n".join(lines[max(0, i - 6) : i + 7])
        ]
        assert not unguarded, (
            f"regen branch(es) at line(s) {unguarded} do not consult `budget_stopped`; "
            "a per-run token budget must bind at EVERY regen site (TASK-533 B4)"
        )

    def test_the_post_delivery_regen_accounts_its_own_spend(self) -> None:
        # The Q1 rerun calls `_regen_compute()`; its tokens must be folded into
        # `tokens_used`, or the run under-reports what it actually spent.
        source = self._workflow_source()
        lines = source.splitlines()
        regen_calls = [i for i, line in enumerate(lines) if "await _regen_compute()" in line]

        assert regen_calls, "no `_regen_compute()` call site found"

        unaccounted = [
            i + 1
            for i in regen_calls
            if "tokens_used" not in "\n".join(lines[i : i + 6])
        ]
        assert not unaccounted, (
            f"`_regen_compute()` at line(s) {unaccounted} does not accumulate `tokens_used` "
            "— the regen's spend would be invisible to the per-run budget (TASK-533 B4)"
        )
