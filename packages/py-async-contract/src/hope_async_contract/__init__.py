"""hope_async_contract — the normative async task/event envelope (TASK-717).

Identity, tenancy, type, payload-or-claim-check, correlation, causation,
idempotency key, schema version — plus the idempotency-key and resume-token
conventions. See ``hope_async_contract.envelope`` for the contract and
``docs/architecture/agentic-workflow-platform/async-contract.md`` for the
full prose design.
"""

from hope_async_contract.envelope import (
    ASYNC_ENVELOPE_SCHEMA_VERSION,
    AsyncEnvelope,
    ClaimCheckRef,
    envelope_problems,
    parse_async_envelope,
)
from hope_async_contract.idempotency import (
    MAX_IDEMPOTENCY_KEY_LENGTH,
    AsyncIdempotencyKey,
    idempotency_key_problems,
)
from hope_async_contract.resume_token import (
    RESUME_FROM_BEGINNING,
    decode_resume_token,
    encode_resume_token,
)

__all__ = [
    "ASYNC_ENVELOPE_SCHEMA_VERSION",
    "MAX_IDEMPOTENCY_KEY_LENGTH",
    "RESUME_FROM_BEGINNING",
    "AsyncEnvelope",
    "AsyncIdempotencyKey",
    "ClaimCheckRef",
    "decode_resume_token",
    "encode_resume_token",
    "envelope_problems",
    "idempotency_key_problems",
    "parse_async_envelope",
]
