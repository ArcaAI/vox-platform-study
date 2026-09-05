# TASK-871 — Post-receive guardrail gate for text generation

| | |
|---|---|
| **Status** | In Progress |
| **Type** | feature (safety) |
| **Program** | TASK-870 wave 1, lane A |
| **Branch** | `task-871-text-guardrail-output-gate` (base `f3c91ca0c` off `dev-2.2`) |
| **Owns** | `apps/text/**`, this directory |
| **Owner decision** | TASK-870 §Requirement Analysis items 5 and 7 |

## Requirement Analysis

Owner decision (TASK-870, 2026-09-05, items 5 and 7): guardrail is built-in and platform-only,
and it gates **every text-generation request before send AND every response after receive**,
for built-in providers (LM Studio, vLLM, Ollama, any internal inference) and BYO providers
(Azure OpenAI, OpenAI, Anthropic, …) alike. The stated safety focus is prompt jailbreak and
injection. A jailbroken RESPONSE is exactly what a post-receive check exists to catch, and it
is the single highest-priority item in the program.

Non-negotiables for this lane, restated from the brief:

1. Every completion that reaches a persisted or returned state has been gated.
2. Rejection is visible — never a silent no-op.
3. The judge-scope cycle tripwire (`services/judge_guard.py`) holds for the output gate.
4. Fail posture matches the input gate: a content rejection is a 422-equivalent, a sustained
   guardrail outage is retryable (503-equivalent), a malformed verdict fails closed.
5. The dev/CI bypass (client absent, or posture disabled) is unchanged.
6. `provider_overrides` (the BYO path) is gated identically to built-in providers.

## Current State Evaluation

Verified at the base commit (`f3c91ca0c`), file:line references are to that tree.

**Input side.** `_apply_guardrail_gate` (`apps/text/src/text/api/endpoints/generate.py:149-206`)
is, per its own docstring, "exactly ONE moderation gate in this service". It is invoked once,
at `:435`, on the REQUEST body, before the provider is resolved. It calls
`ExternalGuardrailClient.validate` (`services/external_guardrail.py:59`), which POSTs
`{system_prompt}\n\n{prompt}` to guardrail's `POST /api/medical/validate` with a bounded retry
and a deterministic fail-closed verdict (`GUARDRAIL_UNAVAILABLE_REASON`) on exhaustion.

**Output side.** There is no output-side call anywhere in `apps/text`. Both `stream.py` routes
(`:377 GET /generations/{id}/stream`, `:404 GET /tasks/{id}/stream`) are replay/tail
subscribers over a generation only `POST /generate` can start. `translate` and `embeddings`
are not LLM completions and carry no guardrail gate on either side (out of scope here, noted
for the program). `POST /generate/internal/judge` (`endpoints/judge.py`) is guardrail's own
delegated judgement lane and must never be gated (the cycle tripwire).

**How tokens actually flow (streaming).** `POST /generate` with `stream: true` (`generate.py:520-578`)
starts a detached producer through `GenerationHub.start` (`routing/hub.py:355`) and returns an
`EventSourceResponse` over `stream_generation` (`endpoints/stream.py:243`), which attaches to
the producer as a subscriber. The producer (`routing/streaming.py:80`, `run_generation_producer`)
iterates `provider.generate_stream(request)`; every delta is `publish`-ed to attached
subscriber queues FIRST (`hub.py:235`, synchronous `put_nowait`) and then offered to a
`BatchFlusher` that `XADD`s coalesced batches into Redis `text:stream:{id}`
(`services/task_manager.py:227`). The provider's `done` frame is held back and re-emitted by
`emit_terminal` (`streaming.py:124`) with the usage block, written durably with `append_chunk`,
after which the task record flips to `COMPLETED` (`streaming.py:317-318`). Consumers:

- the gateway `TextProxyController` relays the raw SSE bytes to the browser
  (`apps/api/src/modules/streaming/text-proxy.controller.ts:838`);
- `packages/applications` `text-stream-consumer.service.ts:159` reads the Redis stream directly
  and completes on a `done` OR `error` typed frame;
