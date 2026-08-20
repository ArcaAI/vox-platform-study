# Async Task/Event Contract

| | |
|---|---|
| **Status** | Validated (TASK-717) |
| **Decides** | [design.md](./design.md) Decision log D7, §"Explicitly not doing (YAGNI ledger)", former Open question 3 |
| **Normative artifacts** | [`packages/async-contract/schema/async-envelope.v1.json`](../../../packages/async-contract/schema/async-envelope.v1.json) (JSON Schema, draft 2020-12) · [`@arcaai/async-contract`](../../../packages/async-contract) (TypeScript) · [`hope_async_contract`](../../../packages/py-async-contract) (Python) |
| **Consumers this document is written for** | TASK-722 (exposure SSE), TASK-727 (webhook channel) — read this document without needing TASK-717's ticket context |

---

## 0. What this settles

D7 in [design.md](./design.md) is **contract over broker**: one documented
async task/event envelope over the infra HOPE already runs (Redis Streams,
BullMQ, Temporal). **No new message broker is being built.** This document is
that contract. It is deliberately narrow: it standardizes the SHAPE of a
message and the CONVENTIONS around delivering it, and changes the behavior of
NO existing transport.

Everything here is implemented, tested, and shipped as two zero/near-zero
dependency packages — `@arcaai/async-contract` (TypeScript) and
`hope_async_contract` (Python) — that TASK-722 and TASK-727 import rather
than re-derive. Both packages carry a parity test against a **shared example
corpus** (`packages/async-contract/src/__tests__/examples/*.json`), so a
change to one language's validator that silently drifts from the other is
caught by CI, not discovered in production. **That parity test is
load-bearing** — see §7, Risk 2.

**Adoption status at the time of writing:** the envelope, the idempotency-key
convention, the resume-token convention, and the reusable conformance suite
(`assertAsyncConformance`, exported from `@arcaai/async-contract`) exist and
are tested. **Wiring the envelope onto the TEXT stream path itself
(`apps/text`) is a follow-up, not yet done** — see §8. Nothing today emits or
consumes an `AsyncEnvelope` on the wire. TASK-722 and TASK-727 are the first
real producers.

---

## 1. The envelope

```jsonc
{
  "schemaVersion": 1,
  "id": "01907d3a-0000-7000-8000-000000000001",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "type": "text.stream.chunk",
  "occurredAt": "2026-08-16T12:00:00.000Z",
  "correlationId": "req-abc123",
  "causationId": null,
  "idempotencyKey": "text:task:t-1:chunk:0",

  // EXACTLY ONE of the two below.
  "payload": { "type": "chunk", "content": "hello" }
}
```

or, with a claim check instead of an inline payload:

```jsonc
{
  "schemaVersion": 1,
  "id": "01907d3a-0000-7000-8000-000000000002",
  "tenantId": "00000000-0000-0000-0000-000000000000",
  "type": "harness.transcript.offloaded",
  "occurredAt": "2026-08-16T12:00:01.000Z",
  "correlationId": "req-abc123",
  "causationId": "01907d3a-0000-7000-8000-000000000001",
  "idempotencyKey": "wf:run:r-1:node:n-1:1",
  "payloadRef": {
    "store": "s3", "bucket": "hope-claims", "key": "ab/cd/...",
    "size": 12345, "sha256": "<64 lowercase hex chars>",
    "contentType": "text/plain; charset=utf-8"
  }
}
```

### 1.1 Field-by-field

