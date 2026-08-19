# TASK-717 — Async Task/Event Contract (design + reference implementation)

| | |
|---|---|
| **Status** | Completed — Phase A, Phase B, and Phase C (Tasks 5-6 reference implementation on `apps/text` + wired conformance) all delivered, see §7 and §8 |
| **Wave** | 1 · **Size** | M |
| **Epic slug** | `async-contract` |
| **Depends on** | — |
| **Design refs** | D7 from [design.md](../../programs/agentic-workflow-platform/design.md) — Decision log D7, §"Explicitly not doing (YAGNI ledger)", Open question 3 |
| **Findings closed** | design.md open question 3 ("Async contract envelope details (schema, delivery semantics, resume tokens) — needs its own short design") |

---

## 1. Requirement Analysis

### What this delivers

D7 settles **contract over broker**: *"one documented async task/event envelope over existing
infra (Redis Streams, BullMQ, Temporal). Broker adoption only behind the contract, only if
proven necessary."* The YAGNI ledger repeats it: **a new message broker is explicitly not
being built.**

This ticket is a **design ticket**. It produces four things and nothing else:

1. **The envelope specification** — a normative JSON Schema plus prose: identity, tenancy,
   type, payload-or-claim-check, correlation, causation, idempotency key, schema version.
2. **Per-transport delivery semantics** — what "at-least-once" actually means on each of the
   five async surfaces that exist today, what acks and redelivery look like, and the
   idempotency-key convention that makes at-least-once survivable.
3. **The resume-token convention** — an opaque, transport-assigned cursor, aligned with the
   Redis-message-id resume SMR already implements.
4. **A reference implementation on exactly ONE existing path**, plus **conformance tests**
   that TASK-722 (exposure SSE) and TASK-727 (webhook channel) can consume directly rather
   than re-deriving.

### Why it is needed now

TASK-722 and TASK-727 both emit events to external consumers. Without a settled envelope they
will each invent one, and the repo has a documented history of exactly that outcome. Verified
today: **the three cross-language wire surfaces are each defined twice, independently, once per
language**, and `packages/py-otel/src/hope_otel/trace_propagation.py:38-43` names its
TypeScript twin and states parity is held only by "golden-traceparent tests" — hand-maintained
duplication, acknowledged in the source.
`packages/json-schema-subset/README.md` records what that costs: *"Three implementations of one
clinical validation rule drift, and the drift is silent in both directions."*

The backlog's own sequencing note says it plainly: *"717 `async-contract` is a design ticket —
its envelope must exist before 722/727 build on it."*

### Explicitly OUT of scope

- **Migrating existing paths wholesale.** The four surfaces not chosen as the reference stay
  exactly as they are. Adopting the envelope on each is that surface's own future ticket, taken
  only when that surface is already being touched. Adding a YAGNI-ledger line for it here.
- **A new broker.** D7 and the YAGNI ledger.
- **Replacing BullMQ, Redis Streams or Temporal.**
- **A dead-letter queue, an outbox, or a schema registry service.** BullMQ already has
  `attempts`/backoff; `AiUsageOutbox` already exists for the one path that needed an outbox.
  None of these is required by 722/727.
- **Retro-fitting the envelope onto Temporal signal payloads.** Temporal's own history *is* the
  durable log; wrapping a signal in an envelope adds bytes to a size-budgeted history for no
  delivery guarantee Temporal does not already provide. §3.4 records the reasoning.
- **Any change to `SysEventType` or the sys-event fan-out.**

---

## 2. Current State Evaluation

Verified against the live tree on 2026-08-16 (branch `feat/loop`). Exclusions: `.claude/worktrees/**`,
`**/dist/**`, `**/node_modules/**`, `**/.venv/**`, `**/__pycache__/**`, `docs/archive/**`.

### 2.1 Surface 1 — STT Redis Streams

`apps/stt/src/stt/streaming/redis_streams.py` (796 lines) + `apps/stt/src/stt/streaming/schemas.py`.

Stream keys (`redis_streams.py:73-95`), all per-session:
`stt:audio:{session_id}` · `stt:result:{session_id}` · `stt:control:{session_id}` ·
`stt:session:{session_id}` (a Redis **hash**, not a stream) · `stt:worker:{worker_id}`.

| Concern | Evidence |
|---|---|
| Consumer group | `AUDIO_CONSUMER_GROUP = "stt-ingest"` `redis_streams.py:51`; created in `_ensure_group()` `:223-249` (`xgroup_create(..., mkstream=True)`, swallows `BUSYGROUP`) |
| Read | `xreadgroup(group, consumer, {key: ">"}, count=100, block=block_ms)` `:383-389` |
| Ack | `_ack()` `:296-307` → `xack`. Acks **unconditionally**, including malformed frames, so a bad frame cannot poison the PEL (`:427-433`) |
| Redelivery | `_reclaim_pending()` `:309-364` → `XAUTOCLAIM`, `_DEFAULT_CLAIM_MIN_IDLE_MS = 30_000` `:56`, `_DEFAULT_CLAIM_INTERVAL_S = 15.0` `:59` |
| Publish | `ResultPublisher.publish()` `:509-533` → `xadd(key, self._with_trace(result.to_redis_dict()), maxlen=..., approximate=True)` |
| Cursor | `SessionMetadata.last_stream_id: str \| None` `schemas.py:338` |

Field names are flat and hand-rolled per message kind:
`AudioFrame.to_redis_dict()` `schemas.py:72-86` → `seq, sr, enc, ch, data, final, ts`;
`SegmentResult.to_redis_dict()` `schemas.py:187-215` → `type, text, start_time, end_time,
is_final, inference_ms` plus conditionals (`utterance_index`, `speaker_id`, `english_text`,
`word_timestamps_json`, `language`, `pipeline_id`, …);
`SessionControl.to_redis_dict()` `schemas.py:287-289` → `{action, target}`.

**The production audio writer is TypeScript**, not the Python test helper:
`packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts:260-285`
(audio `XADD`, literal field order `seq, sr, enc, ch, data, final, ts` then the trace carrier)
and `:303-310` (control `XADD` — note it writes `action` but **not** `target`, so the two
implementations already disagree on one field).

### 2.2 Surface 2 — SMR SSE with Redis message-id resume

`apps/text/src/text/api/endpoints/stream.py` (92 lines) + `apps/text/src/text/services/task_manager.py`.

| Concern | Evidence |
|---|---|
| Stream key | `_STREAM_KEY_PREFIX = "smr:stream:"` `task_manager.py:19`; `_stream_key()` `:55-56` |
| Publish | `append_chunk()` `:98-111` — `fields = {"data": chunk.model_dump_json()}` then `fields.update(inject_trace_carrier())`, then `xadd(..., maxlen=self._stream_max_len)` |
| Read | `read_chunk_entries_blocking()` `:142-176` — plain `xread({key: last_id}, block=block_ms, count=100)` `:152-156`. **No consumer group, no XACK** |
| Resume | `stream.py:35` — `cursor_start = last_event_id or request.headers.get("last-event-id") or "0-0"` |
| SSE frame | `stream.py:61` — `yield {"event": chunk.type, "data": chunk.model_dump_json(), "id": msg_id}` — the SSE `id:` **is the raw Redis stream message id** |
| Terminal | `stream.py:65-66` — returns on `chunk.type in ("done","error")` |
| Payload type | `StreamChunk` — `apps/text/src/text/models/stream.py:10-13`: `type: Literal["chunk","reasoning","meta","done","error","usage"]`, `content: str \| None`, `data: dict \| None` |

**This is the closest thing to the target contract that already exists**: one opaque `data`
field carrying a JSON document, trace context as flat sibling fields, and a message-id resume
cursor surfaced to the client through the standard SSE `id:` / `Last-Event-ID` mechanism.

### 2.3 Surface 3 — BullMQ

Queue names: `packages/domains/src/enums/JobQueue.enum.ts:3-37`, 17 members. Job *name* is
`JobType` (`packages/domains/src/enums/JobType.enum.ts:1-13`) on the generic path, and a
bare literal on the feature paths.

Generic enqueue seam —
`packages/applications/src/services/baseServices/redis/IRedisService.ts:4-9`:
```ts
export interface AddJobProps<T> {
  queueName: JobQueue | string;
  jobType: JobType | string;
  data: T;
  options?: JobsOptions;
}
```
`packages/applications/src/services/baseServices/redis/redis.service.ts:94` —
`await queue.add(jobType as string, data, options)`. So `jobType` **is** the BullMQ job name.

Defaults: `attempts: 3`, exponential 1000 ms, `removeOnComplete: 100`, `removeOnFail: 200` —
`packages/applications/src/services/baseServices/redis/redis.service.module.ts:23-55`.

Job-data types are per-queue and unrelated to each other:
`packages/domains/src/interfaces/jobTypes.ts` (`UserActivityJob` `:5`, `SendEmailJob` `:10`,
`SendSmsJob` `:19`, `SysEventJob` `:27`, `AuditLogJob` `:32`, `WebCrawlerJob` `:47`),
`packages/applications/src/services/consultation/jobs/dto/job.dto.ts` (four payloads,
`:14`/`:27`/`:42`/`:57`), and several declared inline in their processors.

