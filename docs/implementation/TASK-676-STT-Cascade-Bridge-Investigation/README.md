# TASK-676 — STT → cascade bridge: blast-radius investigation

| Field | Value |
|---|---|
| **Status** | `Review` — investigation complete, no code written |
| **Type** | investigation / proposal |
| **Branch** | `dev-2.1` @ `62cb2d174` (investigated state; a concurrent session advanced `dev-2.1` to `866912d01` mid-investigation — the only changes were TASK-671/674 docs and `harness/eval/entity_code_population.py`, none of which this analysis touches) |
| **Scope** | Read-only. No production code changed. Deliverable is this document. |
| **Predecessor** | TASK-654 §6.4a **OP-1** — "Real STT transcripts never enter the cascade" |
| **Successor** | See §5 "Scope for the implementation ticket" |

---

## 1. Requirement Analysis

TASK-654 shipped a context cascade: an action's output re-enters as context and can trigger
further work. Worked example **E2** is *"audio stream → realtime STT → the transcript becomes
raw consultation context."*

The premise of this ticket is that E2 does not work with real audio, because
`sttInternal.service.ts` emits only `TranscriptionCreated` and never `ContextAdded`.

**That premise is correct.** It is also incomplete in two directions, both of which change what
a fix has to do:

- **Upstream** — the "double-write" caveat this ticket asked us to verify is **stale, and stale
  in the opposite direction from what was assumed**. The SDK's per-segment writer is not
  competing with the STT aggregate; it is **rejected at the API boundary with HTTP 400** and has
  never persisted anything (§3.5). The cascade therefore does *not* already fire for per-segment
  writes. But the two writers are one DTO field away from colliding, and the collision would
  silently break clinical note generation (§3.5.3).
- **Downstream** — emitting `ContextAdded` from the STT path is **necessary but not sufficient**
  for E2. Even once the event fires, the transcript carries no `kindKey` so nothing routes
  (§3.4.4), and it fires exactly once, at finalize, so the loop starts *at the end* of the
  consultation (§3.4.5). A ticket that only adds the emission will close OP-1 on paper and leave
  E2 exactly as unproven as it is today.

---

## 2. Current State Evaluation — the two STT write paths

Both paths live in
`packages/applications/src/services/stt/internal/sttInternal.service.ts`.

### 2.1 Batch path — `createTranscript` (has a `jobId`)

`sttInternal.service.ts:297-365`. Entered when `dto.jobId` is present (`:301`).

| Step | Line | What happens |
|---|---|---|
| Job lookup | `:306` | `jobRepository.findById(dto.jobId)` |
| Entity build | `:318-325` | `ContextItemFactory.CreateContextItem({ type: TRANSCRIPT, source: TRANSCRIPTION, content: dto.transcriptText })` |
| Encrypt | `:331` | `contextItemRepository.encryptContentIntoEntity(...)` via `encryptBestEffort` |
| **Persist** | `:333` | **`this.contextItemRepository.create(contextItem)` — direct repository write** |
| Segments | `:336` | `persistTranscriptSegments(savedContextItem, dto)` |
| Job link-back | `:339-340` | `job.setContextItem(...)` + `jobRepository.update` |
| Sys-event | `:342` | `broadcastSysEvent(ResourceCreated, …)` |
| **Pipeline event** | **`:353`** | **`TranscriptionCreated` only** |

### 2.2 Streaming-finalize path — `createStreamingTranscriptInner` (no `jobId`)

`sttInternal.service.ts:391-438`, reached via `createStreamingTranscript` (`:381`).

Same shape, plus two idempotency layers and minus the job wiring:

| Step | Line | What happens |
|---|---|---|
| Redis single-flight | `:388` | `withTranscriptIdempotency(...)` keyed on the caller's `Idempotency-Key` |
| **Existence guard** | **`:395-398`** | `findTranscripts(consultationId)`; if any row exists, **return early — no create, no event** |
| Entity build | `:400-406` | identical factory call (no `tenantId` from CLS — taken from `dto.tenantId`) |
| Encrypt | `:412` | as above |
| **Persist** | `:414` | **direct `contextItemRepository.create`** |
| Segments | `:417` | `persistTranscriptSegments` |
| Sys-event | `:419` | `broadcastSysEvent(ResourceCreated, …)` |
| **Pipeline event** | **`:428`** | **`TranscriptionCreated` only** |

### 2.3 Why `ContextAdded` was never emitted

`ContextAdded` has exactly **one** production emitter for new items:
`ContextService.addContext` at
`packages/applications/src/services/consultation/context/context.service.ts:417`, guarded by
`LIVE_CONTEXT_TYPES` at `:73-79` (which TASK-660 widened to include `TRANSCRIPT` at `:77`).

Neither STT path calls `ContextService` at all — both construct the entity with
`ContextItemFactory` and persist through `ContextItemRepository` directly (`:333`, `:414`).
`SttInternalService`'s constructor injects `ContextItemRepository` and has **no `ContextService`
dependency** (`sttInternal.service.ts:48-60`); `SttInternalServiceModule` does not import the
context module (`sttInternal.service.module.ts:13`).

So the TASK-660 widening at `context.service.ts:77` governs a code path the STT service never
enters. The gate is correct; it is simply not on this road.

A second consequence of bypassing `ContextService`: the STT write skips everything else
`addContext` does — the initial `ContextItemVersion` v1 audit row (`context.service.ts:388-394`),
`assertParentInScope` (`:306`), kind resolution (`:325`), and cascade-depth resolution (`:351`).
That matters for option (c) in §4.

---

## 3. Findings

### 3.1 Complete consumer list

**Emitters**

| Event | Emitter | Line |
|---|---|---|
| `TranscriptionCreated` | `SttInternalService.createTranscript` (batch) | `sttInternal.service.ts:353` |
| `TranscriptionCreated` | `SttInternalService.createStreamingTranscriptInner` | `sttInternal.service.ts:428` |
| `ContextAdded` | `ContextService.addContext` | `context.service.ts:417` |
| `ContextAdded` | `OcrEnrichmentProcessor` (re-emit for the *same* item) | `ocr-enrichment.processor.ts:177` |

**Consumers of `TranscriptionCreated` — exactly one**

| Consumer | Line | Behaviour |
|---|---|---|
| `ConsultationEventHandler.handleTranscriptionCreated` | `consultation-event.handler.ts:93` | Resolves pipeline config; on `harnessEnabled` starts `HarnessDocWorkflow` via `harnessGatewayService.start` (`:172-181`), else enqueues the legacy BullMQ summary job. |

**Consumers of `ContextAdded` — exactly three**

| Consumer | Line | Own filter | Would a TRANSCRIPT reach it? |
|---|---|---|---|
| `LiveDocumentationService.handleContextAdded` | `live-documentation.service.ts:901` | `LIVE_DOC_CONTEXT_TYPES` = `{WORKNOTE, CASE_NOTE, ATTACHMENT}` (`:75`), checked `:905` | **No** — filtered out |
| `OcrEnrichmentProcessor.handleContextAdded` | `ocr-enrichment.processor.ts:92` | `if (payload.contextType !== ATTACHMENT) return` (`:96`) | **No** — filtered out |
| `LoopContextSignalService.handleContextAdded` | `loop-context-signal.service.ts:51` | none; gated on `HARNESS_LOOP_ENABLED` (`:53`) | **Yes** — this is the intended new consumer |

All three are registered in the same module
(`live-documentation.service.module.ts:73`), so all three are in-process with the emitter.

### 3.2 What does **not** break

The three concerns raised in the brief are, on inspection, already defended:

- **`LiveDocumentationService` double-count — no.** TASK-660 installed the explicit kind filter
  *before* widening the gate (`live-documentation.service.ts:903-905`). Its transcript input
  arrives through a completely separate in-process path — `ingestSegment` (`:850`), fed from the
  Redis subscriber at `:1581` — which never touches `ContextAdded`. The comment at `:73` says so
  outright: *"drive the live session through `ingestSegment`, not this event"*.
- **OCR processor filter — holds.** `ocr-enrichment.processor.ts:96` rejects anything that is not
  `ATTACHMENT` before any I/O.
- **Loop signal firing twice for one transcript — no.** Two independent dedupes: gateway-side on
  `(consultationId, contextItemId, timestamp)` (`loop-context-signal.service.ts:55`), and
  harness-side on `(contextItemId, occurredAt)` (`models.py:1246-1248`, checked at
  `workflows.py:1949-1959`). One transcript produces one signal.
- **`SummaryMeta` / `sessionAgentId` continuity — unaffected.** Both stamping sites derive it from
  the live-documentation agent lineage on the harness/summary persist path
  (`harness-internal.service.ts:756`, `summary.service.ts:533`), not from any context event.

### 3.3 What **does** break — concrete

| # | Breakage | Evidence |
|---|---|---|
| B-1 | **A unit test fails immediately.** `sttInternal.service.test.ts:1095` asserts `expect(mockEventEmitter.emit).toHaveBeenCalledTimes(2)` (sys-event + pipeline event). A third emission makes it 3. | `packages/applications/src/services/stt/internal/__tests__/sttInternal.service.test.ts:1095` |
| B-2 | **The signal routes to nothing for every realistic tenant** (§3.4.4). | `workflows.py:2110-2115` |
| B-3 | **The loop starts at the *end* of the consultation** (§3.4.5). | `sttInternal.service.ts:395-398` |
| B-4 | **The transcript is the one payload that can actually hit the 200k cap**, and it is the one payload the cap was reasoned about as never touching (§3.6). | `internal.request.ts:90` vs `context.service.ts:104-107` |
| B-5 | **Finalize-input divergence.** Once the loop *is* running, its finalize child and the `TranscriptionCreated` path race for the same workflow id and supply **different inputs** (§3.4.6). | `workflows.py:2371` vs `internal.py:249-260` |

### 3.4 Why emitting the event is not enough

#### 3.4.1 The signal path, end to end

`ContextAdded` → `LoopContextSignalService` (`:51`, gate `:53`, dedupe `:55`) →
`harnessGatewayService.signalContextAdded` → HTTP `POST
/api/v1/internal/workflows/{consultationId}/signal/context-added`
(`apps/harness/src/harness/api/endpoints/internal.py:396-399`) → **signal-with-start** on the
deterministic loop workflow id (`internal.py:445-451`).

The receiver is built, not a stub: `ConsultationLoopWorkflow` (`workflows.py:1852`), handler at
`:1941-1961`.

#### 3.4.2 Routing is by `kindKey` alone

`_handle_context` (`workflows.py:2104-2115`):

```python
actions = config.actions_for_kind(signal.kind_key)
if not actions:
    # Not subscribed. Silence is correct here — an unsubscribed kind is
    # not an anomaly, it is the common case.
    return
```

`actions_for_kind` (`models.py:1193-1200`) matches `subscription.kind_key == kind_key` and
nothing else. `contextType` is carried on the wire but **never consulted for routing** — it only
feeds the fallback chain.

#### 3.4.3 Depth and budget caps exist and are sound

`max_depth: int = 3` (`models.py:1112`), enforced `workflows.py:2117-2124`;
`max_actions: int = 200` (`models.py:1113`) at `:2142`; `max_specialist_runs: int = 20`
(`models.py:1118`) at `:2529-2539`; `(agent, kind)` cycle detection at `:2516-2527`. Derived
output re-enters at `depth + 1` (`:2265`). None of this is a problem for STT — a transcript
arrives at depth 0.