| Field | Type / grammar | Rationale |
|---|---|---|
| `schemaVersion` | integer, `const 1` in this document | A consumer MUST **refuse** an unknown value rather than best-effort parse it. Precedent: `UsageOutboxPayload` — `packages/applications/src/services/usageLedger/dto/usage-outbox.payload.ts:18-22` states "the drainer refuses unknown shapes" as the reason `version` exists. This is the closest existing precedent for a versioned message envelope in the repo. |
| `id` | UUIDv7 string | The message's own identity. UUIDv7 matches the platform's `@default(uuid(7))` id convention (`.claude/rules/02-database-prisma.md` §Standard Model Field Template) and sorts by creation time. |
| `tenantId` | UUIDv7 string, **mandatory, never null** | Platform-wide messages use the SYSTEM tenant `00000000-0000-0000-0000-000000000000`, never `NULL` — the same rule `02-database-prisma.md` states for `tenantId` columns ("`NULL = global` is banned"). `BaseService.broadcastSysEvent` already enforces this for sys-events by writing `tenantId: this.tenantId ?? SYSTEM_TENANT_ID` **after** the object spread specifically so a caller cannot override it (`packages/applications/src/common/base.service.ts:79`); the envelope generalizes that discipline. |
| `type` | `/^[a-z0-9]+(\.[a-z0-9_]+){1,4}$/`, lowercase dotted, 2-5 segments, max 200 chars | E.g. `stt.segment.finalized`, `text.stream.chunk`. Deliberately **not** `SysEventType`'s `'SysEvent.ResourceCreated'` form (`packages/domains/src/enums/sysEventType.enum.ts:1-10`) — that is a NestJS `EventEmitter2` channel name, not a wire type. §5 records why `type` cannot import the domain enums at all. |
| `occurredAt` | ISO-8601 UTC date-time string | When the FACT happened, **not** the publish or redelivery time. Every transport this contract documents is at-least-once (§2); a redelivery MUST carry the original `occurredAt` or every consumer's ordering logic breaks on retry. |
| `correlationId` | non-empty string, max 255 chars | Request/session-scoped, propagated unchanged across every envelope caused by the same request or session. Already present, ad-hoc, on four independent surfaces before this contract: `packages/domains/src/common/events/arcaai.event.ts:29-30`, `packages/domains/src/interfaces/jobTypes.ts:41-42`, `packages/applications/src/common/base.service.ts:77`, `apps/harness/src/harness/temporal/models.py:80` (`correlation_id`). |
| `causationId` | UUIDv7 string **or `null`** | The `id` of the envelope that caused this one. Makes `DomainEventMetaData.causationId` (`packages/domains/src/common/domainEvent.ts:14`) — declared once, on the `DomainEvent` abstraction, and never touched by `SysEventService` — real instead of declared-and-unused. **Treat it as optional in practice**: most producers emit `null` until they adopt causation tracking deliberately (§7, Risk 4). |
| `idempotencyKey` | `/^[\x21-\x7e]{1,255}$/`, max 255 chars, **intent-derived** | Never random. Full convention: §3. |
| `payload` XOR `payloadRef` | exactly one, enforced by the schema's `oneOf` + `not` | Not "payload plus optional ref" — a consumer must never have to decide which wins if both were present. See §1.2. |

### 1.2 `payload` vs `payloadRef` — exactly one, never both

`payloadRef` is a **claim check**: a small, content-addressed reference to a
blob stored out-of-band, used instead of an inline `payload` when the
document is too large for the transport (Temporal's ~50 MB history budget is
the motivating case). Its shape is `ClaimCheckRef`, reused **verbatim** —
same six fields, same content-addressed `sha256`, same fail-loud posture —
from `apps/harness/src/harness/temporal/claim_check.py:64-80`:

| Field | Type | Notes |
|---|---|---|
| `store` | string | Which `BlobStore` implementation wrote this ref, e.g. `s3` |
| `bucket` | string | |
| `key` | string | Content-addressed object key |
| `size` | non-negative integer | Byte size of the referenced blob |
| `sha256` | `/^[0-9a-f]{64}$/` | Verified by the consumer at resolve time — a mismatch is a fail-loud integrity error, never a silent partial read (`ClaimCheckIntegrityError`, `claim_check.py:60`) |
| `contentType` | string | camelCase on the wire; the Python model's `content_type` maps to it by pydantic alias |

**Only the shape is shared by this contract.** The `BlobStore` implementation
(`claim_check.py:83-177`, `S3BlobStore`, `InMemoryBlobStore`) is Python/
Temporal-only and is **not** lifted into `@arcaai/async-contract` — see §7,
Risk 3. A TypeScript producer that needs to offload a large payload has no
store to write to yet.

