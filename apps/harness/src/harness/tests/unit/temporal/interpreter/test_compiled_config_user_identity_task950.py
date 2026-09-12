"""TASK-950 L2 test 19 — a compiled trigger carrying ``contextSchema.userIdentity``.

The TypeScript compiler now freezes the user-identity binding beside ``resolved`` on the
``core.trigger`` node's config (``compiler.ts``). Two things have to hold on this side, and
only one of them is obvious:

1.  **Admission accepts it.** Every model in ``compiled_config`` is ``extra='forbid'``, so an
    emitter shipping a key the interpreter does not know would make every compiled config
    unreadable the moment it lands — the failure mode ``documentTemplateRefs`` and
    ``contextSchemaRefs`` both had to move all four sides of the contract for. This one is
    admitted *by construction* rather than by a new field: the binding rides INSIDE
    ``CompiledNode.config``, which is a free ``dict[str, Any]`` because a node's config is the
    tenant's authored shape. The test pins that, because "it happens to work" and "it is
    guaranteed to work" look identical until someone tightens the model.

2.  **Validation is unchanged.** ``interpreter.core_trigger`` reads ``contextSchema.resolved``
    (then ``inline``) and NOTHING else, so the marker must not alter what a run payload is
    checked against — not the accepted payloads, not ``additionalProperties: false``, not the
    ``_authored_context`` envelope exemption. The marker declares a MAPPING the GATEWAY acts on
    before a run is dispatched; the harness is not in that path and must stay out of it.

Test only — no harness source changes.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest

from harness.temporal.interpreter.compiled_config import (
    InterpreterConfigError,
    canonical_json,
    parse_and_verify,
)
from harness.temporal.interpreter.models import (
    RESERVED_RUN_IDENTITY_KEYS,
    NodeActivityInput,
    RunSubject,
    sanitize_run_payload,
)
from harness.temporal.interpreter.nodes import core

_TENANT = "50000000-0000-0000-0000-000000000000"
_RUN = "01a08170-d1eb-7529-8b25-1f5350aff7d5"

#: The derived payload schema of the seeded `consultation_note_context`, plus the string
#: property a tenant would mark as its staff identifier.
_DERIVED_CONTEXT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "consultant_id": {"type": "string"},
        "visit_type": {"type": "string", "enum": ["new-visit", "revisit"]},
        "language": {"type": "string"},
    },
}

#: What `userIdentityBindingFromDefinition` derives, frozen onto the trigger by `compile()`.
_USER_IDENTITY: dict[str, str] = {"kindKey": "context", "field": "consultant_id"}


def _trigger_config(*, with_marker: bool) -> dict[str, Any]:
    context_schema: dict[str, Any] = {
        "contextSchemaId": "79000000-0000-0000-0001-000000000010",
        "versionNumber": 2,
        "resolved": _DERIVED_CONTEXT_SCHEMA,
    }
    if with_marker:
        context_schema["userIdentity"] = _USER_IDENTITY
    return {"kinds": ["consultation", "api"], "contextSchema": context_schema}


def _sample_body(*, with_marker: bool) -> dict[str, Any]:
    return {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "general-medicine-consultation",
        "versionNumber": 1,
        "tenantId": _TENANT,
        "paletteKey": "consultation",
        "compiledAt": "2026-09-11T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "abc123",
        "ruleSetVersion": 1,
        "stages": [
            {
                "stageIndex": 0,
                "nodes": [
                    {
                        "nodeId": "n_trigger",
                        "type": "core.trigger",
                        "activity": "interpreter.core_trigger",
                        "config": _trigger_config(with_marker=with_marker),
                        "timeoutSeconds": 30,
                        "retry": {
                            "maximumAttempts": 2,
                            "initialIntervalSeconds": 1,
                            "backoffCoefficient": 2,
                        },
                        "inputs": [],
                        "onError": "fail",
                        "emitsTrajectory": True,
                    }
                ],
            }
        ],
        "gates": [],
        "policyBindings": {
            "guardrailProfile": "STANDARD",
            "redactionRuleSetId": None,
            "promptTemplateRefs": [],
            "contextSchemaVersionId": None,
            "entitlementKeys": [],
        },
        "caps": {"maxTotalSeconds": 3600, "maxNodeSeconds": 900, "maxAttempts": 5},
    }


def _signed_document(*, with_marker: bool) -> str:
    body = _sample_body(with_marker=with_marker)
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    return json.dumps({**body, "checksum": checksum})


def _trigger(run_payload: dict[str, Any], *, with_marker: bool) -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n_trigger",
        node_type="core.trigger",
        config=_trigger_config(with_marker=with_marker),
        tenant_id=_TENANT,
        sandbox=False,
        bound_inputs={},
        run_payload=run_payload,
        run_id=_RUN,
    )


@pytest.fixture(autouse=True)
def _no_flush(monkeypatch: pytest.MonkeyPatch) -> None:
    """`record_and_flush` writes a trajectory step over the API client; these are pure tests."""

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)


class TestAdmission:
    def test_a_trigger_carrying_the_marker_is_admitted(self) -> None:
        config = parse_and_verify(_signed_document(with_marker=True))
        context_schema = config.stages[0].nodes[0].config["contextSchema"]
        # Carried through VERBATIM: the interpreter does not interpret it, but a reader of the
        # artifact (and the gateway that dispatched the run) can see what was frozen.
        assert context_schema["userIdentity"] == _USER_IDENTITY
        assert context_schema["resolved"] == _DERIVED_CONTEXT_SCHEMA

    def test_a_trigger_without_the_marker_is_admitted_unchanged(self) -> None:
        config = parse_and_verify(_signed_document(with_marker=False))
        assert "userIdentity" not in config.stages[0].nodes[0].config["contextSchema"]

    def test_the_marker_is_covered_by_the_checksum(self) -> None:
        # It is inside the signed body, so it cannot be added or edited after publish without
        # invalidating the artifact — the same protection `resolved` has.
        body = _sample_body(with_marker=False)
        checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
        tampered = _sample_body(with_marker=True)
        with pytest.raises(InterpreterConfigError) as exc:
            parse_and_verify(json.dumps({**tampered, "checksum": checksum}))
        assert exc.value.code == "checksum_mismatch"


class TestTriggerValidationIsUnaffected:
    """The marker never changes what a run payload is validated against."""

    @pytest.mark.asyncio
    async def test_a_valid_payload_still_passes(self) -> None:
        payload = {"consultant_id": "DR-950", "visit_type": "new-visit"}
        result = await core.interpreter_core_trigger(_trigger(payload, with_marker=True))
        assert result.status == "SUCCEEDED"
        # The published context is the full payload, exactly as without the marker.
        assert result.output == {"context": payload}

    @pytest.mark.asyncio
    async def test_the_marked_field_is_not_made_mandatory(self) -> None:
        # D-2: presence is governed by the schema's own `required` flags, never by the marker.
        # `_DERIVED_CONTEXT_SCHEMA` declares no `required`, so a payload omitting the identity
        # field is still valid — the marker says what to do with a value, not that there is one.
        result = await core.interpreter_core_trigger(
            _trigger({"visit_type": "revisit"}, with_marker=True)
        )
        assert result.status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_additionalProperties_false_still_bites(self) -> None:
        with pytest.raises(RuntimeError, match="violates the declared context schema"):
            await core.interpreter_core_trigger(
                _trigger({"not_a_declared_kind": "x"}, with_marker=True)
            )

    @pytest.mark.asyncio
    async def test_a_declared_value_is_still_type_checked(self) -> None:
        with pytest.raises(RuntimeError, match="violates the declared context schema"):
            await core.interpreter_core_trigger(
                _trigger({"visit_type": "third-visit"}, with_marker=True)
            )

    @pytest.mark.parametrize("key", RESERVED_RUN_IDENTITY_KEYS)
    @pytest.mark.asyncio
    async def test_the_authored_context_exemption_is_unchanged(self, key: str) -> None:
        # `_authored_context` still strips the server's own run envelope before validating.
        result = await core.interpreter_core_trigger(_trigger({key: "value"}, with_marker=True))
        assert result.status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_marked_and_unmarked_triggers_agree_on_every_outcome(self) -> None:
        """The strongest form of "unchanged": same input, same verdict, marker or not."""
        accepted = sanitize_run_payload(
            {"consultant_id": "DR-950", "language": "en"},
            RunSubject(consultationId="01a0816f-0000-7000-8000-000000000001"),
        )
        for with_marker in (True, False):
            result = await core.interpreter_core_trigger(
                _trigger(accepted, with_marker=with_marker)
            )
            assert result.status == "SUCCEEDED"
            assert result.output == {"context": accepted}

        for with_marker in (True, False):
            with pytest.raises(RuntimeError, match="violates the declared context schema"):
                await core.interpreter_core_trigger(
                    _trigger({"undeclared": 1}, with_marker=with_marker)
                )
