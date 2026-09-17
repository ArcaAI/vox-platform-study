/**
 * TASK-971 lane D — `buildPostmanCollection` is the ONLY Postman artifact in the repo, generated
 * fresh per lineage from its own resolved contract. These tests pin the four things that matter
 * for a file a developer imports straight into Postman:
 *
 *  - it validates against the real Collection v2.1 shape (schema envelope, request shape);
 *  - the agent plane's body is FLAT and the workflow plane's is ENVELOPED — getting this backwards
 *    is a 400 on every call (TASK-971 F-C1);
 *  - NAMED_ENTITY_RECOGNITION never gets a `?mode=stream` example (F-C2: that mode is a 400
 *    `MODE_UNSUPPORTED` on that route);
 *  - no credential is ever embedded — `apiKey` ships empty, for the importer's own environment.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  apiKeyAuth,
  buildPostmanCollection,
  POSTMAN_SCHEMA_URL,
  type PostmanCollection,
  type PostmanCollectionInput,
  type PostmanItem,
} from '../postman-collection';

const BASE_URL = 'https://api.example.com';

function agentInput(overrides: Partial<PostmanCollectionInput> = {}): PostmanCollectionInput {
  return {
    kind: 'agent',
    slug: 'clinic-summarizer',
    task: 'TEXT_GENERATION',
    exampleBody: { text: 'Patient reports mild headache.' },
    baseUrl: BASE_URL,
    ...overrides,
  };
}

function workflowInput(overrides: Partial<PostmanCollectionInput> = {}): PostmanCollectionInput {
  return {
    kind: 'workflow',
    slug: 'discharge-summary',
    modes: ['async', 'blocking', 'stream'],
    exampleBody: { patientName: 'Jane Doe' },
    baseUrl: BASE_URL,
    ...overrides,
  };
}

/** Every request item in the collection, regardless of nesting (none is expected, but future-proof). */
function allItems(collection: PostmanCollection): PostmanItem[] {
  return collection.item;
}

/** The raw JSON body of an item — fails loudly on a multipart item rather than returning undefined. */
function rawBodyOf(item: PostmanItem): string {
  const body = item.request.body;
  expect(body, `"${item.name}" has no body`).toBeDefined();
  expect(body!.mode, `"${item.name}" is not a raw-JSON request`).toBe('raw');
  return (body as { mode: 'raw'; raw: string }).raw;
}

/** The multipart parts of an item — the mirror image of `rawBodyOf`. */
function formDataOf(item: PostmanItem): Array<{ key: string; type: string; src?: string; value?: string }> {
  const body = item.request.body;
  expect(body, `"${item.name}" has no body`).toBeDefined();
  expect(body!.mode, `"${item.name}" is not a multipart request`).toBe('formdata');
  return (body as { mode: 'formdata'; formdata: Array<{ key: string; type: string; src?: string; value?: string }> }).formdata;
}

/** Executes a captured Postman test script against a minimal fake `pm`, returning what it set. */
function runCaptureScript(item: PostmanItem, responseCode: number, responseBody: unknown, isJson = true): Record<string, string> {
  const script = item.event?.find((event) => event.listen === 'test');
  expect(script, `expected a test-script event on "${item.name}"`).toBeDefined();
  const source = script!.script.exec.join('\n');
  const captured: Record<string, string> = {};
  const pm = {
    response: {
      code: responseCode,
      json: () => {
        if (!isJson) throw new SyntaxError('Unexpected token in JSON');
        return responseBody;
      },
    },
    collectionVariables: {
      set: (key: string, value: string) => {
        captured[key] = value;
      },
    },
  };
  new Function('pm', source)(pm);
  return captured;
}

