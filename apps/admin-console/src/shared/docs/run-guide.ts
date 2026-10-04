/**
 * TASK-1036 §3.6 (lane C4) — the five-step RUN GUIDE the Workflow Studio's Integration tab prints
 * (and that an agent's run view can reuse), as DATA: every step carries the same three snippets so
 * no lane is a dead end.
 *
 *   1 Authenticate → 2 Connect → 3 Send input → 4 Receive output → 5 Handle errors
 *
 * | Lane       | What it is                                                                                    |
 * |------------|-----------------------------------------------------------------------------------------------|
 * | `vox-node` | `@arcaai/vox-node` 5.0: `hope.workflows.run(slug, input)` / `hope.agents.run(slug, input)` return a `RunHandle` |
 * | `vox`      | `@arcaai/vox` 5.0, the browser: `useRun({ workflow \| agent })` — PLANNED API (TASK-1039 R2), marked "5.0" everywhere |
 * | `raw`      | curl / fetch / websocat against the gateway, run protocol v2 (`x-hope-run-protocol: 2`)        |
 *
 * ## What is derived, and from what
 *
 * Connect is filtered by the workflow's EFFECTIVE settings (`connections`: api · webhook · sse ·
 * socket; legacy graphs fall back through `effectiveSettings`). Send input and Receive output read
 * the Input shape / Output shape summaries (`run-shapes.ts`): stream audio goes up a socket, an
 * attachment is a stored object referenced by `mediaId`, an audio output streams as
 * `output.audio.delta`. Nothing is written for a lane the workflow does not enable.
 *
 * ## The two body shapes (the trap this file keeps visible)
 *
 *  - SDKs take the input ITSELF: `hope.workflows.run(slug, input)`.
 *  - Raw HTTP to a WORKFLOW takes the envelope: `{ "input": … }`. Raw HTTP to an AGENT takes the
 *    input flat. Mixing the two is a 400 on every call.
 *
 * ## The documentation-surface rules this file inherits
 *
 * Everything here is RENDERED DOCUMENTATION about how a CONSUMER configures THEIR service,
 * including their own `process.env.*`. `scripts/env-sync.mts` exempts DIRECTORIES under
 * `DOCUMENTATION_SURFACES` (`shared/docs/` is one): write snippets as TEMPLATE literals and never
 * read a real environment variable here.
 */
import type { WorkflowConnection } from '@arcaai/workflow-contract';
import { API_KEY_MINT_NOTE, RATE_LIMIT_NOTE, scopeNote, serviceAccountNotes, serviceAccountScopeNote, type GatewayRouteKey } from './gateway-scopes';
import { curlEnvLines, jsonBlock } from './sdk-snippets';
import { SOCKET_LANE_RATIONALE, SOCKET_RUNTIME_FLOOR } from './socket-snippets';
import { RUN_ERROR_CODES, RUN_EVENT_NOTES, RUN_RESYNC_NOTE, RUN_RESULT_NOTE } from './sse-frame-protocol';

export const RUN_GUIDE_LANES = ['vox-node', 'vox', 'raw'] as const;
export type RunGuideLane = (typeof RUN_GUIDE_LANES)[number];

export const RUN_GUIDE_STEP_IDS = ['authenticate', 'connect', 'send', 'receive', 'errors'] as const;
export type RunGuideStepId = (typeof RUN_GUIDE_STEP_IDS)[number];

export const RUN_GUIDE_LANE_LABEL: Readonly<Record<RunGuideLane, string>> = Object.freeze({
  'vox-node': 'vox-node',
  vox: 'vox (browser) 5.0',
  raw: 'Raw HTTP · SSE · socket',
});

export interface RunGuideSnippet {
  lane: RunGuideLane;
  /** Unique across the guide — rendered as the code block's accessible name. */
  label: string;
  code: string;
}

export interface RunGuideConnection {
  connection: WorkflowConnection;
  /** Whether the workflow's effective settings enable it. A disabled lane is listed, never documented. */
  enabled: boolean;
  summary: string;
}

export interface RunGuideStep {
  id: RunGuideStepId;
  title: string;
  summary: string;
  notes: string[];
  snippets: RunGuideSnippet[];
  /** Step 2 of a WORKFLOW guide only: the four connections and which are enabled. */
  lanes?: RunGuideConnection[];
}

