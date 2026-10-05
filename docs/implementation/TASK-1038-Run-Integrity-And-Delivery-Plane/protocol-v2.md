# Run protocol v2: the frozen contract

**Status:** Frozen for wave B (lane F2, 2026-10-04). Changing anything here means changing the code
and the fixture in the same commit.
**Source of truth, in this order:** `packages/async-contract/src/run-protocol.ts` (code),
`tests/contracts/run-protocol.fixture.json` (the cross-language fixture, which includes the Lua
bytes), and this page (the explanation). If they disagree, the code and the fixture win, and this
page has a bug.
**Implemented by:** B3a GATEWAY-STREAMS (delivery, resume, gateway-originated events), B1
HARNESS-CONTRACT (graph and debug events, Python fixture parity), TASK-1039 (SDK 5.0 clients).
**Design record:** TASK-1036 README §8.7 (delivery plane), §10.2 and §10.3 (Test tab, debug events),
decisions OD-23, OD-24, OD-25, OD-33.

This page fixes ten points raised in the adversarial review: non-contiguous `seq` for clients, one
sequencer, version selection by query, node scoping, per-node outputs on the admin trace, optional
token counts, PHI-free public error text, and three kept rules.

---

## 1. Envelope

Every event, on SSE and WS alike, is one JSON object:

```
{ seq, runId, type, ts, nodeId?, data }
```

| Key | Rule |
|---|---|
| `seq` | Integer. `≥ 1` on a stored event; `ping` and `run.resync` may carry `0`. See §5 and §6. |
| `runId` | 1–255 chars. Taken from the stream key, never from a stored field. |
| `type` | One of the 23 types in §3. Unknown types are refused (`parseRunEvent` → `null`). |
| `ts` | ISO-8601 date-time with `Z` or an offset: when the event happened, not when it was delivered. |
| `nodeId` | Present, optional or absent per type (§4). |
| `data` | A JSON object, closed per type (`RUN_EVENT_DATA_SCHEMAS`): unknown properties are refused. |

No other envelope keys are allowed.

**SSE frame** (`toSseFrame`): `event: <type>\nid: <seq>\ndata: <compact JSON of the WHOLE envelope,
keys in envelope order>\n\n`. **WS frame:** the same envelope as one JSON text frame.
`parseSseFrame` refuses a frame whose `event:` or `id:` line disagrees with the envelope.

## 2. Selecting the protocol

| Signal | Example | Why |
|---|---|---|
| Header `RUN_PROTOCOL_HEADER` | `x-hope-run-protocol: 2` | Server SDKs, `fetch` streaming. |
| Query `RUN_PROTOCOL_QUERY_PARAM` | `GET …/events?protocol=2`, `wss://…?protocol=2` | A browser `EventSource` and a browser `WebSocket` cannot set headers. |

`selectRunProtocol({ header, query })`: the header wins when it is non-empty, then the query. If
neither is present, the request gets `legacy` (the six old frame shapes, for one release, OD-23).
Any other value, such as `1`, `3` or `v2`, returns `problems`, and the route answers **400**. It
never falls back to legacy, because a v2 client cannot parse the legacy shapes.

## 3. Event catalogue

Visibility is first decided by type (`RUN_EVENT_VISIBILITY`). One instance-level exception (§5)
narrows it further. Synthetic types are never stored.

