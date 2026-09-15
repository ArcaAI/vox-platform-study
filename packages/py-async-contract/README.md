# hope-async-contract — the normative async envelope (Python)

The normative async task/event envelope (identity, tenancy, type, payload-or-claim-check,
correlation, causation, idempotency key, schema version), plus the idempotency-key and
resume-token conventions, plus a reusable conformance suite, for the HOPE Python services.

Full prose contract:
[`docs/programs/agentic-workflow-platform/async-contract.md`](../../docs/programs/agentic-workflow-platform/async-contract.md).

## Layout

| Path | What it holds |
|---|---|
| `src/hope_async_contract/envelope.py` | `AsyncEnvelope`, `ClaimCheckRef`, `envelope_problems`, `parse_async_envelope`, `ASYNC_ENVELOPE_SCHEMA_VERSION` |
| `src/hope_async_contract/idempotency.py` | `MAX_IDEMPOTENCY_KEY_LENGTH`, `idempotency_key_problems`, `AsyncIdempotencyKey` |
| `src/hope_async_contract/resume_token.py` | `encode_resume_token`/`decode_resume_token`, `RESUME_FROM_BEGINNING` |
| `src/hope_async_contract/conformance.py` | `assert_async_conformance`, `AsyncProducerUnderTest` — the Python mirror of the TS conformance suite |
| `tests/test_parity.py` | Round-trips the SAME example corpus as the TS package through both implementations — the cross-language lock |

## Commands

```bash
conda run -n arcaenv pytest packages/py-async-contract
```

`tests/test_parity.py` is the one that matters most — it is the whole reason this package pair
exists (see "Why it exists" below).

## How it works

### Why it exists

TASK-722 and TASK-727 both emit events to external consumers and both have a Python-side producer
candidate. Without a settled envelope they would invent one independently — the repo has a
documented history of exactly that outcome (`trace_propagation`, the claim-check pattern, the
idempotency-key grammar were each built once and hand-duplicated into a second language).

This package and its TypeScript twin (`@arcaai/async-contract`, `packages/async-contract/`) are two
independent encodings of the same rules — a pydantic model here, a hand-written validator there —
checked against each other by `tests/test_parity.py`, which round-trips the SAME example corpus
(`packages/async-contract/src/__tests__/examples/*.json`) through both. **That test is
load-bearing.** If it is ever skipped or marked flaky, this package joins the list of
hand-maintained twins it exists to stop growing.

### Usage

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

### API

| Export | Purpose |
|---|---|
| `ASYNC_ENVELOPE_SCHEMA_VERSION` | `1` |
| `AsyncEnvelope` | The pydantic model (`extra="forbid"`, camelCase aliases matching the wire and the TS type field-for-field) |
| `envelope_problems(value)` | Problems with a candidate envelope, as strings. Empty list = conforms. Never raises |
| `parse_async_envelope(value)` | Refuse-if-unknown parse. Returns `None` for ANY conformance problem |
| `ClaimCheckRef` | The claim-check shape, reused verbatim from `apps/harness/src/harness/temporal/claim_check.py` |
| `MAX_IDEMPOTENCY_KEY_LENGTH`, `idempotency_key_problems(key)` | The idempotency-key grammar |
| `AsyncIdempotencyKey` | Intent-derived key recipes (`stt_segment`, `text_chunk`, `workflow_node`, `webhook_delivery`) |
| `encode_resume_token(transport, cursor)` / `decode_resume_token(token)` | The opaque resume-token convention — same base64url alphabet as the TS twin, so tokens are cross-language decodable |
| `RESUME_FROM_BEGINNING` | The well-known `"0-0"` Redis sentinel |
| `assert_async_conformance(producer)` | The reusable conformance suite — the Python mirror of `@arcaai/async-contract`'s `assertAsyncConformance` |
| `AsyncProducerUnderTest` | The `Protocol` a producer under test implements for `assert_async_conformance` |

### Install
A `uv` workspace member (root `pyproject.toml`) and an editable install in the shared conda env
`arcaenv`. Consumers declare it as `hope-async-contract = { workspace = true }`.

Its ONE runtime dependency is `pydantic`, already declared by every uv workspace member
(`apps/{guardrail,nlp,text,harness,stt,tts}`), so adding it as a member perturbs no existing
resolution.

## Related

- [`@arcaai/async-contract` README](../async-contract/README.md) — the TypeScript twin and the shared example corpus
- [Async contract design doc](../../docs/programs/agentic-workflow-platform/async-contract.md)
