/**
 * TASK-983 lane I — the BATCH transcription contract, pinned.
 *
 * The batch lane used to print one line (`hope.agents.transcribe(slug, { file })`) and one curl
 * body (`{ "mediaId": "…" }`) and stop there. Both were dead ends:
 *
 *  - `POST /agents/{slug}/transcriptions` carries NO multipart interceptor
 *    (`apps/api/src/modules/agent/agent.controller.ts:751-830`) and answers
 *    `400 \`mediaId\` is required.` for a file upload — so the SDK's `{ file }` branch
 *    (`packages/vox-node/src/resources/agents.ts:213-233`) cannot reach it;
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

describe('the Node snippet calls methods @arcaai/vox-node really carries', () => {
  const snippet = sttBatchVoxNodeSnippet('clinic-asr');
  const methods = new Set(Object.getOwnPropertyNames(AgentsResource.prototype).filter((name) => name !== 'constructor'));

  it('every hope.<resource>.<method>() exists', () => {
    const paths = [...snippet.matchAll(/\bhope\.((?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g)].map((match) => match[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const [resource, ...rest] = path.split('.');
      expect(resource, `hope.${path}() — only the agents plane has a batch method`).toBe('agents');
      expect(rest).toHaveLength(1);
      expect(methods).toContain(rest[0]);
    }
  });

  it('transcribe is called with `mediaId`, never `file` — the gateway route has no multipart handler', () => {
    expect(snippet).toContain('mediaId');
    expect(snippet).not.toMatch(/transcribe\([^)]*\bfile\b/);
  });

  it('shows how the job is followed, because the SDK carries no method for the audio job plane', () => {
    expect(snippet).toContain('sseUrl');
    expect(snippet).toMatch(/fetch\(/);
  });
});

describe('the mediaId note states the defect rather than papering over it', () => {
  it('says the agent route takes an id and not a file', () => {
    expect(MEDIA_ID_NOTE).toMatch(/mediaId/);
    expect(MEDIA_ID_NOTE).toMatch(/multipart|file/i);
  });
});