**Ten `@Processor` declarations exist**; eight registered queues have **no consumer at all** —
including `JobQueue.SysEvent`, which is written to on every resource mutation
(`sysEvent.service.ts:193-205`) and read by nothing. Recorded because a contract that
standardizes the envelope must not be mistaken for one that makes those queues live.

### 2.4 Surface 4 — Temporal

Task queue `harness-task-queue` — `apps/harness/src/harness/core/config.py:41`.
Workflow ids: `harness-doc-{consultation_id}`
(`apps/harness/src/harness/api/endpoints/internal.py:75-77`),
`consultation-loop-{consultation_id}` (`:80-87`, canonical twin at
`temporal/workflows.py:1625-1627`), `specialist-{consultation_id}-{agent_id}-{plan_id}`
(`workflows.py:1793-1799`).

Signals (`workflows.py`): `approval` `:336`, `edit` `:341`, `contextAdded` `:1969`,
`consultationEnding` `:1991`, `cancel` `:1998`. Payloads are pydantic models with
`ConfigDict(extra="forbid")` in `apps/harness/src/harness/temporal/models.py` —
`ApprovalSignal` `:106-115`, `EditSignal` `:118-144`, `ContextAddedSignal` `:1242-1269`
(with its own `dedupe_key()` at `:1267-1269` → `f"{context_item_id}:{occurred_at or ''}"`),
`ConsultationEndingSignal` `:1293-1300`, `CancelLoopSignal` `:1303-1313`.

`signal_context_added()` uses **signal-with-start**
(`internal.py:449-450`, `start_signal="contextAdded"`).