- `@arcaai/vox-node` `summarization.ts:63-84` rejects `result()` on an `error` frame;
- `@arcaai/vox` compat `useText.ts:276` throws on an `error` frame.

So a delivered token cannot be recalled, every consumer already discards a generation whose
terminal frame is `error`, and the durable record of a generation is the Redis stream plus the
task-state record — both of which the producer alone writes.

**Non-streaming path.** `generate.py:618-816` awaits `provider.generate`, then marks the task
`COMPLETED`, logs the audit event, builds the `GenerateResponse`, and writes it to the
idempotency cache. Everything in that block is inside a `try` whose generic `except Exception`
arm records a circuit-breaker failure and answers 502 — so a rejection raised inside it needs
its own arm, exactly as `ProviderCredentialsError` and `ConcurrencyLimitError` already have.

**Cycle tripwire.** `assert_not_in_judge_scope` (`services/judge_guard.py:72`) is a ContextVar
check. The judge route (`endpoints/judge.py`) calls `provider.generate` directly inside
`judge_scope()` and never enters the producer or the public `/generate` body, so the output
gate is structurally unreachable from it; the tripwire is still asserted inside the new gate so
a future re-route raises rather than closes `text → guardrail → text`.

**BYO path.** `provider_overrides` is consumed only by the adapters (`core/connection.py:45`)
and by the funding derivation (`routing/usage.py:83`). Nothing branches the gate on it, on
`provider`, or on funding; the output gate inherits the same property because it sits after
the adapter returns, on the assembled completion, regardless of which adapter produced it.

**Does guardrail expose a response-side endpoint?** Yes. `POST /api/v1/guardrail/screen/outbound`
(`apps/guardrail/src/guardrail/api/endpoints/screen.py:126`, router mounted at `/api/v1`,
`main.py:395`) takes `{response, source_context?, nonce?}` with a mandatory `X-Tenant-Id`
(428 without it), runs under guardrail's admission gate (503 + `Retry-After` when saturated),
and answers `ScreenResponse {decision: "allow"|"block", direction, reasons[], checks[],
tenant_id, policy_source_tenant_id, sanitization}`. It is fail-closed by construction: a check
that could not run is `undetermined` and the decision is `block`; a transport failure is 503.
`Screener.screen_outbound` (`services/screening.py:282`) runs `response_safety`,
`response_toxicity`, `response_refusal`, a PII-leak check against `source_context` (reported
`skipped`, never `pass`, when no source is given) and a containment-echo check against `nonce`.
`POST /guardrail/realtime/output` is NOT this — it is the deterministic NER/grammar
provenance check and explicitly excludes generative output. `/api/medical/validate` answers
"is this medical text", which is not a response-safety question.

Two gaps in that endpoint, reported for the guardrail lane (not editable from this lane):

- `OUTBOUND_TASKS` does not include `jailbreak_detection` (`screening.py:66`) — it is inbound
  only. A response that ECHOES injected instructions is caught only insofar as
  `response_safety`/`response_toxicity` flag it. If the owner wants injection-echo detection
  on the output direction, guardrail must add it to `OUTBOUND_TASKS` (or a dedicated check).
- `ScreenResponse` carries no `stats` / `usage_detail`, so the outbound screen's own judge
  spend does not ride back to the billing plane the way `/api/medical/validate`'s does
  (`guardrail_usage_from_verdict`, `models/usage.py:366`). The text side is already shaped to
  pick it up (`raw.usage_detail`) the moment guardrail adds it.

**Worktree guard (step 0).** `apps/text` declared `pythonpath` for `src`, `py-env` and
`py-runtime-models` only, while the service imports `hope_otel` and `hope_async_contract` as
well. Adding the `assert_source_tree` call to `tests/conftest.py` failed RED on exactly those
two packages (imported from the PRIMARY checkout); both roots are now on `pythonpath` and the
guard lists all four shared packages plus `text`. Commit `9fc0b761b`.

## Design Decision — where the output gate sits

Options weighed against the token flow above:

