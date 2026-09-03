"""Tier 3 — the node-boundary schema check (c).

Tiers 1 and 2 live in the EDITOR: tier 1 kind-checks a connection and blocks, tier 2 warns about
shallow structural mismatch and never blocks. Neither runs at execution time and neither sees the
actual value. Tier 3 is the only tier that sees data, and it is therefore the only one that can
tell an author their run did not produce what their schema promised.

The declaration was carried on the compiled config from with the enforcement deliberately
absent, because claiming to validate without an evaluator is a false safety claim. This file is the
evidence the claim is now true.
"""

from __future__ import annotations

import pytest
from temporalio.testing import ActivityEnvironment

from harness.temporal.interpreter.models import NodeActivityInput, TrajectoryContext
from harness.temporal.interpreter.nodes.agentic import (
    IoSchemaViolation,
    interpreter_agentic_input,
    interpreter_agentic_output,
)


@pytest.fixture
def env() -> ActivityEnvironment:
    """The node activities emit a trajectory step, which needs a real activity context."""
    return ActivityEnvironment()


_STRICT = {
    "type": "object",
    "required": ["patientId"],
    "properties": {"patientId": {"type": "string"}},
}


def _payload(node_type: str, config: dict, *, run_payload=None, bound=None) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n1",
        node_type=node_type,
        config=config,
        tenant_id="t-1",
        sandbox=True,
        trajectory=TrajectoryContext(
            tenant_id="t-1",
            seq=1,
            workflow_version_id="v-1",
            stage_id="0",
            node_id="n1",
            node_type=node_type,
        ),
        bound_inputs=bound or {},
        run_payload=run_payload or {},
    )


class TestConformingValuesPass:
    async def test_input_accepts_a_conforming_payload(self, env):
        result = await env.run(
            interpreter_agentic_input,
            _payload(
                "agentic.input",
                {"ioSchema": _STRICT},
                run_payload={"patientId": "p-1"},
            ),
        )
        assert result.status == "SUCCEEDED"

    async def test_a_node_with_no_ioSchema_is_untouched(self, env):
        """Absent schema must cost nothing — this is what keeps tier 3 opt-in."""
        result = await env.run(
            interpreter_agentic_input, _payload("agentic.input", {}, run_payload={"anything": True})
        )
        assert result.status == "SUCCEEDED"


class TestViolationsAreReported:
    async def test_input_FAILS_by_default_because_it_has_nothing_sound_to_pass_on(self, env):
        """An entry point whose payload does not match its declared shape cannot hand anything
        downstream, so the default is `fail` — which RAISES, because an activity cannot report
        FAILED and inventing a DEGRADED would quietly downgrade the author's declaration."""
        with pytest.raises(IoSchemaViolation) as excinfo:
            await env.run(
                interpreter_agentic_input,
                _payload("agentic.input", {"ioSchema": _STRICT}, run_payload={"wrong": 1}),
            )
        assert "io_schema_violation" in str(excinfo.value)
        assert "patientId" in str(excinfo.value)

    async def test_output_DEGRADES_by_default_because_it_produced_something_inspectable(self, env):
        result = await env.run(
            interpreter_agentic_output,
            _payload("agentic.output", {"ioSchema": _STRICT}, bound={"in": {"wrong": 1}}),
        )
        assert result.status == "DEGRADED"
        assert result.reason is not None and "io_schema_violation" in result.reason

    async def test_onSchemaViolation_overrides_the_default_in_both_directions(self, env):
        # An entry point the author is willing to let through.
        lenient = await env.run(
            interpreter_agentic_input,
            _payload(
                "agentic.input",
                {"ioSchema": _STRICT, "onSchemaViolation": "degrade"},
                run_payload={"wrong": 1},
            ),
        )
        assert lenient.status == "DEGRADED"

        # An exit point the author wants stopped.
        with pytest.raises(IoSchemaViolation):
            await env.run(
                interpreter_agentic_output,
                _payload(
                    "agentic.output",
                    {"ioSchema": _STRICT, "onSchemaViolation": "fail"},
                    bound={"in": {"wrong": 1}},
                ),
            )

    async def test_the_violation_names_WHERE_it_failed(self, env):
        """A violation an author cannot locate is barely better than none."""
        nested = {
            "type": "object",
            "properties": {"vitals": {"type": "object", "required": ["bp"]}},
            "required": ["vitals"],
        }
        result = await env.run(
            interpreter_agentic_output,
            _payload(
                "agentic.output",
                {"ioSchema": nested, "onSchemaViolation": "degrade"},
                bound={"in": {"vitals": {"hr": 70}}},
            ),
        )
        assert result.reason is not None
        assert "vitals" in result.reason


class TestAMalformedSchemaIsReportedNotCrashed:
    async def test_an_invalid_ioSchema_is_a_violation_not_a_stack_trace(self, env):
        """The schema is TENANT-AUTHORED. Someone will type an invalid one, and they should see
        that — not a workflow that died with a jsonschema traceback."""
        result = await env.run(
            interpreter_agentic_output,
            _payload(
                "agentic.output",
                {"ioSchema": {"type": "not-a-real-type"}, "onSchemaViolation": "degrade"},
                bound={"in": {"anything": 1}},
            ),
        )
        assert result.status == "DEGRADED"
        assert result.reason is not None and "not a valid JSON Schema" in result.reason
