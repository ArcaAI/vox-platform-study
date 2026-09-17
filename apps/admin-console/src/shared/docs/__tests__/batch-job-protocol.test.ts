/**
 * TASK-983 lane I — the BATCH transcription contract, pinned.
 *
 * The batch lane used to print one line (`hope.agents.transcribe(slug, { file })`) and one curl
 * body (`{ "mediaId": "…" }`) and stop there. Both were dead ends:
 *
 *  - `POST /agents/{slug}/transcriptions` carries NO multipart interceptor
 *    (`apps/api/src/modules/agent/agent.controller.ts:751-830`) and answers
 *    `400 \`mediaId\` is required.` for a file upload — which is what the SDK's `{ file }` branch
 *    used to send it (lane J repoints that branch at the multipart route, where it belongs);
 *  - no lane said where a `mediaId` comes from, or how the job that the 201 announces is then
 *    READ — the `sseUrl` it hands back is on a different scope family.
 *
 * Every literal example below is parsed here, so a frame example that stops being valid JSON, or
 * a route that stops existing, fails rather than misleading a developer.
 */
import { describe, expect, it } from 'vitest';
import { AgentsResource } from '@arcaai/vox-node';
import {
  BATCH_JOB_SSE_FRAMES,
  BATCH_JOB_TERMINAL_STATUSES,
  BATCH_STT_ROUTES,
  BATCH_STT_STEPS,
  MEDIA_ID_NOTE,
  sttBatchCurlSnippet,
  sttBatchFetchSnippet,
  sttBatchVoxNodeSnippet,
} from '../batch-job-protocol';

const BASE_URL = 'https://api.example.com';

describe('the batch routes are the ones the gateway serves', () => {
  it('names the multipart upload route, not the agent route, as the way audio gets in', () => {
    expect(BATCH_STT_ROUTES.uploadAndStart).toBe('/audio/transcription-jobs/transcribe');
  });

  it('keeps the agent route for media that already exists', () => {
    expect(BATCH_STT_ROUTES.startFromMediaId).toBe('/agents/{slug}/transcriptions');
  });

  it('names the job read and the progress stream', () => {
    expect(BATCH_STT_ROUTES.jobById).toBe('/audio/transcription-jobs/{jobId}');
    expect(BATCH_STT_ROUTES.jobStream).toBe('/audio/transcription-jobs/{jobId}/stream');
  });
});

describe('every SSE frame example is real JSON a developer can match against', () => {
  it('has at least one frame per event type the gateway publishes', () => {
    const types = new Set(BATCH_JOB_SSE_FRAMES.map((frame) => frame.type));
    // `TranscriptionEventType` — packages/applications/src/services/stt/realtime/dto/transcription-events.ts:15-26
    expect(types).toEqual(new Set(['status', 'progress', 'chunk', 'transcript', 'error']));
  });

  it.each(BATCH_JOB_SSE_FRAMES)('$type parses, and is the { type, data } envelope', (frame) => {
    const parsed = JSON.parse(frame.example) as { type?: string; data?: unknown };
    expect(parsed.type).toBe(frame.type);
    expect(parsed.data, `${frame.type} must carry its payload under \`data\``).toBeTypeOf('object');
    expect(frame.note.length).toBeGreaterThan(20);
  });

  it('names the terminal statuses the stream closes on', () => {
    expect([...BATCH_JOB_TERMINAL_STATUSES]).toEqual(['COMPLETED', 'FAILED', 'CANCELLED', 'DEAD']);
  });
});

describe('the steps are a walkthrough, not a list of routes', () => {
  it('runs upload → follow → read, four steps', () => {
    expect(BATCH_STT_STEPS).toHaveLength(4);
    expect(BATCH_STT_STEPS[0].title.toLowerCase()).toContain('upload');
  });
});