The harness's own existing pattern is **additive-optional**
(`transcript_text` + `transcript_ref` both present, `models.py:88-90`)
because it must stay replay-compatible with recorded Temporal histories. This
contract has no such constraint, so it does not inherit that ambiguity:
`payload` and `payloadRef` are mutually exclusive, enforced by the schema's
top-level `oneOf`/`not`, and by both language packages' validators.

### 1.3 What the envelope deliberately does NOT carry

- **Trace context.** `traceparent`/`tracestate` stay OUTSIDE the envelope,
  as flat sibling transport fields — see §4.
- **A domain vocabulary for `type`.** See §5.
- **Anything from `SysEventType` / `JobQueue` / `ResourceType`.** Same reason.

---

## 2. Per-transport delivery semantics

The contract does not *change* any transport's semantics — it **names**
them, so an adopter knows exactly what it is signing up for.

| Transport | Delivery | Ordering | Ack / redelivery | Resume token |
|---|---|---|---|---|
| Redis Streams + consumer group (STT audio/result/control) | at-least-once | per-stream FIFO | `XACK` (`apps/stt/src/stt/streaming/redis_streams.py:301`); reclaim via `XAUTOCLAIM` after 30s idle (`:56`, `:325-332`) | stream message id |
| Redis Stream, no group (TEXT chunks — `text:stream:{task_id}`) | at-least-once, **client-driven** | per-stream FIFO | none — the client re-reads from its own cursor | stream message id, surfaced as SSE `id:` (`apps/text/src/text/api/endpoints/stream.py:61`) and consumed from `Last-Event-ID` (`:35`) |
| BullMQ | at-least-once (`attempts: 3`, exponential 1000ms — `packages/applications/src/services/baseServices/redis/redis.service.module.ts:23-55`) | **none** | job completion / failure | **none** — a failed job replays from its source, it does not resume |
| Temporal signal | at-least-once; the workflow itself dedupes (e.g. `ContextAddedSignal.dedupe_key()`, `apps/harness/src/harness/temporal/models.py:1267-1269`) | per-workflow signal order | implicit in workflow history | **none** — workflow state IS the cursor |
| sys-events (EventEmitter2 → BullMQ) | in-process best-effort, then at-least-once once enqueued | none | job completion | none |

**The single normative rule this contract adds:** every transport above is
at-least-once, so **every consumer must be idempotent on `idempotencyKey`**,
and every producer must set one per §3. Documenting the semantics is the
whole point — at-least-once without a convention for the key is at-least-once
without a defence.

**Temporal is documented here but is a permanent non-adopter.** Its history
is already the durable log, its payloads are size-budgeted, and it provides
the delivery guarantee an envelope would otherwise be asserting. Wrapping a
Temporal signal payload in this envelope adds bytes to a size-budgeted
history for no delivery guarantee Temporal does not already provide — see
§8.

---

## 3. The idempotency-key convention

**Intent-derived, never random.** The rule and its grammar are lifted
verbatim from
`packages/applications/src/services/usageLedger/idempotency-keys.ts:3-26,29,32`
— that module's header states the rule at length; it is restated here
because it is now load-bearing for every async surface, not only usage
billing:

> **A KEY IS DERIVED FROM INTENT, NEVER FROM CHANCE.** … That only works if
> the key is a pure function of WHAT happened — a job id, a session id, a
> request id — and never of a clock, a counter, or a UUID minted at emission
> time. A random key makes every retry a new charge [event], and the index
> that was supposed to prevent it will never fire.

Grammar: `MAX_IDEMPOTENCY_KEY_LENGTH = 255`, pattern `/^[\x21-\x7e]{1,255}$/`
(no whitespace, no control characters), shape
`<capability-prefix>:<intent-id>[:<qualifier>]`.