describe('buildPostmanCollection — schema envelope (Collection v2.1)', () => {
  it('carries the real Postman v2.1 schema URL', () => {
    const collection = buildPostmanCollection(agentInput());
    expect(collection.info.schema).toBe(POSTMAN_SCHEMA_URL);
    expect(collection.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
  });

  it('names the collection after the slug and carries a non-empty description', () => {
    const collection = buildPostmanCollection(agentInput());
    expect(collection.info.name).toContain('clinic-summarizer');
    expect(typeof collection.info.description).toBe('string');
    expect(collection.info.description!.length).toBeGreaterThan(0);
  });

  it('declares baseUrl and apiKey collection variables', () => {
    const collection = buildPostmanCollection(agentInput());
    const byKey = Object.fromEntries(collection.variable.map((v) => [v.key, v]));
    expect(byKey.baseUrl?.value).toBe(BASE_URL);
    expect(byKey.apiKey).toBeDefined();
  });

  it('every item is a well-formed v2.1 request node', () => {
    const collection = buildPostmanCollection(workflowInput());
    for (const item of allItems(collection)) {
      expect(typeof item.name).toBe('string');
      expect(item.name.length).toBeGreaterThan(0);
      expect(['GET', 'POST']).toContain(item.request.method);
      expect(Array.isArray(item.request.header)).toBe(true);
      expect(item.request.url.raw.startsWith('{{baseUrl}}/api/v1/')).toBe(true);
      expect(item.request.url.host).toEqual(['{{baseUrl}}']);
      expect(Array.isArray(item.request.url.path)).toBe(true);
      // Every raw URL must be reconstructible from host + path (+ query) — never diverge.
      const rebuilt = `{{baseUrl}}/${item.request.url.path.join('/')}`;
      expect(item.request.url.raw.startsWith(rebuilt)).toBe(true);
      expect(typeof item.request.description).toBe('string');
      expect(item.request.description!.length).toBeGreaterThan(0);
    }
  });

  it('uses collection-level X-API-Key auth referencing the {{apiKey}} variable, never a literal', () => {
    const auth = apiKeyAuth();
    expect(auth.type).toBe('apikey');
    const apikey = auth.apikey as Array<{ key: string; value: string; in: string }>;
    const byKey = Object.fromEntries(apikey.map((e) => [e.key, e.value]));
    expect(byKey.key).toBe('X-API-Key');
    expect(byKey.value).toBe('{{apiKey}}');
    expect(byKey.in).toBe('header');
    expect(buildPostmanCollection(agentInput()).auth).toEqual(auth);
  });
});

describe('buildPostmanCollection — no credential is ever embedded', () => {
  it.each([
    ['agent / TEXT_GENERATION', agentInput()],
    ['agent / NER', agentInput({ task: 'TEXT_GENERATION', isNamedEntityRecognition: true })],
    ['agent / SPEECH_TO_TEXT', agentInput({ task: 'SPEECH_TO_TEXT', exampleBody: { mediaId: 'm-1' } })],
    ['agent / TEXT_TO_SPEECH', agentInput({ task: 'TEXT_TO_SPEECH' })],
    ['workflow', workflowInput()],
  ])('%s: apiKey variable ships empty', (_label, input) => {
    const collection = buildPostmanCollection(input);
    const apiKeyVar = collection.variable.find((v) => v.key === 'apiKey');
    expect(apiKeyVar?.value).toBe('');
  });

  it('no serialized artifact ever contains a non-empty apiKey value or a bearer-looking literal', () => {
    const serialized = JSON.stringify(buildPostmanCollection(workflowInput()));
    expect(serialized).not.toMatch(/"apiKey"\s*:\s*"(?!")/); // no apiKey key with a non-empty string value in raw JSON shape
    expect(serialized).not.toMatch(/Bearer [A-Za-z0-9._-]{10,}/);
  });
});

