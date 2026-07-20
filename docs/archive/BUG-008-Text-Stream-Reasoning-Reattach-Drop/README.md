# BUG-008 — `/text/tasks/:taskId/stream` cannot re-attach during the reasoning phase (reasoning tokens never persisted)

| Field | Value |
|---|---|
| **Type** | bugfix |
| **Status** | Pending |
| **Severity** | Medium/High — reasoning models appear "dead" on reconnect; UX shows nothing until final output |
| **Area** | `apps/smr` (SMR v2 streaming + provider adapters), `apps/api` (SMR proxy controller), client stream consumer |
| **Reported** | 2026-07-13 |
| **Related** | STT "finalizing treated as terminal" bug (different service — ruled out here) |

---

## Requirement Analysis

### Symptom

The text (SMR/LLM) streaming endpoint `/text/tasks/:taskId/stream` — gateway-proxied to the SMR Python service — **drops / cannot re-attach while the model is reasoning** (thinking tokens). Once the model transitions to final output, re-attach succeeds and messages render.

### Expected behavior

- A client reconnecting **during** the reasoning phase sees liveness (reasoning content or an explicit reasoning/status event) and resumes without the stream looking dead.
- Provider integrations (Ollama, LM Studio, Azure, Bedrock) are reviewed so reasoning deltas are captured correctly.

---

## Current State Evaluation

### The stream path (end to end)

- **Gateway (NestJS):** `apps/api/src/modules/streaming/smr-proxy.controller.ts:505-583` — `@Get('tasks/:taskId/stream')` opens an axios streaming GET to SMR and blind-forwards bytes.
- **SMR endpoint (FastAPI / sse_starlette):** `apps/smr/src/smr_v2/api/endpoints/stream.py:17-58` — `EventSourceResponse` over a generator reading Redis Streams via XREAD BLOCK, tagging each event with the Redis message id.
- **Redis write path:** `apps/smr/src/smr_v2/services/task_manager.py` — `append_chunk` XADD (`:97-103`), `read_chunks_blocking` XREAD (`:117-143`); background writer `generate.py:_run_streaming_generation:527-535` XADDs **only what the provider's `generate_stream` yields**.

### Root cause (PRIMARY) — reasoning tokens are never written to Redis

`StreamChunk.type` has **no reasoning variant** (`models/stream.py:10-13`): `Literal["chunk","meta","done","error","usage"]`. Every provider maps **only the final-content field** to a chunk and drops the separate reasoning field:

| Provider | file:line | Persists | Reasoning field dropped |
|---|---|---|---|
| Ollama | `services/providers/ollama.py:127-129` | `data["response"]` (if non-empty) | native `thinking` field |
| LM Studio / OpenAI-compat | `openai_compat.py:148-151` | `delta.content` | `delta.reasoning_content` / `delta.reasoning` |
| Azure OpenAI | `azure_openai.py:157-160` | `delta.content` | `delta.reasoning_content` |
| Bedrock | `bedrock.py:161-164` | `contentBlockDelta.delta.text` | `delta.reasoningContent` |

