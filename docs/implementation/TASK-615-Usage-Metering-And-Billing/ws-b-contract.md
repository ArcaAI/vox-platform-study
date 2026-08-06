# TASK-615 WS-B — The Frozen Emission Contract

| | |
|---|---|
| **Owner** | WS-B (ledger core services) |
| **Status** | **FROZEN** once branch `task-615-ws-b` merges. Changes require an orchestrator decision + a rebase of every wave-1 lane. |
| **Consumers** | WS-C (STT) · WS-D (SMR + guardrail) · WS-E (TTS + NLP) · WS-F (harness) |
| **Code** | `packages/applications/src/services/usageLedger/**` · `packages/applications/src/services/priceBook/**` |
| **Import from** | `@arcaai/applications` (root barrel) |

---

## 0. The one-paragraph version

An emitter calls `IUsageLedgerService.recordUsage(...)`, ideally passing the
transaction that produced the work. That writes an **outbox row**, nothing else.
A BullMQ-ticked **drainer** later rates each event against the COST price book
*as of `occurredAt`*, appends an `AiUsageEvent`, and increments the hourly and
daily rollups — all three in one transaction. Double-billing is prevented by a
unique, **intent-derived** `idempotencyKey`; that is also why the abort path
emits with the *same* key the completion path would.

---

## 1. `UsageEventInput` — the shape you build

```ts
import { IUsageLedgerService, UsageIdempotencyKey } from '@arcaai/applications';
import { AiCapability, AiDeploymentKind, AiUsageUnit, AiCostBasis } from '@arcaai/domains';

interface UsageEventInput {
  tenantId:        string;                 // required
  idempotencyKey:  string;                 // intent-derived — see §4
  occurredAt:      Date | string;          // when the work HAPPENED (ISO string ok)

  capability:      AiCapability;           // STT | LLM | NLP | TTS | EMBEDDING
  operation:       UsageOperation;         // one of the ten in §2
  provider:        string;                 // §3
  model?:          string | null;          // null when the capability selects no model
  deployment:      AiDeploymentKind;       // SELF_HOSTED | CLOUD | BYOK

  unit:            AiUsageUnit;            // INPUT_TOKEN | … | GPU_SECOND
  quantity:        number | string;        // non-negative; string when fractional

  costBasis?:      AiCostBasis;            // default INTERNAL; BYOK must pass BYOK_NOTIONAL

  consultationId?: string | null;          // attribution — ids only, never names
  doctorId?:       string | null;
  departmentId?:   string | null;
  requestId?:      string | null;          // ties every unit row of one call together
  sessionId?:      string | null;

  attributesJson?: UsageAttributes | null; // allow-listed dimensions ONLY — §6
}
```

**Return:** `{ outboxIds: string[]; events: number }`.
**Throws:** `ArgumentInvalidException` listing *every* violation. Nothing is
written when it throws, so a corrected retry is a clean first attempt.

### The multi-unit form (use this for LLM calls)

```ts
await ledger.recordUsage({
  common: { /* everything except unit + quantity; idempotencyKey is the BASE key */ },
  units:  [{ unit, quantity, attributesJson? }, …],
}, tx);
```

- per-row key = `` `${common.idempotencyKey}:${unit}` ``
- per-unit `attributesJson` is merged **over** the common bag
- **units with `quantity === 0` are dropped** (all-zero ⇒ nothing is written at all)

### Rules that will bite you if you skip them

| Rule | Why |
|---|---|
| `occurredAt` is *event time*, not now | It selects the price row. Defaulting it re-rates history at today's rate. |
| `quantity` as a **string** when fractional | A JSON number is an IEEE double; `12.345678` audio-seconds × price is where drift becomes money. |
| Nothing is derived for you | No inferred `costBasis`, no defaulted `occurredAt`, no normalised provider casing. You get an exception instead. |
| Validation is all-or-nothing | A partial write would race your own retry. |
| BYOK ⇒ pass `costBasis: BYOK_NOTIONAL` explicitly | It is metered and rated for tenant visibility, excluded from platform-spend rollups, never invoiced (D14). Omitting it only logs a warning — the default over-reports platform spend, which is the safe direction, but it is still wrong. |

---

## 2. Operation vocabulary — CLOSED (ten values)

