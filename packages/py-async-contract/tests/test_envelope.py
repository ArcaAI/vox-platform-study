"""AsyncEnvelope / ClaimCheckRef — mirrors src/__tests__/envelope.test.ts."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from hope_async_contract.envelope import (
    ASYNC_ENVELOPE_SCHEMA_VERSION,
    AsyncEnvelope,
    envelope_problems,
    parse_async_envelope,
)

EXAMPLES_DIR = (
    Path(__file__).resolve().parents[2]
    / "async-contract"
    / "src"
    / "__tests__"
    / "examples"
)


def load_example(name: str) -> dict:
    return json.loads((EXAMPLES_DIR / f"{name}.json").read_text())


VALID_INLINE = load_example("inline-payload")
VALID_CLAIM_CHECK = load_example("claim-check-payload")
INVALID_BOTH = load_example("invalid-both")


class TestEnvelopeProblems:
    def test_accepts_inline_payload(self) -> None:
        assert envelope_problems(VALID_INLINE) == []

    def test_accepts_claim_check_payload(self) -> None:
        assert envelope_problems(VALID_CLAIM_CHECK) == []

    def test_rejects_both_payload_and_payload_ref(self) -> None:
        problems = envelope_problems(INVALID_BOTH)
        assert any("exactly one of payload or payloadRef" in p for p in problems)

    def test_rejects_neither_payload_nor_payload_ref(self) -> None:
        without_payload = {k: v for k, v in VALID_INLINE.items() if k != "payload"}
        problems = envelope_problems(without_payload)
        assert any("exactly one of payload or payloadRef" in p for p in problems)

    def test_rejects_an_unknown_schema_version(self) -> None:
        problems = envelope_problems({**VALID_INLINE, "schemaVersion": 2})
        assert problems != []

    def test_rejects_a_non_uuid_id(self) -> None:
        problems = envelope_problems({**VALID_INLINE, "id": "not-a-uuid"})
        assert problems != []

    def test_rejects_a_type_that_is_not_lowercase_dotted(self) -> None:
        problems = envelope_problems({**VALID_INLINE, "type": "Not.Valid"})
        assert problems != []

    def test_accepts_a_null_causation_id(self) -> None:
        assert envelope_problems({**VALID_INLINE, "causationId": None}) == []

    def test_rejects_a_non_uuid_non_null_causation_id(self) -> None:
        problems = envelope_problems({**VALID_INLINE, "causationId": "nope"})
        assert problems != []

    def test_rejects_an_unexpected_top_level_property(self) -> None:
        problems = envelope_problems({**VALID_INLINE, "traceparent": "00-..."})
        assert problems != []

    def test_rejects_a_non_dict_value(self) -> None:
        assert envelope_problems("not-a-dict") == ["envelope must be a JSON object"]


class TestParseAsyncEnvelope:
    def test_returns_the_model_when_it_conforms(self) -> None:
        parsed = parse_async_envelope(VALID_INLINE)
        assert parsed is not None
        assert parsed.id == VALID_INLINE["id"]

    def test_returns_none_for_an_unknown_schema_version(self) -> None:
        assert parse_async_envelope({**VALID_INLINE, "schemaVersion": 999}) is None

    def test_returns_none_for_any_other_conformance_problem(self) -> None:
        assert parse_async_envelope({"not": "an envelope"}) is None


def test_schema_version_constant_is_1() -> None:
    assert ASYNC_ENVELOPE_SCHEMA_VERSION == 1


def test_direct_model_construction_raises_on_a_bad_value() -> None:
    with pytest.raises(ValidationError):
        AsyncEnvelope.model_validate({**VALID_INLINE, "idempotencyKey": ""})
