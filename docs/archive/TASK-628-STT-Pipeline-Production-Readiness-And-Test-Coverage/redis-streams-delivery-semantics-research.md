# TASK-628 Reference — Redis Streams as a Durable Buffer: Primary-Source Findings

**Researched**: 2026-08-07 · **Method**: redis.io `/docs/latest/` (Redis 8.x line), Apache Kafka markdown source, AWS SQS docs, Google Pub/Sub docs. Inferences and unverified claims are flagged inline.

Preserved ahead of the TASK-628 ticket body. Relevant because HOPE uses Redis Streams as the durability mechanism for in-flight clinical audio.

---

## 0. Two corrections before anything else

**A fabrication was caught mid-research.** A first pass returned a confident, well-formatted section titled *"At-Least-Once Delivery Semantics"* attributed to the Redis streams page. **That text does not exist.** Re-verification against the raw markdown source found zero occurrences of `at-least-once`, `at-most-once`, or `exactly once` describing consumer-group delivery.

> **Do not cite "Redis docs say consumer groups are at-least-once."** It is not quotable. The defensible citations are the XCLAIM sentence below, and the structural argument from XACK/PEL.

**And one of my own overclaims needs walking back.** [Appendix G §G3](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-zero-downtime-ha.md) states that `allkeys-lru` "does not respect consumer-group pending-entry semantics: a stream holding unacked audio can simply be evicted." **The word "stream" does not appear anywhere on the Redis eviction page** — verified against the complete page. The concern is real but it is an *inference from key-level framing*, not a documented Redis behavior. Corrected wording is in §3.

---

## 1. What Redis actually guarantees

### The PEL model
From [XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup/):

> "the server will *remember* that a given message was delivered to you: the message will be stored inside the consumer group in what is called a Pending Entries List (PEL) … consumer groups require explicit acknowledgment of the messages successfully processed by the consumer, via the `XACK` command."

`NOACK` is the explicit at-most-once knob: *"avoid adding the message to the PEL in cases where reliability is not a requirement and the occasional message loss is acceptable."*

Crash recovery is the documented `0` → `>` loop: reading with an ID other than `>` returns *"entries that are pending for the consumer sending the command"*; start at `0`, drain, then switch to `>`.