#### 3.4.4 **STT transcripts carry no `kindKey`, so they route to nothing**

Both STT factory calls omit `kindKey` and `contextSchemaVersionId`
(`sttInternal.service.ts:318-325`, `:400-406`) — unlike `ContextService.addContext`, which
resolves and stamps them (`context.service.ts:325`, `:361-362`).

The gateway falls back `kind_key or sub_type or context_type` (`internal.py:180-181`), so the
signal would arrive with `kind_key = "TRANSCRIPT"` — the literal enum name. That matches only a
tenant who happens to have declared a context kind keyed exactly `TRANSCRIPT`. The shipped
primitive→action defaults do not produce one: `loop-config.service.ts:37-43` maps
`STREAM_AUDIO: []` and `TEXT: ['client.emit']`.

**Consequence:** add the emission alone and the observable result is a signal that starts a loop
workflow which immediately finds no subscription and returns silently. OP-1 would read as closed;
E2 would be exactly as broken.

#### 3.4.5 **The transcript is written once, at finalize — so the loop would start at the end**

`createStreamingTranscriptInner` returns early if any TRANSCRIPT row already exists
(`sttInternal.service.ts:395-398`). There is exactly **one** TRANSCRIPT `ContextItem` per
consultation, created when the stream finalizes.

E2 is described as *"audio stream → realtime STT → transcript becomes raw consultation context"* —
an incremental, during-the-visit flow. A single aggregate write at finalize cannot express that.
The loop would be started by its last input rather than its first, receive one signal, and then
receive `consultationEnding` — which `ConsultationController.stopRecording` already sends via
`signalConsultationEnding` (`loop-context-signal.service.ts:88`) at roughly the same moment.

This is the finding that most changes the shape of the fix, and it is independent of which of
options (a)/(b)/(c) is chosen — all three bridge the *same single finalize-time write*.

Worth noting for the follow-up: the per-utterance platform-produced stream **does** already exist
in-process — `LiveDocumentationService.ingestSegment` (`:850`), fed from Redis at `:1581` — but
its segments have no `ContextItem` row and therefore no `contextItemId`, so they cannot be
expressed as `ContextAdded` without a persistence decision.

#### 3.4.6 Finalize-input divergence (pre-existing, surfaced by this change)

Both the loop's finalize child (`workflows.py:2371`) and the gateway's
`TranscriptionCreated` path (`internal.py:75-77`) use the id `harness-doc-{consultationId}`, and
each treats a collision as success (`workflows.py:2400-2402`; `internal.py:283-285`). So there is
**no double workflow** — good.

But they build different inputs: the gateway supplies gate config, redaction rules and the loaded
transcript (`internal.py:249-260`); the loop supplies `LoopFinalizeRequest` fields and **no gate
config** (`workflows.py:2374-2388`). Whichever starts first wins. And when the gateway wins — the
normal case, since `TranscriptionCreated` fires long before `consultationEnding` — the loop's
finalize returns *without awaiting the child*, so the deliberate lifetime coupling documented at
`workflows.py:2360-2364` silently does not hold.

### 3.5 The double-write caveat — **it does not hold, for a reason nobody recorded**

#### 3.5.1 Writer A (SDK) exists and fires per final segment

`packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:770-798`, inside
`onTranscription` under `if (result.isFinal)` (`:730`):

```ts
apiClient
  .post<ContextItem>(CONTEXT_ENDPOINTS.ADD(consultation.id), {
    type: 'TRANSCRIPT',
    content: result.text,
    source: 'TRANSCRIPTION',
    structuredData: { segments: …, speakerId: result.speakerId },
  })
```

Gated only on `consultation && apiClient` being present (`:772`) plus non-whitespace text
(`:737`). No feature flag. It is provider-agnostic, so it fires for backend streaming STT too.
Route: `POST /consultations/:id/context` →
`consultation.controller.ts:708` → `ContextService.addContext` (`context.service.ts:293`).

