/**
 * REALTIME text generation — `POST /agents/{slug}/invocations?mode=stream`, frame by frame.
 *
 * The console used to say "real event:/data:/id: frames, first frame `meta`, last `done`" inside
 * a curl comment, and nothing else. A developer writing an SSE reader needs the frames, their
 * payloads, the heartbeat, and a straight answer about resume.
 *
 * ## Two lanes, and there is no third
 *
 * `?mode=blocking` (the default) answers one JSON body. `?mode=stream` answers
 * `text/event-stream`. The agent plane has NO async/job mode: there is no run id, no
 * `GET /agents/{slug}/invocations/{id}`, nothing to poll. Anything longer than the blocking
 * ceiling is the stream lane — or, since SDK 5, an agent RUN (`POST /agents/{slug}/runs`). See
 * {@link NO_TEXT_JOB_MODE_NOTE}.
 *
 * ## TASK-1036 lane C4 — the RUN stream (protocol v2) lives at the bottom of this file
 *
 * `invocations?mode=stream` is kept as blocking/stream SUGAR (OD-26) and still relays TEXT's own
 * four frames, verbatim, with no resume. A RUN — `POST /workflows/{slug}/runs`,
 * `POST /agents/{slug}/runs` — speaks run protocol v2 (`docs/implementation/TASK-1038-…/protocol-v2.md`):
 * one envelope `{ seq, runId, type, ts, nodeId?, data }` on SSE and WS alike, selected by the
 * `x-hope-run-protocol: 2` header or the `?protocol=2` query, resumed by `seq`. The constants and
 * snippets under "Run protocol v2" below are what the Integration tab prints.
 *
 * ## Source of truth (file:line — the docs follow the code)
 *
 *  - `apps/api/src/modules/agent/agent.controller.ts:253-470` — the route, its two modes and the
 *    NER refusal; `:136` — the 15 s `:keepalive`; `:395-401` — the response headers.
 *  - `packages/applications/src/services/agent/agent-invocation.service.ts:301-305` — the stream
 *    is TEXT's `POST /api/v1/generate` response relayed VERBATIM.
 *  - `apps/text/src/text/api/endpoints/generate.py:622` — that response is
 *    `EventSourceResponse(stream_generation(…))`; `apps/text/src/text/api/endpoints/stream.py:100-105`
 *    and `:272-277` — `_frame()` and the leading `meta`; `apps/text/src/text/routing/hub.py:113` —
 *    `done` and `error` are the terminal events.
 */

import { GATEWAY_ROUTE_SCOPES } from './gateway-scopes';

const FALLBACK_ORIGIN = 'https://your-gateway.example.com';

export interface AgentSseFrame {
  /** The SSE `event:` line. */
  event: 'meta' | 'chunk' | 'done' | 'error';
  /** The `data:` line, verbatim. */
  data: string;
  /** The `id:` line's shape. */
  id: string;
  /** Whether the stream ends after it. */
  terminal: boolean;
  note: string;
}

/** Every frame the gateway relays, in the order a generation produces them. */
export const AGENT_SSE_FRAMES: readonly AgentSseFrame[] = Object.freeze([
  {
    event: 'meta',
    data: '{"generation_id":"01a0f3c2-7e4f-7a90-8b12-3c4d5e6f7081"}',
    id: '<generation_id>:0',
    terminal: false,
    note: 'Always first, and always before any token. Persist the id if you log generations — it is the join key to this call in the TEXT service’s own task log.',
  },
  {
    event: 'chunk',
    data: '{"content":"The patient reports"}',
    id: '<generation_id>:<seq>',
    terminal: false,
    note: 'One token batch. Append `content` — the frames are already in order and `seq` increases by one, so a gap means a dropped connection, not a reorder.',
  },
  {
    event: 'done',
    data: '{"finish_reason":"stop"}',
    id: '<generation_id>:<seq>',
    terminal: true,
    note: 'The generation finished. `finish_reason` is the model’s own (`stop`, `length`, …). Stop reading here — nothing follows it.',
  },
  {
    event: 'error',
    data: '{"error":"provider request failed"}',
    id: '<generation_id>:<seq>',
    terminal: true,
    note: 'The generation failed mid-stream. It is terminal exactly like `done`: the HTTP status was already 200, so this frame is the only place the failure appears.',
  },
]);

/** The gateway writes `:keepalive` this often so an idle proxy does not close the connection. */
export const AGENT_SSE_HEARTBEAT_MS = 15_000;

/** Response headers the stream carries — and that a proxy in front of you must not swallow. */
export const AGENT_SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'X-Agent-Slug': '<slug>',
  'X-Agent-Version-Id': '<the version that served this call>',
});

