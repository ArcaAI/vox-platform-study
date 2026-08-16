"""RED-first tests for compiled-config parsing/admission (Task 5, contracts §2)."""

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
    / "docs"
    / "implementation"
    / "TASK-734-Workflow-Substrate-Second-Pass"
    / "contracts"
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


class TestCanonicalJsonParityFixture:
    """Cross-language checksum parity guard (TASK-734 Task 4) — the byte-for-byte proof
    TASK-718's README named as a known gap: "not verified byte-for-byte against a live
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
