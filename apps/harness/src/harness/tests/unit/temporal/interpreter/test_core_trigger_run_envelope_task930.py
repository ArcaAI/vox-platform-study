"""TASK-930 D-2 — ``core.trigger`` validates the AUTHORED context, not the run envelope.

The §6.9 local run found the consultation plane dead at the first node. Every
consultation-plane run of ``general-medicine-consultation`` failed in ~230 ms with::

    core.trigger: run payload violates the declared context schema: (root): Additional
    properties are not allowed ('consultationId', 'externalPatientId', 'userId' were unexpected)

reproduced identically with ``{"input": {}}`` — so the rejected keys were the ones the SERVER
stamps, never anything a caller sent.

Two facts settle the contract:

* ``sanitize_run_payload`` (``models.py``) STRIPS ``RESERVED_RUN_IDENTITY_KEYS`` from a caller's
  payload unconditionally and re-stamps them from the server-resolved ``RunSubject``. So those
  five keys in ``run_payload`` are, by construction, the gateway's own envelope.
* The gateway REFUSES a caller who sends one (``exposure-palette-policy.ts`` →
  ``reservedIdentityKeysIn`` → 400 naming the key).

A context schema is authored to describe the CONTEXT an author supplies. Policing the envelope
against it removes nothing a caller could have violated (they cannot reach those keys at all) and
kills the clinical plane. So the validated object is ``run_payload`` minus the reserved envelope
keys — which keeps ``additionalProperties: false`` fully sharp for everything an author DID
declare, as the third test here pins.

The published ``context`` output is unchanged: identity stays readable downstream exactly as it is
today.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import (
    RESERVED_RUN_IDENTITY_KEYS,
    NodeActivityInput,
    RunSubject,
    sanitize_run_payload,
)
from harness.temporal.interpreter.nodes import core

_TENANT = "50000000-0000-0000-0000-000000000000"
_RUN = "01a08170-d1eb-7529-8b25-1f5350aff7d5"

# The derived payload schema of the seeded `consultation_note_context`, as
# `payloadSchemaFromDefinition` builds it: closed, one property per declared kind.
_DERIVED_CONTEXT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "visit_type": {"type": "string", "enum": ["new-visit", "revisit"]},
        "current_department": {"type": "string"},
        "language": {"type": "string"},
        "chief_complaint": {"type": "string"},
    },
}


def _trigger(run_payload: dict[str, Any]) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n_trigger",
        node_type="core.trigger",
        config={
            "kinds": ["consultation", "api"],
            "contextSchema": {
                "contextSchemaId": "ctx-1",
                "versionNumber": 1,
                "resolved": _DERIVED_CONTEXT_SCHEMA,
            },
            "guardrail": {"enabled": True},
        },
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={},
        run_payload=run_payload,
        run_id=_RUN,
    )


@pytest.fixture(autouse=True)
def _no_flush(monkeypatch: pytest.MonkeyPatch) -> None:
    """`record_and_flush` writes a trajectory step over the API client; this is a pure test."""

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)


class TestTheRunEnvelopeIsNotAuthoredContext:
    @pytest.mark.asyncio
    async def test_a_consultation_dispatch_passes_the_trigger(self) -> None:
        # Exactly what the dispatcher produces for a consultation open: an empty caller payload,
        # plus the server-resolved subject.
        payload = sanitize_run_payload(
            {},
            RunSubject(
                consultationId="01a0816f-0000-7000-8000-000000000001",
                externalPatientId="LOCAL-LANE-PT-0001",
                userId="60000000-0000-0000-0000-000000000000",
            ),
        )
        assert set(payload) == {"consultationId", "externalPatientId", "userId"}

        result = await core.interpreter_core_trigger(_trigger(payload))

        assert result.status == "SUCCEEDED"
        # The identity still travels: `run_identity(...)` readers and any `trigger.context.*`
        # binding see exactly what they saw before.
        assert result.output == {"context": payload}

    @pytest.mark.asyncio
    async def test_the_envelope_is_ignored_alongside_authored_context(self) -> None:
        payload = sanitize_run_payload(
            {"visit_type": "new-visit", "current_department": "GEN"},
            RunSubject(consultationId="01a0816f-0000-7000-8000-000000000002"),
        )
        result = await core.interpreter_core_trigger(_trigger(payload))
        assert result.status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_additionalProperties_false_still_bites_on_an_authored_key(self) -> None:
        # The exemption is exactly the five envelope keys — not a hole in the schema gate.
        with pytest.raises(RuntimeError, match="violates the declared context schema"):
            await core.interpreter_core_trigger(_trigger({"not_a_declared_kind": "x"}))

    @pytest.mark.asyncio
    async def test_a_declared_value_is_still_type_checked(self) -> None:
        with pytest.raises(RuntimeError, match="violates the declared context schema"):
            await core.interpreter_core_trigger(_trigger({"visit_type": "third-visit"}))

    @pytest.mark.parametrize("key", RESERVED_RUN_IDENTITY_KEYS)
    @pytest.mark.asyncio
    async def test_every_reserved_envelope_key_is_exempt(self, key: str) -> None:
        # `jobId` and `sessionId` reach `run_payload` on other dispatch paths; the exemption is
        # the whole declared tuple, so no future stamp re-opens this defect one key at a time.
        result = await core.interpreter_core_trigger(_trigger({key: "value"}))
        assert result.status == "SUCCEEDED"