#### 3.5.2 Writer A is rejected at the API boundary — HTTP 400

`structuredData` is **not declared on `AddContextRequest`**
(`packages/applications/src/services/consultation/context/dto/add-context.request.ts:12-103` —
the declared fields are `type`, `content`, `mediaId`, `dnaWritingStyleId`, `source`, `metadata`,
`kindKey`, `payload`, `derivedFromContextItemId`).

The global pipe runs `whitelist + forbidNonWhitelisted + forbidUnknownValues`
(`apps/api/src/main.ts:162-166`), and the route carries no local pipe override
(`consultation.controller.ts:692-715`).

**Verified empirically**, replaying the exact SDK body through a `ValidationPipe` configured
identically to `main.ts:162-166`:

```
REJECTED: {"message":["property structuredData should not exist"],
           "error":"Bad Request","statusCode":400}
```
> The same body with `structuredData` removed validates successfully. (Probe run out-of-tree
> against `AddContextRequest`; no repo file was added or modified.)

The SDK swallows the failure into `logger?.error` (`useArcaAudio.ts:790-797`), so it is silent.
Corroborating signal that the field was never wired server-side:
`ContextService.addTranscription` takes it as `_structuredData` — underscore-prefixed, i.e.
deliberately ignored (`context.service.ts:1423`).

**Verdict: the double-write caveat is stale. There is one effective writer — the STT aggregate.
The cascade does not already fire for per-segment writes.**

#### 3.5.3 …but it is a live landmine, and the failure mode is clinical

`findTranscripts` filters on **type only** —
`ContextItemRepository.ts:45-47` → `findByConsultation(consultationId, { type: TRANSCRIPT })`
(the repository exposes a `source` filter; this call does not use it).

So the moment writer A starts succeeding — someone adds `structuredData` to the DTO, or drops it
from the SDK — its first per-segment row makes `existing.length > 0` at
`sttInternal.service.ts:395-398`. The STT aggregate is then **silently skipped, and
`TranscriptionCreated` is never emitted** — which is the only trigger for
`ConsultationEventHandler` (§3.1), i.e. **the harness auto-draft / auto-summary never starts.**

Fixing the SDK/DTO mismatch on its own would break clinical note generation. This should be
recorded as a defect in its own right regardless of what TASK-676's successor does.

### 3.6 PHI and volume

**Encryption.** `ContextItem` has no plaintext content column — it was dropped
(`migrations/20260619100000_task_369_phase6_drop_plaintext_phi_columns/migration.sql:27`).
Storage is `encryptedContent Bytes?` + `contentKeyVersion Int?`
(`consultation.prisma:93-98`), Vault-Transit under `hope-phi`. Reads decrypt in the repository
layer (`packages/domains/src/common/phi-read-decrypt.ts:48`, `:106`) — but only when
`SECRETS_PROVIDER=vault` (`:86-94`), which is why dev/test reads return empty content. Both STT
paths encrypt explicitly (`sttInternal.service.ts:331`, `:412`).

**The signal ships decrypted plaintext PHI over plain HTTP** to `HARNESS_URL`
(`harness-gateway.service.ts:288-296`). That is the existing, accepted design for `ContextAdded`
(TASK-670 §3.1); STT transcripts would make it materially larger, not newly unsafe.

**The cap.** `LOOP_SIGNAL_CONTENT_MAX_LENGTH = CONTEXT_CONTENT_MAX_LENGTH = 200_000`
(`context.service.ts:109` → `add-context.request.ts:10`). Applied as a silent `slice` at
`context.service.ts:431` and `ocr-enrichment.processor.ts:188` — **no `truncated` flag, no
marker**, unlike the attachment path which uses a visible
`ATTACHMENT_TRUNCATION_MARKER` (`harness-internal.service.ts:101-102`, applied `:1493-1494`).
No test asserts the cap.

