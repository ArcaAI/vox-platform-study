"""The async task/event envelope.

Normative prose + rationale: ``docs/programs/agentic-workflow-platform/
async-contract.md Normative machine artifact:
``packages/async-contract/schema/async-envelope.v1.json`` (draft 2020-12).

This module and its TypeScript twin (``packages/async-contract/src/
envelope.ts``) are two independent encodings of the SAME rules — a pydantic
model here, a hand-written validator there, both dependency-light by design
(this package's only dependency is ``pydantic``, already universal; the TS
side is dependency-free outright). Because two independent encodings can
silently drift, ``tests/test_parity.py`` round-trips the SAME example corpus
through both. That test is load-bearing — see the design doc, Risk 2.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from pydantic.alias_generators import to_camel

from hope_async_contract.idempotency import idempotency_key_problems

#: This document defines version 1 only. A future version is a NEW literal, never a mutation.
ASYNC_ENVELOPE_SCHEMA_VERSION: Literal[1] = 1

_UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_TYPE_PATTERN = re.compile(r"^[a-z0-9]+(\.[a-z0-9_]+){1,4}$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

UuidStr = Annotated[str, Field(pattern=_UUID_PATTERN.pattern)]


class ClaimCheckRef(BaseModel):
    """A small out-of-band reference to an offloaded blob (the *claim check*).

    Verbatim shape of ``apps/harness/src/harness/temporal/claim_check.py:64-80``
    (``ClaimCheckRef``) — same six fields, same content-addressed sha256,
    same fail-loud posture. ``content_type`` maps to the wire's ``contentType``
    by alias, matching the TypeScript ``ClaimCheckRef`` field-for-field.
    """

    model_config = ConfigDict(
        extra="forbid", alias_generator=to_camel, populate_by_name=True
    )

    store: str = Field(min_length=1)
    bucket: str = Field(min_length=1)
    key: str = Field(min_length=1)
    size: int = Field(ge=0)
    sha256: str = Field(pattern=_SHA256_PATTERN.pattern)
    content_type: str = Field(min_length=1)


class AsyncEnvelope(BaseModel):
    """The envelope. ``extra="forbid"`` mirrors the schema's `additionalProperties: false`.

    ``payload``/``payload_ref`` both default to ``None`` at the field level
    (pydantic has no clean XOR for object shapes); "exactly one of the two
    was explicitly supplied" is enforced by the `_validate_payload_xor_ref`
    model validator below, using ``model_fields_set`` the same way the
    TypeScript validator uses `hasOwnProperty`.
    """

    model_config = ConfigDict(
        extra="forbid", alias_generator=to_camel, populate_by_name=True
    )

    schema_version: Literal[1]
    id: UuidStr
    tenant_id: UuidStr
    type: str = Field(max_length=200, pattern=_TYPE_PATTERN.pattern)
    occurred_at: str
    correlation_id: str = Field(min_length=1, max_length=255)
    causation_id: UuidStr | None
    idempotency_key: str
    payload: Any | None = None
    payload_ref: ClaimCheckRef | None = None

    @model_validator(mode="after")
    def _validate_idempotency_key(self) -> AsyncEnvelope:
        problems = idempotency_key_problems(self.idempotency_key)
        if problems:
            raise ValueError("; ".join(problems))
        return self

    @model_validator(mode="after")
    def _validate_occurred_at(self) -> AsyncEnvelope:
        try:
            datetime.fromisoformat(self.occurred_at)
        except ValueError as exc:
            raise ValueError("occurredAt must be an ISO-8601 date-time string") from exc
        return self

    @model_validator(mode="after")
    def _validate_payload_xor_ref(self) -> AsyncEnvelope:
        has_payload = "payload" in self.model_fields_set
        has_ref = "payload_ref" in self.model_fields_set
        if has_payload == has_ref:
            raise ValueError("exactly one of payload or payloadRef must be present")
        return self


def envelope_problems(value: object) -> list[str]:
    """Problems with a candidate envelope, as human-readable strings.

    Empty list = conforms. Never raises — mirrors ``asyncEnvelopeProblems``
    on the TypeScript side.
    """
    if not isinstance(value, dict):
        return ["envelope must be a JSON object"]
    try:
        AsyncEnvelope.model_validate(value)
    except ValidationError as exc:
        return [str(err["msg"]) for err in exc.errors()]
    return []


def parse_async_envelope(value: object) -> AsyncEnvelope | None:
    """Refuse-if-unknown parse.

    Returns ``None`` for ANY conformance problem (including an unknown
    ``schemaVersion``, rejected automatically by the ``Literal[1]`` field
    type) — the caller MUST NOT proceed on ``None``.
    """
    if not isinstance(value, dict):
        return None
    try:
        return AsyncEnvelope.model_validate(value)
    except ValidationError:
        return None