`recordUsage` **rejects** anything else. Adding an eleventh is a one-line change
in `vocabulary.ts` + a line here — no migration.

| `operation` | Lane | Notes |
|---|---|---|
| `transcribe.stream` | WS-C | live socket teardown (complete **and** abort) |
| `transcribe.batch` | WS-C | batch job completion |
| `generate` | WS-D | non-streaming SMR generation |
| `generate.stream` | WS-D | streaming SMR generation, abort included |
| `presummarize` | WS-D | pre-summary pass |
| `guardrail.validate` | WS-D | metered for COGS; **never quota-blocked, never invoiced** (D16) |
| `ner.extract` | WS-E | consultation-batched |
| `tts.synthesize` | WS-E | |
| `harness.step` | WS-F | one agentic-loop step |
| `embed` | WS-D/E | retrieval + diarization embeddings |

## 3. Provider vocabulary — OPEN but SHAPED

`recordUsage` enforces only the **shape**: `/^[a-z0-9][a-z0-9._-]{0,63}$/`
(lowercase — `Azure` is rejected, not silently down-cased). It does **not**
reject an unknown provider: a tenant admin can create an `AiProviderConnection`
at runtime, and failing closed there would lose real money to protect a naming
convention.

The canonical list (`KNOWN_PROVIDERS`, exported — assert against it in your own
lane's tests) is copied verbatim from the seeds and the Python services:

| Kind | Values |
|---|---|
| Cloud / BYOK **connection ids** | `openai` · `azure` · `azure-speech` · `anthropic` · `bedrock` · `vertex` · `sarvam` |
| Self-hosted **server** connection ids | `ollama` · `lm-studio` · `vllm` · `llama-cpp` · `built-in` |
| Self-hosted **engine ids** | `whisper_cpp` · `faster_whisper` · `kokoro` · `indic_parler` · `silero` · `gliner` |

> ⚠️ **Spelling traps.** The LLM connection id is `azure`, **not** `azure-openai`
> (that string is an SMR *setting* value). It is `lm-studio` / `llama-cpp`
> (hyphens) but `whisper_cpp` / `indic_parler` / `faster_whisper` (underscores).
> A wrong spelling does not fail — it silently forks a rollup dimension, which
> is worse.

`deployment` carries the economics, independent of the provider string:
`SELF_HOSTED` (platform hardware) · `CLOUD` (platform-funded vendor call) ·
`BYOK` (tenant-funded).

---

## 4. Idempotency-key recipes

**A key is derived from intent, never from chance.** No clocks, no counters, no
freshly-minted UUIDs. The unique index on `AiUsageEvent.idempotencyKey` is the
whole anti-double-billing mechanism and a random key defeats it silently.

Builders live in `UsageIdempotencyKey` (exported); `forUnit(base, unit)` appends
the unit, and the `{common, units}` batch form does that for you.

| Capability | Base key | Example row key |
|---|---|---|
| STT batch | `UsageIdempotencyKey.sttBatchJob(jobId)` → `stt:job:<jobId>` | `stt:job:<jobId>:AUDIO_SECOND` |
| STT streaming | `sttStreamSession(sessionId)` → `stt:session:<sessionId>` | `stt:session:<id>:SESSION_SECOND`, `…:AUDIO_SECOND` |
| LLM (SMR) | `llmRequest(requestId)` → `llm:<requestId>` | `llm:<requestId>:INPUT_TOKEN` |
| Guardrail | `guardrailRequest(requestId)` → `guardrail:<requestId>` | `guardrail:<requestId>:OUTPUT_TOKEN` |
| TTS | `ttsRequest(requestId)` → `tts:<requestId>` | `tts:<requestId>:CHARACTER` |
| NLP | `nlpRequest(requestId)` → `nlp:<requestId>` | `nlp:<requestId>:TEXT_UNIT` |
| Embeddings | `embedRequest(requestId)` → `embed:<requestId>` | `embed:<requestId>:INPUT_TOKEN` |
| Harness step | `harnessStep(stepId)` → `harness:step:<stepId>` | `harness:step:<stepId>:OUTPUT_TOKEN` |

> NLP is **consultation-granular** (§3 of research-findings): the `requestId` you
> pass is the per-consultation batch id, not a per-utterance one. The recipe does
> not change; what it identifies does.

### THE ABORT RULE

> **The abort path emits the SAME key the completion path would.**
> A stream that aborts and then also runs normal teardown emits twice; the
> second is a no-op at the ledger. Inventing an `…:aborted` variant would bill
> the session twice — the exact failure the abort path was added to prevent.
> Record `attributesJson: { interrupted: true }` to mark it instead.

---

## 5. Transaction rules

```ts
// PREFERRED — usage produced by a transactional business write
await this.uow.runInTransaction(async (tx) => {
  const saved = await this.summaryRepository.create(entity, tx);
  await this.ledger.recordUsage({ common: {…}, units: [...] }, tx);   // ← same tx
});

// ACCEPTABLE — no business transaction to join (stream teardown, job callback)
await this.ledger.recordUsage(input);
```

| | |
|---|---|
| **Pass `tx`** | whenever a business row is being written in the same breath. Guards both directions: usage lost after a successful call, *and* usage recorded for work that rolled back. |
| **Omit `tx`** | only when the work already committed elsewhere. |
| **Never** | call `recordUsage` inside a transaction you did not pass in — the row would commit independently and could survive a rollback. |
| **Never** | let a metering failure fail the user's request. Emission is a side effect of work already done; wrap the call if your path cannot tolerate a throw. |

---

## 6. `attributesJson` — the allow-list (PHI gate)

Only these keys, only enum-ish scalar values. Strings must match
`/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/` — **no spaces, no prose**. Numbers must be
safe integers. Nested objects and arrays are rejected. An unknown key is
rejected. An explicit `null` is fine (= "does not apply").

| Key | Type | Meaning |
|---|---|---|
| `channelCount` | number | dual-mic bills 1× (OQ2); the count is kept for repricing |
| `engine` | string | which self-hosted engine served the call |
| `pipelineId` | string | STT pipeline-tier rate resolution + provenance |
| `languageMode` | string | `en` / `ml` / `ml-en` … |
| `serviceTier` | string | provider tier (`batch` is ~50% off at every lab) |
| `interrupted` | boolean | **the abort path emitted this row** |
| `streamKind` | string | `ws` / `sse` |
| `cacheTtl` | string | Anthropic 5m vs 1h cache write (×1.25 vs ×2.00) |
| `endpointKind` | string | which API shape the normalizer branched on |
| `contextBand` | string | price-book context band this row was rated against |

This is the control that keeps the billing plane provably PHI-free and therefore
outside §164.312(b) (D17). **Need a new key? Ask the orchestrator.** Add it only
if it is a *dimension* (something you would group a rollup by or price on) — if
the value could ever be typed by a human, it does not belong in this plane.

---

## 7. Provider-usage normalizer (WS-D and WS-F: read this twice)

```ts
import { normalizeLlmUsage, reduceStreamingUsage, toUsageUnitQuantities,
         anthropicCacheTtlSplit, totalInputTokens, totalOutputTokens } from '@arcaai/applications';

normalizeLlmUsage(provider: string, endpointKind: LlmEndpointKind, rawUsage: unknown)
  => { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }

reduceStreamingUsage(endpointKind, chunks: unknown[]) => unknown   // feed into normalizeLlmUsage
toUsageUnitQuantities(normalized) => Array<{ unit, quantity }>     // drops zeros; feeds `units:`
```

**THE CONTRACT: the five counters are DISJOINT.**

```
billable input  = inputTokens + cacheReadTokens + cacheWriteTokens
billable output = outputTokens + reasoningTokens
```

`inputTokens` is the *uncached* input; `outputTokens` *excludes* reasoning —
regardless of whether the provider reported inclusively or exclusively. The
ledger prices each unit separately, so overlapping counters double-stamp.

**`endpointKind` is the discriminator — branch on the ENDPOINT, never the model.**

| `endpointKind` | Used by | The trap it handles |
|---|---|---|
| `openai.chat` | OpenAI, Azure, vLLM, LM Studio, llama.cpp-in-OAI-mode | `prompt_tokens` **includes** cache → subtracted |
| `openai.responses` | OpenAI Responses API | same, different field names |
| `anthropic.messages` | Anthropic | `input_tokens` **excludes** cache → passed through |
| `bedrock.converse` | Bedrock | exclusive, camelCase |
| `gemini.generate` | Gemini (AI Studio) | `candidatesTokenCount` **includes** thoughts → subtracted |
| `vertex.generate` | Vertex AI | `candidatesTokenCount` **excludes** thoughts → not subtracted |
| `ollama.native` | Ollama | `prompt_eval_count` / `eval_count` |
| `llamacpp.native` | llama.cpp | prefers `usage`; `timings.prompt_n` is the NON-cached portion |
| `lmstudio.chat` | LM Studio | OpenAI shape + non-standard `stats` (ignored) |

Other behaviours you can rely on:

- **Anthropic streaming deltas are CUMULATIVE.** `reduceStreamingUsage` takes the
  last `message_delta` and merges `message_start`'s input/cache — never sums.
- Missing/`null` usage ⇒ all zeros. It never throws on a shape; it *does* throw
  on an unknown `endpointKind` (guessing inclusive-vs-exclusive is a coin flip
  that lands on an invoice).
- Every counter is clamped to ≥ 0 and rounded to an integer. `null` (vLLM V1's
  broken `cached_tokens`) degrades to 0, never `NaN`.
- `anthropicCacheTtlSplit(raw)` returns `{ ephemeral5m, ephemeral1h }` or `null` —
  put the dominant TTL in `attributesJson.cacheTtl`.

---

## 8. What the drainer does with your row (so you can reason about it)

1. **Rates** on the COST plane at `occurredAt` (never `recordedAt`), stamping
   `unitPriceMicros` / `costMicros` / `priceBookVersion`.
   - **A resolved price of `0` is a real rate** — two seeded rows are
     deliberately zero (STT `SESSION_SECOND` COGS, NLP `REQUEST`).
   - **Rating fails OPEN.** No price ⇒ the event is recorded *unrated* (null
     price fields) rather than dropped. A missing rate is repairable by
     back-rating from the raw ledger; a missing event is not.
2. **Appends** the `AiUsageEvent` and **increments** the hourly + daily rollups
   in ONE transaction. The rollup delta is derived from the *insert outcome*, so
   a redelivery is a true no-op.
   - `BYOK_NOTIONAL` cost is stamped on the event but contributes **0** to the
     rollups (platform-spend reads must not include tenant-funded calls).
   - Rollup `model` uses the **empty-string sentinel** when the capability
     selects no model.
3. **Retries** on the outbox row itself (`attempts`, `availableAt`, `lastError`)
   — 30 s doubling to 30 min, 8 attempts, then parked `FAILED` for a human.
   BullMQ only provides the tick and cross-replica single-execution.

Price resolution precedence (also used by WS-I): **tenant card beats SYSTEM
card**; within a card, `provider` > `model` > `contextBand` > `planTier`; ties
break on latest `effectiveFrom`, then newest UUIDv7 id.

Drain schedule (AppSettings): `metering.outbox.drain.enabled` (default **true**)
and `metering.outbox.drain.intervalSeconds` (default **30**).

---

## 9. Per-lane cheat-sheet

### WS-C — STT

Streaming teardown emits **both** units, from complete **and** abort paths:

```ts
await this.ledger.recordUsage({
  common: {
    tenantId, sessionId, consultationId, doctorId,
    idempotencyKey: UsageIdempotencyKey.sttStreamSession(sessionId),
    occurredAt: sessionClosedAt,                 // teardown instant
    capability: AiCapability.STT,
    operation: 'transcribe.stream',
    provider: 'whisper_cpp',                     // engine id
    model: null,
    deployment: AiDeploymentKind.SELF_HOSTED,
    attributesJson: { engine: 'whisper_cpp', pipelineId, languageMode: 'ml-en',
                      channelCount: 2, streamKind: 'ws', interrupted },
  },
  units: [
    { unit: AiUsageUnit.SESSION_SECOND, quantity: sessionSeconds },  // the quota/bill basis (OQ1)
    { unit: AiUsageUnit.AUDIO_SECOND,   quantity: audioSeconds },    // 1x mixed (OQ2)
  ],
});
```

Batch: `operation: 'transcribe.batch'`, key `sttBatchJob(jobId)`, one
`AUDIO_SECOND` row, `occurredAt` = job completion. Emit inside the
job-completion transaction and pass `tx`.

### WS-D — SMR + guardrail

```ts
const raw  = reduceStreamingUsage('anthropic.messages', usageChunks); // streaming
const norm = normalizeLlmUsage('anthropic', 'anthropic.messages', raw);

await this.ledger.recordUsage({
  common: {
    tenantId, requestId, consultationId, doctorId, departmentId,
    idempotencyKey: UsageIdempotencyKey.llmRequest(requestId),
    occurredAt: completedAt,
    capability: AiCapability.LLM,
    operation: 'generate.stream',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    deployment: AiDeploymentKind.CLOUD,          // BYOK ⇒ + costBasis: BYOK_NOTIONAL
    attributesJson: { endpointKind: 'anthropic.messages', streamKind: 'sse',
                      serviceTier, interrupted: aborted },
  },
  units: toUsageUnitQuantities(norm),
}, tx);                                          // same tx as the SummaryMeta write
```

Guardrail is identical with `operation: 'guardrail.validate'` and
`guardrailRequest(requestId)` — metered in full, **never** quota-blocked, never
invoiced.

### WS-E — TTS + NLP

```ts
// TTS — characters accepted (1 Unicode code point = 1 char) + synthesized seconds
common: { idempotencyKey: UsageIdempotencyKey.ttsRequest(requestId),
          capability: AiCapability.TTS, operation: 'tts.synthesize',
          provider: 'kokoro', deployment: AiDeploymentKind.SELF_HOSTED },
units:  [{ unit: AiUsageUnit.CHARACTER,    quantity: [...text].length },
         { unit: AiUsageUnit.AUDIO_SECOND, quantity: synthesizedSeconds }]

// NLP — consultation-batched: ONE REQUEST row per consultation, not per utterance
common: { idempotencyKey: UsageIdempotencyKey.nlpRequest(consultationBatchId),
          capability: AiCapability.NLP, operation: 'ner.extract', provider: 'gliner' },
units:  [{ unit: AiUsageUnit.TEXT_UNIT, quantity: charCount / 100 },
         { unit: AiUsageUnit.REQUEST,   quantity: 1 }]
```

A 413-rejected request emits **nothing** — no work was done.

### WS-F — harness

Emit from the **activity / persistence** path, never inside `@workflow.defn`
(determinism). One call per step, keyed on the step id:

```ts
common: { idempotencyKey: UsageIdempotencyKey.harnessStep(stepId),
          capability: AiCapability.LLM, operation: 'harness.step',
          requestId: runId, consultationId,
          provider: 'lm-studio', model, deployment: AiDeploymentKind.SELF_HOSTED },
units:  toUsageUnitQuantities(normalizeLlmUsage(provider, 'openai.chat', step.stats)),
```

Metered for COGS, never line-itemed to tenants (D16). Emit in the same
transaction as the `AgentTrajectoryStep` write.

---

## 10. Frequently-made mistakes (checked in review)

- ❌ `idempotencyKey: uuid()` — defeats the unique index; every retry bills again.
- ❌ `occurredAt: new Date()` on an abort/backfill — re-rates history.
- ❌ `provider: 'azure-openai'` / `'lmstudio'` / `'whispercpp'` — forks a rollup dimension.
- ❌ Emitting `input + cacheRead` as one `INPUT_TOKEN` row — double-stamps the cache.
- ❌ Summing Anthropic streaming deltas — multiplies output tokens.
- ❌ A descriptive `attributesJson` key — rejected, and it is the PHI boundary.
- ❌ `recordUsage` without `tx` next to a transactional write — usage can survive a rollback.
- ❌ A separate `…:aborted` idempotency key — bills the session twice.

---

## 11. Open items handed on

| Item | Owner |
|---|---|
| Bounded acceptance window for late `occurredAt` + an explicit backfill/correction path (research §6). WS-B validates only that the date parses. | WS-H / WS-K |
| Price-book read cache. Deliberately absent — a stale rate is a wrong invoice. If profiling demands one, the key **must** include `tenantId` (§M4). | WS-I |
| A per-TTL `CACHE_WRITE_TOKEN` price dimension (5m ×1.25 vs 1h ×2.00). Today both write kinds share one unit; the split is surfaced via `anthropicCacheTtlSplit` + `attributesJson.cacheTtl`. | WS-I |
| Outbox retention/pruning for `DISPATCHED` rows. | WS-K |
| Promoting `AiUsageOutboxDrain` into the shared `JobQueue` enum (WS-A's file). | follow-up |