**Does the cap hold for transcripts?** Two problems.

1. **The reasoning behind the cap explicitly excludes this case.** `context.service.ts:104-107`
   argues the cap *"never actually truncates a normal add-context write"* because
   `AddContextRequest.content` is already bounded at the same number. That argument does not
   transfer: the STT DTO field `transcriptText` carries **no `@MaxLength` at all**
   (`internal.request.ts:90`) and never passes through `AddContextRequest`. An STT-sourced
   `ContextAdded` would be the first emission where the cap is a real ceiling rather than a
   restatement of an upstream one.
2. **No measured size distribution exists in the repo.** I looked: the only transcript fixture is
   a contract-shape file (`tests/contracts/stt-transcript-segments/transcript-segments.fixture.json`),
   not a volume sample. The nearest *stated* working assumptions are an order of magnitude lower —
   `liveDelta.maxChars` default **12,000** (`agentic-context.descriptors.ts:29`) and
   `ATTACHMENT_TEXT_MAX_LENGTH` **20,000**. On a back-of-envelope basis (~150 wpm, ~6 chars/word)
   200,000 chars is roughly 3–4 hours of continuous speech, so a typical consultation sits well
   inside it — but that is an estimate, not evidence, and the tail (long procedures, a session
   left recording) is exactly where a *silent* truncation of clinical text is least acceptable.

**Conclusion:** the cap almost certainly holds by magnitude, but it becomes load-bearing for the
first time and it truncates silently. A follow-up should either bound `transcriptText` at the STT
DTO or make the cut visible — preferably the latter, since dropping clinical text at the STT
boundary is worse than shipping it.

---

## 4. Options and tradeoffs

Common to all three: `LiveDocumentationService` and `OcrEnrichmentProcessor` are unaffected
(§3.2), and none of them alone makes E2 work (§3.4.4, §3.4.5).

| | (a) Emit `ContextAdded` from STT, gated by `HARNESS_LOOP_ENABLED` | (b) `LoopContextSignalService` also subscribes to `TranscriptionCreated` | (c) Route STT writes through `ContextService.addContext` |
|---|---|---|---|
| **Files touched** | `sttInternal.service.ts` (2 sites) + tests | `loop-context-signal.service.ts` (1 handler) + tests | `sttInternal.service.ts`, `sttInternal.service.module.ts`, `add-context.request.ts`, + tests |
| **Blast radius** | New emissions on the **shared** bus. Safe today only because both other consumers filter; any future `ContextAdded` consumer inherits transcripts silently. | **Zero** new bus traffic. Provably cannot affect LiveDoc/OCR — no new emission exists to reach them. | Largest. Changes the clinical write path itself. |
| **Gating** | Requires reading `HARNESS_LOOP_ENABLED` in `SttInternalService`, which has no `ConfigService` today (`sttInternal.service.ts:48-60`). **Layering smell**: makes bus *content* depend on a *consumer's* flag. | Natural — the flag already lives in this service (`:44-49`) and already guards all three of its callers. | None needed; inherits the existing ungated gate. |
| **Failure modes** | Emission inside the STT write path; a slow/throwing handler shares that call stack. Inconsistent with `ContextService`, which emits ungated. | Needs the transcript body, which `TranscriptionCreatedPayload` does not carry (`consultation.events.ts:94`) — so a repository read + Vault decrypt, breaking this service's current zero-repository design (`:39-42`). Precedent exists: `loop-context-text.service.ts`. | **Regressions.** Loses the two-layer Redis idempotency (`:388`, `:395`), the job link-back (`:339`), `persistTranscriptSegments` (`:336`, `:417`); *adds* a `ContextItemVersion` v1 WORM row per transcript (`context.service.ts:388-394`) and an `assertParentInScope` read (`:306`). `createdBy` becomes null (no CLS user on the internal path). **And it newly subjects `transcriptText` to `@MaxLength(200_000)` → a long transcript starts returning 400 and the transcript is lost.** |
| **Architecture** | Fine. | Two event types now both mean "context arrived" — a future consumer must know to subscribe to both. | **Reverses an existing dependency direction**: `consultation/*` already imports `stt/realtime` + `stt/streaming` (`live-documentation.service.module.ts:7-8`, `consultation-job.service.module.ts:8`, `harness-progress.service.module.ts:3`). Adding `stt/internal → consultation/context` closes the loop at package level. |
| **Test burden** | Fix `sttInternal.service.test.ts:1095`; new emission tests ×2 paths; regression tests proving LiveDoc/OCR still ignore transcripts. | New handler tests + a decrypt-path test. `sttInternal.service.ts` untouched → **its entire existing suite stays valid**. | Largest: re-prove idempotency, segments, job link-back, encryption, versioning, plus the cap regression. |
| **Clinical invariants** (SMR→NER, NER over raw transcript never the note, grounding drop-if-absent) | Preserved — all three live in `live-documentation.service.ts` (`:1086-1089`, `:1151-1166`, `:2134-2145`) and are untouched by any option. | Preserved. | Preserved *in the live lane*, but the write-path regressions above are their own clinical risk. |