**The corollary that is easiest to get wrong, carried over unchanged**: the
abort/failure path uses the **same key** as the completion path for the same
intent. Inventing an `...:aborted` variant double-delivers.

### 3.1 Recipe table

Both packages ship these as functions (`AsyncIdempotencyKey.*` in TS,
`AsyncIdempotencyKey.*` in Python — see each package's README for the exact
signatures):

| Producer | Key |
|---|---|
| STT finalized segment | `stt:session:<sessionId>:seg:<utteranceIndex>` |
| TEXT stream chunk | `text:task:<taskId>:chunk:<sequence>` |
| Workflow node completion (TASK-718) | `wf:run:<runId>:node:<nodeId>:<attemptGeneration>` |
| Exposure SSE frame (TASK-722) | the source envelope's `idempotencyKey`, **unchanged** — there is nothing to derive, it is a pass-through |
| Webhook delivery (TASK-727) | `hook:<subscriptionId>:<sourceEnvelopeId>` |

### 3.2 The SDK carve-out — read this before "fixing" the SDKs

The browser SDK and `@arcaai/vox-node` **already generate random
idempotency keys**:

- `packages/agentic-sdk-v2/src/utils/idempotency.ts:20-25` —
  `generateIdempotencyKey()`, `crypto.randomUUID()`
- `packages/vox-node/src/resources/consultation-summaries.ts:113,129` —
  random UUIDv7

This is **not a contradiction to resolve**. Those are **client REQUEST
keys** — a caller de-duplicating its own retries of one HTTP call — a
different object from an EVENT's identity. Do not change them; do not read
this document as implying they should adopt `AsyncIdempotencyKey`.

---

## 4. Trace context stays OUTSIDE the envelope

`traceparent`/`tracestate` remain **flat sibling transport fields**, exactly
as both existing propagation implementations already place them:

- Python: `apps/stt/src/stt/streaming/redis_streams.py:487-506` (`_with_trace`),
  `apps/text/src/text/services/task_manager.py:105`
  (`fields.update(inject_trace_carrier())`) — helpers from
  `packages/py-otel/src/hope_otel/trace_propagation.py`.
- TypeScript:
  `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts:284,310`
  (`traceCarrierToArgs`) — helpers from
  `packages/applications/src/services/baseServices/observability/trace-propagation.ts`.

Two concrete reasons this envelope does not change that:

1. Both propagation modules keep an explicit **carrier-key allow-list**
   (`_CARRIER_KEYS` in `trace_propagation.py:75`; `CARRIER_KEYS` in
   `trace-propagation.ts:53`) specifically so a future propagator carrying
   extra baggage can never smuggle a payload field onto a PHI-bearing Redis
   stream. Moving the carrier inside the envelope moves it past that gate.
2. Trace context is transport metadata with its own W3C lifecycle. An
   envelope that embeds it would have to re-version whenever that lifecycle
   moves, for a concern the envelope has no business owning.

**On transports with no sibling-field slot (BullMQ job data)**, the carrier
goes in a reserved `_trace` sibling key on the job data object — a sibling of
the envelope, not a member of it. `@arcaai/async-contract` and
`hope_async_contract` own no propagation code; they document this convention
and defer to the existing `hope-otel` / `trace-propagation.ts` helpers for
the actual inject/extract.

---

## 5. Why `type` cannot reference the domain enums

If the envelope's `type` field ever needs to describe a fact that also has a
`SysEventType`, `JobQueue`, or `ResourceType` name, resist making `type` an
enum import. `@arcaai/domains` does not depend on `@arcaai/types` or on
`@arcaai/async-contract`, and this contract must not create that dependency
— see the package README's "Decision — where the contract lives" for the
full dependency-graph argument. `type` is therefore a **validated dotted
string**, and the mapping from a domain enum to a wire `type` lives in the
adopting surface, not in this package.