describe('buildPostmanCollection — agent plane (flat body)', () => {
  it('TEXT_GENERATION emits a blocking invocation and a separate ?mode=stream invocation', () => {
    const collection = buildPostmanCollection(agentInput());
    const items = allItems(collection);
    expect(items).toHaveLength(2);

    const blocking = items.find((i) => !i.request.url.raw.includes('mode=stream'));
    const streaming = items.find((i) => i.request.url.raw.includes('mode=stream'));
    expect(blocking).toBeDefined();
    expect(streaming).toBeDefined();

    expect(blocking!.request.method).toBe('POST');
    expect(blocking!.request.url.path).toEqual(['api', 'v1', 'agents', 'clinic-summarizer', 'invocations']);
    expect(streaming!.request.url.path).toEqual(['api', 'v1', 'agents', 'clinic-summarizer', 'invocations']);
    expect(streaming!.request.url.query).toEqual([{ key: 'mode', value: 'stream' }]);
  });

  it('TEXT_GENERATION body is FLAT — never wrapped in an `input` envelope', () => {
    const collection = buildPostmanCollection(agentInput({ exampleBody: { text: 'hello', variables: { a: 1 } } }));
    for (const item of allItems(collection)) {
      const parsed = JSON.parse(rawBodyOf(item));
      expect(parsed).toEqual({ text: 'hello', variables: { a: 1 } });
      expect(parsed.input).toBeUndefined();
    }
  });

  it('a null exampleBody falls back to a usable placeholder body, per task', () => {
    const textGen = buildPostmanCollection(agentInput({ exampleBody: null }));
    expect(JSON.parse(rawBodyOf(textGen.item[0]))).toHaveProperty('text');

    // SPEECH_TO_TEXT has no schema-derived body at all: the batch upload is multipart and the
    // other requests carry fixed gateway shapes, so it is exempt from this fallback.

    const tts = buildPostmanCollection(agentInput({ task: 'TEXT_TO_SPEECH', exampleBody: null }));
    expect(JSON.parse(rawBodyOf(tts.item[0]))).toHaveProperty('text');
  });

  it('NAMED_ENTITY_RECOGNITION emits exactly one blocking invocation and no stream example', () => {
    const collection = buildPostmanCollection(agentInput({ task: 'TEXT_GENERATION', isNamedEntityRecognition: true }));
    const items = allItems(collection);
    expect(items).toHaveLength(1);
    expect(items[0].request.url.raw).not.toContain('mode=stream');
    expect(items[0].request.url.query ?? []).toEqual([]);
    expect(items[0].request.description).toMatch(/one-shot|no stream|MODE_UNSUPPORTED/i);
  });

  /**
   * TASK-983 lane I — SPEECH_TO_TEXT is TWO jobs, not one request.
   *
   * It used to emit a single `POST agents/{slug}/transcriptions` with a `{ mediaId }` body: a
   * route that cannot take a file, an id nothing in the collection could produce, and no way to
   * read the job the 201 announced. Realtime was absent entirely.
   */
  describe('SPEECH_TO_TEXT — batch and realtime', () => {
    const collection = buildPostmanCollection(agentInput({ task: 'SPEECH_TO_TEXT', exampleBody: null }));
    const items = allItems(collection);
    const byName = (fragment: string) => items.find((item) => item.name.includes(fragment));

    it('covers the whole batch job and the realtime handshake', () => {
      expect(items.map((item) => item.request.url.path.join('/'))).toEqual([
        'api/v1/audio/transcription-jobs/transcribe',
        'api/v1/agents/clinic-summarizer/transcriptions',
        'api/v1/audio/transcription-jobs/{{jobId}}',
        'api/v1/audio/transcription-jobs/{{jobId}}/stream',
        'api/v1/audio/transcription-jobs/stream/session',
        'api/v1/audio/transcription-jobs/stream/session/{{sessionId}}/refresh-ticket',
      ]);
    });

    it('the upload is REAL multipart — a `file` part and an `agentSlug` field', () => {
      const upload = byName('Upload audio');
      expect(upload).toBeDefined();
      const parts = formDataOf(upload!);
      const file = parts.find((part) => part.key === 'file');
      expect(file?.type).toBe('file');
      expect(file?.src).toBeTruthy();
      expect(parts.find((part) => part.key === 'agentSlug')?.value).toBe('clinic-summarizer');
      // Postman writes the multipart boundary; a hand-set Content-Type breaks the request.
      expect(upload!.request.header.some((header) => header.key.toLowerCase() === 'content-type')).toBe(false);
    });

    it('the mediaId form stays, on the agent route, with a JSON body', () => {
      const fromMedia = byName('from a mediaId');
      expect(fromMedia).toBeDefined();
      expect(JSON.parse(rawBodyOf(fromMedia!))).toEqual({ mediaId: '{{mediaId}}' });
      expect(fromMedia!.request.description).toMatch(/404|mediaId is required/);
    });

    it('both start requests capture the job id, so the follow-ups resolve without copy-paste', () => {
      for (const name of ['Upload audio', 'from a mediaId']) {
        const captured = runCaptureScript(byName(name)!, 201, { id: 'job-9' });
        expect(captured.jobId, name).toBe('job-9');
      }
    });

    it('the session request captures sessionId and describes the socket a collection cannot contain', () => {
      const session = byName('Open a stream session');
      expect(session).toBeDefined();
      expect(JSON.parse(rawBodyOf(session!))).toEqual({ agentSlug: 'clinic-summarizer', sampleRate: 16000 });
      expect(runCaptureScript(session!, 201, { sessionId: 'sess-1' }).sessionId).toBe('sess-1');
      const description = session!.request.description!;
      expect(description).toMatch(/cannot contain a WebSocket/i);
      expect(description).toContain('/ws/stt/stream?sessionId={sessionId}&ticket={ticket}');
      for (const frame of ['ready', 'transcript', 'stop', 'finalizing', 'closed']) {
        expect(description, frame).toContain(frame);
      }
    });

    it('declares the variables its requests reference, all empty', () => {
      const byKey = Object.fromEntries(collection.variable.map((entry) => [entry.key, entry.value]));
      for (const key of ['baseUrl', 'apiKey', 'jobId', 'mediaId', 'sessionId', 'ticket']) {
        expect(byKey, key).toHaveProperty(key);
      }
      for (const key of ['apiKey', 'jobId', 'mediaId', 'sessionId', 'ticket']) {
        expect(byKey[key], key).toBe('');
      }
    });
  });

  it('TEXT_TO_SPEECH routes to the speech endpoint and documents the non-JSON audio response', () => {
    const collection = buildPostmanCollection(agentInput({ task: 'TEXT_TO_SPEECH', exampleBody: { text: 'Hello there.' } }));
    const items = allItems(collection);
    expect(items).toHaveLength(1);
    expect(items[0].request.url.path).toEqual(['api', 'v1', 'agents', 'clinic-summarizer', 'speech']);
    expect(JSON.parse(rawBodyOf(items[0]))).toEqual({ text: 'Hello there.' });
    expect(items[0].request.description).toMatch(/audio/i);
    expect(items[0].request.description).not.toMatch(/\bJSON body\b.*returns/i);
  });
});