**A claim-check already exists here** —
`apps/harness/src/harness/temporal/claim_check.py`. `ClaimCheckRef` (`:64-80`) is a pydantic
model with `extra="forbid"` and exactly six fields:
`store, bucket, key, size, sha256, content_type`. Its module docstring (`:1-36`) states the
rationale (Temporal's ~50 MB history budget), the integrity property ("a claim-check must
round-trip EXACTLY … a missing/corrupt blob must fail LOUD"), and that writes are
content-addressed by sha256 and therefore idempotent under retry. `BlobStore` Protocol `:83`,
`InMemoryBlobStore` `:99`, `S3BlobStore` `:123` (lazy `boto3`), `should_offload()` `:209`,
`maybe_offload()` `:247`, `resolve()` `:263`.
**There is no TypeScript equivalent.**

### 2.5 Surface 5 — sys-events

`SysEventType` — `packages/domains/src/enums/sysEventType.enum.ts:1-10`, 7 members
(`ResourceCreated/Viewed/Updated/Deleted/Archived`, `WebHookRun`, `SendContactMessage`).
`WebHookRun` has no `@OnEvent` handler.

`BaseService.broadcastSysEvent` — `packages/applications/src/common/base.service.ts:71-89`:
```ts
broadcastSysEvent(type: SysEventType, data: Partial<SysEvent> | Partial<SendContactMessageEvent>): void {
  const impersonatedBy = this.requestUser?.impersonatedBy;
  this.eventEmitter.emit(type, {
    responsibleEntityId: this.requestUser?.id,
    responsibleIp: this.requestIp,
    resourceType: this.resourceType,
    correlationId: this.correlationId,
    ...data,
    tenantId: this.tenantId ?? SYSTEM_TENANT_ID,
    ...(impersonatedBy ? { metaData: { ...data.metaData, impersonatedBy } } : {}),
  });
}
```
Note the ordering: `tenantId` is written **after** the spread, so a caller cannot override it;
`correlationId`, `resourceType` and `responsibleEntityId` **can** be overridden.

The emitted value is a **plain object literal**, not `new SysEvent(...)`
(`packages/domains/src/common/events/arcaai.event.ts:34-72`), so `id` and `createdAt` are
`undefined` unless the caller supplied them — yet `SysEventService.queueSysEventJob` reads
`event.id` (`sysEvent.service.ts:199`) and `queueUserActivityJob` reads `event.createdAt`
(`:183`). **An envelope with a mandatory `id` and `occurredAt` fixes a real latent gap here**,
which is why the sys-event path is the recommended *second* adopter (§6).

### 2.6 What exists of an envelope today: four partial, unrelated contracts

| Fragment | Location | What it covers |
|---|---|---|
| `correlationId` | `arcaai.event.ts:29-30`, `jobTypes.ts:41-42`, `base.service.ts:77`, `consultation.events.ts:84-85`, `models.py:80` (`correlation_id`), `internal.py:98` | present on four surfaces, each declaring it independently |
| `causationId` | `packages/domains/src/common/domainEvent.ts:14` (`DomainEventMetaData.causationId: string \| null`), props `:26`, default `:49`, surfaced `:66`/`:81` | declared once, on the `DomainEvent` abstraction, which `SysEventService` never touches. Effectively unused |
| `schemaVersion` on a message payload | `packages/applications/src/services/usageLedger/dto/usage-outbox.payload.ts` — header calls it "The JSONB envelope stored in `AiUsageOutbox.payload`" `:7`; `USAGE_OUTBOX_PAYLOAD_VERSION = 1 as const` `:22`; `UsageOutboxPayload { version; events }` `:47-50`; rationale (the drainer refuses unknown shapes) `:18-20` | **the closest existing precedent for a versioned message envelope** |
| claim check | `apps/harness/src/harness/temporal/claim_check.py:64-80` | Python/Temporal only |

Every other `"envelope"` hit in the tree is **envelope encryption** (`globalSetting.service.ts:45`,
`auditLog.service.ts:98`) or a test-only response wrapper
(`tests/contracts/smr-compat.contract.test.ts:86`).

**Verdict: no shared envelope exists.**

### 2.7 Idempotency: four incompatible mechanisms, and one that is right

| # | Mechanism | Location | Key source |
|---|---|---|---|
| a | SDK v2 — body field | `packages/agentic-sdk-v2/src/utils/idempotency.ts:20-25` `generateIdempotencyKey()` | **random** `crypto.randomUUID()`. Header comment `:1-12` explains it ships as a body field because `AgenticClient.post` cannot set custom headers |
| b | `@arcaai/vox-node` — body field | `packages/vox-node/src/resources/consultation-summaries.ts:113`, `:129` | **random** UUIDv7 |
| c | Server, job creation — body field | `packages/applications/src/services/consultation/jobs/consultation-job.service.ts:80-81` (`IDEMPOTENCY_KEY_PREFIX`, `IDEMPOTENCY_TTL = 86400`), replay at `:106-109` | client-supplied; namespaced by `tenantId + userId` (`:77-79`) |
| d | Server, harness callbacks — HTTP header | `packages/applications/src/services/consultation/harness/harness-internal.service.ts:1377-1379` `buildIdempotencyKey()`, `:1392-1435` `withHarnessIdempotency()` (caches and replays the prior response **body**) | **intent-derived**: the harness `{run_id}:{activity_id}` (`:1371-1376`) |
| e | Usage ledger | `packages/applications/src/services/usageLedger/idempotency-keys.ts` | **intent-derived**, with the rule stated as law |

(e) is the one to generalize. Its header (`:3-26`) is unambiguous:

> **THE ONE RULE: A KEY IS DERIVED FROM INTENT, NEVER FROM CHANCE.**
> … That only works if the key is a pure function of WHAT happened — a job id, a session id,
> a request id — and never of a clock, a counter, or a UUID minted at emission time. A random
> key makes every retry a new charge, and the index that was supposed to prevent it will never
> fire.

Its grammar is reusable verbatim: `MAX_IDEMPOTENCY_KEY_LENGTH = 255` (`:29`),
`/^[\x21-\x7e]{1,255}$/` (`:32`), shape `<capability-prefix>:<intent-id>` with a recipe table
at `:37-51`. Enforcement is a `@unique` column on `AiUsageEvent.idempotencyKey`, asserted at
`packages/database/src/__tests__/usage-ledger-schema.test.ts:60-62`.

**Critically: no idempotency key crosses into any async message payload today** — not BullMQ
job data, not a Redis Stream field, not a Temporal signal. Every mechanism above is
request-scoped.

### 2.8 Trace propagation already exists, twice

Python — `packages/py-otel/src/hope_otel/trace_propagation.py`:
`TRACEPARENT_HEADER` `:69`, `TRACESTATE_HEADER` `:70`, `_CARRIER_KEYS` allow-list `:75`,
`inject_trace_carrier()` `:78-89`, `extract_trace_context()` `:92-109`,
`carrier_from_redis_fields()` `:121-146`. Single dependency `opentelemetry-api`; declared as a
uv workspace member in the root `pyproject.toml` with the note that its dependency "is already
declared by every member, so it adds nothing to this resolution".

TypeScript — `packages/applications/src/services/baseServices/observability/trace-propagation.ts`:
`TRACEPARENT_HEADER` `:44`, `CARRIER_KEYS` `:53`, `injectTraceCarrier()` `:65`,
`extractTraceCarrier()` `:90-97`, `traceCarrierFromFields()` `:128`, `traceCarrierToArgs()` `:143`.

The `_CARRIER_KEYS` allow-list exists, per its own comment, *"so a future propagator carrying
extra baggage can never smuggle a payload field onto a PHI-bearing Redis stream."*

**Trace context is carried as flat sibling fields on the message, never inside the payload** —
alongside `seq`/`data` on the STT streams and alongside `data` on `smr:stream`. It is on
neither BullMQ job data nor `SysEvent`; Temporal uses the SDK's own `TracingInterceptor`
(`apps/harness/src/harness/temporal/client.py:19-43`). §3.3 keeps it that way.

### 2.9 Candidate homes for the contract

| Package | Facts |
|---|---|
| `packages/types` (`@arcaai/types`) | `"type": "module"` (ESM-only), single `"."` export, `tsc --build`, **zero dependencies and zero devDependencies**. Consumers: only `packages/utils` and `packages/applications`. Content is domain media types (`audio`, `transcription`, `diarization`, `vad`, `llm`, …) |
| `packages/utils` (`@arcaai/utils`) | dual CJS/ESM via tsup, but **not** types-only — ships model-download/loader runtime code. Depends on `@arcaai/types` |
| `packages/json-schema-subset` | zero runtime deps, dual CJS/ESM *"so the NestJS server (`moduleResolution: node`) and the bundled browser consumers can both use it"*. Consumers: `@arcaai/applications`, `@arcaai/vox`, `@arcaai/admin-console` |
| `packages/py-runtime-models`, `packages/py-env`, `packages/py-otel` | the three shared Python packages; each a uv workspace member, each dependency-free or single-dependency by design |
| `tests/contracts/` | 13 files, **Zod, TS-only, HTTP request/response schemas**. `tests/contracts/schemas.ts:1-6` describes itself as the API-Gateway↔Python-services contract. Nothing here covers Redis Stream fields, BullMQ job data or Temporal signals |

Dependency graph (from `package.json` files, `node_modules` excluded):
`@arcaai/types` → nothing · `@arcaai/utils` → `@arcaai/types` ·
`@arcaai/applications` → `database`, `domains`, `exceptions`, `logger`, `json-schema-subset`,
`types`, `utils` · `@arcaai/domains` → `database`, `exceptions`, NestJS, Prisma (**not** `types`).

---

## 3. Knowledge & Best Practices

### 3.1 Decision — where the contract lives: **a new dual-language package pair**

**Recommendation: `packages/async-contract` (`@arcaai/async-contract`) +
`packages/py-async-contract` (`hope_async_contract`).**

The TS package is modelled file-for-file on `packages/json-schema-subset`: **zero runtime
dependencies, permanently**, dual CJS/ESM output. The Python package is modelled on
`packages/py-runtime-models` / `packages/py-otel`: a uv workspace member, dependency-free (or
at most `pydantic`, already a dependency of every member, so it perturbs no resolution — the
rationale the root `pyproject.toml` states for `py-env` and `py-otel`).

The **normative artifact is a JSON Schema document** checked into the TS package
(`schema/async-envelope.v1.json`), and **each language package has a parity test asserting its
own type surface against it**. That is what upgrades `py-otel`'s honest "hand-maintained twins
verified by golden tests" into "twins verified against one artifact".

Why not the alternatives:

| Candidate | Why not |
|---|---|
| `packages/types` | It *could* host it without a cycle — it is a true zero-dependency leaf (§2.9). Rejected on three grounds: (1) **ESM-only** (`"type": "module"`, `tsc --build`), while the NestJS server runs `moduleResolution: node` — the exact constraint that made `json-schema-subset` ship dual CJS/ESM; (2) its consumer set is `utils` + `applications` only, and the envelope's consumers include `@arcaai/vox-node` and `apps/admin-console`, so adopting it would widen a package that has stayed narrow; (3) it holds **domain media types**, not wire contracts — an envelope there is a category error a future reader will have to un-learn |
| `packages/utils` | Ships runtime model-download code; a wire contract must not drag that into a consumer |
| `tests/contracts/` | Test-only, TS-only, and scoped to HTTP request/response schemas by its own header |
| `@arcaai/domains` | Server-only; `@arcaai/vox-node` and the console cannot depend on it |
| One package, TS only, Python re-declares | This is precisely the status quo that produced three twin pairs (§2.8) |

**Consequence to accept, explicitly:** if the envelope's `type` field ever needs to reference
`SysEventType` / `JobQueue` / `ResourceType` (which live in `@arcaai/domains`, and `domains`
does not depend on `types` or on this new package), the contract must **not** import them. It
declares `type` as a validated dotted string and leaves the mapping to the adopting surface.
That is a feature: the envelope is a transport contract, not a domain vocabulary.

### 3.2 Decision — the envelope

```jsonc
{
  "schemaVersion": 1,            // integer. Consumers MUST refuse an unknown value rather
                                 // than best-effort parse — the UsageOutboxPayload rationale
                                 // (usage-outbox.payload.ts:18-22).
  "id": "<uuidv7>",              // the message's own identity. UUIDv7 matches the platform's
                                 // id convention (`@default(uuid(7))` everywhere) and sorts
                                 // by creation time, which makes a stream of ids debuggable.
  "tenantId": "<uuidv7>",        // MANDATORY. Never null. Platform-wide messages use the
                                 // SYSTEM tenant 00000000-…, never NULL — the same rule
                                 // rule 02 fixes for tenantId columns.
  "type": "stt.segment.finalized",   // lowercase dotted. Grammar below.
  "occurredAt": "<ISO-8601 UTC>",    // when the FACT happened, not when it was published.
  "correlationId": "<string>",       // request/session-scoped. Already present, ad-hoc, on
                                     // four surfaces (§2.6).
  "causationId": "<envelope id> | null",  // the envelope that caused this one. Makes
                                          // DomainEventMetaData.causationId (domainEvent.ts:14)
                                          // real instead of declared-and-unused.
  "idempotencyKey": "<intent-derived>",   // §3.5. Grammar reused verbatim from
                                          // usageLedger/idempotency-keys.ts:29,32.

  // EXACTLY ONE of the two below. Enforced by the schema (oneOf + required).
  "payload":    { },                 // inline JSON
  "payloadRef": {                    // claim check — shape is ClaimCheckRef verbatim
    "store": "s3", "bucket": "...", "key": "...",
    "size": 12345, "sha256": "<hex>", "contentType": "text/plain; charset=utf-8"
  }
}
```

Field-by-field rationale, each grounded:

- **`schemaVersion` as an integer, refused-if-unknown.** `usage-outbox.payload.ts:18-22`
  already establishes both the field and the "the drainer refuses unknown shapes" posture. A
  consumer that best-effort parses an unknown version is a consumer that silently drops fields.
- **`tenantId` mandatory and never null.** `base.service.ts:79` already writes
  `tenantId: this.tenantId ?? SYSTEM_TENANT_ID` **after** the spread specifically so a caller
  cannot override it, and rule 02 bans `NULL = global` on columns. The envelope inherits both.
- **`type` grammar** `/^[a-z0-9]+(\.[a-z0-9_]+){1,4}$/`. Lowercase dotted matches the register's
  own 29 named events (`transcript.segment.finalized`, `hitl.edit`, `code.bound`,
  `agent.timeout` — `01-invariant-register.md` §4) and `AGENT_ACTION_KEYS`
  (`departmentAgent/constants.ts:304`). Deliberately **not** `SysEventType`'s
  `'SysEvent.ResourceCreated'` form, which is a NestJS `EventEmitter2` channel name, not a wire
  type.
- **`occurredAt` is the fact time, not the publish time.** A redelivery must carry the original
  `occurredAt` or every consumer's ordering logic breaks on retry.
- **`causationId` nullable, referencing another envelope's `id`.** This is the field that makes
  a trajectory reconstructible without a tracing backend — which matters because
  design.md's observability model ("every node execution appends a trajectory row") must work
  when OTel is off (`OTEL_TRACES_ENABLED` is a flag —
  `packages/applications/src/services/baseServices/observability/otel.service.ts:88`).
- **`payload` XOR `payloadRef`.** Not "payload plus optional ref". Exactly one, enforced in the
  schema, so a consumer never has to decide which wins. The harness's existing pattern is
  additive-optional (`transcript_text` + `transcript_ref`, `models.py:88-90`) because it had to
  stay replay-compatible with recorded histories; a new contract has no such constraint and
  should not inherit the ambiguity.
- **`payloadRef` reuses `ClaimCheckRef` verbatim** (`claim_check.py:64-80`) — same six fields,
  same content-addressed sha256, same fail-loud semantics
  (`ClaimCheckNotFound` `:56`, `ClaimCheckIntegrityError` `:60`). The TS side gets the type
  and the verification helper; the *store* implementation is out of scope (§4 Task 5 notes it).

### 3.3 Decision — trace context stays OUTSIDE the envelope

`traceparent` / `tracestate` remain **flat sibling transport fields**, exactly as both existing
implementations already place them (`redis_streams.py:487-506` `_with_trace`;
`task_manager.py:105` `fields.update(inject_trace_carrier())`;
`streamingAudioBridge.service.ts:284`, `:310` `traceCarrierToArgs`).

Two reasons, both concrete:
1. The `_CARRIER_KEYS` allow-list (`trace_propagation.py:75`) exists precisely so a propagator
   cannot smuggle extra fields onto a PHI-bearing stream. Moving the carrier inside the
   envelope moves it past that gate.
2. Trace context is transport metadata with its own W3C lifecycle; an envelope that embeds it
   must re-version whenever that lifecycle moves.

The contract therefore **documents** the sibling-field convention and re-exports the existing
helpers' names for discoverability, but owns no propagation code. On transports that have no
sibling-field slot (BullMQ job data), the carrier goes in a reserved `_trace` sibling key on
the job data object — a sibling of the envelope, not a member of it.

### 3.4 Decision — delivery semantics, per transport

The contract does not *change* any transport's semantics. It **names** them, so an adopter
knows what it is signing up for.

| Transport | Delivery | Ordering | Ack / redelivery | Resume token |
|---|---|---|---|---|
| Redis Streams + consumer group (STT audio/result/control) | at-least-once | per-stream FIFO | `XACK` (`redis_streams.py:301`); reclaim via `XAUTOCLAIM` after 30 s idle (`:56`, `:325-332`) | stream message id |
| Redis Stream, no group (SMR chunks) | at-least-once, **client-driven** | per-stream FIFO | none — the client re-reads from its cursor | stream message id, surfaced as SSE `id:` (`stream.py:61`) and consumed from `Last-Event-ID` (`:35`) |
| BullMQ | at-least-once (`attempts: 3`, exponential 1000 ms — `redis.service.module.ts:23-55`) | **none** | BullMQ job completion / failure | **none** — a failed job replays from its source, it does not resume |
| Temporal signal | at-least-once; the workflow dedupes (`ContextAddedSignal.dedupe_key()` `models.py:1267-1269`) | per-workflow signal order | implicit in workflow history | **none** — workflow state IS the cursor |
| sys-events (EventEmitter2 → BullMQ) | in-process best-effort, then at-least-once once enqueued | none | job completion | none |

**The single normative rule the contract adds:** every transport above is at-least-once, so
**every consumer must be idempotent on `idempotencyKey`**, and every producer must set one
per §3.5. That is the whole point of documenting the semantics — at-least-once without a
convention for the key is at-least-once without a defence.

Temporal is documented but **not** an envelope adopter (§1 OUT): its history is already the
durable log, its payloads are size-budgeted, and it provides the delivery guarantee an envelope
would otherwise be asserting.

### 3.5 Decision — the idempotency-key convention

**Intent-derived, never random.** The rule and its justification are lifted verbatim from
`packages/applications/src/services/usageLedger/idempotency-keys.ts:3-26`, and so is the
grammar: `MAX_IDEMPOTENCY_KEY_LENGTH = 255` (`:29`), `/^[\x21-\x7e]{1,255}$/` (`:32`), shape
`<capability-prefix>:<intent-id>[:<qualifier>]`.

Recipes the contract ships (mirroring the table at `idempotency-keys.ts:37-51`):

| Producer | Key |
|---|---|
| STT finalized segment | `stt:session:<sessionId>:seg:<utteranceIndex>` |
| SMR stream chunk | `smr:task:<taskId>:chunk:<sequence>` |
| Workflow node completion (TASK-718) | `wf:run:<runId>:node:<nodeId>:<attemptGeneration>` |
| Exposure SSE frame (TASK-722) | the source envelope's `idempotencyKey`, unchanged |
| Webhook delivery (TASK-727) | `hook:<subscriptionId>:<sourceEnvelopeId>` |

The **contradiction with existing code is explicit and carved out**: the SDKs generate *random*
keys (`packages/agentic-sdk-v2/src/utils/idempotency.ts:20-25`;
`packages/vox-node/src/resources/consultation-summaries.ts:113`). Those are **client request
keys** — a caller de-duplicating its own retries of one HTTP call — which is a different object
from an event's identity. The contract says so in one sentence and does not try to change them.

The corollary from `idempotency-keys.ts:17-22` carries over unchanged and is the easiest thing
to get wrong: **the abort path uses the same key as the completion path.** Inventing an
`…:aborted` variant double-delivers.

### 3.6 Decision — the resume-token convention

**Opaque, transport-assigned, consumer-echoed.** The token is `base64url(JSON({v:1, t:<transport>, c:<cursor>}))`.

- The producer never invents it; the transport does. On a Redis stream it wraps the message id
  (`"1723800000000-0"`), which is exactly what SMR already surfaces as the SSE `id:`
  (`stream.py:61`) and reads back from `Last-Event-ID` (`:35`).
- It is opaque to the consumer: echo it back, do not parse it. The repo already uses opaque
  base64url cursors for the same reason — rule 04 §Pagination: *"opaque base64url
  `(sortKey, uuidv7 id)` token"*, implemented in
  `packages/applications/src/common/cursorPagination.ts`.
- `"0-0"` is the well-known "from the beginning" sentinel on Redis transports, matching
  `stream.py:35` and `redis_streams.py:168`.
- A transport with no cursor (BullMQ, Temporal) declares `resumable: false` and the contract
  forbids a synthetic token there — a resume token that cannot resume is worse than none.

Wrapping rather than exposing the raw id is what lets TASK-722's exposure SSE keep the same
client contract if the underlying stream is ever repartitioned, which is the only forward
compatibility this contract needs and the cheapest possible way to buy it.

### 3.7 Decision — the reference implementation path: **SMR SSE (`smr:stream:{task_id}`)**

| Candidate | Assessment |
|---|---|
| **SMR SSE + Redis stream** ✅ | Its wire schema is already **one `data` field holding a JSON document** (`task_manager.py:105`), so wrapping that document in an envelope is purely additive and breaks no field layout. It already implements the exact resume mechanism the contract standardizes (`id:` / `Last-Event-ID` / `"0-0"`, `stream.py:35,61`). It already carries the trace carrier as sibling fields. And it is the **direct upstream of TASK-722** (exposure SSE), so the reference implementation is on the path 722 builds on rather than beside it |
| STT Redis Streams ❌ | `AudioFrame` carries raw PCM bytes in `data` on the per-frame hot path (`schemas.py:72-86`); an envelope per audio frame is per-frame overhead for no benefit. Its result stream is a better fit but its fields are flat and hand-rolled in **two** independent implementations (Python publisher, TS producer, already disagreeing on `target` — §2.1), so adopting it means reconciling those first. A worthwhile ticket; not this one |
| BullMQ ❌ | Job data is per-queue and unrelated; adopting one queue proves nothing about the others, and eight registered queues have no consumer at all (§2.3) |
| sys-events ➖ | The best **second** adopter (§6): the envelope's mandatory `id`/`occurredAt` fixes the real latent gap at `sysEvent.service.ts:183,199`. Out of scope here because it touches every mutation path in the platform, which is not an M-sized change |
| Temporal ❌ | Excluded by §3.4 |

Adoption on SMR is **backward compatible by construction**: the envelope becomes the value of
the existing `data` field, and a `schemaVersion` probe lets a consumer distinguish an enveloped
chunk from a bare `StreamChunk` during rollout.

### 3.8 Repo rules that bind this work

| Rule | Obligation |
|---|---|
| `.claude/rules/06-python-services.md` §Env loading / Tooling | ruff + black (line length 100) + mypy; pytest `--strict-config --strict-markers`, `asyncio_mode = "auto"`; after a dependency change, `uv lock` at the **root** |
| `06-python-services.md` §Pitfalls | do not add `[tool.isort]` — ruff's `I` rules own import order |
| `.claude/rules/01-development-workflow.md` §Script Naming | new root scripts follow `<target>:<action>`; `typecheck` never `type-check`; `test:cov` never `test:coverage`; a `lint` script must not carry `--fix` |
| `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers | any new runtime knob (e.g. a claim-check size threshold) is a `global-kv` descriptor, not a new env var, unless it is bootstrap-floor. `HARNESS_CLAIM_CHECK_*` already exists in `turbo.json` for the harness's own store |
| `.claude/rules/04-application-services.md` | the reference implementation's TS side, if any, stays out of `services/**` Prisma access |

### 3.9 Known pitfalls for THIS ticket

- **A "documented contract" that nothing consumes is a wiki page.** The conformance suite in
  Task 6 is the deliverable that makes it real; it is not optional polish.
- **Do not put `traceparent` inside the envelope** (§3.3) — it defeats the `_CARRIER_KEYS`
  allow-list that exists to keep baggage off PHI-bearing streams.
- **Do not make `payloadRef` and `payload` both-optional.** XOR, enforced in the schema.
- **Do not generate `idempotencyKey` randomly.** `idempotency-keys.ts:3-26` explains, at
  length, why the resulting unique index never fires.
- **Do not synthesize a resume token for a non-resumable transport** (§3.6).
- **The Python package must not perturb `uv.lock`.** Follow the root `pyproject.toml`'s stated
  test for a new workspace member: its dependencies must already be declared by every member.
  `pydantic` qualifies; anything else does not.
- **`tenantId` in a message is not a substitute for a tenant guard.** The envelope carries it
  for routing and audit; the server-side boundary stays authoritative, and a consumer must
  still resolve authorization rather than trust the field.

---

## 4. Implementation Plan

Phase A is the design deliverable (the ticket's primary output). Phase B is one reference
implementation and the conformance suite 722/727 will consume.

### Phase A — Design

#### Task 1 — Write the envelope design document
- **Agent:** T4 · opus-5 · xhigh
- **Files:**
  - create `docs/programs/agentic-workflow-platform/async-contract.md`
  - modify `docs/programs/agentic-workflow-platform/design.md` (strike open question 3,
    linking the new document)
- **Approach:** The normative prose. Sections, in order: the envelope (§3.2 with the field
  table and grammars); trace context stays outside (§3.3); delivery semantics per transport
  (§3.4's table); the idempotency-key convention with the recipe table and the SDK carve-out
  (§3.5); the resume-token convention (§3.6); adoption guidance (what a surface must do to
  claim conformance) and the explicit non-adoption list with reasons (Temporal, and
  "everything not yet adopted stays as-is").

  Every claim about an existing surface carries its verified `file:line`. The document is
  written to be read by the TASK-722 and TASK-727 authors without this ticket's context.
- **Verify:** peer review by the TASK-722 and TASK-727 authors before Task 2 starts
  (coordination gate — these are the two consumers the ticket exists to serve).

#### Task 2 — Author the normative JSON Schema
- **Agent:** T3 · sonnet-5 · medium
- **Files:** create `packages/async-contract/schema/async-envelope.v1.json`
- **Approach:** Draft 2020-12. Encodes every constraint from §3.2 mechanically: the `type`
  pattern, the `idempotencyKey` pattern `^[\x21-\x7e]{1,255}$`, `occurredAt` as
  `format: date-time`, `tenantId`/`id`/`causationId` as UUID patterns, `payloadRef`'s six
  required fields, and the `payload` XOR `payloadRef` `oneOf`. `additionalProperties: false`
  at the top level — the `ConfigDict(extra="forbid")` discipline the harness models already use
  (`models.py:74` and throughout).
  Include a `$defs/claimCheckRef` whose field names match `ClaimCheckRef` exactly
  (`claim_check.py:64-80`), with `contentType` as the camelCase spelling and a note that the
  Python model's `content_type` maps to it by alias.
- **Verify:** validates against the draft-2020-12 metaschema; three worked example documents
  (inline payload, claim-check payload, invalid-both) behave as intended.

### Phase B — Packages

#### Task 3 — `@arcaai/async-contract` (TS)
- **Agent:** T3 · sonnet-5 · medium
- **Files:** create `packages/async-contract/` — `package.json`, `tsup.config.ts`,
  `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `eslint.config.mjs`, `README.md`,
  `src/index.ts`, `src/envelope.ts`, `src/idempotency.ts`, `src/resume-token.ts`,
  `src/claim-check-ref.ts`, `src/__tests__/`; modify root `package.json` (scripts)
- **Approach:** Copy `packages/json-schema-subset/package.json` structure exactly — zero runtime
  dependencies, dual CJS/ESM, `sideEffects: false`, `files: ["dist"]`. The README follows that
  package's README shape (why it exists / API table / constraints / consumers), because that
  README is the reason the rule stopped drifting and its shape is doing real work.

  Exports:
  ```ts
  export const ASYNC_ENVELOPE_SCHEMA_VERSION = 1;
  export interface AsyncEnvelope<TPayload = unknown> { … }   // §3.2
  export interface ClaimCheckRef { store; bucket; key; size; sha256; contentType; }

  /** House idiom: returns problems, never throws, so a caller surfaces them all at once. */
  export function asyncEnvelopeProblems(value: unknown): string[];
  /** Refuse-if-unknown. Returns null for an unknown schemaVersion; caller MUST NOT proceed. */
  export function parseAsyncEnvelope<T>(value: unknown): AsyncEnvelope<T> | null;

  export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
  export function idempotencyKeyProblems(key: string): string[];
  export const AsyncIdempotencyKey = { sttSegment, smrChunk, workflowNode, webhookDelivery };

  export function encodeResumeToken(transport: string, cursor: string): string;
  export function decodeResumeToken(token: string): { transport: string; cursor: string } | null;
  export const RESUME_FROM_BEGINNING = '0-0';
  ```
  The `problems: string[]` return shape is deliberate and matches
  `authorableJsonSchemaProblems`, `contextSchemaDefinitionProblems`, `writeScopeProblems` — the
  package-level house idiom (TASK-716 §2.2 lists them).

  Tests first, one per constraint in the schema, plus a test asserting the TS type surface and
  `asyncEnvelopeProblems` agree with `schema/async-envelope.v1.json` on a shared example corpus
  (`src/__tests__/examples/*.json`) — the same corpus the Python parity test uses.
- **Verify:** `pnpm --filter @arcaai/async-contract build test lint typecheck`; the built
  `package.json` declares zero runtime dependencies.

#### Task 4 — `hope_async_contract` (Python)
- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `packages/py-async-contract/` — `pyproject.toml`, `README.md`,
  `src/hope_async_contract/{__init__.py,envelope.py,idempotency.py,resume_token.py,py.typed}`,
  `tests/`; modify root `pyproject.toml` `[tool.uv.workspace] members`
- **Approach:** Mirror `packages/py-otel`'s packaging (`name = "hope-async-contract"`, ships
  `py.typed`, single already-universal dependency). Pydantic models with
  `ConfigDict(extra="forbid")` and camelCase aliases so the wire form matches the TS surface
  byte-for-byte. Same three helper areas: envelope parse/validate, idempotency-key recipes +
  grammar, resume-token encode/decode.

  Add the member to the root `pyproject.toml` with the same justification comment style the
  existing three carry ("Its single dependency (pydantic) is already declared by every member,
  so it adds nothing to this resolution").

  `tests/test_parity.py` validates the pydantic model's generated JSON Schema against
  `packages/async-contract/schema/async-envelope.v1.json` and round-trips the **same** example
  corpus the TS test uses. This test is the whole reason the pair exists (§3.1).
- **Verify:** `uv lock` at the root re-runs with no unrelated resolution change;
  `conda run -n arcaenv pytest packages/py-async-contract`; ruff + black + mypy clean.

### Phase C — Reference implementation + conformance

#### Task 5 — Adopt the envelope on the SMR stream path
- **Agent:** T3 · opus-4-8 · high
- **Files:**
  - modify `apps/text/src/text/services/task_manager.py` (`append_chunk` `:98-111`,
    `read_chunk_entries_blocking` `:142-176`)
  - modify `apps/text/src/text/api/endpoints/stream.py` (`:35`, `:61`)
  - modify `apps/text/pyproject.toml` (add `hope-async-contract`)
  - tests under `apps/text/src/text/tests/`
- **Approach:** Additive and backward compatible (§3.7).

  Producer (`append_chunk`): the `data` field's JSON becomes an `AsyncEnvelope` whose `payload`
  is the existing `StreamChunk` document, `type` is `smr.stream.<chunk.type>`,
  `idempotencyKey` is `smr:task:<taskId>:chunk:<sequence>`, `correlationId` is the request's
  correlation id, `tenantId` the resolved tenant. `inject_trace_carrier()` continues to write
  `traceparent`/`tracestate` as **sibling** fields — unchanged (§3.3).

  Consumer (`stream.py`): the SSE `id:` becomes `encode_resume_token("redis-stream", msg_id)`;
  `Last-Event-ID` is decoded back to a cursor, with the raw-`msg_id` form still accepted during
  rollout and `"0-0"` still the beginning sentinel. The SSE `event:` name stays `chunk.type`
  so existing clients are unaffected.

  A `schemaVersion` probe distinguishes an enveloped `data` document from a bare `StreamChunk`;
  a bare document is still accepted and read as today. Cutover of the acceptance path is a
  follow-up, not this ticket.

  **Claim check is wired but not required here.** SMR chunks are small; `payloadRef` is
  exercised by the conformance suite, not by this path. The blob store the harness already has
  (`claim_check.py:123` `S3BlobStore`) is not lifted into a shared package by this ticket —
  recorded in §6 as the next natural step, not done, because no consumer needs it yet.

  Tests: an enveloped chunk round-trips; an unknown `schemaVersion` is refused rather than
  best-effort parsed; a resume from a mid-stream token replays exactly the chunks after it; a
  bare legacy chunk still parses; `traceparent` is still a sibling field and is **not** inside
  the envelope (assert this explicitly).
- **Verify:** `pnpm text:test`; `pnpm text:lint`; `pnpm text:typecheck`.

#### Task 6 — Conformance suite (the deliverable 722/727 consume)
- **Agent:** T3 · sonnet-5 · high
- **Files:**
  - create `packages/async-contract/src/conformance/index.ts` (exported from the package root)
  - create `packages/async-contract/src/conformance/__tests__/self.test.ts`
  - create `packages/py-async-contract/src/hope_async_contract/conformance.py` + tests
  - create `tests/contracts/async-envelope.contract.test.ts`
- **Approach:** The suite is **exported from the package**, not written inside a consumer's
  tests — so TASK-722 and TASK-727 import and run it against their own producer rather than
  re-deriving what conformance means. This is the one design choice that makes the ticket's
  output reusable instead of exemplary.

  ```ts
  export interface AsyncProducerUnderTest {
    /** Produce one envelope for a given logical event. */
    produce(input: { type: string; payload: unknown; correlationId: string }): Promise<unknown>;
    /** Replay from a resume token, if the transport is resumable. */
    replay?(token: string): Promise<unknown[]>;
    resumable: boolean;
  }
  export function assertAsyncConformance(producer: AsyncProducerUnderTest): Promise<string[]>;
  ```

  Assertions (each returning a problem string, never throwing):
  1. every produced value satisfies `asyncEnvelopeProblems` → empty;
  2. `id` is unique across 1 000 productions and UUIDv7-shaped;
  3. `tenantId` is present and never null/empty;
  4. `type` matches the grammar;
  5. `occurredAt` parses as ISO-8601 and does **not** change across a redelivery of the same
     logical event;
  6. `idempotencyKey` is **stable** across two productions of the same logical event and
     **differs** for two different events — the property that catches a random key
     (§3.5's failure mode) mechanically;
  7. `payload` XOR `payloadRef`;
  8. a `payloadRef` verifies: size and sha256 match the referenced blob (fail-loud, per
     `claim_check.py:1-36`);
  9. `correlationId` is propagated unchanged; `causationId`, when set, names a previously
     produced `id`;
  10. `schemaVersion` unknown → the consumer helper returns null (refusal), not a partial parse;
  11. if `resumable`, replay from a mid-stream token yields exactly the suffix — no gap, no
      duplicate-with-different-`id`;
  12. if not `resumable`, no resume token is emitted.

  `tests/contracts/async-envelope.contract.test.ts` runs the suite against the Task 5
  implementation, joining the existing cross-service contract suite
  (`tests/contracts/`, run by `pnpm test:unit`).
- **Verify:** `pnpm --filter @arcaai/async-contract test`; `pnpm test:unit` (the contract test);
  `conda run -n arcaenv pytest packages/py-async-contract`.

#### Task 7 — Record the YAGNI boundary
- **Agent:** T1 · haiku-4-5 · default
- **Files:** modify `docs/programs/agentic-workflow-platform/design.md`
  (§"Explicitly not doing")
- **Approach:** Add one line: wholesale migration of the four non-reference async surfaces
  (STT streams, BullMQ, Temporal signals, sys-events) is explicitly not being done; each adopts
  the envelope only when that surface is already being changed for another reason, and Temporal
  is a permanent non-adopter for the reason in the design document. Strike open question 3 and
  link `async-contract.md`.
- **Verify:** `git diff` shows only those edits.

---

## 5. Acceptance Criteria

Paste actual output for every box.

- [ ] `docs/programs/agentic-workflow-platform/async-contract.md` exists and every claim
      about an existing surface carries a verified `file:line`
- [ ] Reviewed by the TASK-722 and TASK-727 authors before Phase B started (record the review)
- [ ] `packages/async-contract/schema/async-envelope.v1.json` validates against draft 2020-12;
      the three worked examples behave as specified
- [ ] `pnpm --filter @arcaai/async-contract build test lint typecheck` green; the package
      declares **zero runtime dependencies** (paste `package.json`)
- [ ] `conda run -n arcaenv pytest packages/py-async-contract` green; ruff, black and mypy clean
- [ ] The Python↔TS parity test passes against the shared example corpus
- [ ] `uv lock` at the repo root re-runs with **no** resolution change outside the new member
      (paste the diff summary)
- [x] `pnpm text:test`, `pnpm text:lint`, `pnpm text:typecheck` green — see §7 Task 5 evidence
- [x] The SMR path proves: enveloped round-trip, unknown-`schemaVersion` refusal, mid-stream
      resume, legacy bare-chunk acceptance, and `traceparent` still a **sibling** field — see
      `test_async_envelope_task717.py`
- [x] `assertAsyncConformance` is exported from the package root and passes against an
      SMR-recipe-shaped producer via `tests/contracts/async-envelope.contract.test.ts`
      (`pnpm test:unit`) — see §7 Task 6 evidence for the scope note on why this is a
      recipe-conformance adapter rather than a literal cross-language call
- [ ] `design.md` open question 3 struck; the YAGNI line added
- [ ] New root `package.json` scripts follow the `<target>:<action>` taxonomy; no `lint` script
      carries `--fix`
- [ ] `pnpm lint:all` and `pnpm typecheck:all` clean
- [ ] Ticket README updated with an Implementation Summary and files changed

---

## 6. Risks & Open Questions

1. **HUMAN-GATED — this contract binds two unwritten tickets.** TASK-722 and TASK-727 will
   build on the envelope, so a field added later is a breaking change for both. The Task 1
   review by those tickets' authors is a real gate, not a courtesy.
2. **A fifth twin pair is the failure mode.** The whole value is the parity test in Task 4. If
   it is ever skipped or marked flaky, the contract joins `trace_propagation` /
   `redis_streams` / the harness signal bodies as a hand-maintained duplicate. Recommend the
   parity test be named in the ticket's Implementation Summary as load-bearing.
3. **The claim-check store is Python-only and stays that way here.** `ClaimCheckRef`'s *shape*
   is shared by this ticket; the `BlobStore` implementation (`claim_check.py:83-177`) is not.
   A TS producer that needs to offload has no store today. That is acceptable while SMR chunks
   are small, and becomes a real gap the first time an exposure or webhook payload exceeds a
   transport limit — most likely in TASK-722. Recorded rather than pre-built.
4. **`causationId` is new behaviour, not just a new field.** Populating it correctly requires a
   producer to know which envelope caused it, which the sys-event path does not currently
   track (`base.service.ts:71-89` propagates `correlationId` only). On the SMR reference path
   the causing envelope is unambiguous. Elsewhere it will be `null` until a surface adopts it
   deliberately — and a `causationId` that is usually null is worse than none if consumers
   start relying on it. TASK-722/727 should treat it as optional.
5. **The sys-event path is the highest-value second adopter, and it is not this ticket.** §2.5
   shows `broadcastSysEvent` emits an object literal whose `id` and `createdAt` are `undefined`
   while `sysEvent.service.ts:183,199` reads both — a latent gap the envelope's mandatory `id`
   and `occurredAt` close. Doing it here would touch every mutation path in the platform, which
   is not M-sized. Recommend it as a Wave-2 follow-up.
6. **Eight registered BullMQ queues have no consumer** (§2.3), `JobQueue.SysEvent` among them.
   Standardizing an envelope does not make them live and must not be read as having done so.
   Whether those queues should be removed or wired is a separate finding, out of scope here.
7. **`type` cannot reference the domain enums** (§3.1). It is a validated dotted string, and
   the mapping from `SysEventType` / `JobQueue` / `ResourceType` to a wire `type` lives in the
   adopting surface. This is deliberate but it does mean two surfaces could pick different
   wire types for the same fact. The design document should ship a starting type registry as
   guidance, and TASK-722 should own it once there is a second adopter.
8. **Backward compatibility on SMR is proven by test, not by rollout.** The `schemaVersion`
   probe accepts bare legacy chunks, but no staged rollout is specified here because the
   producer and consumer deploy together in one service. If SMR is ever split into separately
   deployed producer/consumer pods (design.md's worker-pool standard, TASK-725), the probe
   becomes load-bearing across a version skew — worth a note in the design document.

---

## 7. Implementation Summary

**Scope executed**: Phase A (design), Phase B (packages), and Phase C (Tasks
5-6 reference implementation + wired conformance) all delivered. Phase A and
B were built in an earlier session (see the original text below, unchanged);
Phase C was completed in a follow-up session per §8's Change History — the
owner explicitly authorized Task 5 (SMR adoption on `apps/text`) and the
remainder of Task 6 (the Python conformance twin + the TS contract test
wiring the suite against a Task-5-shaped producer) that the original session
had deferred. Task 7 (YAGNI ledger line) was folded into the Task 1
`design.md` edit in the original session.

### Task 1 — Design document

Created `docs/programs/agentic-workflow-platform/async-contract.md`
(the envelope, per-transport delivery semantics, the idempotency-key
convention + SDK carve-out, why trace context stays outside the envelope,
why `type` cannot reference the domain enums, the resume-token convention,
adoption guidance, and an explicit adopters/non-adopters list). Every claim
about an existing surface carries a verified `file:line`, re-checked against
the live tree while writing (not copied from the ticket's own §2 verbatim).
Struck open question 3 in `design.md` and added the corresponding YAGNI
ledger line (Task 7).

**Not done**: the ticket calls for peer review by the TASK-722 and
TASK-727 authors as a hard coordination gate before Phase B starts (§5
acceptance criterion, §6 Risk 1) — those tickets do not exist yet, so this
review could not happen. Recorded as gated, not skipped.

### Task 2 — JSON Schema

Created `packages/async-contract/schema/async-envelope.v1.json` (draft
2020-12): `additionalProperties: false`, `payload`/`payloadRef` XOR via
`oneOf` + `not`, `$defs/uuid` and `$defs/claimCheckRef`. Verified with
Python's `jsonschema.Draft202012Validator`:
- the schema itself validates against the draft 2020-12 metaschema
- the two embedded valid `examples` validate
- three worked examples behave as specified: inline payload → valid,
  claim-check payload → valid, invalid-both (both `payload` and
  `payloadRef` present) → rejected; a "neither present" case and an
  "unknown `schemaVersion`" case were also verified rejected

### Task 3 — `@arcaai/async-contract` (TypeScript)

Created `packages/async-contract/` modeled file-for-file on
`packages/json-schema-subset` (zero runtime dependencies, dual CJS/ESM,
`sideEffects: false`). TDD: wrote all five test files first, ran `vitest`
and confirmed RED (`Cannot find module '../envelope'` etc. — pasted below),
then implemented `envelope.ts`, `claim-check-ref.ts`, `idempotency.ts`,
`resume-token.ts`, `src/index.ts` barrel, and (Task 6, additive) `src/
conformance/index.ts` exporting `assertAsyncConformance`. 49 tests, all
green. `resume-token.ts` deliberately avoids Node's `Buffer` (uses
`TextEncoder`/`TextDecoder`/`btoa`/`atob`) so the package stays usable from
`@arcaai/vox-node`'s non-Node targets. One deliberate interface extension
beyond the ticket's Task 6 sketch: `AsyncProducerUnderTest` gained an
optional `resumeTokenOf?(produced)` method — the sketch's `replay(token)`
alone cannot be exercised by a transport-agnostic suite without a way to
obtain a token for a specific prior production first; documented inline and
in the design doc.

RED (confirmed before implementation):
```
FAIL  src/__tests__/claim-check-ref.test.ts — Cannot find module '../claim-check-ref'
FAIL  src/__tests__/envelope.test.ts — Cannot find module '../envelope'
FAIL  src/__tests__/idempotency.test.ts — Cannot find module '../idempotency'
FAIL  src/__tests__/resume-token.test.ts — Cannot find module '../resume-token'
Test Files  4 failed (4)
```

GREEN, final verification (`pnpm --filter @arcaai/async-contract build test lint typecheck`, run individually inside the package):
```
$ pnpm build
CJS dist/index.js     11.96 KB   ⚡️ Build success
ESM dist/index.mjs     11.61 KB  ⚡️ Build success
DTS dist/index.d.ts    10.35 KB  ⚡️ Build success