| Type | Visibility | `nodeId` | Data (required **bold**) | Notes |
|---|---|---|---|---|
| `run.started` | public | forbidden | **kind** (`workflow`\|`agent`), **slug**, **versionNumber**, mode | |
| `run.completed` | public | forbidden | **status** `COMPLETED`, **durationMs**, **tokens**, result, degraded | Terminal. `result` is exactly `{kind:'inline',value}` or `{kind:'ref',bucket,key,sizeBytes,sha256}`. Inline when the result is ≤ 64 KiB (`RUN_RESULT_INLINE_MAX_BYTES`). |
| `run.failed` | public | forbidden | **status** `FAILED`\|`TIMED_OUT`, **durationMs**, **error**, tokens | Terminal. Error rules in §8. |
| `run.cancelled` | public | forbidden | **status** `CANCELED`, **durationMs**, reason | Terminal. The type is spelled `cancelled` (OD-23); the status uses the persisted spelling `CANCELED`. |
| `run.resync` | public | forbidden | **reason**, **snapshot** | Synthetic. See §6. |
| `node.started` | public | required | **kind**, label, attempt | When `attempt > 1`, the client discards that node's earlier partial outputs. |
| `node.completed` | public | required | **status** `COMPLETED`\|`DEGRADED`\|`SKIPPED`, **durationMs**, tokens, warnings | |
| `node.failed` | public | required | **durationMs**, **error**, attempt, willRetry | Error rules in §8. |
| `output.text.delta` | public | required | **field**, **text** | Only from End-wired or `stream` nodes (OD-24). |
| `output.audio.delta` | public | required | **field**, **chunk** (base64), **format**, sampleRate | |
| `output.data` | public **or admin** | required | **field**, **value**, visibility (`'admin'` only) | See §5. |
| `ping` | public | forbidden | `{}` | Synthetic. Its `seq` is this connection's position (§6). |
| `input.validated` | admin | forbidden | **valid**, **problems**, schema | |
| `data.bound` | admin | required | **inputs[]** (`input`, `source`, value, empty, phiClass) | |
| `binding.warning` | admin | required | **input**, **code**, **message** | |
| `consultation.read` | admin | required | **consultationId**, **snapshot** (`node-start`\|`run-start`), **fields[]** | |
| `transcript.partial` | admin | **optional** | **text**, utteranceIndex, stableChars | `nodeId` is absent when the consultation session is the source (§4). |
| `transcript.final` | admin | **optional** | **text**, utteranceIndex, start, end, speaker, language | Same as `transcript.partial`. |
| `prompt.composed` | admin | required | **layers[]** (`name`, **chars**, tokens), **charsTotal**, tokensTotal, **selected**, **excluded**, **blocks[]**, composedPromptId | Sizes only, never content. Tokens are optional (§7). |
| `model.request` | admin | required | **provider**, **model**, **attempt**, **fallback**, **stream**, parameters | |
| `guardrail.inbound` / `guardrail.outbound` | admin | required | **action**, **detected**, categories, mode, latencyMs | |
| `output.validated` | admin | required | **valid**, **problems**, field | |

## 4. Node scoping

`RUN_EVENT_NODE_SCOPE` holds `required`, `optional` or `forbidden` for each type.

- **Graph node events** (`node.*`, every delta, every debug event except `input.validated` and the
  transcripts) **must** carry `nodeId`. It is the graph node id (`WORKFLOW_NODE_ID_PATTERN`).
- **Agent runs** (`POST /agents/:slug/runs`) have no graph. They have exactly one step, and its
  `nodeId` is always `AGENT_RUN_NODE_ID` = `'agent'`. Validate with
  `runEventProblems(e, { runKind: 'agent' })`, which refuses any other `nodeId`. Workflow graphs
  may use `agent` as an ordinary node id, so the rule applies to agent runs only.
- **Transcripts** (`transcript.partial|final`) are `optional`. When a graph ASR node produces them,
  it names itself. When the consultation session produces them (the gateway STT bridge feeding a
  consultation-bound run), they have no `nodeId`.

## 5. Visibility, the admin trace and per-node outputs

- The **public plane** is every business-plane caller and the SDKs. It receives
  `toPublicRunEvent(e)` for every stored event and nothing else. That function returns `null` for
  an admin-audience event, and for `run.failed` / `node.failed` it removes `error.detail`.
  `runEventProblems(e, { plane: 'public' })` checks that the result is clean.
- The **admin trace** is the console Test tab, and only the console. It receives every stored
  event unchanged. PHI is visible to admins, and viewing it is audited.
- **Outputs on the public plane (OD-24):** only nodes wired into End, or flagged `stream`, send
  outputs. Text goes out as `output.text.delta`, and other values as `output.data`.
- **Outputs on the admin trace (fix 5):** when each node completes, the producer emits
  `output.data { field, value, visibility: 'admin' }` for **every declared output of that node**
  that has not already gone out as a public `output.data`. A streamed text field therefore also
  arrives once more as its final value. The Test tab never has to rebuild a node's output from
  deltas, and the public plane never sees a non-public node's output.
