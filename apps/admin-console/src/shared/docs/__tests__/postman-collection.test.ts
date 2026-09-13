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
      const parsed = JSON.parse(item.request.body!.raw);
      expect(parsed).toEqual({ text: 'hello', variables: { a: 1 } });
      expect(parsed.input).toBeUndefined();
    }
  });

  it('a null exampleBody falls back to a usable placeholder body, per task', () => {
    const textGen = buildPostmanCollection(agentInput({ exampleBody: null }));
    expect(JSON.parse(textGen.item[0].request.body!.raw)).toHaveProperty('text');

    const stt = buildPostmanCollection(agentInput({ task: 'SPEECH_TO_TEXT', exampleBody: null }));
    expect(JSON.parse(stt.item[0].request.body!.raw)).toHaveProperty('mediaId');

    const tts = buildPostmanCollection(agentInput({ task: 'TEXT_TO_SPEECH', exampleBody: null }));
    expect(JSON.parse(tts.item[0].request.body!.raw)).toHaveProperty('text');
  });

  it('NAMED_ENTITY_RECOGNITION emits exactly one blocking invocation and no stream example', () => {
    const collection = buildPostmanCollection(agentInput({ task: 'TEXT_GENERATION', isNamedEntityRecognition: true }));
    const items = allItems(collection);
    expect(items).toHaveLength(1);
    expect(items[0].request.url.raw).not.toContain('mode=stream');
    expect(items[0].request.url.query ?? []).toEqual([]);
    expect(items[0].request.description).toMatch(/one-shot|no stream|MODE_UNSUPPORTED/i);
  });

  it('SPEECH_TO_TEXT routes to the transcriptions endpoint with a 201 + sseUrl description', () => {
    const collection = buildPostmanCollection(agentInput({ task: 'SPEECH_TO_TEXT', exampleBody: { mediaId: 'media-123' } }));
    const items = allItems(collection);
    expect(items).toHaveLength(1);
    expect(items[0].request.url.path).toEqual(['api', 'v1', 'agents', 'clinic-summarizer', 'transcriptions']);
    expect(JSON.parse(items[0].request.body!.raw)).toEqual({ mediaId: 'media-123' });
    expect(items[0].request.description).toMatch(/201/);
    expect(items[0].request.description).toMatch(/sseUrl/);
  });

  it('TEXT_TO_SPEECH routes to the speech endpoint and documents the non-JSON audio response', () => {
    const collection = buildPostmanCollection(agentInput({ task: 'TEXT_TO_SPEECH', exampleBody: { text: 'Hello there.' } }));
    const items = allItems(collection);
    expect(items).toHaveLength(1);
    expect(items[0].request.url.path).toEqual(['api', 'v1', 'agents', 'clinic-summarizer', 'speech']);
    expect(JSON.parse(items[0].request.body!.raw)).toEqual({ text: 'Hello there.' });
    expect(items[0].request.description).toMatch(/audio/i);
    expect(items[0].request.description).not.toMatch(/\bJSON body\b.*returns/i);
  });
});

describe('buildPostmanCollection — workflow plane (enveloped body)', () => {
  it('the run request body is ENVELOPED as { input: ... }, never flat', () => {
    const collection = buildPostmanCollection(workflowInput({ modes: ['async'], exampleBody: { patientName: 'Jane' } }));
    const runItem = collection.item.find((i) => i.request.method === 'POST' && i.request.url.path.includes('runs') && !i.request.url.path.includes('stream-ticket'));
    expect(runItem).toBeDefined();
    expect(JSON.parse(runItem!.request.body!.raw)).toEqual({ input: { patientName: 'Jane' } });
  });

  it('a null exampleBody envelopes an empty object, never a bare {}', () => {
    const collection = buildPostmanCollection(workflowInput({ modes: ['async'], exampleBody: null }));
    const runItem = collection.item.find((i) => i.request.url.path.includes('runs') && !i.request.url.path.includes('stream-ticket'));
    expect(JSON.parse(runItem!.request.body!.raw)).toEqual({ input: {} });
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