---

## 5. Recommendation

**Adopt (b) as the mechanism — and scope the ticket to the two things that actually make E2
work, not just the emission.**

### 5.1 Why (b) for the bridge

- It is the only option that **cannot** regress the clinical path, and that is provable by
  construction rather than by test: it adds no emission to the shared bus and does not touch
  `sttInternal.service.ts`, so the entire existing STT suite remains valid evidence.
- The gate is already where it belongs. `HARNESS_LOOP_ENABLED` is a *loop* concern, and
  `LoopContextSignalService` is the loop adapter; option (a) would push a loop flag into the STT
  write path and make bus content depend on a consumer's configuration.
- It is the same shape the codebase already uses for this exact job — a thin adapter translating
  an internal event into a harness HTTP signal.

(c) is the *conceptually* cleanest — inheriting the gate naturally is genuinely attractive — but
its regression list is disqualifying, and the `@MaxLength` interaction (a long transcript
starting to 400) is a clinical-safety regression, not a refactor cost.

### 5.2 The honest counter-argument

**(b) makes the bus stop being the single source of truth for "context arrived."** Two event
types would mean the same thing, and every future cascade consumer has to know to subscribe to
both or silently miss platform-produced transcripts. That is precisely the duplication pattern
that has already cost this codebase dearly at the LiveDoc↔harness seam (four snapshot resolvers,
four NER callers). If a second `ContextAdded` consumer ever appears, (b) will have to be undone
and (a) or (c) done properly.

**(b) is therefore the right call if and only if the STT bypass is treated as a wart to be repaid,
not as the new architecture.** If the owner's intent is that `ContextService` becomes the single
write path for all context — which is the architecturally correct end state — then (c) is right
and this ticket should be scoped as the multi-week refactor it actually is, not as a bridge.

**Two further conditions would flip the recommendation:**
- If per-utterance cascade input is required for E2 (likely — see §3.4.5), the finalize-time
  bridge is the wrong object entirely and *none* of (a)/(b)/(c) is the answer; the ticket becomes
  "what is the per-segment context source, and does it persist?"
- If the SDK writer is about to be fixed (§3.5.3), writer A comes alive and the whole analysis
  re-bases: transcripts would then flow through `ContextService` naturally, `ContextAdded` would
  fire per segment for free, and the work becomes suppressing the *aggregate* rather than bridging
  it.

### 5.3 Scope for the implementation ticket

Ordered by dependency. Items 1–2 are prerequisites for E2 actually working; item 3 is the bridge.

