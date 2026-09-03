"""Python <-> TypeScript parity — the whole reason this package pair exists.

Round-trips the SAME example corpus (`packages/async-contract/src/__tests__/
examples/*.json`) that the TypeScript package's own test uses
(`packages/async-contract/src/__tests__/envelope.test.ts`), and asserts this
package's verdict agrees with the ground truth established, independently,
by validating `packages/async-contract/schema/async-envelope.v1.json` (draft
2020-12) against each fixture with `jsonschema.Draft202012Validator` —
the SAME ground truth the TypeScript parity test asserts against.

If this test is ever skipped or marked flaky, `hope_async_contract` joins the
list of hand-maintained twins (`trace_propagation`, `redis_streams`, the
harness signal bodies) was written to stop growing. See the design
doc, Risk 2.

Also proves the resume-token wire format is cross-language compatible: a
token minted by ``encode_resume_token`` here must decode in TypeScript, and
vice versa — this test checks the Python round trip and pins the base64url
alphabet (no ``+``/``/``/``=``) that makes it so.
"""

from __future__ import annotations

import json
from pathlib import Path

import jsonschema
import pytest
from jsonschema import Draft202012Validator

from hope_async_contract.envelope import envelope_problems
from hope_async_contract.resume_token import decode_resume_token, encode_resume_token

PACKAGES_DIR = Path(__file__).resolve().parents[2]
SCHEMA_PATH = PACKAGES_DIR / "async-contract" / "schema" / "async-envelope.v1.json"
EXAMPLES_DIR = PACKAGES_DIR / "async-contract" / "src" / "__tests__" / "examples"

with SCHEMA_PATH.open() as f:
    SCHEMA = json.load(f)

Draft202012Validator.check_schema(SCHEMA)
_VALIDATOR = Draft202012Validator(SCHEMA)


def _schema_valid(value: object) -> bool:
    return next(_VALIDATOR.iter_errors(value), None) is None


CASES = ["inline-payload", "claim-check-payload", "invalid-both"]


@pytest.mark.parametrize("name", CASES)
def test_python_validator_agrees_with_the_schema(name: str) -> None:
    value = json.loads((EXAMPLES_DIR / f"{name}.json").read_text())
    schema_valid = _schema_valid(value)
    python_valid = envelope_problems(value) == []
    assert (
        python_valid == schema_valid
    ), f"{name}: schema says valid={schema_valid}, hope_async_contract says valid={python_valid}"


def test_schema_itself_is_a_valid_draft_2020_12_document() -> None:
    # Re-asserts what module load already proved (check_schema above would have
    # raised at import time) — kept as an explicit, independently-readable test.
    jsonschema.Draft202012Validator.check_schema(SCHEMA)


def test_schema_required_fields_match_the_pydantic_model() -> None:
    """The 8 unconditionally-required envelope keys agree in both artifacts.

    `payload`/`payloadRef` are excluded on both sides — they are governed by
    the schema's `oneOf`, not its top-level `required` list, and by the
    pydantic model's `_validate_payload_xor_ref` model validator rather than
    a field default. Full JSON-Schema-object equality is NOT asserted here:
    the pydantic model and the hand-written TS validator are two independent
    encodings of the same rules, not a shared code path, so the example-corpus
    round trip above — not a schema dump diff — is this test's real parity
    guarantee.
    """
    from hope_async_contract.envelope import AsyncEnvelope

    schema_required = set(SCHEMA["required"])
    pydantic_required_aliases = {
        (field.alias or name)
        for name, field in AsyncEnvelope.model_fields.items()
        if field.is_required()
    }
    assert schema_required == pydantic_required_aliases


def test_resume_token_round_trips_within_python() -> None:
    token = encode_resume_token("redis-stream", "1723800000000-0")
    assert decode_resume_token(token) == {
        "transport": "redis-stream",
        "cursor": "1723800000000-0",
    }


def test_resume_token_alphabet_is_cross_language_safe() -> None:
    """base64url, no padding — the exact alphabet resume-token.ts also emits."""
    token = encode_resume_token("redis-stream", "1723800000000-0")
    assert "+" not in token
    assert "/" not in token
    assert "=" not in token