/** The straight answer about resume, stated where a developer would otherwise assume it. */
export const AGENT_STREAM_RESUME_NOTE =
  'This stream does not resume. The frames carry an `id:`, but it is TEXT’s own generation cursor and the gateway ' +
  'exposes no route to reconnect against — sending Last-Event-ID has nothing to replay it. A dropped connection ends ' +
  'the invocation; re-send with the same Idempotency-Key to join the in-flight one rather than start a second. ' +
  '(Runs are the opposite: a workflow run, and since SDK 5 an agent run — POST /agents/{slug}/runs, followed on ' +
  '…/events — resume with Last-Event-ID by seq, which is why a run is the lane for anything that must survive a drop.)';

/** Why there is no job lane here — said once, so nobody invents one. */
export const NO_TEXT_JOB_MODE_NOTE =
  'There is no job mode on the invocations route: `?mode=blocking` and `?mode=stream` are its two lanes, and an invocation ' +
  'has no run id to poll. For work that is asynchronous, pollable, idempotent and resumable, start an agent RUN instead — ' +
  'POST /agents/{slug}/runs (hope.agents.run in @arcaai/vox-node 5.0) — and follow it on …/events. ' +
  '(The gateway also carries a task-based text plane — POST text-generations/generate with ' +
  '`stream: true` answers a `task_id` and a resumable `stream_url` — but nothing there names a published agent: it ' +
  'selects a provider and a model directly, on the consultation:report:write scope. It is not this agent’s lane.)';

function origin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function jsonBlock(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : pad + line))
    .join('\n');
}

/**
 * Shell: the streamed invocation with `curl -N`.
 *
 * `-N` is what makes this work at all — without it curl buffers the whole response and the
 * tokens arrive together at the end, which reads as a model that hung and then answered.
 */
export function agentSseCurlSnippet(slug: string, exampleBody: Record<string, unknown>, baseUrl: string = FALLBACK_ORIGIN): string {
  const base = origin(baseUrl);
  return [
    // Spelled without JSON quoting on purpose — the convention `sdk-snippets.ts` set: the ONLY
    // quoted "input" a reader ever finds in an agent snippet is one this route would reject.
    `# Scope: ${GATEWAY_ROUTE_SCOPES.agentInvocations.apiKeyScope}. The body is FLAT — the { input: … } envelope is the`,
    `# workflow plane's and is a 400 here. Send exactly what this agent's inputSchema declares.`,
    `export HOPE_API_URL=${JSON.stringify(base)}`,
    `export HOPE_API_KEY=${JSON.stringify('…')}`,
    ``,
    `# -N disables curl's buffering. Without it the tokens all arrive at the end and the call looks hung.`,
    `curl -N -X POST "$HOPE_API_URL/api/v1/agents/${slug}/invocations?mode=stream" \\`,
    `  -H "X-API-Key: $HOPE_API_KEY" \\`,
    `  -H "Accept: text/event-stream" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${jsonBlock(exampleBody, 6)}'`,
    ``,
    `# On the wire:`,
    ...AGENT_SSE_FRAMES.flatMap((frame) => [`#   event: ${frame.event}`, `#   data: ${frame.data}`, `#   id: ${frame.id}`, `#`]),
    `#   :keepalive            ← every ${AGENT_SSE_HEARTBEAT_MS / 1000}s, so an idle proxy does not close the connection`,
  ].join('\n');
}