| | Option | Verdict |
|---|---|---|
| (a) | Buffer the full completion, gate it, then emit | Strictly correct, but it discards time-to-first-token for every streaming consumer and makes the whole hub/replay design (subscriber-first delivery, coalesced flush, ring replay, cross-pod resume) dead weight. Rejected. |
| (b) | Stream as today; gate the ASSEMBLED completion at end-of-stream; on rejection emit a terminal `error` frame and persist the generation as rejected | Preserves TTFT and the replay contract; every existing consumer already discards an `error`-terminated generation; the durable record is written by the producer, so the rejection lands in the same place the completion would have. Tokens already displayed are a UX consequence — stated plainly below. |
| (c) | Incremental chunked moderation during the stream | A partial verdict on partial text is a DIFFERENT safety semantics (a refusal or a leak is a property of the whole response), it multiplies guardrail's per-generation load by the chunk count behind its admission gate, and it still cannot recall a delivered chunk. Not what "check the response" means. Rejected. |
| (d) | (b) for the streaming path + (a) for the non-streaming path | The non-streaming path already holds the whole completion before anything is persisted or returned, so gating it there IS the buffer-then-gate option at zero cost. |

**Chosen: (d).** One gate helper, two call sites:

1. **Non-streaming** — after `provider.generate` returns and BEFORE `update_task(COMPLETED)`,
   the audit event, the response, and the idempotency-cache write. Nothing about a rejected
   completion is persisted as a success or cached; the caller gets 422 (content) / 503
   (outage or enforce-posture-with-unwired-client), the task is `FAILED` with
   `error="guardrail_rejected:<reason>"`, and NO circuit-breaker failure is recorded (a
   rejection is not provider unhealth — same reasoning as the credentials arm).
