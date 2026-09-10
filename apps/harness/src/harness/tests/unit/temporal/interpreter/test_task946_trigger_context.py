"""TASK-946 D1 / OD-3 — `trigger.context.*` is the canonical namespace on BOTH lanes.

The defect, from the Temporal history of run `01a08a8d-65fb-742b-824e-1c94af99e898`
(2026-09-10): `interpreter.core_condition` for the seeded `n_visit` node completed

    {"errors":[{"branch":"new_visit","error":"no such key: 'context'"},
               {"branch":"revisit","error":"no such key: 'context'"}],
     "taken_handle":"else"}

so every one of the eleven seeded ArcaAI department graphs documented every encounter — first
visit or follow-up — with the `else` branch's note shape. The graphs are right: the realtime lane
(`live-documentation.service.ts#realtimeRunContext`) publishes `{trigger: {context}, vars, nodes}`
and the seed was authored against it. The DURABLE lane published the flattened context as
`trigger` itself, so `trigger.context` did not exist and the CEL read raised rather than routed.

OD-3 moves the durable lane: `_run_context()` nests the merged context (the `core.trigger`
node's published context, overlaid by the live handoff's) under `trigger.context`, and keeps the
flat top level so nothing that reads `trigger.<key>` today — a published graph's binding, the
`{{context.…}}` alias `_prompt_scope` builds, the run identity — changes meaning.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.claim_check import ClaimCheckRef
from harness.temporal.interpreter.models import InterpreterInput, NodeActivityInput
from harness.temporal.interpreter.nodes import core
from harness.temporal.interpreter.nodes._consultation_shared import run_identity
from harness.temporal.interpreter.templating import render_template
from harness.temporal.interpreter.workflow import WorkflowInterpreter

_TENANT = "10000000-0000-0000-0000-000000000001"
_CONSULTATION = "01a0816f-0000-7000-8000-0000000009e4"
_USER = "60000000-0000-0000-0000-000000000000"

#: The run payload a consultation dispatch stamps: `RunSubject` identity and nothing else.
_RUN_PAYLOAD: dict[str, Any] = {
    "consultationId": _CONSULTATION,
    "externalPatientId": "MRN-42",
    "userId": _USER,
}

#: Verbatim from `packages/database/src/prisma/db_main/seed/28-workflow-library.ts` — the
#: `n_visit` node every ArcaAI department graph carries. KEY_PATTERN forbids a hyphen in a branch
#: key, so the handles are `new_visit`/`revisit` while the compared VALUE is the schema's enum.
_SEEDED_VISIT_BRANCHES = [
    {
        "key": "new_visit",
        "label": "New / referral visit",
        "when": "trigger.context.visit_type == 'new-visit'",
    },
    {
        "key": "revisit",
        "label": "Follow-up visit",
        "when": "trigger.context.visit_type == 'revisit'",
    },
]


@pytest.fixture(autouse=True)
def _no_trajectory(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)


def _run_context(live_context: dict[str, Any], *, published: dict[str, Any] | None = None) -> dict:
    """The run context the REAL `_run_context()` publishes for a consultation-bound run.

    Built through the interpreter rather than by hand: the shape under test is exactly what the
    durable walk hands `interpreter.core_condition`, and a hand-written copy of it would keep
    passing after the code stopped producing it.
    """
    interpreter = WorkflowInterpreter()
    interpreter._node_types["n_trigger"] = "core.trigger"
    interpreter._node_outputs["n_trigger"] = {
        "context": dict(_RUN_PAYLOAD if published is None else published)
    }
    interpreter._live_context = dict(live_context)
    return interpreter._run_context()


def _condition_payload(run_context: dict[str, Any]) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n_visit",
        node_type="core.condition",
        config={"branches": _SEEDED_VISIT_BRANCHES},
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={},
        run_payload=dict(_RUN_PAYLOAD),
        run_context=run_context,
    )


class TestTheSeededVisitConditionRoutes:
    """D1 — the whole point: `n_visit` must evaluate, not error into `else`."""

    @pytest.mark.parametrize(
        ("visit_type", "expected"),
        [
            pytest.param("revisit", "revisit", id="revisit"),
            pytest.param("new-visit", "new_visit", id="new-visit"),
        ],
    )
    async def test_the_handoff_s_visit_type_takes_its_branch(
        self, visit_type: str, expected: str
    ) -> None:
        run_context = _run_context({"visit_type": visit_type})

        result = await core.interpreter_core_condition(_condition_payload(run_context))

        assert result.taken_handle == expected
        assert result.output is not None
        evaluation = result.output["evaluation"]
        assert evaluation["errors"] == [], "a CEL error never routes a branch — it must not raise"
        assert evaluation["matched"] is True

    async def test_a_visit_type_no_branch_names_still_falls_through_to_else(self) -> None:
        """The `else` fall-through stays a real answer — it just stops being the ONLY one."""
        run_context = _run_context({"visit_type": "walk-in"})

        result = await core.interpreter_core_condition(_condition_payload(run_context))

        assert result.taken_handle == "else"
        assert result.output is not None
        assert result.output["evaluation"]["errors"] == []

    async def test_an_absent_visit_type_reports_the_gap_rather_than_routing(self) -> None:
        """No handoff key ⇒ the CEL read fails, which is recorded and takes no branch.

        This is the pre-OD-3 behaviour for EVERY run, and it stays the behaviour when the live
        lane genuinely sent no `visit_type` — the fix is that the namespace exists, not that a
        missing value is invented.
        """
        result = await core.interpreter_core_condition(_condition_payload(_run_context({})))

        assert result.taken_handle == "else"
        assert result.output is not None
        assert [e["branch"] for e in result.output["evaluation"]["errors"]] == [
            "new_visit",
            "revisit",
        ]


class TestTheRunContextShape:
    def test_the_merged_context_is_published_under_trigger_context(self) -> None:
        run_context = _run_context(
            {
                "visit_type": "revisit",
                "current_department": "Breast Oncology",
                "language": "en",
                "dna_style_text": "Terse. Abbreviates freely.",
                "dna_style_id": "rep-1",
            }
        )

        context = run_context["trigger"]["context"]
        assert context["visit_type"] == "revisit"
        assert context["current_department"] == "Breast Oncology"
        assert context["language"] == "en"
        assert context["dna_style_text"] == "Terse. Abbreviates freely."

    def test_the_flat_top_level_is_unchanged(self) -> None:
        """The nesting ADDS a namespace; it never moves a key out from under an existing read.

        Every published graph binding, `resolve_dotted_path(run_context, over)` on a `core.loop`
        and the `{{context.…}}` prompt alias all read the flat top level today.
        """
        run_context = _run_context({"dna_style_text": "Terse.", "visit_type": "revisit"})

        trigger = run_context["trigger"]
        assert trigger["consultationId"] == _CONSULTATION
        assert trigger["externalPatientId"] == "MRN-42"
        assert trigger["userId"] == _USER
        assert trigger["dna_style_text"] == "Terse."
        assert trigger["visit_type"] == "revisit"

    def test_identity_still_reaches_the_run_identity_readers(self) -> None:
        """The thirteen `run_identity(...)` readers take `run_payload`, which this never touches
        — and the identity is reachable on the published trigger too."""
        run_context = _run_context({"visit_type": "revisit"})

        identity = run_identity(_RUN_PAYLOAD)
        assert identity.consultation_id == _CONSULTATION
        assert identity.user_id == _USER
        assert run_context["trigger"]["consultationId"] == _CONSULTATION

    def test_the_handoff_wins_over_an_identically_named_payload_key(self) -> None:
        """R-16a's rule, restated under the nesting: the clinician's effective DNA style is
        resolved gateway-side and must never be settable from the caller's run payload."""
        run_context = _run_context(
            {"dna_style_text": "from the handoff"},
            published={**_RUN_PAYLOAD, "dna_style_text": "from the payload"},
        )

        assert run_context["trigger"]["context"]["dna_style_text"] == "from the handoff"
        assert run_context["trigger"]["dna_style_text"] == "from the handoff"

    def test_an_envelope_payload_is_not_double_wrapped(self) -> None:
        """A graph whose trigger schema declares the single `context` kind already publishes
        `{"context": {...}}`. `trigger.context.safe_age` must keep meaning what it means —
        nesting the envelope inside itself would move every seeded read one level down."""
        run_context = _run_context(
            {"visit_type": "revisit"},
            published={**_RUN_PAYLOAD, "context": {"safe_age": "41"}},
        )

        context = run_context["trigger"]["context"]
        assert context["safe_age"] == "41"
        assert context["visit_type"] == "revisit"
        assert "context" not in context


class TestThePromptAlias:
    def test_the_dna_style_still_renders_through_the_context_alias(self) -> None:
        """Constraint (a): the seeded `casenote-finalization` instruction renders
        `{{context.dna_style_text | default("")}}` and must keep resolving to the handoff value."""
        run_context = _run_context({"dna_style_text": "Terse. Abbreviates freely."})

        scope = core._prompt_scope({}, run_context)

        assert render_template("{{context.dna_style_text}}", scope) == "Terse. Abbreviates freely."
        assert render_template('{{context.dna_style_text | default("")}}', scope) == (
            "Terse. Abbreviates freely."
        )


class TestTheInterpreterStillBuildsAnInput:
    """A guard on the fixture above: `_run_context()` is an instance method on a real workflow
    class, so the test would silently stop exercising it if the constructor grew a dependency."""

    def test_the_interpreter_input_is_still_constructible(self) -> None:
        inp = InterpreterInput(
            run_id="run-946",
            session_id="session-946",
            tenant_id=_TENANT,
            workflow_version_id="wfv-946",
            config_ref=ClaimCheckRef(
                store="memory", bucket="harness-claim-check", key="cfg", size=1, sha256="0" * 64
            ),
        )
        assert inp.run_id == "run-946"