export interface RunGuideInput {
  kind: 'workflow' | 'agent';
  slug: string;
  /** `effectiveSettings(graph).connections`. Ignored for an agent, whose run resource always has api + events. */
  connections: readonly WorkflowConnection[];
  /** The smallest accepted input (`run-shapes`), or `null` when the schema declares none. */
  exampleInput: Record<string, unknown> | null;
  streamAudioIn: boolean;
  attachmentsIn: boolean;
  streamAudioOut: boolean;
  /** The console's configured gateway ORIGIN (no `/api/v1`). Omitted → a documentation placeholder. */
  baseUrl?: string;
}

const FALLBACK_ORIGIN = 'https://your-gateway.example.com';

const CONNECTION_SUMMARY: Readonly<Record<WorkflowConnection, string>> = Object.freeze({
  api: 'Start a run with a POST, then read its status and result. Nothing is held open.',
  webhook: 'The platform delivers the result to a URL a tenant admin registers (admin/webhooks). There is nothing for you to call.',
  sse: 'Follow a run’s events and text as it happens. The default stream, and the only lane that resumes.',
  socket: 'A WebSocket run stream, and the route live audio takes. Use it when something buffers text/event-stream.',
});

const ALL_CONNECTIONS: readonly WorkflowConnection[] = ['api', 'webhook', 'sse', 'socket'];

interface Ctx extends RunGuideInput {
  origin: string;
  /** `workflows` | `agents` */
  collection: string;
  /** `$HOPE_API_URL/api/v1/workflows/<slug>` — the shell spelling every raw snippet shares. */
  shellBase: string;
  /** The follow-the-run path segment: `stream` on a workflow, `events` on an agent. */
  eventsSegment: 'stream' | 'events';
  has: (connection: WorkflowConnection) => boolean;
}

function ctxOf(input: RunGuideInput): Ctx {
  const workflow = input.kind === 'workflow';
  const connections = new Set<WorkflowConnection>(input.connections);
  return {
    ...input,
    origin: (input.baseUrl ?? FALLBACK_ORIGIN).replace(/\/+$/, ''),
    collection: workflow ? 'workflows' : 'agents',
    shellBase: `$HOPE_API_URL/api/v1/${workflow ? 'workflows' : 'agents'}/${input.slug}`,
    eventsSegment: workflow ? 'stream' : 'events',
    // An agent run is always api + events; only a workflow's lanes are configured.
    has: (connection) => !workflow || connections.has(connection),
  };
}

function makeLabels(ctx: Ctx) {
  return {
    node: (step: string, extra?: string) => `${step}${extra ? ` (${extra})` : ''} — vox-node snippet`,
    vox: (step: string, extra?: string) => `${step}${extra ? ` (${extra})` : ''} — vox 5.0 (browser) snippet`,
    raw: (step: string, extra?: string) => `${step}${extra ? ` (${extra})` : ''} — raw HTTP snippet`,
    kind: ctx.kind,
  };
}

const HEADER = [`import { HopeClient } from '@arcaai/vox-node';`, ``];
const CLIENT = `const hope = new HopeClient({ baseUrl: process.env.HOPE_API_URL, apiKey: process.env.HOPE_API_KEY });`;

function resourceOf(ctx: Ctx): string {
  return ctx.kind === 'workflow' ? 'workflows' : 'agents';
}

function inputLiteral(ctx: Ctx): string {
  return jsonBlock(ctx.exampleInput ?? (ctx.kind === 'agent' ? { text: '…' } : {}), 0);
}

/** The raw HTTP body: the workflow plane ENVELOPES the input, the agent plane takes it flat. */
function rawBody(ctx: Ctx, indent: number): string {
  const input = ctx.exampleInput ?? (ctx.kind === 'agent' ? { text: '…' } : {});
  return jsonBlock(ctx.kind === 'workflow' ? { input } : input, indent);
}