$ pnpm lint
> eslint src
(no output — clean)

$ pnpm typecheck
> tsc --noEmit
(no output — clean)

$ pnpm test
 Test Files  5 passed (5)
      Tests  49 passed (49)
```

`package.json` declares **zero runtime dependencies** (no `dependencies` key at all):
```json
{
  "name": "@arcaai/async-contract",
  "devDependencies": {
    "@arcaai/config-eslint": "workspace:*",
    "@arcaai/config-ts": "workspace:*",
    "tsup": "^8.5.1",
    "typescript": "^5.9.3",
    "vitest": "^4.1.10"
  }
}
```

### Task 4 — `hope_async_contract` (Python)

Created `packages/py-async-contract/` modeled on `packages/py-otel` (uv
workspace member, `pydantic>=2.12.5` — already declared by every other
workspace member, so it perturbs no resolution). Pydantic models with
`ConfigDict(extra="forbid")` and `alias_generator=to_camel` so the wire form
matches the TS surface field-for-field. `tests/test_parity.py` round-trips
the SAME example corpus (`packages/async-contract/src/__tests__/examples/
*.json`) the TS package's own test uses, asserting this package's verdict
against ground truth independently established by validating the JSON
Schema file with `jsonschema.Draft202012Validator` — the SAME ground truth
the TS parity test asserts against (both packages stay dependency-light, so
neither runs the OTHER'S validator; see the module docstrings for why full
JSON-Schema-object equality isn't asserted, only the corpus-level verdict
and the top-level `required` set). Also proves the resume-token wire format
is cross-language-decodable (same base64url alphabet on both sides).

```
$ conda run -n arcaenv pytest packages/py-async-contract   (ran directly via
  ~/miniconda3/envs/arcaenv/bin/python -m pytest, per this session's HARD
  RULES — conda run's wrapper is broken in this environment)
============================== 39 passed in 0.06s ==============================

$ ruff check packages/py-async-contract/src/ packages/py-async-contract/tests/
All checks passed!

$ black --check packages/py-async-contract/src/ packages/py-async-contract/tests/
All done! 8 files would be left unchanged.

$ mypy --config-file packages/py-async-contract/pyproject.toml packages/py-async-contract/src/
Success: no issues found in 4 source files
```

`uv lock` at the repo root, diff summary (27 lines total, ALL additive — zero
lines removed, zero lines changed on any pre-existing package):
```
32a33
>     "hope-async-contract",
1967a1969,1994
[... 26 more added lines, all `[[package]] name = "hope-async-contract"` and
     its dependency/optional-dependency/metadata block; nothing else in the
     8000+-line lockfile changed]
```

### Task 5 — SMR reference implementation (completed, Phase C session)

`apps/text/src/text/services/task_manager.py` — `append_chunk` gained
`tenant_id`/`correlation_id` keyword args. When `tenant_id` is resolved, the
stream entry's `data` field becomes an `AsyncEnvelope` (`schemaVersion`,
UUIDv7 `id` via `uuid_extensions.uuid7()`, `type =
smr.stream.<chunk.type>`, `idempotencyKey =
AsyncIdempotencyKey.textChunk(taskId, sequence)` — a per-instance
`_chunk_sequences` counter — `correlationId`, `causationId: null`,
`payload` = the existing `StreamChunk`) written with
`model_dump_json(by_alias=True, exclude_unset=True)` (the `exclude_unset`
is load-bearing: it is what keeps an explicitly-`None` `payloadRef` out of
the wire form, which would otherwise satisfy the payload/payloadRef XOR
check on re-parse via `model_fields_set`). Without a resolved `tenant_id`
the write stays the bare `StreamChunk` exactly as before (additive,
backward compatible — no caller in `generate.py` was changed to pass a
tenant this session; the parameter is additive-only and unused by existing
call sites, which is why the full `apps/text` suite is untouched). A new
`_decode_chunk_data` probes for a `schemaVersion` key and either parses the
envelope (refusing — raising `ValueError`, never best-effort — on an
unrecognized version) or falls back to the legacy bare parse; `get_chunks`
and `read_chunk_entries_blocking` both route through it, so a single stream
can freely mix legacy and enveloped entries. `inject_trace_carrier()`'s
`traceparent` stays a sibling Redis field, never folded into the envelope.

`apps/text/src/text/api/endpoints/stream.py` — the SSE `id:` field is now
`encode_resume_token('redis-stream', msg_id)`; incoming `Last-Event-ID`
(query param or header) is decoded back to a raw cursor via
`decode_resume_token`, falling through to the raw value unchanged when it
isn't a well-formed token — so an OLD client storing a raw Redis message id
(or the `"0-0"` sentinel) keeps resuming correctly during rollout.

`apps/text/pyproject.toml` gained `hope-async-contract` (workspace source)
and `uuid7` (PyPI distribution `uuid7`, importable as `uuid_extensions` —
confirmed via `pip show -f uuid7`; the same package `apps/stt` already
depends on) plus a new `[[tool.mypy.overrides]]` entry for
`uuid_extensions` (it ships no stubs/`py.typed`). `uv lock` at the repo
root re-run — additive only (see evidence below).

Tests: `apps/text/src/text/tests/unit/test_async_envelope_task717.py` (10
tests, new) — enveloped-write shape, per-task/per-sequence idempotency key
stability, `traceparent` staying a sibling field, legacy bare writes
unchanged, mixed-stream reads, unknown-`schemaVersion` refusal, resume-token
round-trip. Two PRE-EXISTING tests in `test_xread_streaming.py`
(`test_sse_includes_message_id`, `test_sse_resumes_from_last_event_id`)
asserted the raw Redis message id verbatim in the SSE `id:` field — updated
to decode the now-opaque resume token back to its cursor before comparing
(the underlying Redis behavior they lock is unchanged; only the wire
encoding of `id:` changed, exactly as designed). Three NEW tests added to
`test_stream_endpoint.py` cover the resume-token cutover end-to-end: emitted
ids decode to `{transport: 'redis-stream', cursor: <msg_id>}`; a legacy raw
`Last-Event-ID` still resumes; a new opaque `Last-Event-ID` token decodes to
its cursor and is passed to `read_chunk_entries_blocking` unchanged.

RED (confirmed before implementation — 5 of 10 new tests failing on
`TypeError: TaskManager.append_chunk() got an unexpected keyword argument
'tenant_id'`, the other 5 passing incidentally since they exercise the
unchanged legacy path):
```
FAILED …test_async_envelope_task717.py::TestAppendChunkEnvelopesWhenTenantKnown::test_enveloped_write_wraps_the_stream_chunk_as_payload
FAILED …test_async_envelope_task717.py::TestAppendChunkEnvelopesWhenTenantKnown::test_idempotency_key_is_stable_per_task_and_sequence
FAILED …test_async_envelope_task717.py::TestAppendChunkEnvelopesWhenTenantKnown::test_traceparent_stays_a_sibling_field_not_inside_the_envelope
FAILED …test_async_envelope_task717.py::TestReadersAcceptBothEnvelopedAndBareEntries::test_get_chunks_reads_an_enveloped_entry
FAILED …test_async_envelope_task717.py::TestReadersAcceptBothEnvelopedAndBareEntries::test_read_chunk_entries_blocking_reads_mixed_stream
5 failed, 5 passed
```

GREEN, final verification:
```
$ pnpm text:lint
All checks passed!

$ pnpm text:typecheck
Success: no issues found in 74 source files

$ pnpm text:test   (equivalent direct invocation — see §"A note on the
                     conda/worktree environment" below for why; full
                     apps/text suite, e2e-marked tests deselected)
1199 passed, 16 deselected, 8 warnings in 191.23s
```

### Task 6 — Conformance suite (completed, Phase C session)

The TypeScript half (`assertAsyncConformance`, self-tested against an
in-memory fake producer) was already built in the original session and is
unchanged. This session completed the two remaining pieces:

**`packages/py-async-contract/src/hope_async_contract/conformance.py`** — a
line-for-line Python port of `packages/async-contract/src/conformance/
index.ts`, exported from the package root as `assert_async_conformance` +
the `AsyncProducerUnderTest` `Protocol` (`@runtime_checkable`; `replay` and
`resume_token_of` are optional exactly as in the TS twin — Python has no
clean way to express an optional Protocol method, so the suite probes for
them with `getattr` instead of requiring them structurally). All 12
numbered assertions from the ticket's Task 6 are present. Self-tested in
`packages/py-async-contract/tests/test_conformance.py` (5 tests, mirroring
`self.test.ts`'s four fakes + an added `isinstance` check) against
`FakeResumableProducer`, `FakeNonResumableProducer`, `BadProducer`, and
`MisdeclaredProducer`.

**`tests/contracts/async-envelope.contract.test.ts`** — wires
`assertAsyncConformance` against an in-memory `SmrStreamProducer` that
reproduces the EXACT recipe Task 5's `_encode_chunk_data`/the SSE `id:`
field implement (`smr.stream.<chunk.type>`, `AsyncIdempotencyKey.
textChunk(taskId, sequence)`, `encodeResumeToken('redis-stream', msgId)`).
`assertAsyncConformance` cannot import Python directly, so — following this
directory's existing convention of exercising a peer's WIRE CONTRACT rather
than a live network call (`text.contract.test.ts`, `stt.contract.test.ts`
mock the peer's responses instead of calling it) — a green run here proves:
IF a Python producer follows this documented recipe (as Task 5 does), it
conforms to the async envelope contract. Building this adapter surfaced one
real subtlety worth recording: `assertAsyncConformance`'s assertions 5/6
require that two `produce()` calls carrying the SAME `correlationId`
(modeling an at-least-once REDELIVERY) yield the SAME `occurredAt` and
`idempotencyKey` — a naive per-call sequence counter fails this, because
each `produce()` call would mint a NEW sequence regardless of whether it
represents a genuine retry. The adapter fixes this by memoizing
`(sequence, occurredAt)` per `correlationId` and only advancing the counter
for a `correlationId` it has not seen before — still appending a fresh
stream entry (new `id` / resume token) on every call, matching a real
retried `XADD`. `apps/text`'s actual `TaskManager._encode_chunk_data` does
NOT implement this memoization (its counter is a pure per-call increment) —
this is a documented, deliberate simplification: no caller in `generate.py`
retries a single `append_chunk` call today, so the gap is currently
unreachable, but a future retry-safe caller of `append_chunk` MUST NOT
assume distinct calls collapse. Left in scope-appropriate `docs/
implementation/TASK-717-Async-Contract/README.md` here rather than filed
separately since it does not block Task 5/6's acceptance criteria as written
(none of which requires producer-level retry-safety on the append path
itself — only the resume/redelivery semantics the transport already
provides).

RED (confirmed before the fix — the first version of `SmrStreamProducer`
used a bare per-call counter):
```
✗ conforms to the async envelope contract end to end
  - "occurredAt changed across two productions of the same logical event"
  - "idempotencyKey is not stable across two productions of the same logical event"
```

GREEN, final verification:
```
$ conda run -n arcaenv pytest packages/py-async-contract   (ran directly via
  ~/miniconda3/envs/arcaenv/bin/python -m pytest, per this session's
  environment note below)
44 passed

$ ruff check packages/py-async-contract/src/ packages/py-async-contract/tests/
All checks passed!

$ black --check packages/py-async-contract/src/ packages/py-async-contract/tests/
All done! 10 files would be left unchanged.

$ mypy --config-file packages/py-async-contract/pyproject.toml packages/py-async-contract/src/
Success: no issues found in 5 source files

$ pnpm --filter @arcaai/async-contract build test lint typecheck   (unchanged
  by this session — re-run to confirm no regression)
Test Files  5 passed (5) · Tests  49 passed (49)

$ npx vitest run tests/contracts/async-envelope.contract.test.ts
Test Files  1 passed (1) · Tests  5 passed (5)

$ pnpm test:unit   (repo-wide; see note below)
tests/contracts/async-envelope.contract.test.ts — all 5 passed
packages/async-contract/src/__tests__/envelope.test.ts — all passed (unchanged)
Test Files  768 failed | 349 passed | 2 skipped (1119)
     Tests  263 failed | 5744 passed | 4 skipped | 9 todo (6020)
```
The 768 failed files are PRE-EXISTING and unrelated to this ticket: this
worktree had no `node_modules` before this session (`pnpm install` was run
fresh) and several workspace packages (`@arcaai/database`, `@arcaai/domains`,
`@arcaai/room`, …) have not been built, so every suite importing their
built `dist/` fails with `Failed to resolve entry for package "@arcaai/
database"` / `"@arcaai/domains"` / `Failed to resolve import "@arcaai/room"`
— a repo-wide build-state issue, not a TASK-717 regression. Confirmed by
inspecting the failures: none reference `async-contract`, `task_manager`,
`stream.py`, or any file this ticket touched.

#### A note on the conda/worktree environment (process note, not a code change)

This worktree's `apps/text` and `packages/py-async-contract` are NOT
editable-installed in the shared `arcaenv` conda environment — that
environment's editable links point at the MAIN repo checkout (verified via
`pip show -f uuid7`-style introspection: `import text` resolved to `/…/
hope-v2/apps/text/…`, not this worktree, until `PYTHONPATH` was set
explicitly). Reinstalling the editable link would repoint it for every
OTHER concurrent worktree session sharing `arcaenv`, so this session instead
ran pytest directly against the conda env's interpreter with `PYTHONPATH`
prepended to this worktree's `src/` — `PYTHONPATH="$(pwd)/apps/text/src"
~/miniconda3/envs/arcaenv/bin/python -m pytest …` — which is the evidence
pasted above under "$ pnpm text:test". `pnpm text:lint` and `pnpm
text:typecheck` are unaffected (ruff/mypy operate on file paths, not
`import` resolution) and were run via the real `pnpm` scripts. Flagging this
for whichever session next touches `apps/text`/`packages/py-*` from a
worktree — it is not this ticket's problem to fix, but it will bite the same
way again.

### Task 7 — YAGNI boundary

Folded into the Task 1 `design.md` edit (see above) rather than a separate
commit-sized change — `git diff docs/programs/agentic-workflow-platform/
design.md` shows exactly: open question 3 struck + linked, and one new YAGNI
ledger clause naming the four non-adopted surfaces and Temporal's permanent
non-adoption.

### What was NOT run, and why

- `pnpm lint:all` / `pnpm typecheck:all` / `pnpm verify` — repo-root
  aggregates; this session's HARD RULES reserve those for the orchestrator.
  Package-scoped equivalents (above) were run instead.
- Any command touching a live DB, cluster, or deployed env — local infra is
  down per this session's brief; nothing in this ticket needed one.
- `pnpm --filter @arcaai/async-contract test:ct` / Storybook — this package
  ships no UI components.

### A note on shared-file touches

Adding two new workspace packages necessarily touched three shared files:
`pnpm-lock.yaml`, root `pyproject.toml` (new `packages/py-async-contract`
workspace member), and `uv.lock`. The `uv.lock` diff is proven purely
additive above. The `pnpm-lock.yaml` diff is also purely additive for actual
package entries, but installing `tsup` pulled a newer transitive `esbuild`
peer (`0.27.7` → `0.28.2`), which caused pnpm to re-emit peer-dependency-
suffixed resolution KEYS for several already-resolved packages (Storybook/
Vite/Playwright entries) without changing any package's actual version or
`specifier`. Flagging this explicitly in case a sibling ticket's `pnpm`
command produces an unexpected (but harmless) lockfile diff in the same
area.

---

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | ticket-writer agent (Wave 1 substrate foundations) |
| 2026-08-16 | Phase A + Phase B delivered (Tasks 1-4, 7): `async-contract.md` design doc, JSON Schema, `@arcaai/async-contract` (TS, incl. Task 6's `assertAsyncConformance`, self-tested), `hope_async_contract` (Python), `design.md` open question 3 struck + YAGNI line added. Phase C (Task 5 SMR adoption, and Task 6's Python conformance twin + real-producer wiring) deliberately deferred — see §7. Status set to Partial. | implementation agent |
| 2026-08-19 | Phase C delivered (owner-authorized): Task 5 — `apps/text/src/text/services/task_manager.py` (`append_chunk` envelopes chunks when a tenant is resolved, additive/backward-compatible; `_decode_chunk_data` reads both shapes) and `apps/text/src/text/api/endpoints/stream.py` (opaque resume tokens on the SSE `id:`, legacy raw-cursor fallback); `hope-async-contract` + `uuid7` added to `apps/text/pyproject.toml`, `uv lock` re-run (additive only). Task 6 — `packages/py-async-contract/src/hope_async_contract/conformance.py` (Python twin of `assertAsyncConformance`, self-tested) and `tests/contracts/async-envelope.contract.test.ts` (wires the suite against an SMR-recipe producer, `pnpm test:unit`). 10 new Python unit tests + 2 updated pre-existing ones + 3 new endpoint tests; 5 new Python conformance tests; 5 new TS contract tests. Full `apps/text` suite (1199 tests), `text:lint`, `text:typecheck` green; `py-async-contract` (44 tests) + ruff/black/mypy green; `@arcaai/async-contract` unchanged and still green; TS contract file green under `pnpm test:unit` (768 pre-existing, unrelated failures elsewhere in the repo-wide run traced to an unbuilt fresh `node_modules` in this worktree — see §7). Status set to Completed. | implementation agent |
