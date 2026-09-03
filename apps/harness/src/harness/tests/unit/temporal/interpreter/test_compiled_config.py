"""RED-first tests for compiled-config parsing/admission (Task 5, contracts)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from harness.temporal.interpreter.compiled_config import (
    CompiledWorkflowConfig,
    InterpreterConfigError,
    canonical_json,
    parse_and_verify,
)

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[8]
    / "packages"
    / "workflow-contract"
    / "src"
    / "__tests__"
    / "fixtures"
    / "canonical-json-fixtures.json"
)


def _load_canonical_json_parity_cases() -> list[dict]:
    if not _FIXTURE_PATH.is_file():
        return []
    with _FIXTURE_PATH.open(encoding="utf-8") as f:
        return json.load(f)["cases"]


def _sample_body(**overrides) -> dict:
    body = {
        "formatVersion": 1,
        "definitionId": "11111111-1111-1111-1111-111111111111",
        "slug": "smoke-test",
        "versionNumber": 1,
        "tenantId": "22222222-2222-2222-2222-222222222222",
        "paletteKey": "summarization",
        "compiledAt": "2026-08-16T00:00:00.000Z",
        "compilerVersion": "0.1.0",
        "registryChecksum": "abc123",
        "ruleSetVersion": 1,
        "stages": [
            {
                "stageIndex": 0,
                "nodes": [
                    {
                        "nodeId": "n1",
                        "type": "noop",
                        "activity": "interpreter.noop",
                        "config": {},
                        "timeoutSeconds": 30,
                        "retry": {
                            "maximumAttempts": 2,
                            "initialIntervalSeconds": 1,
                            "backoffCoefficient": 2,
                        },
                        "inputs": [],
                        "onError": "degrade",
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
    body.update(overrides)
    return body


def _signed_document(**overrides) -> str:
    body = _sample_body(**overrides)
    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    return json.dumps({**body, "checksum": checksum})


class TestCanonicalJson:
    def test_key_order_does_not_affect_output(self):
        a = canonical_json({"b": 1, "a": 2})
        b = canonical_json({"a": 2, "b": 1})
        assert a == b

    def test_array_order_is_preserved(self):
        assert canonical_json([3, 1, 2]) == "[3,1,2]"

    def test_whole_number_float_drops_trailing_zero(self):
        assert canonical_json(2.0) == "2"


class TestParseAndVerifyHappyPath:
    def test_valid_signed_document_parses(self):
        doc = _signed_document()
        config = parse_and_verify(doc)
        assert isinstance(config, CompiledWorkflowConfig)
        assert config.format_version == 1
        assert config.stages[0].nodes[0].type == "noop"


class TestFormatVersion:
    def test_unsupported_format_version_rejected(self):
        doc = _signed_document(formatVersion=2)
        with pytest.raises(InterpreterConfigError) as exc:
            parse_and_verify(doc)
        assert exc.value.code in ("unsupported_format_version", "checksum_mismatch")


class TestChecksum:
    def test_tampered_body_fails_checksum(self):
        body = _sample_body()
        checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
        tampered = {**body, "slug": "tampered", "checksum": checksum}
        with pytest.raises(InterpreterConfigError) as exc:
            parse_and_verify(json.dumps(tampered))
        assert exc.value.code == "checksum_mismatch"


class TestGateAdmission:
    """Gate admission narrowed, not removed.

    This used to be a blanket refusal of any non-empty `gates` (`gates_not_supported_v1`). The
    interpreter now executes ONE blocking gate as a child workflow, so what is admitted narrowed
    to exactly that shape — every other shape is still refused loudly at admission rather than
    silently walked past.
    """

    @staticmethod
    def _doc(gates):
        body = _sample_body(gates=gates)
        checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
        return json.dumps({**body, "checksum": checksum})

    @staticmethod
    def _gate(node_id="g1", blocking=True):
        return {
            "nodeId": node_id,
            "gateType": "consultation.hitlGate",
            "blocking": blocking,
            "timeoutSeconds": 60,
            "onTimeout": "TIMED_OUT",
        }

    def test_one_blocking_gate_is_admitted(self):
        config = parse_and_verify(self._doc([self._gate()]))
        assert len(config.gates) == 1
        assert config.gates[0].node_id == "g1"

    def test_two_gates_rejected(self):
        # One durable human wait per run: a second gate would need a second child workflow id and
        # a second approve route, neither of which exists. The validator's SINGLE_ENTRY rule on
        # the gate node type enforces this upstream, so reaching here means a compiler bug.
        with pytest.raises(InterpreterConfigError) as exc:
            parse_and_verify(self._doc([self._gate("g1"), self._gate("g2")]))
        assert exc.value.code == "too_many_gates"

    def test_non_blocking_gate_rejected(self):
        # "Carry on without the human" is a different authority model, not a variation of this
        # one — refused rather than approximated.
        with pytest.raises(InterpreterConfigError) as exc:
            parse_and_verify(self._doc([self._gate(blocking=False)]))
        assert exc.value.code == "non_blocking_gate_not_supported"

    def test_gates_not_a_list_rejected(self):
        with pytest.raises(InterpreterConfigError) as exc:
            parse_and_verify(self._doc({"nodeId": "g1"}))
        assert exc.value.code == "invalid_shape"

    def test_empty_gates_still_admitted(self):
        # Every pre-Phase-B config: the shape that was the ONLY admitted one.
        assert parse_and_verify(self._doc([])).gates == []


class TestMalformed:
    def test_malformed_json_rejected(self):
        with pytest.raises(InterpreterConfigError) as exc:
            parse_and_verify("{not json")
        assert exc.value.code == "malformed_json"


class TestDocumentTemplateRefs:
    """the compiled artifact pins WHICH document shape each generation
    node produces, the same way ``promptTemplateRefs`` pins its prompt.

    This model is ``extra='forbid'`` throughout, so it is not enough that the
    TypeScript compiler emits the field: an interpreter that does not KNOW it rejects
    every compiled config the moment the emitter ships. That is why all four sides of
    this contract move in one commit.
    """

    def test_document_template_refs_are_parsed(self):
        refs = [
            {
                "nodeId": "n_synth",
                "templateId": "b2c9a1d4-7e36-4f80-8a15-3c6d9e2f0b47",
                "versionNumber": 2,
            }
        ]
        bindings = {**_sample_body()["policyBindings"], "documentTemplateRefs": refs}
        config = parse_and_verify(_signed_document(policyBindings=bindings))
        assert len(config.policy_bindings.document_template_refs) == 1
        assert config.policy_bindings.document_template_refs[0].node_id == "n_synth"
        assert config.policy_bindings.document_template_refs[0].version_number == 2

    def test_an_unknown_key_inside_a_ref_is_still_refused(self):
        # `extra='forbid'` reaches into the new ref model too — the emitter and this
        # consumer agree on THREE keys or the document is refused, never best-effort read.
        refs = [
            {
                "nodeId": "n_synth",
                "templateId": "b2c9a1d4-7e36-4f80-8a15-3c6d9e2f0b47",
                "versionNumber": 2,
                "shapeKey": "soap",
            }
        ]
        bindings = {**_sample_body()["policyBindings"], "documentTemplateRefs": refs}
        with pytest.raises(InterpreterConfigError):
            parse_and_verify(_signed_document(policyBindings=bindings))

    def test_a_config_without_the_field_still_parses(self):
        # Same posture as `promptTemplateRefs`/`entitlementKeys` on this model: a
        # default_factory, so an artifact compiled before the field existed is still
        # readable. Absence means "binds no shape", never "unknown".
        config = parse_and_verify(_signed_document())
        assert config.policy_bindings.document_template_refs == []


class TestCanonicalJsonParityFixture:
    """Cross-language checksum parity guard — the byte-for-byte proof
    README named as a known gap: "not verified byte-for-byte against a live
    Node.js execution of the TypeScript original". Both this class and
    `node-registry-parity`'s sibling, `canonical-json-parity-fixture.test.ts`, assert against
    the SAME fixture file (`canonical` / `checksum` were generated by the real TS
    `canonicalJson()`, not by this port) — a divergence in either implementation's byte output
    fails its own language's half of this guard.
    """

    def test_fixture_file_exists(self):
        assert _FIXTURE_PATH.is_file(), f"expected fixture at {_FIXTURE_PATH}"

    def test_fixture_is_non_trivial(self):
        assert len(_load_canonical_json_parity_cases()) >= 5

    @pytest.mark.parametrize(
        "case",
        _load_canonical_json_parity_cases(),
        ids=lambda case: case["name"],
    )
    def test_canonical_json_matches_the_committed_canonical_string(self, case):
        assert canonical_json(case["value"]) == case["canonical"]

    @pytest.mark.parametrize(
        "case",
        _load_canonical_json_parity_cases(),
        ids=lambda case: case["name"],
    )
    def test_sha256_of_canonical_matches_the_committed_checksum(self, case):
        computed = hashlib.sha256(canonical_json(case["value"]).encode("utf-8")).hexdigest()
        assert computed == case["checksum"]