describe('the manual snippets call the routes they document', () => {
  const curl = sttBatchCurlSnippet('clinic-asr', BASE_URL);
  const fetchSnippet = sttBatchFetchSnippet('clinic-asr', BASE_URL);

  it('the curl sample posts a REAL multipart file part', () => {
    expect(curl).toMatch(/-F ["']?file=@/);
    expect(curl).toContain('agentSlug=clinic-asr');
    expect(curl).toContain(BATCH_STT_ROUTES.uploadAndStart);
  });

  it('the curl sample follows the stream with -N and reads the finished job', () => {
    expect(curl).toContain('curl -N');
    expect(curl).toContain('/stream');
    expect(curl).toMatch(/audio\/transcription-jobs\/\$JOB_ID/);
  });

  it('neither manual sample imports an SDK', () => {
    expect(curl).not.toMatch(/@arcaai\//);
    expect(fetchSnippet).not.toMatch(/@arcaai\//);
  });

  it('the fetch sample uploads with FormData and names the scope-crossing header', () => {
    expect(fetchSnippet).toContain('FormData');
    expect(fetchSnippet).toContain('X-API-Key');
    expect(fetchSnippet).toContain(BATCH_STT_ROUTES.uploadAndStart);
  });
});

/**
 * The batch job's SDK surface lives on `hope.agents`, NOT `hope.jobs`.
 *
 * `JobsResource` addresses `consultations/jobs/{id}` and 404s on a transcription job id (proven
 * against the dev gateway, 2026-09-17), so lane J adds `transcriptionJob` /
 * `subscribeTranscription` / `waitForTranscription` beside `transcribe`. Until that lands, the
 * three assertions that need the real prototype are SKIPPED with the reason in their own title —
 * never quietly dropped, and never asserted against a prototype that cannot carry them.
 */
const LANE_J_METHODS = ['transcriptionJob', 'subscribeTranscription', 'waitForTranscription'] as const;
const AGENT_METHODS = new Set(Object.getOwnPropertyNames(AgentsResource.prototype).filter((name) => name !== 'constructor'));
const LANE_J_MERGED = LANE_J_METHODS.every((name) => AGENT_METHODS.has(name));

describe('the Node snippet calls methods @arcaai/vox-node really carries', () => {
  const snippet = sttBatchVoxNodeSnippet('clinic-asr');

  /**
   * True of the SNIPPET regardless of the SDK, so the documentation side is pinned even while
   * lane J is in flight: every call it makes is on the agents plane, and none is on `hope.jobs`.
   */
  it('every call is on hope.agents — never hope.jobs, which is a different plane', () => {
    const paths = [...snippet.matchAll(/\bhope\.((?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g)].map((match) => match[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const [resource, ...rest] = path.split('.');
      expect(resource, `hope.${path}() — the batch plane is hope.agents`).toBe('agents');
      expect(rest, `hope.${path}() reaches through a sub-resource that does not exist`).toHaveLength(1);
    }
  });

  it('names the batch-job methods lane J adds, and says hope.jobs is not this plane', () => {
    for (const name of LANE_J_METHODS) expect(snippet, name).toContain(name);
    expect(snippet).toMatch(/hope\.jobs[^\n]*CONSULTATION/);
  });

  it.skipIf(!LANE_J_MERGED)('[needs lane J merged] every method it calls exists on AgentsResource', () => {
    const paths = [...snippet.matchAll(/\bhope\.agents\.([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
    for (const method of paths) expect(AGENT_METHODS, `hope.agents.${method}()`).toContain(method);
  });

  it.skipIf(!LANE_J_MERGED)('[needs lane J merged] the three batch-job methods are on the prototype', () => {
    for (const name of LANE_J_METHODS) expect(AGENT_METHODS, name).toContain(name);
  });

  it.skipIf(!LANE_J_MERGED)('[needs lane J merged] transcribe still accepts a file, which is what the snippet sends', () => {
    // Lane J repoints the `{ file }` branch at the multipart route; the SDK's own signature is
    // what proves the snippet's first call is reachable.
    expect(AGENT_METHODS).toContain('transcribe');
    expect(AgentsResource.prototype.transcribe.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * The parameter shape, not just the method name. `TranscribeSource` is a union — `{ file,
   * filename?, language? }` or `{ mediaId, language? }` — and a snippet naming a key outside it
   * is a dead end the console handed a developer with the authority of the product.
   */
  it('every option key `transcribe` is called with is one TranscribeSource declares', () => {
    const allowed = new Set(['file', 'filename', 'language', 'mediaId']);
    const calls = [...snippet.matchAll(/transcribe\([^,]+,\s*\{([^}]*)\}/g)].map((match) => match[1]);
    expect(calls.length, 'the snippet must actually call transcribe with an options object').toBeGreaterThan(0);
    for (const call of calls) {
      for (const key of [...call.matchAll(/([A-Za-z_$][\w$]*)\s*[:,}]/g)].map((match) => match[1])) {
        expect(allowed, `transcribe({ ${key} }) — TranscribeSource declares no such option`).toContain(key);
      }
    }
  });

  it('a TranscribeSource key the SDK dropped would fail this test', () => {
    // The guard above is only meaningful if it can actually reject — prove it on a fake snippet.
    const bogus = "const job = await hope.agents.transcribe('x', { audioUrl: '…' });";
    const keys = [...bogus.matchAll(/transcribe\([^,]+,\s*\{([^}]*)\}/g)].map((match) => match[1]);
    expect(keys[0]).toContain('audioUrl');
    expect(new Set(['file', 'filename', 'language', 'mediaId'])).not.toContain('audioUrl');
  });

  it('shows both forms — the file upload and the mediaId — and names the route each reaches', () => {
    expect(snippet).toContain('file');
    expect(snippet).toContain('mediaId');
    expect(snippet).toContain(BATCH_STT_ROUTES.uploadAndStart);
  });

  it('follows the job and reads resultText, rather than stopping at the 201', () => {
    expect(snippet).toMatch(/hope\.agents\.(waitForTranscription|subscribeTranscription)/);
    expect(snippet).toContain('resultText');
    // `onError` is REQUIRED on a fire-and-forget subscription — a 403 with nowhere to go is
    // indistinguishable from a quiet job.
    expect(snippet).toContain('onError');
  });

  it('names the scope each half needs — they are different families', () => {
    expect(snippet).toContain('stt:transcription:write');
    expect(snippet).toContain('agent:invocation:write');
  });
});

describe('the mediaId note states the defect rather than papering over it', () => {
  it('says the agent route takes an id and not a file', () => {
    expect(MEDIA_ID_NOTE).toMatch(/mediaId/);
    expect(MEDIA_ID_NOTE).toMatch(/multipart|file/i);
  });
});