describe('buildPostmanCollection — workflow plane (enveloped body)', () => {
  it('the run request body is ENVELOPED as { input: ... }, never flat', () => {
    const collection = buildPostmanCollection(workflowInput({ modes: ['async'], exampleBody: { patientName: 'Jane' } }));
    const runItem = collection.item.find((i) => i.request.method === 'POST' && i.request.url.path.includes('runs') && !i.request.url.path.includes('stream-ticket'));
    expect(runItem).toBeDefined();
    expect(JSON.parse(rawBodyOf(runItem!))).toEqual({ input: { patientName: 'Jane' } });
  });

  it('a null exampleBody envelopes an empty object, never a bare {}', () => {
    const collection = buildPostmanCollection(workflowInput({ modes: ['async'], exampleBody: null }));
    const runItem = collection.item.find((i) => i.request.url.path.includes('runs') && !i.request.url.path.includes('stream-ticket'));
    expect(JSON.parse(rawBodyOf(runItem!))).toEqual({ input: {} });
  });

  it.each([
    [['async'], 1],
    [['async', 'blocking'], 2],
    [['async', 'blocking', 'stream'], 3],
    [['blocking'], 1],
  ])('modes %j produce %i run-start item(s), one per admitted mode', (modes, expectedCount) => {
    const collection = buildPostmanCollection(workflowInput({ modes: modes as string[] }));
    const runItems = collection.item.filter((i) => i.request.method === 'POST' && i.request.url.path.at(-1) === 'runs');
    expect(runItems).toHaveLength(expectedCount);
    for (const mode of modes) {
      expect(runItems.some((i) => i.request.url.query?.some((q) => q.key === 'mode' && q.value === mode))).toBe(true);
    }
  });

  it('an unknown mode (e.g. a stray "socket") is dropped, and an empty/undefined modes list defaults to async', () => {
    const withSocket = buildPostmanCollection(workflowInput({ modes: ['async', 'socket'] }));
    const runItems = withSocket.item.filter((i) => i.request.method === 'POST' && i.request.url.path.at(-1) === 'runs');
    expect(runItems).toHaveLength(1);
    expect(runItems[0].request.url.query).toEqual([{ key: 'mode', value: 'async' }]);

    const noModes = buildPostmanCollection(workflowInput({ modes: undefined }));
    const noModesRunItems = noModes.item.filter((i) => i.request.method === 'POST' && i.request.url.path.at(-1) === 'runs');
    expect(noModesRunItems).toHaveLength(1);
    expect(noModesRunItems[0].request.url.query).toEqual([{ key: 'mode', value: 'async' }]);
  });

  it('run-start items are always followed by GET run status and POST stream-ticket', () => {
    const collection = buildPostmanCollection(workflowInput());
    const statusItem = collection.item.find((i) => i.request.method === 'GET');
    const ticketItem = collection.item.find((i) => i.request.url.path.at(-1) === 'stream-ticket');
    expect(statusItem).toBeDefined();
    expect(statusItem!.request.url.path).toEqual(['api', 'v1', 'workflows', 'discharge-summary', 'runs', '{{runId}}']);
    expect(ticketItem).toBeDefined();
    expect(ticketItem!.request.method).toBe('POST');
    expect(ticketItem!.request.url.path).toEqual(['api', 'v1', 'workflows', 'discharge-summary', 'runs', '{{runId}}', 'stream-ticket']);
    expect(ticketItem!.request.body).toBeUndefined();
  });

  it('declares a runId collection variable (empty) so the follow-up requests resolve', () => {
    const collection = buildPostmanCollection(workflowInput());
    const runIdVar = collection.variable.find((v) => v.key === 'runId');
    expect(runIdVar).toBeDefined();
    expect(runIdVar!.value).toBe('');
  });

  it('the async and blocking run-start items each carry a runId-capturing test script', () => {
    const collection = buildPostmanCollection(workflowInput({ modes: ['async', 'blocking', 'stream'] }));
    const runItems = collection.item.filter((i) => i.request.method === 'POST' && i.request.url.path.at(-1) === 'runs');
    const asyncItem = runItems.find((i) => i.request.url.query?.some((q) => q.value === 'async'))!;
    const blockingItem = runItems.find((i) => i.request.url.query?.some((q) => q.value === 'blocking'))!;
    const streamItem = runItems.find((i) => i.request.url.query?.some((q) => q.value === 'stream'))!;

    expect(asyncItem.event?.some((e) => e.listen === 'test')).toBe(true);
    expect(blockingItem.event?.some((e) => e.listen === 'test')).toBe(true);
    // The stream item's response isn't a single JSON document — no capture script belongs there.
    expect(streamItem.event ?? []).toEqual([]);
  });

  it('the capture script sets runId from a 202 JSON body', () => {
    const collection = buildPostmanCollection(workflowInput({ modes: ['async'] }));
    const asyncItem = collection.item.find((i) => i.request.url.query?.some((q) => q.value === 'async'))!;
    const captured = runCaptureScript(asyncItem, 202, { runId: 'run-abc-123', status: 'started' });
    expect(captured.runId).toBe('run-abc-123');
  });

  it('the capture script sets runId from a 200 terminal (blocking) JSON body too', () => {
    const collection = buildPostmanCollection(workflowInput({ modes: ['blocking'] }));
    const blockingItem = collection.item.find((i) => i.request.url.query?.some((q) => q.value === 'blocking'))!;
    const captured = runCaptureScript(blockingItem, 200, { runId: 'run-xyz-789', status: 'COMPLETED' });
    expect(captured.runId).toBe('run-xyz-789');
  });

  it('the capture script guards against a non-JSON response instead of throwing', () => {
    const collection = buildPostmanCollection(workflowInput({ modes: ['async'] }));
    const asyncItem = collection.item.find((i) => i.request.url.query?.some((q) => q.value === 'async'))!;
    expect(() => runCaptureScript(asyncItem, 202, undefined, false)).not.toThrow();
    expect(runCaptureScript(asyncItem, 202, undefined, false)).toEqual({});
  });

  it('the capture script guards against a non-202/200 response (e.g. the 504 ceiling) instead of throwing', () => {
    const collection = buildPostmanCollection(workflowInput({ modes: ['blocking'] }));
    const blockingItem = collection.item.find((i) => i.request.url.query?.some((q) => q.value === 'blocking'))!;
    expect(() => runCaptureScript(blockingItem, 504, { message: 'timed out' })).not.toThrow();
    expect(runCaptureScript(blockingItem, 504, { message: 'timed out' })).toEqual({});
  });

  it('descriptions state the reserved-key rule and the blocking-mode 504 ceiling', () => {
    const collection = buildPostmanCollection(workflowInput({ modes: ['async', 'blocking'] }));
    const runItems = collection.item.filter((i) => i.request.method === 'POST' && i.request.url.path.at(-1) === 'runs');
    for (const item of runItems) {
      expect(item.request.description).toMatch(/consultationId/);
    }
    const blockingItem = runItems.find((i) => i.request.url.query?.some((q) => q.value === 'blocking'))!;
    expect(blockingItem.request.description).toMatch(/504/);
    expect(blockingItem.request.description).toMatch(/60s|60 s|60-second|60 second/i);
  });
});

