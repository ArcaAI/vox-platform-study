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
    body?: { mode: 'raw'; raw: string; options?: { raw: { language: 'json' } } };
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

function buildAgentItems(input: PostmanCollectionInput): PostmanItem[] {
  const { slug, exampleBody } = input;
  const task: SdkSnippetAgentTask = input.task ?? 'TEXT_GENERATION';
  const isNer = task === 'TEXT_GENERATION' && input.isNamedEntityRecognition === true;
  const path = agentRoutePath(slug, task);
  const body = jsonBody(exampleBody ?? defaultAgentBody(task));

  if (task === 'SPEECH_TO_TEXT') {
    return [
      {
        name: `Transcribe with ${slug}`,
        request: {
          method: 'POST',
          header: JSON_HEADER,
          url: buildUrl(path),
          body,
          description:
            'Submit a batch transcription job for a previously uploaded media object. `mediaId` is required; ' +
            '`consultationId` and `language` are optional. Returns 201 with `{ id, status, agentSlug, ' +
            'agentVersionId, sseUrl }` — poll the job or open `sseUrl` for progress.',
        },
      },
    ];
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
            '(`audio/pcm`, `audio/wav`, or `audio/mpeg`), never JSON.',
        },
      },
    ];
  }

  // TEXT_GENERATION (and NAMED_ENTITY_RECOGNITION, which shares this exact route and body).
  const blockingDescription = isNer
    ? 'Invoke the published agent (one-shot). Returns 200 with the agent\'s output. Named entity recognition ' +
      'has no streaming mode — `?mode=stream` on this route answers 400 `MODE_UNSUPPORTED`, so no stream ' +
      'example is offered here. The body is FLAT — do not wrap it in an `input` envelope; that shape is for ' +
      'the workflow plane only.'
    : 'Invoke the published agent (blocking, the default mode). Returns 200 with the agent\'s output. The body ' +
      'is FLAT — do not wrap it in an `input` envelope; that shape is for the workflow plane only.';

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
        description: 'Same call with `?mode=stream`. The response is `text/event-stream` instead of a single JSON body.',
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
      `${ENVELOPE_NOTE} ${RESERVED_KEY_NOTE}`
    );
  }
  if (mode === 'blocking') {
    return (
      'Start a run and wait for it to finish. Returns 200 with the terminal run status, or 504 if the run has ' +
      'not finished within the gateway\'s ~60s ceiling — the run keeps executing past that point, it is not ' +
      'cancelled; switch to polling `GET runs/{{runId}}` or to the stream request instead. ' +
      `Same ${ENVELOPE_NOTE.charAt(0).toLowerCase()}${ENVELOPE_NOTE.slice(1)} ${RESERVED_KEY_NOTE}`
    );
  }
  return (
    'Start a run and stream its progress as `text/event-stream` (SSE) instead of a single JSON response. ' +
    `Same ${ENVELOPE_NOTE.charAt(0).toLowerCase()}${ENVELOPE_NOTE.slice(1)} ${RESERVED_KEY_NOTE}`
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
          '`COMPLETED`, `FAILED`, `CANCELED`, `TIMED_OUT`, …).',
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
          '`{ ticket, expiresAt, scope, url }`.',
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
  }

  const description = isWorkflow
    ? `Calls the active published version of ${slug}. Set the \`apiKey\` variable to a key minted on the HOPE ` +
      'console\'s API keys screen. The `runId` variable is captured automatically by the "Start a run" ' +
      'request\'s test script.'
    : `Calls the active published version of ${slug}. Set the \`apiKey\` variable to a key minted on the HOPE console's API keys screen.`;

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