### The closest thing to an at-least-once admission
From [XCLAIM](https://redis.io/docs/latest/commands/xclaim/):

> "two consumers trying to claim a message at the same time will never both succeed … **yet multiple processing is possible and unavoidable in the general case**."

That parenthetical is the citable sentence. For an explicit *statement* of at-least-once, cite Pub/Sub or SQS (§5) instead.

### XAUTOCLAIM specifics worth knowing
- *"Conceptually equivalent to calling `XPENDING` and then `XCLAIM`, but provides a more straightforward way … via `SCAN`-like semantics."* Returns `0-0` when the scan completes — but *"you may want to continue calling `XAUTOCLAIM` even after the scan is complete … because enough time passed, so older pending entries may now be eligible."*
- **Scan budget gotcha**: *"The maximum number of pending entries that the command scans is the product of multiplying `count`'s value by 10 (hard-coded)."* So a claim pass can silently reclaim fewer entries than requested.
- **Redis 7.0+** drops dangling PEL entries whose stream entry was trimmed/deleted, and returns those IDs in reply element 3.
- `min-idle-time` is the mutual-exclusion mechanism, and *"claiming a message resets its idle time."*

---

## 2. ⚠️ Trimming silently destroys unacked work — the finding that matters most here

From the XREADGROUP page, *"What happens when a pending message is deleted?"*:

> "When an entry is trimmed with `XADD` or `XTRIM` and `DELREF` or `ACKED` are not specified … Redis doesn't prevent the deletion of entries that are present in the stream's PELs. When this happens, **the PELs retain the deleted entries' IDs, but the actual entry payload is no longer available. Therefore, when reading such PEL entries, Redis will return a null value in place of their respective data.**"

**Direct consequence for HOPE**: both the audio stream and the result stream are capped at `MAXLEN ~10000`. A consumer that falls behind while the producer keeps writing will have its pending entries trimmed out from under it, and the recovery read returns `nil` — data loss that presents as a null payload, not an error.

### The fix exists and is one keyword — Redis 8.2+

`XADD`/`XTRIM` gained a trim-mode argument:

| Mode | Behavior |
|---|---|
| `KEEPREF` | **Default.** Trims regardless of PEL references, "but preserves existing references to these entries in all consumer groups' PEL" — i.e. the tombstone behavior above |
| `DELREF` | Trims and removes the references from all PELs |
| **`ACKED`** | **"only removes entries that were read and acknowledged by all consumer groups"** — the consumer-group-safe retention mode |

⚠️ Caveat stated in the docs: *"if the number of referenced entries is larger than `MAXLEN`, trimming will still stop at the limit."* So `ACKED` bounds the damage but does not make the stream unbounded — a permanently stuck consumer still eventually loses entries.

**Recommendation for HOPE**: use `ACKED` on the audio and result streams if the deployed Redis is ≥ 8.2. Verify the actual server version first — this is a hard version floor.

### Capped-stream mechanics
`MAXLEN ~` (the form HOPE uses) is explicitly approximate: *"I don't really need this to be exactly 1000 items. It can be 1000 or 1010 or 1030"* — trimming happens only when a whole macro node can be released. XTRIM adds: *"the stream may have a few tens of additional entries over the `threshold`."* There is **no time-based retention** — *"There is currently no option to tell the stream to just retain items that are not older than a given period."*

---

## 3. Eviction × streams — a verified *negative*

The [key eviction page](https://redis.io/docs/latest/develop/reference/eviction/) was retrieved in full. **The word "stream" does not appear on it.** Redis documents no special interaction between eviction and streams, consumer groups, or PELs.

What *is* defensible:

1. **Eviction operates on whole keys.** An `allkeys-*` policy can evict the entire stream key — taking group state and PELs with it. ⚠️ This is an inference from the page's key-level framing, not a Redis statement.
2. **`noeviction` gives the fail-closed behavior you want**, and this one is verifiable by assembling two primary sources:
   - Eviction page: *"`noeviction`: Keys are not evicted but the server will return an error when you try to execute commands that cache new data … commands that only read existing data still work as normal."*
   - Command metadata: `XADD` carries `denyoom`; `XACK`, `XCLAIM`, `XAUTOCLAIM` do **not**.

   Therefore at `maxmemory` under `noeviction`, **ingest is rejected with an error while consumers can still read, ack, and claim.** The buffer fails closed on the producer side — which is exactly the desired behavior for clinical audio. ⚠️ Assembled from two sources; not stated in one place.

This strengthens the recommendation already in Appendix G §G3 (`noeviction` for the streams DB), and now on firmer ground than the original phrasing.

---

## 4. Persistence and replication — the decisive passage

From the streams intro, *"Persistence, replication and message safety"*:

> "**the consumer groups full state is propagated to AOF, RDB and replicas**, so if a message is pending in the master, also the replica will have the same information. Similarly, after a restart, the AOF will restore the consumer groups' state."

> "* AOF must be used with a strong fsync policy if persistence of messages is important in your application.
> * By default the asynchronous replication will not guarantee that `XADD` commands or consumer groups state changes are replicated: after a failover something can be missing …
> * The `WAIT` command may be used in order to force the propagation … However … the Redis failover process as operated by Sentinel or Redis Cluster performs only a *best effort* check …"

Two things follow for HOPE's Redis-persistence decision (Appendix G §G3):

- Consumer-group state **is** persisted and replicated — so enabling AOF genuinely restores the resume machinery after a restart, not just the raw entries. That makes option (a) — AOF on an encrypted volume — materially more valuable than "the streams survive."
- `appendfsync everysec` (the default) means *"you may lose 1 second of data if there is a disaster."* For clinical audio that is likely acceptable; `always` is *"very very slow."*

RDB alone is explicitly unsuitable: *"you should be prepared to lose the latest minutes of data."*

---

## 5. Delivery semantics elsewhere — for citation

| Source | Statement |
|---|---|
| **Kafka** ([Apache markdown](https://raw.githubusercontent.com/apache/kafka-site/markdown/content/en/43/design/design.md)) | *"At most once — Messages may be lost but are never redelivered. At least once — Messages are never lost but may be redelivered. Exactly once — Each message is processed once and only once."* Note exactly-once is defined on **processing**, not delivery |
| **Kafka** | The ack-ordering rule, cleanly stated: saving position *before* processing = at-most-once; processing *before* saving position = at-least-once. **This is the citable source for "ack after processing, never before."** |
| **SQS FIFO** | *"If you retry the `SendMessage` action **within the 5-minute deduplication interval**, Amazon SQS doesn't introduce any duplicates."* The clearest primary-source precedent that **dedup is a bounded window, not a promise** |
| **Pub/Sub** | *"Pub/Sub offers at-least-once delivery for all messages published … Message processing must be idempotent."* |
| **Pub/Sub exactly-once** | *"**A subscription might receive multiple copies of the same message due to publish side duplicates, even with exactly-once delivery enabled.**"* — the strongest statement that vendor "exactly-once" covers only the delivery leg |
| **Pub/Sub ordering** | *"Redeliveries of a message trigger redelivery of all subsequent messages for that key, even acknowledged ones."* Directly relevant to any `(sessionId, seq)` design: **the consumer must be idempotent over a range, not just a point** |

### Idempotency primitives worth knowing
- Redis guarantees **total ordering within a stream** (XADD: *"the ID of any entry you insert will be greater than any previous ID"*).
- **Redis 8.6** added producer-side idempotency: `XADD IDMP <producer-id> <idempotent-id>` — *"If this producer-id/idempotent-id combination was already used, the command returns the ID of the original entry instead of creating a duplicate"* — with a configurable, **finite** retention window (`IDMP-DURATION`, `IDMP-MAXSIZE`). Same bounded-window shape as SQS.
- Kafka dedups on `(producer id, sequence number)` at the broker.

---

## 6. Explicitly unverified — do not cite as primary

1. **"Redis docs say consumer groups are at-least-once"** — verified **false** as a quotation (§0).
2. **Redis docs say nothing about eviction × streams/PELs** — verified negative.
3. "Eviction removes whole stream keys including PEL" — inference, not a Redis statement.
4. `noeviction` × `XADD denyoom` behavior — assembled from two sources, not stated in one.
5. Redis "Recovering from permanent failures" — paraphrase only, not verbatim.
6. Kafka's transactional-offset (exactly-once) consumer scenario — not captured verbatim from the Apache source.
7. Kafka's "sequence number must be exactly one greater" — from a search summary only.
8. **No gap-detection protocol is documented by any vendor** — not Redis, Kafka, Pub/Sub, or SQS. If HOPE wants gap detection on `(sessionId, seq)`, that is a design decision to be argued on its own merits, not an inherited pattern.
9. No canonical impossibility paper (FLP, Two Generals) was fetched; none is cited.

---

## Sources

[Redis Streams intro](https://redis.io/docs/latest/develop/data-types/streams/) · [XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup/) · [XAUTOCLAIM](https://redis.io/docs/latest/commands/xautoclaim/) · [XCLAIM](https://redis.io/docs/latest/commands/xclaim/) · [XADD](https://redis.io/docs/latest/commands/xadd/) · [XTRIM](https://redis.io/docs/latest/commands/xtrim/) · [Key eviction](https://redis.io/docs/latest/develop/reference/eviction/) · [Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/) · [Kafka design (Apache source)](https://raw.githubusercontent.com/apache/kafka-site/markdown/content/en/43/design/design.md) · [SQS standard queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html) · [SQS FIFO exactly-once](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html) · [Pub/Sub reliability](https://docs.cloud.google.com/pubsub/docs/reliability-intro) · [Pub/Sub exactly-once](https://docs.cloud.google.com/pubsub/docs/exactly-once-delivery) · [Pub/Sub ordering](https://docs.cloud.google.com/pubsub/docs/ordering)
