/**
 * TASK-971 lane D — a Postman Collection v2.1 for ONE published agent or workflow.
 *
 * ## Why generated rather than shipped
 *
 * The repository carries no Postman artifact of any kind, and a static one could not carry the
 * thing that makes this useful: the body derived from THIS lineage's own input schema. A
 * hand-maintained collection would also be a fourth place the flat-vs-enveloped rule could rot.
 *
 * ## What must never appear in the output
 *
 * A credential. `apiKey` ships as an EMPTY collection variable the importer fills in their own
 * Postman environment. The console knows the operator's session, never a tenant API key, and a
 * downloadable file is exactly the artifact that ends up in a chat thread or a ticket.
 *
 * ## Contract note (TASK-971 §3, lane boundary)
 *
 * The signature and the envelope below are the ORCHESTRATOR-OWNED contract that lane C renders
 * against. Lane D owns the body: the per-task agent routes, the workflow follow-up requests
 * (status, stream-ticket), the `runId` capture script, and the conformance tests.
 */

import { BATCH_STT_ROUTES } from './batch-job-protocol';
import { GATEWAY_ROUTE_SCOPES } from './gateway-scopes';
import { STT_SOCKET_ROUTES } from './stt-socket-protocol';
import type { SdkSnippetAgentTask } from './sdk-snippets';

/** Structural shape of the emitted document — enough to type the builder, not a full v2.1 model. */
export interface PostmanCollection {
  info: { name: string; description?: string; schema: string };
  variable: Array<{ key: string; value: string; type?: string }>;
  auth: Record<string, unknown>;
  item: PostmanItem[];
}

export interface PostmanItem {
  name: string;
  request: {
    method: string;
    header: Array<{ key: string; value: string }>;
    url: { raw: string; host: string[]; path: string[]; query?: Array<{ key: string; value: string }> };
    body?:
      | { mode: 'raw'; raw: string; options?: { raw: { language: 'json' } } }
      /** Postman's multipart mode — the ONLY way to send the batch upload by hand. */
      | { mode: 'formdata'; formdata: Array<{ key: string; type: 'file' | 'text'; src?: string; value?: string; description?: string }> };
    description?: string;
  };
  /** Postman test/pre-request scripts — how `runId` is captured for the follow-up requests. */
  event?: Array<{ listen: 'test' | 'prerequest'; script: { type: 'text/javascript'; exec: string[] } }>;
}

export interface PostmanCollectionInput {
  kind: 'agent' | 'workflow';
  slug: string;
  /** Agent only. NER shares TEXT_GENERATION's route, so it arrives already mapped. */
  task?: SdkSnippetAgentTask;
  /**
   * Agent + `task: 'TEXT_GENERATION'` only. Set when the underlying agent is actually a
   * NAMED_ENTITY_RECOGNITION agent sharing the invocations route with text generation (`task`
   * above arrives already mapped — see `snippetTaskOf` in `integration-panel.tsx`). NER is
   * one-shot: `?mode=stream` on that route is a 400 `MODE_UNSUPPORTED`, so this suppresses the
   * stream example that would otherwise be emitted for `TEXT_GENERATION`.
   */
  isNamedEntityRecognition?: boolean;
  /** Workflow only — the admitted `?mode=` values, `socket` already removed by the caller. */
  modes?: string[];
  /** Derived from the lineage's own input schema; `null` when no usable schema exists. */
  exampleBody: Record<string, unknown> | null;
  /** Gateway ORIGIN only, no `/api/v1` suffix — e.g. `https://api.example.com`. */
  baseUrl: string;
}

export const POSTMAN_SCHEMA_URL = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/**
 * The collection-level auth every request inherits. An API key is the credential a tenant admin
 * has just minted on `/api-keys`, and the only one of the three classes that is theirs to hand to
 * a developer — a JWT is a user session and a service-account token is exchanged, not issued.
 */
