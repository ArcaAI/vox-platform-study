"""RED-first tests for compiled-config parsing/admission (Task 5, contracts §2)."""

from __future__ import annotations

import hashlib
import json

import pytest

from harness.temporal.interpreter.compiled_config import (
    CompiledWorkflowConfig,
    InterpreterConfigError,
    canonical_json,
    parse_and_verify,
)


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


class TestGatesNotSupported:
    def test_non_empty_gates_rejected(self):
        body = _sample_body(
            gates=[
                {
                    "nodeId": "g1",
                    "gateType": "clinician",
                    "blocking": True,
                    "timeoutSeconds": 60,
                    "onTimeout": "TIMED_OUT",
                }
            ]
        )
        checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
        doc = json.dumps({**body, "checksum": checksum})
        with pytest.raises(InterpreterConfigError) as exc:
            parse_and_verify(doc)
        assert exc.value.code == "gates_not_supported_v1"


class TestMalformed:
    def test_malformed_json_rejected(self):
        with pytest.raises(InterpreterConfigError) as exc:
            parse_and_verify("{not json")
        assert exc.value.code == "malformed_json"