describe('buildPostmanCollection — determinism', () => {
  it('the same input produces byte-identical JSON, twice', () => {
    const input = workflowInput();
    const first = JSON.stringify(buildPostmanCollection(input));
    const second = JSON.stringify(buildPostmanCollection(input));
    expect(first).toBe(second);
  });

  it('two structurally-equal but distinct input objects produce byte-identical JSON', () => {
    const a = JSON.stringify(buildPostmanCollection(agentInput({ task: 'SPEECH_TO_TEXT', exampleBody: { mediaId: 'm-1' } })));
    const b = JSON.stringify(buildPostmanCollection(agentInput({ task: 'SPEECH_TO_TEXT', exampleBody: { mediaId: 'm-1' } })));
    expect(a).toBe(b);
  });

  it('is stable across every task and mode combination exercised above', () => {
    const inputs: PostmanCollectionInput[] = [
      agentInput(),
      agentInput({ task: 'TEXT_GENERATION', isNamedEntityRecognition: true }),
      agentInput({ task: 'SPEECH_TO_TEXT', exampleBody: { mediaId: 'm-1' } }),
      agentInput({ task: 'TEXT_TO_SPEECH' }),
      workflowInput({ modes: ['async'] }),
      workflowInput({ modes: ['async', 'blocking', 'stream'] }),
    ];
    for (const input of inputs) {
      expect(JSON.stringify(buildPostmanCollection(input))).toBe(JSON.stringify(buildPostmanCollection(input)));
    }
  });
});