export function apiKeyAuth(): Record<string, unknown> {
  return {
    type: 'apikey',
    apikey: [
      { key: 'key', value: 'X-API-Key' },
      { key: 'value', value: '{{apiKey}}' },
      { key: 'in', value: 'header' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const JSON_HEADER = [{ key: 'Content-Type', value: 'application/json' }];

/**
 * The body below is derived from THIS agent's own `inputSchema`, but a schema is only half the
 * contract: an agent's prompt may also bind `trigger.context.*` placeholders the schema never
 * declares, and a missing one is a 400 that names it.
 */
const BODY_SCHEMA_NOTE =
  'The body is this agent’s own `inputSchema` (read it back from `GET /api/v1/agents/' +
  '{slug}`). The agent’s prompt may additionally require variables the schema does not declare; a missing one is a 400 naming it, ' +
  'so send them under `variables`.';

/** Builds a v2.1 `url` node whose `raw` is always reconstructible from `host` + `path` + `query`. */
function buildUrl(path: string[], query?: Array<{ key: string; value: string }>): PostmanItem['request']['url'] {
  const qs = query && query.length > 0 ? `?${query.map((q) => `${q.key}=${q.value}`).join('&')}` : '';
  const url: PostmanItem['request']['url'] = {
    raw: `{{baseUrl}}/${path.join('/')}${qs}`,
    host: ['{{baseUrl}}'],
    path,
  };
  if (query && query.length > 0) {
    url.query = query;
  }
  return url;
}

function jsonBody(value: Record<string, unknown>): PostmanItem['request']['body'] {
  return {
    mode: 'raw',
    raw: JSON.stringify(value, null, 2),
    options: { raw: { language: 'json' } },
  };
}

// ---------------------------------------------------------------------------
// Agent plane — the body is FLAT, one route per task
// ---------------------------------------------------------------------------

const RESERVED_RUN_INPUT_KEYS = ['consultationId', 'externalPatientId', 'userId', 'jobId', 'sessionId'];

function agentRoutePath(slug: string, task: SdkSnippetAgentTask): string[] {
  if (task === 'SPEECH_TO_TEXT') return ['api', 'v1', 'agents', slug, 'transcriptions'];
  if (task === 'TEXT_TO_SPEECH') return ['api', 'v1', 'agents', slug, 'speech'];
  return ['api', 'v1', 'agents', slug, 'invocations'];
}

/** The placeholder body used only when the caller has no schema-derived example to offer. */
function defaultAgentBody(task: SdkSnippetAgentTask): Record<string, unknown> {
  if (task === 'SPEECH_TO_TEXT') return { mediaId: '<media-id>' };
  return { text: '…' };
}

/** Splits a documented route string (`/audio/transcription-jobs/{jobId}`) into v2.1 path segments under `api/v1`. */
function apiPath(route: string, substitutions: Record<string, string> = {}): string[] {
  let resolved = route;
  for (const [token, value] of Object.entries(substitutions)) resolved = resolved.replace(`{${token}}`, value);
  return ['api', 'v1', ...resolved.split('/').filter(Boolean)];
}

function scopeLine(key: keyof typeof GATEWAY_ROUTE_SCOPES): string {
  return `Scope: \`${GATEWAY_ROUTE_SCOPES[key].apiKeyScope}\` (service account: \`${GATEWAY_ROUTE_SCOPES[key].serviceAccountScope}\`).`;
}

/**
 * Captures one string field out of a JSON response into a collection variable, so the follow-up
 * requests below resolve without copy-paste. Same guards as `RUN_ID_CAPTURE_SCRIPT`: a non-2xx
 * response and a non-JSON body both return silently rather than throwing in the importer's face.
 */
function captureScript(field: string, variable: string): string[] {
  return [
    '(function () {',
    '  if (pm.response.code < 200 || pm.response.code >= 300) {',
    '    return;',
    '  }',
    '  var body;',
    '  try {',
    '    body = pm.response.json();',
    '  } catch (error) {',
    '    return;',
    '  }',
    `  if (body && typeof body.${field} === "string") {`,
    `    pm.collectionVariables.set(${JSON.stringify(variable)}, body.${field});`,
    '  }',
    '})();',
  ];
}

function testEvent(exec: string[]): NonNullable<PostmanItem['event']> {
  return [{ listen: 'test' as const, script: { type: 'text/javascript' as const, exec } }];
}

/**
 * SPEECH_TO_TEXT — the two jobs a developer actually has, in the order they meet them.
 *
 * BATCH: upload the file (the multipart route is the only one that takes audio bytes), or start
 * from a `mediaId` you already hold; then read or follow the job. REALTIME: open the session,
 * then open the WebSocket — which a v2.1 collection cannot contain, so the item that mints the
 * ticket carries the handshake and the first frames in its description.
 */
function buildSpeechToTextItems(slug: string): PostmanItem[] {
  return [
    {
      name: `Batch 1 · Upload audio and start a job (${slug})`,
      request: {
        method: 'POST',
        header: [],
        url: buildUrl(apiPath(BATCH_STT_ROUTES.uploadAndStart)),
        body: {
          mode: 'formdata',
          formdata: [
            { key: 'file', type: 'file', src: '/path/to/consultation.wav', description: 'Pick a real audio file here. Postman sets the part’s content type from the file — an octet-stream part is a 400 `Unsupported audio type`.' },
            { key: 'agentSlug', type: 'text', value: slug, description: 'The published ASR agent. Remove this field to use the tenant’s assigned agent instead.' },
          ],
        },
        description:
          'THE way to transcribe a file you hold: multipart/form-data, and the only route on this gateway that accepts audio bytes. ' +
          '201 answers `{ id, status: "QUEUED", sseUrl, audioUri, agentSlug, agentVersionId }`, and this request’s test script captures `id` ' +
          'into the `jobId` variable so the two requests below need no copy-paste. Do NOT set Content-Type yourself — Postman writes the ' +
          'multipart boundary. Ceilings (size, duration, in-flight jobs) come from `GET /api/v1' + BATCH_STT_ROUTES.limits + '`. ' +
          scopeLine('transcriptionUpload'),
      },
      event: testEvent(captureScript('id', 'jobId')),
    },
    {
      name: `Batch 1b · Start a job from a mediaId (${slug})`,
      request: {
        method: 'POST',
        header: JSON_HEADER,
        url: buildUrl(apiPath(BATCH_STT_ROUTES.startFromMediaId, { slug })),
        body: jsonBody({ mediaId: '{{mediaId}}' }),
        description:
          'The OTHER batch form: media that already exists (a consultation recording). This route takes an id and has no multipart handler, ' +
          'so sending a file to it is a 400 `mediaId is required`; a mediaId this tenant does not own is a 404. Its 201 carries an `sseUrl` on ' +
          'the STT job plane, which needs a DIFFERENT scope from this request — see the two below. ' +
          scopeLine('agentTranscriptions'),
      },
      event: testEvent(captureScript('id', 'jobId')),
    },
    {
      name: 'Batch 2 · Read the job (and the transcript)',
      request: {
        method: 'GET',
        header: [],
        url: buildUrl(apiPath(BATCH_STT_ROUTES.jobById, { jobId: '{{jobId}}' })),
        description:
          'Poll the job. Once `status` is COMPLETED it also carries `resultText` — the transcript itself — with `resultMetadata` beside it; ' +
          '`errorCode` and `errorMessage` on a failure. This is a complete alternative to the stream below, and the way to fetch the result ' +
          'after any reconnect. ' +
          scopeLine('transcriptionJobGet'),
      },
    },
    {
      name: 'Batch 3 · Follow the job (SSE)',
      request: {
        method: 'GET',
        header: [{ key: 'Accept', value: 'text/event-stream' }],
        url: buildUrl(apiPath(BATCH_STT_ROUTES.jobStream, { jobId: '{{jobId}}' })),
        description:
          'Server-Sent Events. Postman shows the frames as they arrive; on a command line this is `curl -N` (without -N, curl buffers the whole ' +
          'stream and the job looks stalled). The first frame is always a `status` snapshot, then `progress`, `chunk` per finished segment, and ' +
          'one `transcript` with the full text; the stream closes on COMPLETED / FAILED / CANCELLED / DEAD. Each frame carries its `type` inside ' +
          'the JSON as well as on the `event:` line. There is no Last-Event-ID replay here — after a drop, re-open and read the snapshot, then use ' +
          'the request above. ' +
          scopeLine('transcriptionJobStream'),
      },
    },
    {
      name: `Realtime 1 · Open a stream session (${slug})`,
      request: {
        method: 'POST',
        header: JSON_HEADER,
        url: buildUrl(apiPath(STT_SOCKET_ROUTES.createSession)),
        body: jsonBody({ agentSlug: slug, sampleRate: 16000 }),
        description:
          'Opens a realtime session and mints the SINGLE-USE socket ticket. 201 answers `{ sessionId, status: "active", wsUrl: "' +
          STT_SOCKET_ROUTES.socketPath +
          '", ticket, ticketExpiresAt, sessionEpochMs, agentSlug, agentVersionId, maxConcurrent, currentActive }`. This request’s test script ' +
          'captures `sessionId` into the `sessionId` variable; copy `ticket` into the `ticket` variable yourself (a single-use secret is not ' +
          'captured automatically).\n\n' +
          'A Postman v2.1 collection CANNOT contain a WebSocket request, so the socket itself is not an item here. Open it by hand at ' +
          '`{{baseUrl}}' +
          STT_SOCKET_ROUTES.handshake +
          '` with http(s) swapped for ws(s) — Postman’s own New ▸ WebSocket Request does this, as does `websocat`. Then:\n' +
          '  1. wait for `{ "type": "ready" }` before sending anything;\n' +
          '  2. send raw PCM16 LE mono at the session sample rate as BINARY frames, 20–100 ms each (or JSON `{ "type": "audio", "data": "<base64>" }`);\n' +
          '  3. read `{ "type": "transcript", "text": "…", "isFinal": false|true, "seq": n }` — partials are replaced, finals are what you keep;\n' +
          '  4. send `{ "type": "stop" }` at the end of speech: the session answers `status: "finalizing"`, delivers the last finals, then `status: "closed"`.\n\n' +
          'The console’s Manual lane has the full frame table and a runnable fetch + WebSocket sample. ' +
          scopeLine('streamSessionCreate'),
      },
      event: testEvent(captureScript('sessionId', 'sessionId')),
    },
    {
      name: 'Realtime 2 · Refresh the stream ticket (for a reconnect)',
      request: {
        method: 'POST',
        header: [],
        url: buildUrl(apiPath(STT_SOCKET_ROUTES.refreshTicket, { sessionId: '{{sessionId}}' })),
        description:
          'The first ticket is consumed by the first socket open, so every reconnect needs a fresh one. No request body. Answers ' +
          '`{ ticket, ticketExpiresAt }`. Re-open the socket with it and send `{ "type": "resume", "sessionId": "{{sessionId}}", "lastSeq": <your last transcript seq> }` ' +
          'as the FIRST frame; the server answers `resumed` (results continue from `fromSeq`) or `resume_failed` — which is a real transcript gap, not a hiccup. ' +
          scopeLine('streamSessionRefreshTicket'),
      },
      event: testEvent(captureScript('ticket', 'ticket')),
    },
  ];
}

function buildAgentItems(input: PostmanCollectionInput): PostmanItem[] {
  const { slug, exampleBody } = input;
  const task: SdkSnippetAgentTask = input.task ?? 'TEXT_GENERATION';
  const isNer = task === 'TEXT_GENERATION' && input.isNamedEntityRecognition === true;
  const path = agentRoutePath(slug, task);
  const body = jsonBody(exampleBody ?? defaultAgentBody(task));

  if (task === 'SPEECH_TO_TEXT') {
    return buildSpeechToTextItems(slug);
  }

  if (task === 'TEXT_TO_SPEECH') {
    return [
      {
        name: `Synthesize speech with ${slug}`,
        request: {
          method: 'POST',
          header: JSON_HEADER,
          url: buildUrl(path),
          body,
          description:
            'Synthesize speech from `text` or `ssml` (send exactly one). The response is streamed audio ' +
            '(`audio/pcm`, `audio/wav`, or `audio/mpeg`), never JSON. ' +
            scopeLine('agentSpeech'),
        },
      },
    ];
  }

  // TEXT_GENERATION (and NAMED_ENTITY_RECOGNITION, which shares this exact route and body).
  const blockingDescription = isNer
    ? 'Invoke the published agent (one-shot). Returns 200 with the agent\'s output. Named entity recognition ' +
      'has no streaming mode — `?mode=stream` on this route answers 400 `MODE_UNSUPPORTED`, so no stream ' +
      'example is offered here. The body is FLAT — do not wrap it in an `input` envelope; that shape is for ' +
      'the workflow plane only. ' +
      BODY_SCHEMA_NOTE +
      ' ' +
      scopeLine('agentInvocations')
    : 'Invoke the published agent (blocking, the default mode). Returns 200 with the agent\'s output. The body ' +
      'is FLAT — do not wrap it in an `input` envelope; that shape is for the workflow plane only. ' +
      BODY_SCHEMA_NOTE +
      ' ' +
      scopeLine('agentInvocations');

  const items: PostmanItem[] = [
    {
      name: `Invoke ${slug}`,
      request: {
        method: 'POST',
        header: JSON_HEADER,
        url: buildUrl(path),
        body,
        description: blockingDescription,
      },
    },
  ];

  if (!isNer) {
    items.push({
      name: `Invoke ${slug} (stream)`,
      request: {
        method: 'POST',
        header: JSON_HEADER,
        url: buildUrl(path, [{ key: 'mode', value: 'stream' }]),
        body,
        description:
          'Same call with `?mode=stream`. The response is `text/event-stream` instead of a single JSON body: ' +
          '`event: meta` first (carrying the generation id), then `event: chunk` frames whose data is `{"content":"…"}`, ' +
          'and one terminal `event: done` (`{"finish_reason":"stop"}`) or `event: error`. A `:keepalive` comment arrives every 15s. ' +
          'This stream does NOT resume — the `id:` lines are the text service’s own cursor and there is no route to reconnect against; ' +
          're-send with the same Idempotency-Key to join the in-flight invocation instead. On a command line this needs `curl -N`. ' +
          scopeLine('agentInvocations'),
      },
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Workflow plane — the body is ENVELOPED as `{ input }`, one item per admitted mode
// ---------------------------------------------------------------------------

const KNOWN_RUN_MODES = ['async', 'blocking', 'stream'] as const;
type WorkflowRunMode = (typeof KNOWN_RUN_MODES)[number];

/** Canonical order, deduplicated, unknown values (e.g. a stray `socket`) dropped; defaults to `['async']`. */
function admittedModes(modes: string[] | undefined): WorkflowRunMode[] {
  const requested = new Set(modes && modes.length > 0 ? modes : ['async']);
  const known = KNOWN_RUN_MODES.filter((mode) => requested.has(mode));
  return known.length > 0 ? known : ['async'];
}

const RESERVED_KEY_NOTE =
  '`input` must not contain the reserved keys ' +
  RESERVED_RUN_INPUT_KEYS.map((key) => `\`${key}\``).join(', ') +
  ' — the gateway answers 400 if it does.';

const ENVELOPE_NOTE =
  'The body is ENVELOPED as `{ "input": { ... } }` — unlike the agent plane, whose body is flat.';

function runModeDescription(mode: WorkflowRunMode): string {
  if (mode === 'async') {
    return (
      'Start a run without waiting for it to finish (the default mode). Returns 202 with ' +
      '`{ runId, status, statusUrl, streamUrl }`. This request\'s test script captures `runId` into the ' +
      '`runId` collection variable, so the two requests below need no copy-paste. ' +
      `${ENVELOPE_NOTE} ${RESERVED_KEY_NOTE} ${scopeLine('workflowRunStart')}`
    );
  }
  if (mode === 'blocking') {
    return (
      'Start a run and wait for it to finish. Returns 200 with the terminal run status, or 504 if the run has ' +
      'not finished within the gateway\'s ~60s ceiling — the run keeps executing past that point, it is not ' +
      'cancelled; switch to polling `GET runs/{{runId}}` or to the stream request instead. ' +
      `Same ${ENVELOPE_NOTE.charAt(0).toLowerCase()}${ENVELOPE_NOTE.slice(1)} ${RESERVED_KEY_NOTE} ${scopeLine('workflowRunStart')}`
    );
  }
  return (
    'Start a run and stream its progress as `text/event-stream` (SSE) instead of a single JSON response. ' +
    `Same ${ENVELOPE_NOTE.charAt(0).toLowerCase()}${ENVELOPE_NOTE.slice(1)} ${RESERVED_KEY_NOTE} ${scopeLine('workflowRunStart')}`
  );
}

/**
 * Captures `runId` out of a run-start response into the `runId` collection variable, so the
 * status and stream-ticket follow-ups below need no manual copy-paste. Guards against a
 * non-JSON body (the `stream` mode's SSE response is never attached to this script in the first
 * place, but a caller who re-sends this exact request with `?mode=stream` should not see it
 * throw) and against anything other than the two response codes a run-start can legitimately
 * carry a `runId` on: 202 (`async`) and 200 (`blocking`, once the run has finished — a 504 at
 * the ceiling carries no `runId` and must not throw either).
 */
const RUN_ID_CAPTURE_SCRIPT: string[] = [
  '(function () {',
  '  if (pm.response.code !== 202 && pm.response.code !== 200) {',
  '    return;',
  '  }',
  '  var body;',
  '  try {',
  '    body = pm.response.json();',
  '  } catch (error) {',
  '    return;',
  '  }',
  '  if (body && typeof body.runId === "string") {',
  '    pm.collectionVariables.set("runId", body.runId);',
  '  }',
  '})();',
];

function buildWorkflowRunItems(input: PostmanCollectionInput): PostmanItem[] {
  const { slug, exampleBody, modes } = input;
  const path = ['api', 'v1', 'workflows', slug, 'runs'];
  const body = jsonBody({ input: exampleBody ?? {} });

  return admittedModes(modes).map((mode) => ({
    name: `Start a run of ${slug} (${mode})`,
    request: {
      method: 'POST',
      header: JSON_HEADER,
      url: buildUrl(path, [{ key: 'mode', value: mode }]),
      body,
      description: runModeDescription(mode),
    },
    // A `stream` response is SSE, not a single JSON document — nothing to capture a `runId` from.
    ...(mode === 'stream'
      ? {}
      : { event: [{ listen: 'test' as const, script: { type: 'text/javascript' as const, exec: RUN_ID_CAPTURE_SCRIPT } }] }),
  }));
}

function buildWorkflowFollowUpItems(slug: string): PostmanItem[] {
  const statusPath = ['api', 'v1', 'workflows', slug, 'runs', '{{runId}}'];
  const ticketPath = [...statusPath, 'stream-ticket'];
  return [
    {
      name: 'Get run status',
      request: {
        method: 'GET',
        header: [],
        url: buildUrl(statusPath),
        description:
          'Poll the status of a previously started run. Uses the `runId` collection variable — run one of the ' +
          '"Start a run" requests first (or set `runId` yourself). Returns the live run status (`RUNNING`, ' +
          '`COMPLETED`, `FAILED`, `CANCELED`, `TIMED_OUT`, …). ' +
          scopeLine('workflowRunGet'),
      },
    },
    {
      name: 'Mint a stream ticket',
      request: {
        method: 'POST',
        header: [],
        url: buildUrl(ticketPath),
        description:
          'Mint a single-use, ~30s ticket for opening this run\'s SSE stream from a context that cannot send an ' +
          '`Authorization` header (for example a browser `EventSource`). No request body. Returns 201 with ' +
          '`{ ticket, expiresAt, scope, url }`. ' +
          scopeLine('workflowRunStreamTicket'),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build a Postman Collection v2.1 document for one published agent or workflow.
 *
 * Agent: one item per task (`invocations` for TEXT_GENERATION/NAMED_ENTITY_RECOGNITION —
 * TEXT_GENERATION gets a second `?mode=stream` item, NER never does; `transcriptions` for
 * SPEECH_TO_TEXT; `speech` for TEXT_TO_SPEECH). Body is FLAT.
 *
 * Workflow: one "Start a run" item per admitted `?mode=` value, plus the `GET runs/{{runId}}`
 * and `POST runs/{{runId}}/stream-ticket` follow-ups. Body is ENVELOPED as `{ input }`. The
 * `async` and `blocking` run items carry a test script that captures `runId` into a collection
 * variable so the follow-ups resolve without manual copy-paste.
 */
export function buildPostmanCollection(input: PostmanCollectionInput): PostmanCollection {
  const { kind, slug, baseUrl } = input;
  const isWorkflow = kind === 'workflow';
  const items = isWorkflow ? [...buildWorkflowRunItems(input), ...buildWorkflowFollowUpItems(slug)] : buildAgentItems(input);

  const variables: PostmanCollection['variable'] = [
    { key: 'baseUrl', value: baseUrl, type: 'string' },
    // Never populated by the console — the importer supplies their own.
    { key: 'apiKey', value: '', type: 'string' },
  ];
  if (isWorkflow) {
    // Never populated by the console — captured at run time by the async/blocking test scripts.
    variables.push({ key: 'runId', value: '', type: 'string' });
  } else if (input.task === 'SPEECH_TO_TEXT') {
    // `jobId` and `sessionId` are captured by the test scripts above; `mediaId` and `ticket` are
    // the importer's to fill — one is an id only they have, the other a single-use secret.
    variables.push(
      { key: 'jobId', value: '', type: 'string' },
      { key: 'mediaId', value: '', type: 'string' },
      { key: 'sessionId', value: '', type: 'string' },
      { key: 'ticket', value: '', type: 'string' },
    );
  }

  const keyNote =
    `Set the \`apiKey\` variable to a key minted on the HOPE console's API keys screen (/api-keys). Mint it as a TENANT user: a key ` +
    'issued by a super admin with no working tenant is bound to a human with no membership here and answers 401 on every business route. ' +
    'Each request below names the scope it needs in its own description — a key missing one answers ' +
    '403 "API key does not have required scope(s): <scope>".';
  const description = isWorkflow
    ? `Calls the active published version of ${slug}. ${keyNote} The \`runId\` variable is captured automatically by the "Start a run" ` +
      "request's test script."
    : input.task === 'SPEECH_TO_TEXT'
      ? `Both jobs for ${slug}: BATCH (upload a file, or start from a mediaId, then read or follow the job) and REALTIME (open a session, ` +
        `then open the WebSocket by hand — a v2.1 collection cannot contain one; "Realtime 1" carries the handshake and the frames). ${keyNote}`
      : `Calls the active published version of ${slug}. ${keyNote}`;

  return {
    info: {
      name: `HOPE — ${slug}`,
      description,
      schema: POSTMAN_SCHEMA_URL,
    },
    variable: variables,
    auth: apiKeyAuth(),
    item: items,
  };
}
