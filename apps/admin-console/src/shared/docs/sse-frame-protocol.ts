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
 * ceiling is the stream lane. See {@link NO_TEXT_JOB_MODE_NOTE}.
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
  '(Workflow runs are the opposite: their SSE lane resumes with Last-Event-ID, which is why it is their default.)';

/** Why there is no job lane here — said once, so nobody invents one. */
export const NO_TEXT_JOB_MODE_NOTE =
  'There is no job mode on the agent plane: `?mode=blocking` and `?mode=stream` are the two lanes, and an invocation ' +
  'has no run id to poll. (The gateway does carry a task-based text plane — POST text-generations/generate with ' +
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