/** Plain `fetch` — read `response.body`, not `EventSource`: an EventSource cannot send `X-API-Key`. */
export function agentSseFetchSnippet(slug: string, exampleBody: Record<string, unknown>, baseUrl: string = FALLBACK_ORIGIN): string {
  const base = origin(baseUrl);
  return [
    `// No SDK. Scope: ${GATEWAY_ROUTE_SCOPES.agentInvocations.apiKeyScope}.`,
    `// EventSource cannot set headers, so it can never carry an API key — read response.body instead.`,
    `const response = await fetch(${JSON.stringify(`${base}/api/v1/agents/${slug}/invocations?mode=stream`)}, {`,
    `  method: 'POST',`,
    `  headers: {`,
    `    'X-API-Key': process.env.HOPE_API_KEY,`,
    `    'Content-Type': 'application/json',`,
    `    Accept: 'text/event-stream',`,
    `  },`,
    `  body: JSON.stringify(${jsonBlock(exampleBody, 2)}),`,
    `});`,
    `if (!response.ok) throw new Error(\`\${response.status} \${await response.text()}\`);`,
    ``,
    `// Frames are separated by a blank line; ':' starts a comment (the keepalive).`,
    `const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();`,
    `let buffer = '';`,
    `let text = '';`,
    `for (;;) {`,
    `  const { value, done } = await reader.read();`,
    `  if (done) break;`,
    `  buffer += value;`,
    `  let split;`,
    `  while ((split = buffer.indexOf('\\n\\n')) !== -1) {`,
    `    const raw = buffer.slice(0, split);`,
    `    buffer = buffer.slice(split + 2);`,
    `    if (raw.startsWith(':')) continue;                       // :keepalive`,
    `    const event = /^event: ?(.*)$/m.exec(raw)?.[1] ?? 'message';`,
    `    const data = /^data: ?(.*)$/m.exec(raw)?.[1] ?? '';`,
    `    if (event === 'chunk') text += JSON.parse(data).content; // append tokens`,
    `    if (event === 'done') return text;                       // terminal`,
    `    if (event === 'error') throw new Error(JSON.parse(data).error); // also terminal — status was already 200`,
    `  }`,
    `}`,
    ``,
    `// Browser with a signed-in user instead of a key? The same call works with`,
    `// Authorization: Bearer <jwt>. Still fetch, never EventSource — the body is a POST.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Run protocol v2 (TASK-1038 / TASK-1036 lane C4)
// ---------------------------------------------------------------------------

/**
 * The events a BUSINESS-PLANE reader receives (`docs/implementation/TASK-1038-…/protocol-v2.md` §3,
 * the `public` rows). Admin-audience events (`prompt.composed`, `data.bound`, …) never reach an
 * API key or a service account, so they are deliberately not listed.
 */
export interface RunV2Event {
  type: string;
  terminal: boolean;
  note: string;
}

export const RUN_V2_EVENTS: readonly RunV2Event[] = Object.freeze([
  { type: 'run.started', terminal: false, note: 'First. Carries kind (workflow | agent), slug and versionNumber.' },
  { type: 'node.started', terminal: false, note: 'A step began. When attempt > 1, discard that node’s earlier partial output.' },
  { type: 'output.text.delta', terminal: false, note: 'A piece of text for `field`, in order. Only End-wired or `stream` nodes send them.' },
  { type: 'output.audio.delta', terminal: false, note: 'A base64 audio chunk for `field`, with its format and sample rate.' },
  { type: 'output.data', terminal: false, note: 'A whole non-text output value for `field`.' },
  { type: 'node.completed', terminal: false, note: 'A step ended: COMPLETED, DEGRADED or SKIPPED.' },
  { type: 'node.failed', terminal: false, note: 'A step failed. error is { code, message }; willRetry says whether another attempt follows.' },
  { type: 'run.completed', terminal: true, note: 'Terminal. durationMs, tokens, and the result as { kind: "inline", value } or { kind: "ref", … }.' },
  { type: 'run.failed', terminal: true, note: 'Terminal. status FAILED | TIMED_OUT, with error { code, message } — the fixed public label.' },
  { type: 'run.cancelled', terminal: true, note: 'Terminal. The type is spelled cancelled; the status is CANCELED.' },
  { type: 'run.resync', terminal: false, note: 'The server could not replay from your cursor. Replace your state with data.snapshot and continue from its seq.' },
  { type: 'ping', terminal: false, note: 'Keep-alive. Its seq moves your cursor past events you were never meant to see; do not deliver it.' },
]);

/** The fixed public error codes (`RUN_ERROR_MESSAGES`). A producer may use another; its message is then a generic label. */
export const RUN_ERROR_CODES: readonly string[] = Object.freeze([
  'RUN_TIMED_OUT',
  'NODE_TIMED_OUT',
  'RUN_CANCELLED',
  'INPUT_INVALID',
  'OUTPUT_INVALID',
  'BINDING_UNRESOLVED',
  'PROMPT_VARIABLE_UNRESOLVED',
  'PAYLOAD_TOO_LARGE',
  'MODEL_UNAVAILABLE',
  'MODEL_ERROR',
  'PROVIDER_NOT_CONFIGURED',
  'AGENT_VERSION_UNAVAILABLE',
  'GUARDRAIL_BLOCKED',
  'CONSULTATION_READ_FAILED',
  'DOWNSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export const RUN_ENVELOPE_NOTE =
  'Every event is one JSON object { seq, runId, type, ts, nodeId?, data } — the SSE data: line, and one WebSocket text frame. ' +
  'Select protocol v2 with the x-hope-run-protocol: 2 header, or ?protocol=2 where a browser cannot set headers; ' +
  'without either you get the six legacy shapes (kept readable for one release). Any other value is a 400.';

/** Prose a reader needs beside the event table. */
export const RUN_EVENT_NOTES: readonly string[] = Object.freeze([
  RUN_ENVELOPE_NOTE,
  `Events you handle: ${RUN_V2_EVENTS.map((event) => event.type).join(', ')}. The terminal ones are ${RUN_V2_EVENTS.filter((event) => event.terminal).map((event) => event.type).join(', ')} — stop reading after one.`,
]);

export const RUN_RESYNC_NOTE =
  'Resume: send the seq of the last event you handled as Last-Event-ID (or ?after=<seq>; the header wins, 0 means from the beginning). ' +
  'If the server cannot replay — the window was trimmed, the stream expired, or the cursor is invalid — it sends run.resync { reason, snapshot } ' +
  'with reason gap | expired | cursor_invalid | unavailable: replace your state with the snapshot and carry on from its seq. ' +
  'Streams are retained 24 hours after the run ends; after that, read GET …/runs/{runId} and …/result.';

export const RUN_RESULT_NOTE =
  'The result: run.completed carries it inline (value) when it is 64 KiB or less, otherwise as a ref (bucket, key, sizeBytes, sha256). ' +
  'GET …/runs/{runId}/result answers it either way — 200 JSON, 204 when there is none, 409 RUN_NOT_TERMINAL while the run is still going, ' +
  'and with an x-hope-result-kind: ref header the body points at a signed URL (ask the route again if the URL is refused or has expired).';

export type RunStreamKind = 'workflow' | 'agent';

function runEventsPath(kind: RunStreamKind, slug: string): string {
  return kind === 'workflow' ? `workflows/${slug}/runs/$RUN_ID/stream` : `agents/${slug}/runs/$RUN_ID/events`;
}

/** Shell: follow a run with protocol v2. `-N` for the same reason as {@link agentSseCurlSnippet}. */
export function runEventsCurlSnippet(kind: RunStreamKind, slug: string, baseUrl: string = FALLBACK_ORIGIN): string {
  return [
    `export HOPE_API_URL=${JSON.stringify(origin(baseUrl))}`,
    `export HOPE_API_KEY=${JSON.stringify('…')}`,
    ``,
    `# -N disables curl's buffering. x-hope-run-protocol: 2 selects the v2 envelope.`,
    `# Last-Event-ID is the seq of the last event you handled; 0 (or omit it) replays the retained window.`,
    `curl -N "$HOPE_API_URL/api/v1/${runEventsPath(kind, slug)}" \\`,
    `  -H "X-API-Key: $HOPE_API_KEY" \\`,
    `  -H "x-hope-run-protocol: 2" \\`,
    `  -H "Last-Event-ID: 0"`,
    ``,
    `# On the wire (one envelope per frame; the event: and id: lines repeat the envelope's type and seq):`,
    `#   event: output.text.delta`,
    `#   id: 5`,
    `#   data: {"seq":5,"runId":"…","type":"output.text.delta","ts":"…","nodeId":"n_note","data":{"field":"text","text":"The patient"}}`,
  ].join('\n');
}

