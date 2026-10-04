/**
 * TASK-983 lane I — the REALTIME text-generation contract (`?mode=stream`), pinned.
 *
 * The panel promised "real event:/data:/id: frames, first frame `meta`, last `done`" in a curl
 * comment and nowhere else — no frame shapes, no payloads, no statement of whether it resumes.
 * A developer writing an SSE reader needs the frames themselves.
 *
 * Each example below is parsed here, so a payload that stops being valid JSON fails rather than
 * being copied into a client.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_SSE_FRAMES,
  AGENT_SSE_HEARTBEAT_MS,
  AGENT_SSE_RESPONSE_HEADERS,
  AGENT_STREAM_RESUME_NOTE,
  NO_TEXT_JOB_MODE_NOTE,
  RUN_ENVELOPE_NOTE,
  RUN_ERROR_CODES,
  RUN_RESULT_NOTE,
  RUN_RESYNC_NOTE,
  RUN_V2_EVENTS,
  agentSseCurlSnippet,
  agentSseFetchSnippet,
  runEventsCurlSnippet,
  runEventsFetchSnippet,
} from '../sse-frame-protocol';

const BASE_URL = 'https://api.example.com';

describe('the frames are the ones the gateway relays', () => {
  it('covers meta, chunk, done and error — and nothing invented', () => {
    expect(AGENT_SSE_FRAMES.map((frame) => frame.event)).toEqual(['meta', 'chunk', 'done', 'error']);
  });

  it.each(AGENT_SSE_FRAMES)('$event carries a parseable data payload', (frame) => {
    expect(() => JSON.parse(frame.data)).not.toThrow();
    expect(frame.note.length).toBeGreaterThan(20);
  });

  it('meta is first and carries the generation id; done and error are terminal', () => {
    const [first] = AGENT_SSE_FRAMES;
    expect(first.event).toBe('meta');
    expect(JSON.parse(first.data)).toHaveProperty('generation_id');
    expect(AGENT_SSE_FRAMES.filter((frame) => frame.terminal).map((frame) => frame.event)).toEqual(['done', 'error']);
  });

  it('states the 15s heartbeat the gateway writes', () => {
    expect(AGENT_SSE_HEARTBEAT_MS).toBe(15_000);
  });

  it('names the response headers a proxy must not swallow', () => {
    expect(AGENT_SSE_RESPONSE_HEADERS['Content-Type']).toBe('text/event-stream');
    expect(AGENT_SSE_RESPONSE_HEADERS['X-Accel-Buffering']).toBe('no');
    expect(Object.keys(AGENT_SSE_RESPONSE_HEADERS)).toContain('X-Agent-Version-Id');
  });
});

describe('the two honest absences', () => {
  it('says the invocation stream does not resume, and why', () => {
    expect(AGENT_STREAM_RESUME_NOTE).toMatch(/Last-Event-ID/);
    expect(AGENT_STREAM_RESUME_NOTE).toMatch(/not|no /i);
  });

  it('says the agent plane has no job mode rather than inventing one', () => {
    expect(NO_TEXT_JOB_MODE_NOTE).toMatch(/blocking/);
    expect(NO_TEXT_JOB_MODE_NOTE).toMatch(/stream/);
    // The legacy task plane exists but cannot name an agent — the note must not offer it as this agent's lane.
    expect(NO_TEXT_JOB_MODE_NOTE).toMatch(/text-generations/);
    // …and points at the lane that IS asynchronous: the agent run resource (SDK 5, OD-26).
    expect(NO_TEXT_JOB_MODE_NOTE).toContain('POST /agents/{slug}/runs');
    expect(NO_TEXT_JOB_MODE_NOTE).toContain('hope.agents.run');
  });
});

describe('the manual samples call the route they document', () => {
  const curl = agentSseCurlSnippet('clinic-summarizer', { text: 'Summarise this.' }, BASE_URL);
  const fetchSnippet = agentSseFetchSnippet('clinic-summarizer', { text: 'Summarise this.' }, BASE_URL);

  it('curl uses -N and the mode=stream query', () => {
    expect(curl).toContain('curl -N');
    expect(curl).toContain('?mode=stream');
    expect(curl).toContain('/agents/clinic-summarizer/invocations');
  });

  it('curl names the exact scope', () => {
    expect(curl).toContain('agent:invocation:write');
  });

  it('the fetch sample reads response.body and never uses EventSource with a key', () => {
    expect(fetchSnippet).toContain('response.body');
    // EventSource cannot set X-API-Key — a sample that paired them would be a dead end.
    expect(fetchSnippet).not.toMatch(/new EventSource\([^)]*apiKey/i);
  });

  it('neither manual sample imports an SDK', () => {
    expect(curl).not.toMatch(/@arcaai\//);
    expect(fetchSnippet).not.toMatch(/@arcaai\//);
  });

  it('the body is rendered flat, never wrapped in the workflow envelope', () => {
    expect(curl).not.toMatch(/"input"\s*:/);
    expect(fetchSnippet).not.toMatch(/"input"\s*:/);
  });
});

/**
 * TASK-1036 lane C4 — run protocol v2, the resumable lane. `invocations?mode=stream` (above) is
 * sugar that cannot resume; a RUN is what a developer follows with Last-Event-ID.
 */