function scopeKeys(ctx: Ctx, which: 'start' | 'read' | 'all'): GatewayRouteKey[] {
  if (ctx.kind === 'workflow') {
    const start: GatewayRouteKey[] = ['workflowRunStart', 'workflowRunCancel'];
    // The ticket route is in the list on purpose: it carries the one `serviceAccountNote` (JWT or API key only).
    const read: GatewayRouteKey[] = ['workflowRunGet', 'workflowRunResult', 'workflowRunStream', 'workflowRunStreamTicket'];
    return which === 'start' ? start : which === 'read' ? read : [...start, ...read];
  }
  const start: GatewayRouteKey[] = ['agentRunStart', 'agentRunCancel'];
  const read: GatewayRouteKey[] = ['agentRunGet', 'agentRunEvents', 'agentRunResult'];
  return which === 'start' ? start : which === 'read' ? read : [...start, ...read];
}

// ---------------------------------------------------------------------------
// 1 — Authenticate
// ---------------------------------------------------------------------------

function authenticate(ctx: Ctx): RunGuideStep {
  const label = makeLabels(ctx);
  const keys = scopeKeys(ctx, 'all');
  return {
    id: 'authenticate',
    title: 'Authenticate',
    summary: 'Pick the credential class for the caller. Both machine classes reach a run; a user session needs an extra ability.',
    notes: [
      scopeNote(keys),
      serviceAccountScopeNote(keys),
      API_KEY_MINT_NOTE,
      'A service account is exchanged at POST /api/v1/auth/service-token for an opaque token that lives about 15 minutes (expiresIn 900); the SDK exchanges, refreshes early and re-exchanges for you.',
      'The tenant binds to the credential: never send X-Tenant-Id with an API key or a service-account token. A service account’s working tenant binds at the exchange.',
      ...(ctx.kind === 'workflow'
        ? ['Over a user JWT, starting a run additionally needs the create:WorkflowRun ability (read:WorkflowRun for the reads). An API key or service account carrying the scopes above does not.']
        : []),
      ...serviceAccountNotes(keys),
    ],
    snippets: [
      {
        lane: 'vox-node',
        label: label.node('Authenticate'),
        code: [
          ...HEADER,
          `// API key — the business plane. Minted on the console's API keys screen.`,
          CLIENT,
          ``,
          `// …or a service account (a machine identity): the SDK does the token exchange.`,
          `const machine = new HopeClient({`,
          `  baseUrl: process.env.HOPE_API_URL,`,
          `  clientId: process.env.HOPE_SVC_CLIENT_ID,`,
          `  clientSecret: process.env.HOPE_SVC_CLIENT_SECRET,`,
          `  // workingTenantId: '…',  // binds at the exchange, never per request`,
          `});`,
        ].join('\n'),
      },
      {
        lane: 'vox',
        label: label.vox('Authenticate'),
        code: [
          `import { AgenticProvider } from '@arcaai/vox/core'; // @arcaai/vox 5.0`,
          ``,
          `// baseUrl INCLUDES /api/v1 here — @arcaai/vox-node adds the prefix for you, this SDK does not.`,
          `const config = { api: { baseUrl: ${JSON.stringify(`${ctx.origin}/api/v1`)}, accessToken: token /* the signed-in user's JWT */ } };`,
          `// <AgenticProvider config={config}>…</AgenticProvider>`,
          ``,
          `// An API key works too — apiKey: 'hope_…' — but it is visible to anyone who opens the page.`,
          `// Prefer the signed-in user's token in a browser.`,
        ].join('\n'),
      },
      {
        lane: 'raw',
        label: label.raw('Authenticate'),
        code: [
          ...curlEnvLines(ctx.origin),
          `# API key: send it on every request.`,
          `#   -H "X-API-Key: $HOPE_API_KEY"`,
          ``,
          `# Service account: exchange once, present the token until it expires (900 s), then exchange again.`,
          `TOKEN=$(curl -sS -X POST "$HOPE_API_URL/api/v1/auth/service-token" \\`,
          `  -H "Content-Type: application/json" \\`,
          `  -d '{ "clientId": "…", "clientSecret": "…" }' | jq -r .accessToken)`,
          `#   -H "X-Service-Account-Token: $TOKEN"`,
          ``,
          `# Never add X-Tenant-Id to either — the tenant binds to the credential.`,
        ].join('\n'),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 2 — Connect
// ---------------------------------------------------------------------------

function connectSnippets(ctx: Ctx): RunGuideSnippet[] {
  const label = makeLabels(ctx);
  const resource = resourceOf(ctx);
  const start = `const run = await hope.${resource}.run('${ctx.slug}', input);`;
  const snippets: RunGuideSnippet[] = [];
  const headerEnv = curlEnvLines(ctx.origin);

  if (ctx.has('api')) {
    snippets.push(
      {
        lane: 'vox-node',
        label: label.node('Connect', 'API'),
        code: [start, ``, `// No stream held open: poll the run until it ends.`, `const outcome = await run.wait({ poll: true, intervalMs: 2_000 });`].join('\n'),
      },
      {
        lane: 'vox',
        label: label.vox('Connect', 'API'),
        code: [
          `import { useRun } from '@arcaai/vox/core'; // @arcaai/vox 5.0`,
          ``,
          `const { start, status, result } = useRun({ ${ctx.kind}: '${ctx.slug}' });`,
          `// status moves RUNNING → COMPLETED | FAILED | TIMED_OUT | CANCELED; result is the verified delivered value.`,
        ].join('\n'),
      },
      {
        lane: 'raw',
        label: label.raw('Connect', 'API'),
        code: [...headerEnv, `# Read where the run got to — poll this until status is terminal.`, `curl -sS "${ctx.shellBase}/runs/$RUN_ID" \\`, `  -H "X-API-Key: $HOPE_API_KEY"`].join('\n'),
      },
    );
  }

  if (ctx.has('sse')) {
    snippets.push(
      {
        lane: 'vox-node',
        label: label.node('Connect', 'SSE'),
        code: [
          start,
          ``,
          `// Protocol v2, resumed by seq. A dropped connection reconnects with Last-Event-ID for you.`,
          `for await (const event of run.events()) {`,
          `  // run.started → node.started → output.text.delta … → run.completed`,
          `}`,
          `// Persist run.lastSeq to pick the run up from another process: hope.${resource}.attach('${ctx.slug}', runId).events({ after })`,
        ].join('\n'),
      },
      {
        lane: 'vox',
        label: label.vox('Connect', 'SSE'),
        code: [
          `import { useRun } from '@arcaai/vox/core'; // @arcaai/vox 5.0`,
          ``,
          `// events is the v2 event list; the hook follows the run over SSE and resumes on mount.`,
          `const { start, events, status } = useRun({ ${ctx.kind}: '${ctx.slug}' });`,
        ].join('\n'),
      },
      {
        lane: 'raw',
        label: label.raw('Connect', 'SSE'),
        code: [
          ...headerEnv,
          `# -N disables curl's buffering. The protocol header selects v2 frames; without it you get the legacy shapes.`,
          `curl -N "${ctx.shellBase}/runs/$RUN_ID/${ctx.eventsSegment}" \\`,
          `  -H "X-API-Key: $HOPE_API_KEY" \\`,
          `  -H "x-hope-run-protocol: 2" \\`,
          `  -H "Last-Event-ID: 0"   # on a reconnect, the seq of the last event you handled`,
          ...(ctx.kind === 'workflow'
            ? [
                ``,
                `# A browser EventSource cannot set headers: mint a run-scoped, single-use ticket and use the query form.`,
                `#   POST ${ctx.shellBase}/runs/$RUN_ID/stream-ticket  →  { ticket, expiresAt, scope, url }`,
                `#   new EventSource(\`\${origin}/api/v1/workflows/${ctx.slug}/runs/\${runId}/stream?protocol=2&ticket=\${ticket}\`)`,
              ]
            : [``, `# Use fetch and read response.body — an EventSource cannot send X-API-Key.`]),
        ].join('\n'),
      },
    );
  }

  if (ctx.has('socket') && ctx.kind === 'workflow') {
    snippets.push(
      {
        lane: 'vox-node',
        label: label.node('Connect', 'socket'),
        code: [
          start,
          ``,
          `// ${SOCKET_RUNTIME_FLOOR}`,
          `const ticket = await fetch(\`\${process.env.HOPE_API_URL}/api/v1/workflows/${ctx.slug}/runs/\${run.runId}/stream-ticket\`, {`,
          `  method: 'POST',`,
          `  headers: { 'X-API-Key': process.env.HOPE_API_KEY },`,
          `}).then((response) => response.json());`,
          `// ticket.url is RELATIVE and already carries ?slug=&runId=&ticket= — add only the protocol.`,
          `const socket = new WebSocket(\`\${process.env.HOPE_API_URL.replace(/^http/, 'ws')}\${ticket.url}&protocol=2\`);`,
          `socket.onmessage = (message) => {`,
          `  const event = JSON.parse(message.data); // one v2 envelope per text frame`,
          `};`,
        ].join('\n'),
      },
      {
        lane: 'vox',
        label: label.vox('Connect', 'socket'),
        code: [
          `import { useWorkflowRun } from '@arcaai/vox/core';`,
          ``,
          `// The socket lane is the one option kept on useWorkflowRun in vox 5.0; useRun follows SSE.`,
          `const { start, watch, events, lastEventId } = useWorkflowRun({ transport: 'socket' });`,
          `// A socket ticket is single-use, so a drop ENDS the watch: start a new one from lastEventId.`,
        ].join('\n'),
      },
      {
        lane: 'raw',
        label: label.raw('Connect', 'socket'),
        code: [
          ...headerEnv,
          `# 1. Mint a run-scoped, single-use ticket (~30s).`,
          `TICKET=$(curl -sS -X POST "${ctx.shellBase}/runs/$RUN_ID/stream-ticket" \\`,
          `  -H "X-API-Key: $HOPE_API_KEY")`,
          ``,
          `# 2. Open the url it returned (relative, already carrying the ticket) with ?protocol=2 for v2 frames.`,
          `URL=$(printf '%s' "$TICKET" | jq -r .url)`,
          `WS_ORIGIN=$(printf '%s' "$HOPE_API_URL" | sed 's|^http|ws|')`,
          `websocat "$WS_ORIGIN$URL&protocol=2"`,
          ``,
          `# The ticket is consumed by the first open; every reconnect mints a new one, and resumes with ?after=<seq>.`,
        ].join('\n'),
      },
    );
  }

  // The guide is never empty: a workflow with no api connection still documents what a caller sees.
  if (snippets.length === 0) {
    snippets.push(
      { lane: 'vox-node', label: label.node('Connect'), code: `// No connection is enabled in Settings, so a caller cannot start this workflow.` },
      { lane: 'vox', label: label.vox('Connect'), code: `// No connection is enabled in Settings, so a caller cannot start this workflow.` },
      { lane: 'raw', label: label.raw('Connect'), code: `# No connection is enabled in Settings, so a caller cannot start this workflow.` },
    );
  }
  return snippets;
}

function connect(ctx: Ctx): RunGuideStep {
  const workflow = ctx.kind === 'workflow';
  const enabled = new Set<WorkflowConnection>(ctx.connections);
  const notes: string[] = [];
  if (workflow && ctx.connections.length === 0) {
    notes.push('No connection is enabled in this workflow’s Settings, so a caller cannot reach it. Enable API (and SSE or socket to stream) first.');
  }
  if (workflow && enabled.has('sse') && enabled.has('socket')) notes.push(SOCKET_LANE_RATIONALE);
  else if (workflow && enabled.has('sse')) notes.push('SSE is the only lane that resumes: a dropped connection reconnects with Last-Event-ID and loses no events.');
  if (workflow && enabled.has('socket')) notes.push(SOCKET_RUNTIME_FLOOR);
  if (!workflow) notes.push('An agent run always has two ways in: start it and poll, or follow its resumable SSE events.');

  return {
    id: 'connect',
    title: 'Connect',
    summary: workflow
      ? 'Choose how you follow the run. Only the connections this workflow’s Settings enable are shown.'
      : 'Choose how you follow the run: poll its status, or follow its events.',
    notes,
    snippets: connectSnippets(ctx),
    ...(workflow ? { lanes: ALL_CONNECTIONS.map((connection) => ({ connection, enabled: enabled.has(connection), summary: CONNECTION_SUMMARY[connection] })) } : {}),
  };
}

// ---------------------------------------------------------------------------
// 3 — Send input
// ---------------------------------------------------------------------------

function send(ctx: Ctx): RunGuideStep {
  const label = makeLabels(ctx);
  const resource = resourceOf(ctx);
  const notes: string[] = [];
  notes.push(
    ctx.kind === 'workflow'
      ? 'SDKs take the input itself. Raw HTTP takes the envelope { "input": … } — the agent plane takes its input flat, and mixing the two is a 400 on every call.'
      : 'The agent plane takes its input FLAT. Wrapping it in the workflow plane’s { "input": … } envelope is a 400.',
  );
  notes.push('Every start carries an Idempotency-Key: a retry with the same key and body joins the run already in flight instead of starting — and billing — a second one.');
  if (ctx.kind === 'workflow') {
    notes.push('input may not carry consultationId, externalPatientId, userId, jobId or sessionId — the server stamps those itself.');
  }
  if (ctx.streamAudioIn) {
    notes.push(
      'Stream audio is not part of the JSON body. It goes up a realtime STT session as binary PCM16 little-endian mono frames, with typed transcript and status events coming back; the run’s own events come back on the run stream.',
    );
  }
  if (ctx.attachmentsIn) {
    notes.push(
      'An attachment (or blob audio) is a stored media object, referenced in the input by its mediaId. Attachment types are text/plain, text/markdown, application/pdf and image/jpeg (image/png and image/webp where the schema allows them). A mediaId this tenant does not own answers 404.',
    );
  }

  const snippets: RunGuideSnippet[] = [
    {
      lane: 'vox-node',
      label: label.node('Send input'),
      code: [
        ...HEADER,
        CLIENT,
        ``,
        `const input = ${inputLiteral(ctx)};`,
        ``,
        `// Pass your own key (an order id, a message id) when a fresh process might start the same run again.`,
        `const run = await hope.${resource}.run('${ctx.slug}', input, { idempotencyKey: \`${ctx.slug}-\${visitId}\` });`,
        `// run.runId is the handle's id; run.joined is true when the key matched a run already in flight`,
      ].join('\n'),
    },
    {
      lane: 'vox',
      label: label.vox('Send input'),
      code: [
        `import { useRun } from '@arcaai/vox/core'; // @arcaai/vox 5.0`,
        ``,
        `// …in any component under <AgenticProvider>:`,
        `const { start, text, events, result, status, cancel } = useRun({ ${ctx.kind}: '${ctx.slug}' });`,
        ``,
        `await start(${inputLiteral(ctx)});`,
      ].join('\n'),
    },
    {
      lane: 'raw',
      label: label.raw('Send input'),
      code: [
        ...curlEnvLines(ctx.origin),
        `# 202 → { runId, status, links: { self, events, result, cancel } }`,
        `RUN=$(curl -sS -X POST "${ctx.shellBase}/runs" \\`,
        `  -H "X-API-Key: $HOPE_API_KEY" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Idempotency-Key: $(uuidgen)" \\`,
        `  -d '${rawBody(ctx, 6)}')`,
        `RUN_ID=$(printf '%s' "$RUN" | jq -r .runId)`,
      ].join('\n'),
    },
  ];

  if (ctx.streamAudioIn) {
    snippets[0].code += [
      ``,
      ``,
      `// Live audio: a realtime STT session, binary PCM16 up, typed events down.`,
      `const session = await hope.stt.createStreamSession({});`,
      `const socket = hope.stt.socket(session);`,
      `await socket.connect();`,
      `socket.sendPcm16(pcm16LeMonoChunk);`,
      `await socket.finalize();`,
    ].join('\n');
    snippets[1].code += [
      ``,
      ``,
      `// Microphone → the run, with no model in the browser (capture and transport only).`,
      `const audio = useRunAudio({ ${ctx.kind}: '${ctx.slug}' }); // @arcaai/vox 5.0`,
      `await audio.start();`,
    ].join('\n');
    snippets[2].code += [
      ``,
      ``,
      `# Live audio: open a realtime session, then send binary PCM16 LE mono frames on its socket.`,
      `SESSION=$(curl -sS -X POST "$HOPE_API_URL/api/v1/audio/transcription-jobs/stream/session" \\`,
      `  -H "X-API-Key: $HOPE_API_KEY" -H "Content-Type: application/json" -d '{}')`,
      `# → { sessionId, ticket, … } — open /ws/stt/stream?sessionId=…&ticket=… (websocat -b).`,
    ].join('\n');
  }

  return {
    id: 'send',
    title: 'Send input',
    summary: ctx.streamAudioIn
      ? 'Start the run with a JSON body; live audio goes up a socket. The body below is the smallest accepted input.'
      : 'Start the run with a JSON body. The body below is the smallest accepted input.',
    notes,
    snippets,
  };
}

// ---------------------------------------------------------------------------
// 4 — Receive output
// ---------------------------------------------------------------------------

function receive(ctx: Ctx): RunGuideStep {
  const label = makeLabels(ctx);
  const resource = resourceOf(ctx);
  const workflow = ctx.kind === 'workflow';
  const notes: string[] = [
    ...RUN_EVENT_NOTES,
    RUN_RESULT_NOTE,
    'seq is monotonic but NOT contiguous for you (the public plane is filtered out of one stored sequence): never infer loss from a jump. Only the server signals loss, with run.resync.',
  ];
  if (!workflow) notes.push("An agent run has exactly one step; every node event names nodeId: 'agent'.");
  if (ctx.streamAudioOut) notes.push('Audio output arrives as output.audio.delta events: a base64 chunk with its format and sample rate, in order.');

  return {
    id: 'receive',
    title: 'Receive output',
    summary: 'Read text as it is written, then the verified result. Or poll, with no stream at all.',
    notes,
    snippets: [
      {
        lane: 'vox-node',
        label: label.node('Receive output'),
        code: [
          `const run = await hope.${resource}.run('${ctx.slug}', input);`,
          ``,
          `for await (const chunk of run.text()) process.stdout.write(chunk); // output.text.delta, in order`,
          `const delivered = await run.result(); // the delivered value, size- and hash-verified; null when the run produced none`,
          ``,
          `// No stream: poll the run, then read the result.`,
          `// const outcome = await run.wait({ poll: true, intervalMs: 2_000 });`,
          `// if (outcome.status === 'COMPLETED') await run.result();`,
        ].join('\n'),
      },
      {
        lane: 'vox',
        label: label.vox('Receive output'),
        code: [
          `import { useRun } from '@arcaai/vox/core'; // @arcaai/vox 5.0`,
          ``,
          `const { start, text, events, result, status, cancel } = useRun({ ${ctx.kind}: '${ctx.slug}' });`,
          ``,
          `// text grows as output.text.delta arrives; result is the verified value once the run is COMPLETED;`,
          `// status is RUNNING until a terminal event. cancel() ends the run — closing the page never does.`,
          `return <output>{text}</output>;`,
        ].join('\n'),
      },
      {
        lane: 'raw',
        label: label.raw('Receive output'),
        code: [
          ...curlEnvLines(ctx.origin),
          `# Follow it (SSE v2). Resume with Last-Event-ID: <seq>.`,
          `curl -N "${ctx.shellBase}/runs/$RUN_ID/${ctx.eventsSegment}" \\`,
          `  -H "X-API-Key: $HOPE_API_KEY" -H "x-hope-run-protocol: 2" -H "Last-Event-ID: 0"`,
          ...(workflow ? [`#   The query spelling for a browser EventSource: ${ctx.shellBase}/runs/$RUN_ID/stream?protocol=2&ticket=…`] : []),
          ``,
          `# Or poll it.`,
          `curl -sS "${ctx.shellBase}/runs/$RUN_ID" -H "X-API-Key: $HOPE_API_KEY"`,
          ``,
          `# Then read the result: 200 JSON · 204 none · 409 RUN_NOT_TERMINAL while it runs.`,
          `# x-hope-result-kind: ref means the body points at a signed URL — fetch that for the bytes.`,
          `curl -sS -i "${ctx.shellBase}/runs/$RUN_ID/result" -H "X-API-Key: $HOPE_API_KEY"`,
        ].join('\n'),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 5 — Handle errors
// ---------------------------------------------------------------------------

function errors(ctx: Ctx): RunGuideStep {
  const label = makeLabels(ctx);
  const resource = resourceOf(ctx);
  return {
    id: 'errors',
    title: 'Handle errors',
    summary: 'A failed run is a normal terminal state with a fixed code, not an exception to parse.',
    notes: [
      `A failed run carries { code, message }: the code is one of a fixed set and the message is its fixed label — never an interpolated model or patient value. Branch on the code. ${RUN_ERROR_CODES.join(', ')}.`,
      RUN_RESYNC_NOTE,
      'Retries: send the same Idempotency-Key and body to join the run in flight. A different body with a key already used is refused (409), not silently re-run.',
      'A dropped connection never cancels a run — it is durable. Resume by seq, or poll. Call cancel() (POST …/cancel, idempotent) to end it on purpose.',
      RATE_LIMIT_NOTE,
      'Cross-tenant ids answer 404, not 403; a missing scope answers 403 naming the scope to add.',
    ],
    snippets: [
      {
        lane: 'vox-node',
        label: label.node('Handle errors'),
        code: [
          `import { RunFailedError, RunStreamInterruptedError } from '@arcaai/vox-node';`,
          ``,
          `const run = await hope.${resource}.run('${ctx.slug}', input, { idempotencyKey });`,
          `try {`,
          `  for await (const chunk of run.text()) process.stdout.write(chunk);`,
          `  await run.result();`,
          `} catch (error) {`,
          `  if (error instanceof RunFailedError) {`,
          `    // error.status is FAILED | TIMED_OUT | CANCELED; error.code is the fixed public code.`,
          `    if (error.code === 'INPUT_INVALID') { /* fix the input — retrying will not help */ }`,
          `  } else if (error instanceof RunStreamInterruptedError) {`,
          `    // The RUN is unaffected. Pick it up again from the cursor, or poll:`,
          `    await hope.${resource}.attach('${ctx.slug}', run.runId).wait({ poll: true });`,
          `  } else throw error;`,
          `}`,
          ``,
          `await run.cancel(); // idempotent; the only thing that ends a run early`,
        ].join('\n'),
      },
      {
        lane: 'vox',
        label: label.vox('Handle errors'),
        code: [
          `import { useRun } from '@arcaai/vox/core'; // @arcaai/vox 5.0`,
          ``,
          `const { status, error, cancel } = useRun({ ${ctx.kind}: '${ctx.slug}' });`,
          ``,
          `// error.code is the fixed public code (INPUT_INVALID, GUARDRAIL_BLOCKED, …); show your own copy for it.`,
          `if (status === 'FAILED' && error?.code === 'INPUT_INVALID') { /* fix the input */ }`,
        ].join('\n'),
      },
      {
        lane: 'raw',
        label: label.raw('Handle errors'),
        code: [
          ...curlEnvLines(ctx.origin),
          `# Retry-safe start: the same Idempotency-Key joins the run in flight.`,
          `curl -sS -X POST "${ctx.shellBase}/runs" \\`,
          `  -H "X-API-Key: $HOPE_API_KEY" -H "Content-Type: application/json" \\`,
          `  -H "Idempotency-Key: $KEY" \\`,
          `  -d '${rawBody(ctx, 6)}'`,
          ``,
          `# A terminal failure arrives as an event, not as a bad HTTP status (the stream was already 200):`,
          `#   event: run.failed`,
          `#   data: {"seq":9,"runId":"…","type":"run.failed","ts":"…","data":{"status":"FAILED","durationMs":812,"error":{"code":"MODEL_UNAVAILABLE","message":"…"}}}`,
          ``,
          `# Cancel on purpose (idempotent):`,
          `curl -sS -X POST "${ctx.shellBase}/runs/$RUN_ID/cancel" -H "X-API-Key: $HOPE_API_KEY"`,
        ].join('\n'),
      },
    ],
  };
}

/** The five steps for one workflow (or agent), in the order a developer works through them. */
export function buildRunGuide(input: RunGuideInput): RunGuideStep[] {
  const ctx = ctxOf(input);
  return [authenticate(ctx), connect(ctx), send(ctx), receive(ctx), errors(ctx)];
}