| # | Work | Files |
|---|---|---|
| **0** | **Split out the SDK 400 as its own defect** (§3.5). It is independent, live, and its fix order matters: the `findTranscripts` type-only check (`ContextItemRepository.ts:45-47` used at `sttInternal.service.ts:395`) **must** be narrowed by `source` *before* `structuredData` is accepted, or note generation breaks. | `add-context.request.ts`, `useArcaAudio.ts:784`, `ContextItemRepository.ts:45-47`, `sttInternal.service.ts:395` |
| **1** | **Decide and stamp a resolvable kind on platform-produced transcripts.** Without this the signal routes to nothing (§3.4.4). Either stamp `kindKey` at the STT write, or give the loop a primitive-level fallback for `STREAM_AUDIO`/`TEXT`. This is a product decision (what does a tenant subscribe to?), not a code detail. | `sttInternal.service.ts:318-325,400-406`; `loop-config.service.ts:37-43`; `models.py:1193-1200` |
| **2** | **Decide the cascade's transcript cadence** (§3.4.5): finalize-aggregate only (accepting that the loop starts at the end), or per-utterance from `ingestSegment` (`live-documentation.service.ts:850`), which requires deciding whether per-segment context is persisted. **Answer this before writing the bridge** — it determines whether the bridge is worth building. | design |
| **3** | **The bridge itself** — `@OnEvent(TranscriptionCreated)` in `LoopContextSignalService`, reusing the existing `HARNESS_LOOP_ENABLED` gate and dedupe, resolving the body via the repository + decrypt (mirroring `loop-context-text.service.ts:39-55`) and mapping to `HarnessContextAddedSignal`. | `loop-context-signal.service.ts` |
| **4** | **Make the 200k truncation visible** (§3.6) — a marker or a `truncated` flag on `ContextAddedPayload`/`HarnessContextAddedSignal`, following `ATTACHMENT_TRUNCATION_MARKER` (`harness-internal.service.ts:101-102`). Do **not** add `@MaxLength` to `transcriptText`: dropping a transcript at the STT boundary is worse than truncating it downstream. | `context.service.ts:109,431`, `harness-gateway.service.ts:73-110` |
| **5** | **Tests.** New: `LoopContextSignalService` handler (gate off ⇒ no-op; dedupe; decrypt-miss degradation). Regression: transcripts still ignored by `LiveDocumentationService` and `OcrEnrichmentProcessor`; `TranscriptionCreated` still starts exactly one `HarnessDocWorkflow`. First cap assertion. Note `sttInternal.service.test.ts:1095` needs **no** change under option (b) — that is part of the argument for it. | `loop/__tests__/`, `live-documentation/__tests__/`, `ocr/__tests__/` |

**Explicitly out of scope:** the finalize-input divergence at `workflows.py:2374-2388` vs
`internal.py:249-260` (§3.4.6). It is pre-existing, orthogonal, and deserves its own ticket.

---

## 6. Implementation Summary

No implementation. This ticket is investigation-only; no production file was created, modified or
deleted. The single deliverable is this document.

Verification performed: read-only inspection of the paths cited above, plus one out-of-tree
validation probe (§3.5.2) run against `AddContextRequest` with a `ValidationPipe` configured
identically to `apps/api/src/main.ts:162-166`. The probe lived in the session scratchpad and added
nothing to the repository.

---

## 7. Change History

- **2026-08-12** — Investigation completed on `dev-2.1` @ `62cb2d174`. Confirmed TASK-654 OP-1.
  Established that the double-write caveat is **stale** — the SDK writer is rejected 400 at the
  API boundary (`structuredData` undeclared) and has never persisted, so the cascade does not
  already fire per segment; recorded the latent collision in which fixing that DTO would silently
  disable `TranscriptionCreated` and with it clinical note generation. Established that emitting
  `ContextAdded` is necessary but not sufficient: STT transcripts carry no `kindKey` so they route
  to no subscription, and the single finalize-time write would start the loop at the end of the
  consultation. Recommended option (b) with its counter-argument, and scoped a six-item follow-up.
  Status `Review`.