During reasoning these content fields are empty → `generate_stream` yields nothing → `_run_streaming_generation` XADDs zero chunks → the Redis stream `smr:stream:{task_id}` **has no entries (often doesn't exist yet)**. Task status stays `RUNNING` (`models/task.py:11-18` has no "reasoning" state).

On re-attach **during reasoning**: `read_chunks_blocking` from `"0-0"` returns `[]` on a 5 s loop (`stream.py:39,49`); status is non-terminal so the generator never returns and never yields a real event — only sse_starlette pings. There is nothing to replay and no content-bearing liveness. Once final output begins, chunks are XADD'd and the same `0-0` replay delivers them → re-attach "works."

Corroboration inside the repo: `apps/harness/src/harness/eval/config.py:81-83` documents these local models (qwen/gemma/medgemma) stranding output in `reasoning_content` separate from `content`, and `apps/harness/.../eval/jsonio.py` has dedicated `<think>`/`reasoning_content` handling — logic the SMR streaming adapters lack.

### Contributing cause — no real resume cursor through the gateway

`streamTaskEvents(@Param taskId, @Res res)` (`smr-proxy.controller.ts:509`) takes **no `@Req`/`@Headers`**. It never reads the incoming SSE `Last-Event-ID` header and never appends `?last_event_id=` to the upstream URL (`:521`). SMR only accepts `last_event_id` as a **query param** (`stream.py:21`), not the standard header — so cursor is always `"0-0"` and every attach is a **full replay from the start**. This masks the primary bug during final output but leaves reasoning re-attach with an empty stream and no true resume point.

### Ruled out

- **"Phase treated as terminal"** (the STT `finalizing` bug): not applicable. The only terminal gate is `stream.py:50-56` (COMPLETED/FAILED/CANCELLED); the gateway blind-forwards bytes and never parses `type`/`phase` to close.
- **App-layer keep-alive/idle timeout as primary:** both hops emit traffic every ~15 s (SMR default sse_starlette ping `stream.py:58`; gateway 15 s `:keepalive` + `timeout: 300_000` `smr-proxy.controller.ts:524,529-533`). An app-layer idle timeout should not fire mid-reasoning. A residual hard-drop vector remains external (front proxy/ingress idle timeout, or a client SSE consumer that counts only named events — not `:comment` keep-alives — as liveness); to be confirmed against the actual client.

---

## Implementation Plan

> Primary: persist reasoning deltas as replayable stream chunks so there is content + liveness during thinking. Secondary: forward a real resume cursor end-to-end. Both are needed for correct re-attach.

### Step 1 — Model a reasoning chunk type (SMR)

- Extend `StreamChunk.type` (`apps/smr/src/smr_v2/models/stream.py:10-13`) with a `reasoning` (or `thinking`) variant; keep `chunk` for final content. Decide payload shape (reuse the text field vs. a dedicated `reasoning` field).
- Optionally add a task status/phase (`models/task.py`) so re-attach can distinguish reasoning from idle.
- **Test (RED):** serializing/deserializing a reasoning chunk round-trips; consumers can tell reasoning from content.

### Step 2 — Emit reasoning deltas from every provider adapter

Map the provider's reasoning field to the new chunk in each `generate_stream`:

| Provider | Field to capture |
|---|---|
| `ollama.py` | native `thinking` (verify the `/api/generate` request enables it, e.g. `think: true`; some models emit `<think>…</think>` inline in `response` instead — handle both) |
| `openai_compat.py` (LM Studio/vLLM) | `delta.reasoning_content` / `delta.reasoning` |
| `azure_openai.py` | `delta.reasoning_content` |
| `bedrock.py` | `contentBlockDelta.delta.reasoningContent` |

- `generate.py:_run_streaming_generation:527-535` then XADDs reasoning chunks like any other → they land in Redis and become replayable.
- **Review provider integration correctness while here:** confirm request params actually request reasoning (Ollama `think`, OpenAI-compat reasoning exposure), and that inline `<think>` tags are parsed, not leaked into content.
- **Test (RED):** with a stubbed provider stream that emits reasoning-then-content, Redis contains reasoning chunks before content; a from-`0-0` replay returns them.

### Step 3 — Forward a real resume cursor through the gateway

- `smr-proxy.controller.ts` `streamTaskEvents`: read the inbound `Last-Event-ID` header (add `@Headers()`/`@Req()`), and forward it to SMR. Align SMR (`stream.py:21`) to accept the standard `Last-Event-ID` **header** in addition to (or instead of) the query param, so real resume works, not just full replay.
- **Test (RED):** reconnect with `Last-Event-ID` resumes after that id, not from `0-0`.

### Step 4 — Client rendering (coordinate)

- Ensure the client stream consumer renders/holds reasoning chunks (or at least treats them as liveness) and counts comment keep-alives as alive. If the drop is partly an external idle-timeout, reasoning events also serve as real traffic that keeps intermediaries open.
- Confirm any ingress/proxy idle timeout ≥ keep-alive interval.

### Files expected to change

| File | Change |
|---|---|
| `apps/smr/src/smr_v2/models/stream.py` | add reasoning chunk type |
| `apps/smr/src/smr_v2/models/task.py` (optional) | reasoning phase/status |
| `apps/smr/src/smr_v2/services/providers/{ollama,openai_compat,azure_openai,bedrock}.py` | emit reasoning deltas; verify reasoning request params + `<think>` parsing |
| `apps/smr/src/smr_v2/api/endpoints/stream.py` | accept `Last-Event-ID` header |
| `apps/api/src/modules/streaming/smr-proxy.controller.ts` | read + forward `Last-Event-ID` |
| client SSE consumer | render reasoning / keep-alive handling |

### Verification criteria

- Reconnect **during** reasoning shows reasoning content/liveness and resumes without a dead stream.
- Redis stream contains reasoning chunks during the thinking phase (inspect `smr:stream:{task_id}` via `XRANGE`).
- `Last-Event-ID` resume returns only post-cursor events.
- `pnpm py:smr-v2:test`, `py:smr-v2:lint`, `py:smr-v2:typecheck` green; api unit tests green.
- Manual: a reasoning-heavy local model (LM Studio / Ollama qwen) reproduces the original drop before the fix and re-attaches cleanly after.

---

## Implementation Summary

_Pending — no code written yet._

---

## Change History

| Date | Author | Change |
|---|---|---|
| 2026-07-13 | Tap Huynh | Ticket created. Root cause traced: reasoning tokens are never XADD'd to Redis (all 4 provider adapters map only the final-content field; `StreamChunk` has no reasoning type), so a re-attach mid-reasoning finds an empty stream and no liveness; compounded by the gateway never forwarding a resume cursor (`Last-Event-ID`), making every attach a full `0-0` replay. STT "finalizing terminal" and app-layer idle-timeout ruled out as primary. Solution plan drafted (persist reasoning chunks + real cursor resume, no coding yet). |
