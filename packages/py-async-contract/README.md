# `hope-async-contract`

TASK-717: the normative async task/event envelope (identity, tenancy, type,
payload-or-claim-check, correlation, causation, idempotency key, schema
version), plus the idempotency-key and resume-token conventions, for the
HOPE Python services.

Full prose contract:
[`docs/architecture/agentic-workflow-platform/async-contract.md`](../../docs/architecture/agentic-workflow-platform/async-contract.md).

## Why it exists

TASK-722 and TASK-727 both emit events to external consumers and both have a
Python-side producer candidate. Without a settled envelope they would invent
one independently — the repo has a documented history of exactly that
outcome (`trace_propagation`, the claim-check pattern, the idempotency-key
grammar were each built once and hand-duplicated into a second language).

This package and its TypeScript twin (`@arcaai/async-contract`,
`packages/async-contract/`) are two independent encodings of the same
rules — a pydantic model here, a hand-written validator there — checked
against each other by `tests/test_parity.py`, which round-trips the SAME
example corpus (`packages/async-contract/src/__tests__/examples/*.json`)
through both. **That test is load-bearing.** If it is ever skipped or marked
flaky, this package joins the list of hand-maintained twins TASK-717 exists
to stop growing.

## Usage

```python
from hope_async_contract import (
    AsyncEnvelope,
    AsyncIdempotencyKey,
    encode_resume_token,
    envelope_problems,
    parse_async_envelope,
)

envelope = {
    "schemaVersion": 1,
    "id": "01907d3a-0000-7000-8000-000000000001",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "type": "text.stream.chunk",
    "occurredAt": "2026-08-16T12:00:00.000Z",
    "correlationId": "req-1",
    "causationId": None,
    "idempotencyKey": AsyncIdempotencyKey.text_chunk("task-1", 0),
    "payload": {"type": "chunk", "content": "hello"},
}

assert envelope_problems(envelope) == []          # [] means it conforms
parsed = parse_async_envelope(envelope)            # None on ANY conformance problem
```

## API

| Export | Purpose |
|---|---|
| `ASYNC_ENVELOPE_SCHEMA_VERSION` | `1`. |
| `AsyncEnvelope` | The pydantic model (`extra="forbid"`, camelCase aliases matching the wire and the TS type field-for-field). |
| `envelope_problems(value)` | Problems with a candidate envelope, as strings. Empty list = conforms. Never raises. |
| `parse_async_envelope(value)` | Refuse-if-unknown parse. Returns `None` for ANY conformance problem. |
| `ClaimCheckRef` | The claim-check shape, reused verbatim from `apps/harness/src/harness/temporal/claim_check.py:64-80`. |
| `MAX_IDEMPOTENCY_KEY_LENGTH`, `idempotency_key_problems(key)` | The idempotency-key grammar. |
| `AsyncIdempotencyKey` | Intent-derived key recipes (`stt_segment`, `text_chunk`, `workflow_node`, `webhook_delivery`). |
| `encode_resume_token(transport, cursor)` / `decode_resume_token(token)` | The opaque resume-token convention — same base64url alphabet as the TS twin, so tokens are cross-language decodable. |
| `RESUME_FROM_BEGINNING` | The well-known `"0-0"` Redis sentinel. |

## Install

A `uv` workspace member (root `pyproject.toml`) and an editable install in
the shared conda env `arcaenv`. Consumers declare it as
`hope-async-contract = { workspace = true }`.

Its ONE runtime dependency is `pydantic`, already declared by every uv
workspace member (`apps/{guardrail,nlp,text,harness,stt,tts}`), so adding it
as a member perturbs no existing resolution.

## Tests

```bash
conda run -n arcaenv pytest packages/py-async-contract
```

`tests/test_parity.py` is the one that matters most — it is the whole reason
this package pair exists (see "Why it exists" above).