2. **Streaming** — in the producer, after the provider stream ends (normally OR on an early
   stop: a cancelled/abandoned partial was delivered too, so it is gated too) and BEFORE the
   terminal frame. On allow, the `done` frame goes out exactly as today. On rejection the
   terminal frame is `error` with `code: "GUARDRAIL_REJECTED"` (or `"GUARDRAIL_UNAVAILABLE"`,
   `retryable: true`), the guardrail decision summary (`decision`, `reasons` — names and labels
   only, never text, by guardrail's own construction), and the usage block the gateway meters
   from; the task record flips to `FAILED` with the same `error` string; the audit event is
   logged with `status="rejected"`; `GENERATION_TOTAL{status="rejected"}` and
   `GENERATION_ERRORS{error_type="guardrail_rejected"}` count it; the breaker is NOT tripped.
   Every consumer listed above discards the generation on that frame. A late reconnect replays
   the same `error` terminal from the durable buffer, so cross-process readers agree.

**The UX consequence, stated plainly:** on the streaming path the clinician may have SEEN
tokens that are subsequently rejected. The stream ends with an explicit rejection rather than
a `done`, nothing is persisted as a completed generation, and no consumer treats the text as a
result — but the bytes reached the screen. That is the price of streaming; the alternative
(option a) is to stop streaming, which the owner has not asked for. If a product decision later
wants "never show a token before the verdict", option (a) is a `stream: false` from the caller,
not a change here.

**What is screened.** The full visible model output — content deltas AND reasoning deltas
(both reach consumers via `chunk`/`reasoning` frames; a jailbroken model can put the payload in
either) — with the request's `system_prompt + prompt` as `source_context`, so guardrail's
PII-leak check actually runs instead of being `skipped`. No nonce is passed (text does not use
guardrail's inbound containment envelope; that check is reported `skipped`). An EMPTY
completion is not sent to guardrail: there is nothing to screen and a blank `response` is a
422 on guardrail's side, which would masquerade as an outage.

**Persisted status.** `TaskStatus.FAILED` + `error="guardrail_rejected:<reason>"` rather than a
new `REJECTED` enum value: the status string crosses into `packages/applications` and the
gateway (`TaskResponse` is proxied verbatim), which are other lanes' surfaces, and `FAILED` is
already what every consumer discards on. The distinction is carried by the `error` field and
the terminal frame's `code`.

**Fail posture, mirrored exactly from the input gate.** Client absent AND posture disabled ⇒
bypass (dev/CI). Client absent AND posture enabled ⇒ fail closed, retryable. Client present:
`decision == "allow"` ⇒ allowed; `"block"` ⇒ rejected with the first `reasons[]` entry; a
payload without a `decision` key ⇒ rejected as `malformed_verdict`; transport/HTTP failure ⇒
bounded retry (the posture's `max_retries`/`retry_backoff_ms`/`timeout_s`) then
`external_guardrail_unavailable` ⇒ retryable. A guardrail 503 (admission gate, undetermined
verdict) is an HTTP error on `raise_for_status` and lands on the same retry path. There is no
fail-open branch.

## Implementation Plan

TDD, RED before GREEN, all hermetic (guardrail client stubbed as the input-gate tests do).

Test file: `apps/text/src/text/tests/unit/test_task871_output_gate.py`.

| # | Test | Proves |
|---|---|---|
| 1 | `ExternalGuardrailClient.screen_output` POSTs `{response, source_context}` to `/api/v1/guardrail/screen/outbound` with `X-Tenant-Id`; `allow` ⇒ allowed, `block` ⇒ not allowed with the first reason; disabled posture short-circuits; no `decision` key ⇒ not allowed (`malformed_verdict`); raising transport ⇒ bounded retry then `external_guardrail_unavailable`; never `allowed: True` from an error | client contract + fail posture |
| 2 | Non-streaming `/generate`: rejected completion ⇒ 422, task `FAILED` with `guardrail_rejected:`, provider WAS called (post-receive), nothing cached, breaker not tripped; outage ⇒ 503; malformed ⇒ 422; allowed ⇒ 200 with content; `screen_output` receives the provider's content | call site 1 |
| 3 | Streaming producer (`_run_streaming_generation`): rejected ⇒ terminal frame is `error` with `code=GUARDRAIL_REJECTED` + usage, no `done`, task `FAILED`, audit `status="rejected"`, breaker not tripped; outage ⇒ `code=GUARDRAIL_UNAVAILABLE`, `retryable=true`; allowed ⇒ `done` exactly as before; `screen_output` receives the ASSEMBLED content+reasoning; an early-stopped partial is gated | call site 2 |
| 4 | Streaming through HTTP: `POST /generate stream=true` with a rejecting guardrail ⇒ SSE body carries `event: error` with `GUARDRAIL_REJECTED` and no `event: done` | end-to-end wiring of the hub path |
| 5 | Bypass parity: client absent + posture off ⇒ both paths succeed untouched; client absent + posture ON ⇒ non-stream 503, stream `error` retryable | non-negotiable 5 |
| 6 | Judge tripwire: the gate helper inside `judge_scope()` raises `GuardrailRecursionError`; `POST /generate/internal/judge` with a wired guardrail client never awaits `screen_output` | non-negotiable 3 |
| 7 | BYO parity: a request carrying `provider_overrides` for its provider is gated on input and output exactly as a built-in one (same call, same kwargs) | non-negotiable 6 |

Files (creation/modification order):

1. `apps/text/src/text/services/external_guardrail.py` — add `screen_output(...)`.
2. `apps/text/src/text/services/output_gate.py` — NEW: `OutputRejectedError`, `gate_completion(...)`
   (the one output gate; asserts the tripwire; mirrors `_apply_guardrail_gate`'s branches).
3. `apps/text/src/text/core/guardrail_posture.py` — `platform_moderation_enabled(app_state)`
   moved here from `generate.py` so the producer module can read it without importing the
   endpoint (which would be circular); `generate.py` keeps its private name as an alias.
4. `apps/text/src/text/routing/streaming.py` — gate before the terminal frame; new kwargs
   `guardrail_client`, `guardrail_app_state`, default `None` (existing callers unchanged).
5. `apps/text/src/text/api/endpoints/generate.py` — non-stream gate + dedicated `except` arm;
   pass the client/state into the producer; docstring of `_apply_guardrail_gate` corrected.

Verification: `pnpm text:test`, `pnpm text:lint`, `pnpm text:typecheck` from the worktree,
output pasted below.

## Implementation Summary

_Pending._

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; step-0 worktree guard added to `apps/text` (commit `9fc0b761b`); design decision (d) recorded. |
