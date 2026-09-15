# @arcaai/async-contract — the normative async envelope

The normative async task/event envelope — identity, tenancy, type, payload-or-claim-check,
correlation, causation, idempotency key, schema version — plus the idempotency-key and
resume-token conventions, plus a reusable conformance suite. Zero runtime dependencies.

Full prose contract, per-transport delivery semantics, and the rationale behind every field:
[`docs/programs/agentic-workflow-platform/async-contract.md`](../../docs/programs/agentic-workflow-platform/async-contract.md).

## Layout

| Path | What it holds |
|---|---|
| `schema/async-envelope.v1.json` | The NORMATIVE artifact — JSON Schema, draft 2020-12 |
| `src/envelope.ts` | `AsyncEnvelope<TPayload>`, `asyncEnvelopeProblems`, `parseAsyncEnvelope`, `ASYNC_ENVELOPE_SCHEMA_VERSION` |
| `src/claim-check-ref.ts` | `ClaimCheckRef`, `claimCheckRefProblems` |
| `src/idempotency.ts` | `MAX_IDEMPOTENCY_KEY_LENGTH`, `idempotencyKeyProblems`, `AsyncIdempotencyKey` |
| `src/resume-token.ts` | `encodeResumeToken`/`decodeResumeToken`, `RESUME_FROM_BEGINNING` |
| `src/conformance/` | `assertAsyncConformance`, `AsyncProducerUnderTest` |
| `src/__tests__/examples/*.json` | The shared example corpus also used by `packages/py-async-contract`'s parity test |

## Commands

```bash
pnpm --filter @arcaai/async-contract build test lint typecheck
```

## How it works

### Why this package exists

TASK-722 (exposure SSE) and TASK-727 (webhook channel) both emit events to external consumers.
Without a settled envelope they would each invent one — the repo has a documented history of
exactly that outcome: `traceparent` propagation, the claim-check pattern, and the idempotency-key
grammar were each built once and then hand-duplicated into a second language. This package is the
single implementation both language sides consume.

This package does NOT interpret `schema/async-envelope.v1.json` at runtime — no ajv, no zod, zero
dependencies, the same tradeoff `@arcaai/json-schema-subset` makes and for the same reason: it is
bundled into `@arcaai/vox-node` and `apps/admin-console`, whose dependency footprint is policed.
Instead, `envelope.ts` is a hand-written validator whose verdict is asserted, by test, to agree with
the schema on the shared example corpus (`src/__tests__/examples/*.json`) — the SAME corpus
`packages/py-async-contract`'s parity test uses. **That parity test is load-bearing.** If it is
ever skipped or marked flaky, this package joins the list of hand-maintained twins it was built to
stop growing.

### API

| Export | Purpose |
|---|---|
| `ASYNC_ENVELOPE_SCHEMA_VERSION` | `1`. A future version is a new constant, never a mutation |
| `AsyncEnvelope<TPayload>` | The envelope type. `payload`/`payloadRef` are both optional at the TYPE level; "exactly one" is a RUNTIME invariant enforced by `asyncEnvelopeProblems` |
| `asyncEnvelopeProblems(value)` | Structural problems with a candidate envelope. Empty array = conforms. Never throws |
| `parseAsyncEnvelope<T>(value)` | Refuse-if-unknown parse. Returns `null` for ANY conformance problem, including an unknown `schemaVersion` — the caller MUST NOT proceed on `null` |
| `ClaimCheckRef` / `claimCheckRefProblems(value)` | The claim-check shape, reused verbatim from `apps/harness/src/harness/temporal/claim_check.py` |
| `MAX_IDEMPOTENCY_KEY_LENGTH`, `idempotencyKeyProblems(key)` | The idempotency-key grammar, reused verbatim from `usageLedger/idempotency-keys.ts` |
| `AsyncIdempotencyKey` | Intent-derived key recipes (`sttSegment`, `textChunk`, `workflowNode`, `webhookDelivery`) |
| `encodeResumeToken(transport, cursor)` / `decodeResumeToken(token)` | The opaque `base64url(JSON({v,t,c}))` resume-token convention |
| `RESUME_FROM_BEGINNING` | The well-known `"0-0"` Redis "from the start" sentinel |
| `assertAsyncConformance(producer)` | The reusable conformance suite (see below). Never throws — returns a problem list; empty means the producer conforms |

### Using the conformance suite

```typescript
import { assertAsyncConformance, type AsyncProducerUnderTest } from '@arcaai/async-contract';

const producer: AsyncProducerUnderTest = {
  resumable: true,
  produce: (input) => myTransport.produceEnvelope(input),
  replay: (token) => myTransport.replayFrom(token),
  // optional — needed to exercise the mid-stream replay assertion:
  resumeTokenOf: (produced) => myTransport.tokenFor(produced),
};

const problems = await assertAsyncConformance(producer);
expect(problems).toEqual([]);
```

### Consumers

| Consumer | Uses |
|---|---|
| `apps/api` | The workflow-run streaming/completion path (`modules/workflows/`, `modules/workflow-sandbox-run/`, `modules/streaming/workflow-ws.gateway.ts`) — envelope + resume token |
| `packages/py-async-contract` | The Python mirror; shares the example corpus for the cross-language parity test |

## Gotchas

- **Zero runtime dependencies, permanently.**
- No Node builtins in the shipped code (`resume-token.ts` uses `TextEncoder`/`TextDecoder`/`btoa`/`atob`,
  not `Buffer`) so this package stays usable from `@arcaai/vox-node`'s non-Node targets (Bun/Deno/edge
  — WinterTC globals only per `.claude/rules/08-vox-sdk.md`).
- `payloadRef`'s SHAPE is shared with the harness's `ClaimCheckRef`; the `BlobStore` implementation
  is not lifted here.
- Trace context (`traceparent`/`tracestate`) is deliberately NOT a field on this envelope — it stays
  a flat sibling transport field, exactly as both existing implementations already place it.

## Related

- [Async contract design doc](../../docs/programs/agentic-workflow-platform/async-contract.md)
- [`py-async-contract` README](../py-async-contract/README.md) — the Python mirror and shared parity test
- [`08-vox-sdk.md`](../../.claude/rules/08-vox-sdk.md) — the `@arcaai/vox-node` runtime constraints this package respects