/**
 * TASK-983 lane I — the collection is a file a developer imports and RUNS. Two things have to be
 * true of it that no amount of prose can establish: every path it contains is a route the gateway
 * actually serves, and every `{{variable}}` it references is declared so the import resolves.
 *
 * The manifest is read READ-ONLY from the sibling app — the same authorization oracle the e2e
 * authz matrix uses (`05-nestjs-api.md` §API Test Standard).
 */
describe('buildPostmanCollection — every request is a route this gateway serves', () => {
  const manifest: { routes: Array<{ method: string; path: string }> } = JSON.parse(
    readFileSync(join(__dirname, '../../../../../api/route-manifest.json'), 'utf8'),
  ) as { routes: Array<{ method: string; path: string }> };

  /** `api/v1/audio/transcription-jobs/{{jobId}}` → `/api/v1/audio/transcription-jobs/{id}`. */
  function manifestPathsFor(item: PostmanItem): string {
    return `/${item.request.url.path.join('/')}`;
  }

  /** Postman's `{{var}}` and the manifest's `{param}` are different spellings of the same hole. */
  function matchesManifest(candidate: string, manifestPath: string): boolean {
    const candidateSegments = candidate.split('/');
    const manifestSegments = manifestPath.split('/');
    if (candidateSegments.length !== manifestSegments.length) return false;
    return candidateSegments.every((segment, index) => {
      const expected = manifestSegments[index];
      if (expected.startsWith('{') && expected.endsWith('}')) return true;
      return segment === expected;
    });
  }

  const COLLECTIONS: ReadonlyArray<[string, PostmanCollectionInput]> = [
    ['agent / TEXT_GENERATION', agentInput()],
    ['agent / NER', agentInput({ isNamedEntityRecognition: true })],
    ['agent / SPEECH_TO_TEXT', agentInput({ task: 'SPEECH_TO_TEXT', exampleBody: null })],
    ['agent / TEXT_TO_SPEECH', agentInput({ task: 'TEXT_TO_SPEECH' })],
    ['workflow', workflowInput()],
  ];

  it('the manifest was readable (otherwise every case below is vacuous)', () => {
    expect(manifest.routes.length).toBeGreaterThan(100);
  });

  it.each(COLLECTIONS)('%s: every item resolves to a real route', (_label, input) => {
    const collection = buildPostmanCollection(input);
    expect(collection.item.length).toBeGreaterThan(0);
    for (const item of collection.item) {
      const candidate = manifestPathsFor(item);
      const hit = manifest.routes.some((route) => route.method === item.request.method && matchesManifest(candidate, route.path));
      expect(hit, `${item.request.method} ${candidate} ("${item.name}") is not a route this gateway serves`).toBe(true);
    }
  });

  it.each(COLLECTIONS)('%s: every {{variable}} it references is declared', (_label, input) => {
    const collection = buildPostmanCollection(input);
    const declared = new Set(collection.variable.map((entry) => entry.key));
    const referenced = new Set(
      [...JSON.stringify(collection.item).matchAll(/\{\{([A-Za-z_$][\w$]*)\}\}/g)].map((match) => match[1]),
    );
    // `baseUrl` is declared too, and appears in every raw URL.
    for (const name of referenced) {
      expect(declared, `{{${name}}} is referenced but never declared`).toContain(name);
    }
    expect(referenced.size).toBeGreaterThan(0);
  });

  it.each(COLLECTIONS)('%s: the whole document round-trips through JSON', (_label, input) => {
    const json = JSON.stringify(buildPostmanCollection(input), null, 2);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json)).toEqual(buildPostmanCollection(input));
  });

  it.each(COLLECTIONS)('%s: every request names the scope it needs', (_label, input) => {
    for (const item of buildPostmanCollection(input).item) {
      expect(item.request.description, `"${item.name}" names no scope`).toMatch(/Scope: `[a-z]+:[a-z-]+:[a-z]+`/);
    }
  });
});