describe('run protocol v2 — the public events', () => {
  it('lists only business-plane events (no admin-audience debug event)', () => {
    const types = RUN_V2_EVENTS.map((event) => event.type);
    for (const adminOnly of ['prompt.composed', 'data.bound', 'model.request', 'guardrail.inbound', 'input.validated']) expect(types).not.toContain(adminOnly);
    expect(types).toEqual(
      expect.arrayContaining(['run.started', 'run.completed', 'run.failed', 'run.cancelled', 'run.resync', 'node.started', 'node.failed', 'output.text.delta', 'output.audio.delta', 'output.data', 'ping']),
    );
  });

  it('marks exactly the three terminal run events', () => {
    expect(RUN_V2_EVENTS.filter((event) => event.terminal).map((event) => event.type)).toEqual(['run.completed', 'run.failed', 'run.cancelled']);
  });

  it('error codes are SCREAMING_SNAKE identifiers (the fixed public labels, never a value)', () => {
    for (const code of RUN_ERROR_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
    expect(RUN_ERROR_CODES).toContain('INPUT_INVALID');
  });

  it('states how v2 is selected, how a cursor resumes, and where the result is', () => {
    expect(RUN_ENVELOPE_NOTE).toMatch(/x-hope-run-protocol: 2/);
    expect(RUN_ENVELOPE_NOTE).toMatch(/\?protocol=2/);
    expect(RUN_RESYNC_NOTE).toMatch(/Last-Event-ID/);
    expect(RUN_RESYNC_NOTE).toMatch(/gap \| expired \| cursor_invalid \| unavailable/);
    expect(RUN_RESULT_NOTE).toMatch(/64 KiB/);
    expect(RUN_RESULT_NOTE).toMatch(/RUN_NOT_TERMINAL/);
  });
});

describe('run protocol v2 — the manual samples', () => {
  it('a workflow follows /stream, an agent follows /events, both with the protocol header and a cursor', () => {
    const workflow = runEventsCurlSnippet('workflow', 'discharge-summary', BASE_URL);
    const agent = runEventsCurlSnippet('agent', 'scribe', BASE_URL);
    expect(workflow).toContain('/api/v1/workflows/discharge-summary/runs/$RUN_ID/stream');
    expect(agent).toContain('/api/v1/agents/scribe/runs/$RUN_ID/events');
    for (const snippet of [workflow, agent]) {
      expect(snippet).toContain('curl -N');
      expect(snippet).toContain('x-hope-run-protocol: 2');
      expect(snippet).toContain('Last-Event-ID');
    }
  });

  it('the fetch reader drops replays, honours run.resync and stops on a terminal event', () => {
    const code = runEventsFetchSnippet('agent', 'scribe', BASE_URL);
    expect(code).toContain("'x-hope-run-protocol': '2'");
    expect(code).toContain('response.body');
    expect(code).not.toContain('new EventSource');
    expect(code).toContain('run.resync');
    expect(code).toContain('run.completed');
    // A replayed duplicate is dropped by seq, never because the numbers jumped.
    expect(code).toMatch(/event\.seq <= lastSeq/);
  });
});