- Visibility is therefore decided per **event**, not per type. Filter with
  `runEventAudience(e)`, never with `isPublicRunEvent(type)`. `public` is never written
  explicitly: an `output.data` without `visibility` is public, and `visibility: 'public'` is
  refused.
- `run.resync.snapshot.outputs` is keyed by `nodeId` first, then by `field`
  (`{ n_note: { text: '…' }, n_summary: { text: '…' } }`), so two nodes that declare the same field
  name never collide. On the public plane, the snapshot holds only public outputs.

## 6. Sequencing, resume and loss

### 6.1 One sequencer

Every stored event of a run, whichever process writes it, is appended by **one** Redis Lua script.
That covers the harness (graph and debug events) and the gateway (the events it originates:
session transcripts, and run-level events of runs the gateway owns). No producer `XADD`s or
`INCR`s these keys directly.

| Key | Export | Type | Holds |
|---|---|---|---|
| `wf:run:<runId>:seq` | `RUN_SEQ_KEY(runId)` | string (counter) | The last `seq` assigned. |
| `wf:run:<runId>:events` | `RUN_EVENTS_KEY(runId)` | stream | The stored events. This is the same literal as the existing `runEventStreamKey` / `run_event_stream_key`. |
| `wf:run:<runId>:dedupe` | `RUN_DEDUPE_KEY(runId)` | hash | `dedupeKey → "<seq> <streamId>"` |

**Stored entry**, with fields in `RUN_STREAM_FIELDS` order:
`seq <n>`, `type <t>`, `ts <iso>`, `nodeId <id>` (only when present), `vis public|admin`
(`runEventAudience`), `body <compact JSON of data>`.

`runId` is not stored, because the key carries it. `body` is not named `data` on purpose: a legacy
entry is `data <AsyncEnvelope JSON>` with no `seq`, so the two kinds of reader never mistake each
other's entries. A v2 reader treats an entry without `seq` as `legacy` and skips it
(`parseStoredRunEvent`). The legacy reader skips an entry without `data`. Producers write **only**
v2 entries from the release that ships this contract onwards. For legacy-selecting clients, the
gateway derives the legacy frames from v2 entries (B3a). Legacy entries can still be found in
streams of runs that started before the deploy.

**The script** (`RUN_APPEND_LUA`). The bytes below are copied from the fixture key
`sequencer.lua`, and the harness loads them from there:

```lua
-- HOPE run protocol v2: the ONE run-event sequencer (TASK-1038).
-- KEYS: [1] wf:run:<runId>:seq  [2] wf:run:<runId>:events  [3] wf:run:<runId>:dedupe
-- ARGV: [1] maxLen  [2] retention seconds ('0' = not terminal)  [3] dedupe key ('' = none)
--       [4..] field/value pairs after seq: type, ts, [nodeId], vis, body
local dedupe = ARGV[3]
if dedupe ~= '' then
  local prior = redis.call('HGET', KEYS[3], dedupe)
  if prior then
    local s, id = string.match(prior, '^(%d+) (.+)$')
    return {tonumber(s), id, 1}
  end
end
if redis.call('PTTL', KEYS[2]) >= 0 then
  return redis.error_reply('RUN_STREAM_CLOSED')
end
local seq = redis.call('INCR', KEYS[1])
local xadd = {'XADD', KEYS[2], 'MAXLEN', '~', ARGV[1], '*', 'seq', tostring(seq)}
for i = 4, #ARGV do xadd[#xadd + 1] = ARGV[i] end
local id = redis.call(unpack(xadd))
if dedupe ~= '' then redis.call('HSET', KEYS[3], dedupe, seq .. ' ' .. id) end
local ttl = tonumber(ARGV[2])
if ttl > 0 then
  for i = 1, 3 do redis.call('EXPIRE', KEYS[i], ttl) end
end
return {seq, id, 0}
```