This is deliberate, but it has a real cost: two surfaces could independently
pick different wire types for the same underlying fact. There is no starting
type registry shipped with this ticket (M-sized, not this ticket's scope);
TASK-722 should own one once there is a second real adopter. Until then,
follow the pattern already used in the two worked examples above
(`text.stream.chunk`, `harness.transcript.offloaded`) — lowercase, dotted,
named after the fact, not the internal enum member.

---

## 6. The resume-token convention

**Opaque, transport-assigned, consumer-echoed.** The token is
`base64url(JSON({v: 1, t: <transport>, c: <cursor>}))`.

- **The producer never invents the cursor `c`; the transport does.** On a
  Redis stream it wraps the raw message id (e.g. `"1723800000000-0"`) —
  exactly what TEXT already surfaces as the SSE `id:`
  (`apps/text/src/text/api/endpoints/stream.py:61`) and reads back from
  `Last-Event-ID` (`:35`).
- **It is opaque to the consumer**: echo it back, never parse it. The repo
  already uses this exact pattern for pagination —
  `.claude/rules/04-application-services.md` §Pagination: *"opaque base64url
  `(sortKey, uuidv7 id)` token"*, implemented in
  `packages/applications/src/common/cursorPagination.ts`.
- `"0-0"` is the well-known Redis "from the beginning" sentinel, matching
  `stream.py:35` and `redis_streams.py:168`. Exported as
  `RESUME_FROM_BEGINNING` from both packages.
- **A transport with no cursor (BullMQ, Temporal) declares `resumable: false`
  and the contract forbids a synthetic token there.** A resume token that
  cannot resume is worse than none.

Wrapping rather than exposing the raw id is what lets TASK-722's exposure SSE
keep the same client-facing token contract if the underlying stream is ever
repartitioned — the only forward compatibility this contract needs, bought
as cheaply as possible.

Both language packages implement `encodeResumeToken`/`decodeResumeToken`
(`encode_resume_token`/`decode_resume_token` in Python) using
`TextEncoder`/`TextDecoder` + `btoa`/`atob` (not Node's `Buffer`) on the TS
side and the standard-library `base64.urlsafe_b64encode` on the Python side —
the same base64url alphabet, so a token minted in one language decodes
correctly in the other (`packages/py-async-contract/tests/test_parity.py`
asserts this).

---

## 7. Risks & open questions carried into adoption

1. **This contract binds two unwritten-at-time-of-authoring tickets.**
   TASK-722 and TASK-727 will build on the envelope, so a field added later
   is a breaking change for both. This document's review by those tickets'
   authors, before either starts building, is a real coordination gate, not
   a courtesy.
2. **The parity test is the whole value of the two-package pair.** If
   `packages/async-contract/src/__tests__/envelope.test.ts`'s parity
   assertions or `packages/py-async-contract/tests/test_parity.py` are ever
   skipped or marked flaky, this contract joins `trace_propagation` /
   `redis_streams` / the harness signal bodies as a hand-maintained
   duplicate — precisely the failure mode this ticket exists to stop
   repeating.
3. **The claim-check store is Python-only and stays that way here.**
   `ClaimCheckRef`'s *shape* is shared; the `BlobStore` implementation is
   not. A TypeScript producer that needs to offload has no store today. That
   is acceptable while known payloads (TEXT chunks) are small, and becomes a
   real gap the first time an exposure or webhook payload exceeds a
   transport limit — most likely in TASK-722. Recorded rather than
   pre-built.
4. **`causationId` is new behaviour, not just a new field.** Populating it
   correctly requires a producer to know which envelope caused it, which no
   existing surface currently tracks (`base.service.ts:71-89` propagates
   `correlationId` only). Treat it as optional; a `causationId` that is
   usually `null` is worse than none if a consumer starts relying on it
   being present.
5. **The sys-event path is the highest-value SECOND adopter, and it is not
   this ticket.** `BaseService.broadcastSysEvent`
   (`packages/applications/src/common/base.service.ts:71-89`) emits a plain
   object literal whose `id` and `createdAt` are `undefined` unless the
   caller supplied them — yet `SysEventService.queueSysEventJob` reads
   `event.id` (`sysEvent.service.ts:199`) and `queueUserActivityJob` reads
   `event.createdAt` (`:183`). This envelope's mandatory `id`/`occurredAt`
   closes that latent gap. Doing it here would touch every mutation path in
   the platform — a Wave-2 follow-up, not M-sized.
6. **Eight registered BullMQ queues have no consumer at all**, including
   `JobQueue.SysEvent`. Standardizing an envelope does not make them live
   and must not be read as having done so. Whether those queues should be
   removed or wired is a separate finding.
7. **`type` cannot reference the domain enums** (§5) — a deliberate
   dependency-graph decision with a real cost: two surfaces could pick
   different wire types for the same fact absent a shared registry.
8. **Backward compatibility on any given adopter is proven by test, not by a
   staged rollout plan.** A `schemaVersion` presence probe lets a consumer
   distinguish an enveloped message from a legacy bare one during rollout,
   but no staged-rollout mechanism is specified by this contract — if a
   producer and its consumer are ever deployed as separately-scaled pods
   (design.md's worker-pool standard, TASK-725), the probe becomes
   load-bearing across a version skew. Worth revisiting if/when that
   happens.

---

## 8. Adoption guidance — what a surface must do to claim conformance

A surface "adopts the envelope" when:

1. Every message it produces on the wire is a value that
   `asyncEnvelopeProblems`/`envelope_problems` reports as conforming (empty
   problem list) — i.e., it validates against
   `schema/async-envelope.v1.json`.
2. Its `idempotencyKey` is intent-derived per §3, using or extending
   `AsyncIdempotencyKey`.
3. If the transport is resumable, its resume tokens are produced by
   `encodeResumeToken`/`encode_resume_token` and it declares `resumable:
   true`; if not resumable, it emits no resume token at all.
4. Trace context, if the transport crosses a non-HTTP boundary, stays a
   sibling field per §4 — never a member of the envelope.
5. It passes `assertAsyncConformance` (exported from
   `@arcaai/async-contract`) against its own producer, wired into its own
   test suite — see the package README for the `AsyncProducerUnderTest`
   contract.

### Adopters

| Surface | Status |
|---|---|
| TASK-722 (exposure SSE) | Designed for; not yet built |
| TASK-727 (webhook channel) | Designed for; not yet built |
| TEXT stream (`apps/text`, `text:stream:{task_id}`) | **Designated reference path, not yet adopted.** Its wire schema is already one `data` field holding a JSON document, so wrapping that document in an envelope is purely additive; it already implements the exact resume mechanism this contract standardizes. Adopting it is a follow-up ticket, not part of TASK-717's delivered scope — see the ticket README's Implementation Summary for what was and was not built. |

### Explicit non-adopters

- **STT Redis Streams** (`apps/stt`) — the audio-frame stream carries raw PCM
  bytes on a per-frame hot path; an envelope per audio frame is pure
  overhead. The result stream is a better fit, but its fields are flat and
  hand-rolled in two independently-drifting implementations (Python
  publisher, TypeScript producer — they already disagree on one field,
  `target`) that would need reconciling first. A worthwhile future ticket,
  not this one.
- **BullMQ** — job data is per-queue and unrelated across queues; adopting
  one queue proves nothing about the others, and most registered queues have
  no consumer at all (§7, Risk 6).
- **Temporal** — permanent non-adopter, §2.
- **Everything not listed as an adopter above stays exactly as it is today.**
  Adopting the envelope on any of these surfaces is that surface's own
  future ticket, taken only when the surface is already being touched for
  another reason — see design.md's YAGNI ledger.

---

## Related documents

- [design.md](./design.md) — Decision log D7, YAGNI ledger
- [`packages/async-contract/README.md`](../../../packages/async-contract/README.md) — TypeScript package API, dependency-graph rationale for where the contract lives
- [`packages/py-async-contract/README.md`](../../../packages/py-async-contract/README.md) — Python package API
- [`docs/implementation/TASK-717-Async-Contract/README.md`](../../implementation/TASK-717-Async-Contract/README.md) — this ticket's plan and Implementation Summary
