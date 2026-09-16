"""TASK-982 §3.4.4 — ``core.trigger`` validates whatever ``resolved`` holds, and asks nothing else.

The gateway now REWRITES a follow-latest trigger's ``contextSchema.resolved`` into the per-run
compiled config immediately before dispatch, so a workflow bound to the tenant's pin is checked
against the schema version the tenant has pinned NOW rather than the one it was published with.

The whole design rests on the interpreter needing no change at all for that to work, and this
file is the proof: every case below is read from the SAME committed fixture the TypeScript
producer half asserts against — ``tests/contracts/effective-trigger-config.fixture.json``, whose
TS half is ``tests/contracts/effective-trigger-config.contract.test.ts`` — and
``interpreter_core_trigger`` is exercised UNMODIFIED. It reads ``contextSchema.resolved`` and
nothing else, so it cannot tell a pinned block from a rewritten one, which is exactly the property
that makes a per-run rewrite safe: no new request field, no database read, no replay concern.

Change the fixture with both suites open.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "50000000-0000-0000-0000-000000000000"
_RUN = "01a08170-d1eb-7529-8b25-1f5350aff7d5"

# tests/contracts/ sits at the repo root: this file is
# apps/harness/src/harness/tests/unit/temporal/interpreter/<this>, so eight parents up.
_FIXTURE_PATH = (
    Path(__file__).resolve().parents[8]
    / "tests"
    / "contracts"
    / "effective-trigger-config.fixture.json"
)


def _load_cases() -> list[tuple[str, dict[str, Any]]]:
    fixture = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))
    return [(name, case) for name, case in fixture.items() if isinstance(case, dict)]


_CASES = _load_cases()
_CASE_IDS = [name for name, _ in _CASES]


def _trigger(context_schema: dict[str, Any], run_payload: dict[str, Any]) -> NodeActivityInput:
    """A trigger node carrying the fixture's block verbatim — nothing is normalised on the way in."""
    return NodeActivityInput(
        node_id="n_trigger",
        node_type="core.trigger",
        config={"kinds": ["consultation", "api"], "contextSchema": context_schema},
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={},
        run_payload=run_payload,
        run_id=_RUN,
    )


@pytest.fixture(autouse=True)
def _no_flush(monkeypatch: pytest.MonkeyPatch) -> None:
    """``record_and_flush`` writes a trajectory step over the API client; this is a pure test."""

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)


class TestTheFixtureIsIntact:
    def test_the_contract_fixture_is_where_both_suites_expect_it(self) -> None:
        assert _FIXTURE_PATH.is_file(), f"contract fixture missing at {_FIXTURE_PATH}"

    def test_it_declares_the_three_pinned_cases(self) -> None:
        assert set(_CASE_IDS) >= {
            "pinnedTriggerIsUnchanged",
            "followsLatestCarriesTheTenantPin",
            "reservedIdentityKeysAreNeverValidated",
        }

    @pytest.mark.parametrize(("name", "case"), _CASES, ids=_CASE_IDS)
    def test_every_case_carries_a_resolved_schema_and_both_payload_lists(
        self, name: str, case: dict[str, Any]
    ) -> None:
        assert isinstance(case["contextSchema"].get("resolved"), dict), name
        assert case["accepts"], name
        assert case["refuses"], name


class TestTheInterpreterValidatesAgainstResolved:
    @pytest.mark.parametrize(("name", "case"), _CASES, ids=_CASE_IDS)
    @pytest.mark.asyncio
    async def test_every_accepted_payload_passes(self, name: str, case: dict[str, Any]) -> None:
        for payload in case["accepts"]:
            result = await core.interpreter_core_trigger(_trigger(case["contextSchema"], payload))
            assert result.status == "SUCCEEDED", f"{name}: {payload}"
            # The published `context` is the FULL payload — the reserved envelope is exempt from
            # validation, never stripped from what downstream nodes read.
            assert result.output == {"context": payload}

    @pytest.mark.parametrize(("name", "case"), _CASES, ids=_CASE_IDS)
    @pytest.mark.asyncio
    async def test_every_refused_payload_raises(self, name: str, case: dict[str, Any]) -> None:
        for payload in case["refuses"]:
            with pytest.raises(RuntimeError, match="violates the declared context schema"):
                await core.interpreter_core_trigger(_trigger(case["contextSchema"], payload))


class TestTheRewriteIsInvisibleToTheInterpreter:
    @pytest.mark.asyncio
    async def test_followsLatest_and_effectiveVersionNumber_are_never_read(self) -> None:
        """The two per-run fields are metadata for operators, not inputs to the check.

        Dropping them from a block that is otherwise identical must not change a single verdict —
        if it did, the interpreter would be reading the gateway's bookkeeping, and a per-run
        rewrite would no longer be a pure substitution of `resolved`.
        """
        case = dict(_CASES)["followsLatestCarriesTheTenantPin"]
        stripped = {
            k: v
            for k, v in case["contextSchema"].items()
            if k not in {"followsLatest", "effectiveVersionNumber"}
        }

        for payload in case["accepts"]:
            assert (
                await core.interpreter_core_trigger(_trigger(stripped, payload))
            ).status == "SUCCEEDED"
        for payload in case["refuses"]:
            with pytest.raises(RuntimeError, match="violates the declared context schema"):
                await core.interpreter_core_trigger(_trigger(stripped, payload))

    @pytest.mark.asyncio
    async def test_a_rewritten_block_accepts_what_the_published_one_would_have_refused(
        self,
    ) -> None:
        """The behaviour change the whole ticket is for, stated as one assertion.

        `referral` is a kind the tenant added AFTER this workflow was published. Against the
        PINNED block it is an undeclared property and the run dies on its first node; against the
        follow-latest block the gateway rewrote at dispatch it is simply accepted.
        """
        payload = {
            "encounter": {"chief_complaint": "cough"},
            "referral": {"reason": "rheumatology"},
        }
        pinned = dict(_CASES)["pinnedTriggerIsUnchanged"]["contextSchema"]
        rewritten = dict(_CASES)["followsLatestCarriesTheTenantPin"]["contextSchema"]

        with pytest.raises(RuntimeError, match="violates the declared context schema"):
            await core.interpreter_core_trigger(_trigger(pinned, payload))

        assert (
            await core.interpreter_core_trigger(_trigger(rewritten, payload))
        ).status == "SUCCEEDED"