**Calling it.** `buildRunAppend({ runId, type, ts, nodeId?, data, dedupeKey?, retentionSeconds?,
maxLen? })` validates the event (it throws `RunProtocolError`) and returns `{ keys, args }` for
`EVALSHA`/`EVAL`. Load the script once per connection: ioredis `defineCommand`, or redis-py
`register_script`. The reply is `[seq, streamId, duplicate(0|1)]`. Example from the fixture
(`stored[0]`):

```
keys: wf:run:R:seq  wf:run:R:events  wf:run:R:dedupe
args: "10000" "0" "wf:run:R:node:n_note:1:started"
      "type" "node.started" "ts" "2026-10-04T10:00:00.000Z" "nodeId" "n_note"
      "vis" "public" "body" "{\"kind\":\"core.agent\",\"label\":\"Write the note\",\"attempt\":1}"
entry: seq 3 type node.started ts … nodeId n_note vis public body {…}
```

| Rule | Detail |
|---|---|
| Atomic | `INCR` and `XADD` run in one script, so **stored seqs are contiguous** (1, 2, 3, …). Trimming only removes from the front. Nothing calls `XDEL`. |
| Bounded | `XADD … MAXLEN ~ RUN_STREAM_MAX_LEN` (10 000, the harness's existing bound). A cursor that falls behind the trim gets `run.resync { reason: 'gap' }`. |
| Synthetic types are never appended | `buildRunAppend` refuses `ping` and `run.resync`. |
| Dedupe | `dedupeKey` is derived from what the event means, never from a clock or a UUID. Examples: `wf:run:<runId>:node:<nodeId>:<attempt>:started`, `wf:run:<runId>:node:<nodeId>:<attempt>:output:<field>`, `wf:run:<runId>:completed`. If a retried activity appends again with the same key, the call returns the first position and writes nothing. Deltas carry **no** dedupe key, because a retried model call produces different text. The retry's `node.started` (attempt + 1) tells clients to discard the earlier partial text. |
| Retention | A **terminal** append (`TERMINAL_RUN_EVENT_TYPES`) **must** pass `retentionSeconds` = `workflowRuns.eventRetentionHours × 3600` (24 h, OD-25). `buildRunAppend` refuses it on any other event. The gateway resolves the value and passes it to the harness with the run start (gateway-resolved injection, rule 06). It is never a literal in a producer. The script puts the **same** expiry on all three keys, so they disappear together. A counter can then never outlive its stream (or the reverse) and hand out a `seq` a second time. |
| Closed | Once the events key has an expiry, the stream is closed, and any append is refused with `RUN_STREAM_CLOSED_ERROR` (`RUN_STREAM_CLOSED`). A dedupe hit still returns the earlier position. |
| Terminal backstop | When the run is terminal in the read model but no terminal event arrived (the existing R-2 path), the gateway runs `EXPIRE <key> <retention> NX` on **all three** keys. That closes the stream, so a terminal event that arrives late is refused. The read model then serves the terminal state. |
| Best-effort mirror | The stream mirrors Temporal; it is not the record. A failed append, `RUN_STREAM_CLOSED` included, is logged and swallowed. It never fails a clinical run. This is the same posture as the current `RunEventProducer`. |
| Not cluster-safe | The keys have no `{hash tag}`, and HOPE runs a single Redis. Moving to Redis Cluster requires a new protocol version, not a quiet change to the key names. |

### 6.2 Resume

The client cursor is the last `seq` it **saw**. The client sends it as `Last-Event-ID: <seq>`
(EventSource does this itself) or `?after=<seq>`. The header wins, and `0` means "from the
beginning" (`parseResumeCursor`). WS uses the same `?after=`.

On every (re)connect, the gateway does the following:

1. Reads `lastSeq = GET wf:run:<runId>:seq` and `oldestSeq` = the `seq` field of
   `XRANGE wf:run:<runId>:events - + COUNT 1`.
2. Calls `planRunResume({ after, oldestSeq, lastSeq })`:

   | Condition | Plan |
   |---|---|
   | No counter, `after = 0` | `replay` from the start. The run has not emitted yet, so read live. |
   | No counter, `after > 0` | `resync: expired` |
   | `after > lastSeq` | `resync: cursor_invalid` |
   | Counter but no retained entries | `replay` only if `after === lastSeq`, otherwise `resync: gap` |
   | `after + 1 < oldestSeq` | `resync: gap` (the next seq the client needs was trimmed) |
   | otherwise | `replay` after `after` |
3. For `replay`, the gateway turns `after` into an `XREAD` id. If `after < oldestSeq`, it uses
   `0-0`. Otherwise it uses the stream id of the entry whose `seq === after`, found by scanning
   back from the tail with `XREVRANGE … + - COUNT <page>`. Resumes are usually near the tail, and
   `MAXLEN` bounds the scan. From there it reads through the multiplexed hub (R-1), passes each
   entry through `parseStoredRunEvent` (skipping `legacy`, logging and skipping `invalid`), then
   through `toPublicRunEvent` on the public plane, and writes the frames that remain.
4. For `resync`, the gateway sends `run.resync { reason, snapshot }` with
   `seq = snapshot.lastSeq`, then continues live from `lastSeq + 1`. The snapshot comes from the
   read model and the harness state query, folded together with any retained events.
5. If the event transport is down, the gateway answers `run.resync { reason: 'unavailable' }` with
   a snapshot built from the read model.

### 6.3 What a client may and may not conclude (fix 1)

- **`seq` is monotonic but NOT contiguous for a client.** The public plane is filtered out of the
  same stored sequence, so a jump from 3 to 7 is normal. **Clients never infer loss from a gap.**
- `advanceRunCursor(cursor, event)` is the whole client rule:

  | Event | Result |
  |---|---|
  | stored, `seq > cursor` | Deliver it, and set the cursor to `seq`, however far that jumps. |
  | stored, `seq ≤ cursor` | Drop it as a replayed duplicate. |
  | `ping` | Do not deliver it. Set the cursor to `max(cursor, seq)`. |
  | `run.resync` | Deliver it with `reset`: replace the run state with the snapshot, and set the cursor to `seq`. |
- **Only the server signals loss**, using `run.resync.reason` (`RUN_RESYNC_REASONS`):
  `gap | expired | cursor_invalid | unavailable`. The server can detect each of these exactly
  because the stored stream is contiguous.
- `ping.seq` is **this connection's position**: the last stored `seq` the server has delivered
  *or filtered out* for this connection, and `0` before the first event. A ping therefore lets a
  public client move its cursor past admin events it was never meant to see.
- Fix 8, kept as before: `ping` and `run.resync` never advance the sequencer, and
  `run.resync.seq === data.snapshot.lastSeq`.

### 6.4 Retention

OD-25 is unchanged. The event stream expires `workflowRuns.eventRetentionHours` (24 h) after the
run becomes terminal; the terminal append or the gateway backstop starts that clock. Status and
result stay in the read model for `workflowRuns.resultRetentionDays`. A client that reconnects
after expiry gets `run.resync { reason: 'expired' }` with a terminal snapshot. If that snapshot has
no inline result, the client reads `GET …/runs/:runId/result`.

## 7. `prompt.composed` sizes (fix 6)

The harness has no tokenizer. Each layer therefore carries **`chars`** (required) and `tokens`
(optional). The event carries **`charsTotal`** (required) and `tokensTotal` (optional). `blocks[]`
still carries `chars`. A consumer shows tokens only when they are present, and never estimates
them from `chars`. The event carries sizes only: the composed text is read through the Prompt
Inspector by `composedPromptId`.

## 8. Errors (fix 7)

`run.failed.error` and `node.failed.error` have the shape
`{ code, message, nodeId?, detail? }`:

| Field | Rule |
|---|---|
| `code` | SCREAMING_SNAKE (`^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$`, at most 64 characters). Because it is a fixed identifier, it cannot carry a value. |
| `message` | **Must** equal `runErrorMessage(code)`: the fixed label from `RUN_ERROR_MESSAGES`, or `RUN_ERROR_FALLBACK_MESSAGE` for a code the catalogue does not list. Producers never interpolate into it. |
| `detail` | Free text, at most 4000 characters. Allowed on the stored event and on the admin trace **only**. `toPublicRunEvent` removes it, and `{ plane: 'public' }` validation refuses it. |

Catalogue (`RUN_ERROR_MESSAGES`, copied in the fixture as `errorMessages`): `RUN_TIMED_OUT`,
`NODE_TIMED_OUT`, `RUN_CANCELLED`, `INPUT_INVALID`, `OUTPUT_INVALID`, `BINDING_UNRESOLVED`,
`PROMPT_VARIABLE_UNRESOLVED`, `PAYLOAD_TOO_LARGE`, `MODEL_UNAVAILABLE`, `MODEL_ERROR`,
`PROVIDER_NOT_CONFIGURED`, `AGENT_VERSION_UNAVAILABLE`, `GUARDRAIL_BLOCKED`,
`CONSULTATION_READ_FAILED`, `DOWNSTREAM_UNAVAILABLE`, `INTERNAL_ERROR`. Adding a label is a
contract change (code, fixture and Python mirror together). A producer may use a code that is not
listed, and its message is then the fallback label.

## 9. Python mirror (B1)

- Read `tests/contracts/run-protocol.fixture.json`, the same file the TypeScript suite reads. For
  each fixture section, assert the same thing the TS suite asserts: the constants, `nodeScope`,
  `agentRunNodeId`, `errorMessages`, every `examples` entry valid under its `runKind`/`plane`,
  every `invalid` entry refused with its `problem`, and `sse` bytes.
- **Settled by the orchestrator, 2026-10-04:** the harness keeps the Lua as a byte-for-byte constant in code, because the service image does not ship `tests/contracts/`. A parity test asserts it equals the fixture's `sequencer.lua` exactly, so the two cannot drift silently. (This replaces the earlier "load it from the fixture" wording.) For each `stored`
  entry, build the same `keys` and the same `args`. The one exception is `body`: it must be
  compact JSON (`separators=(",", ":")`, `ensure_ascii=False`) whose parsed value equals the
  fixture's, but its byte order may differ. Consumers parse `body`; they never compare its bytes.
- Every `ARGV` value is a string. `ts` is ISO-8601 UTC. Appends happen only in activity code, never
  inside a `@workflow.defn` body.

## 10. Exports added to `packages/async-contract/src/index.ts`

`index.ts` belongs to the orchestrator; this lane did not edit it. These symbols are new or
changed in `run-protocol.ts` and need to be re-exported:

| Kind | Names |
|---|---|
| Values | `RUN_PROTOCOL_QUERY_PARAM`, `selectRunProtocol`, `RUN_RESYNC_REASONS`, `advanceRunCursor`, `AGENT_RUN_NODE_ID`, `RUN_ERROR_MESSAGES`, `RUN_ERROR_FALLBACK_MESSAGE`, `runErrorMessage`, `runEventAudience`, `toPublicRunEvent`, `RUN_STREAM_KEY_PREFIX`, `RUN_SEQ_KEY`, `RUN_EVENTS_KEY`, `RUN_DEDUPE_KEY`, `RUN_STREAM_MAX_LEN`, `RUN_STREAM_FIELDS`, `RUN_STREAM_CLOSED_ERROR`, `TERMINAL_RUN_EVENT_TYPES`, `RUN_APPEND_LUA`, `buildRunAppend`, `parseStoredRunEvent`, `planRunResume` |
| Types | `RunResyncReason`, `RunCursorStep`, `RunEventNodeScope`, `RunEventValidationOptions`, `RunAppendInput`, `RunAppendCommand`, `ParsedStoredRunEvent`, `RunResumePlan` |
| Changed signatures | `runEventProblems(value, options?)` and `parseRunEvent(value, options?)` take `{ runKind?, plane? }`. `RUN_EVENT_NODE_SCOPE` values now include `'optional'`. |

## 11. Known limits

- `run.cancelled.reason` is still free text on the public plane. It is normally the caller's own
  words, but if a producer ever fills it in, the reason should become a code, following the error
  rule.
- If a producer appends more than `eventRetentionHours` after the keys expired, the append starts
  a fresh sequence at 1, because nothing is left to tell it apart from a new run. Run ids are
  unique and every run is terminal long before this, so only a producer bug could cause it.