/** Plain `fetch` reader for run protocol v2 — body, not EventSource, because the key goes in a header. */
export function runEventsFetchSnippet(kind: RunStreamKind, slug: string, baseUrl: string = FALLBACK_ORIGIN): string {
  const path = kind === 'workflow' ? `workflows/${slug}/runs/\${runId}/stream` : `agents/${slug}/runs/\${runId}/events`;
  return [
    `// No SDK. EventSource cannot send X-API-Key, so read response.body.`,
    `let lastSeq = 0; // persist this to resume from another process`,
    `const response = await fetch(\`${origin(baseUrl)}/api/v1/${path}\`, {`,
    `  headers: {`,
    `    'X-API-Key': process.env.HOPE_API_KEY,`,
    `    'x-hope-run-protocol': '2',`,
    `    'Last-Event-ID': String(lastSeq),`,
    `  },`,
    `});`,
    `if (!response.ok) throw new Error(\`\${response.status} \${await response.text()}\`);`,
    ``,
    `const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();`,
    `let buffer = '';`,
    `for (;;) {`,
    `  const { value, done } = await reader.read();`,
    `  if (done) break;`,
    `  buffer += value;`,
    `  let split;`,
    `  while ((split = buffer.indexOf('\\n\\n')) !== -1) {`,
    `    const raw = buffer.slice(0, split);`,
    `    buffer = buffer.slice(split + 2);`,
    `    const data = /^data: ?(.*)$/m.exec(raw)?.[1];`,
    `    if (data === undefined) continue; // a comment line`,
    `    const event = JSON.parse(data);`,
    `    if (event.type === 'ping') { lastSeq = Math.max(lastSeq, event.seq); continue; }`,
    `    if (event.type === 'run.resync') { /* replace your state with event.data.snapshot */ }`,
    `    if (event.seq <= lastSeq && event.type !== 'run.resync') continue; // a replayed duplicate`,
    `    lastSeq = event.seq;`,
    `    if (event.type === 'output.text.delta') process.stdout.write(event.data.text);`,
    `    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') return event;`,
    `  }`,
    `}`,
  ].join('\n');
}
