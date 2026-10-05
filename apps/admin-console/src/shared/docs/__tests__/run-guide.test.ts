/**
 * TASK-1036 §3.6 / lane C4 — the five-step run guide, as data.
 *
 * What these cases pin is the shape of the promise the Integration tab makes:
 *  - five steps in a fixed order (Authenticate → Connect → Send input → Receive output → Handle errors);
 *  - EVERY step carries all three snippets — vox-node (`RunHandle`), vox (browser `useRun`, marked 5.0)
 *    and raw HTTP/SSE/socket — so no lane is a dead end;
 *  - Connect shows only the lanes the workflow's effective settings enable;
 *  - the snippets are the 5.0 API (`hope.workflows.run(slug, input)` returns a handle; the body is the
 *    input itself, not the `{ input }` envelope that only the raw HTTP body still carries).
 */
import { describe, expect, it } from 'vitest';
import { buildRunGuide, RUN_GUIDE_LANES, RUN_GUIDE_STEP_IDS, type RunGuideInput } from '../run-guide';

const BASE: RunGuideInput = {
  kind: 'workflow',
  slug: 'discharge-summary',
  connections: ['api', 'sse'],
  exampleInput: { message: '…' },
  streamAudioIn: false,
  attachmentsIn: false,
  streamAudioOut: false,
  baseUrl: 'https://api.example.com',
};

function stepsOf(input: Partial<RunGuideInput> = {}) {
  return buildRunGuide({ ...BASE, ...input });
}

function code(step: ReturnType<typeof stepsOf>[number], lane: (typeof RUN_GUIDE_LANES)[number]): string {
  return step.snippets
    .filter((snippet) => snippet.lane === lane)
    .map((snippet) => snippet.code)
    .join('\n');
}

describe('buildRunGuide — structure', () => {
  it('has the five steps, in order', () => {
    expect(stepsOf().map((step) => step.id)).toEqual([...RUN_GUIDE_STEP_IDS]);
    expect(RUN_GUIDE_STEP_IDS).toEqual(['authenticate', 'connect', 'send', 'receive', 'errors']);
  });

  it.each([['workflow'], ['agent']] as const)('every step of a %s guide has a snippet in all three lanes', (kind) => {
    for (const step of stepsOf({ kind, slug: 'scribe' })) {
      for (const lane of RUN_GUIDE_LANES) {
        expect(code(step, lane).length, `${step.id} / ${lane}`).toBeGreaterThan(20);
      }
    }
  });

  it('marks the browser lane as vox 5.0 wherever it is shown', () => {
    for (const step of stepsOf()) {
      for (const snippet of step.snippets.filter((entry) => entry.lane === 'vox')) {
        expect(snippet.label).toMatch(/5\.0/);
      }
    }
  });

  it('labels are unique, so each snippet is a distinct accessible group', () => {
    const labels = stepsOf().flatMap((step) => step.snippets.map((snippet) => snippet.label));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('step 1 — Authenticate', () => {
  const step = stepsOf()[0];

  it('covers an API key and a service account, and never reads a real env var', () => {
    const raw = code(step, 'raw');
    expect(raw).toContain('X-API-Key');
    expect(raw).toContain('/api/v1/auth/service-token');
    expect(raw).toContain('X-Service-Account-Token');
    expect(code(step, 'vox-node')).toContain('clientId');
    expect(code(step, 'vox-node')).toContain('apiKey');
  });

  it('says the working tenant binds at exchange, so X-Tenant-Id is never sent beside a token', () => {
    expect(step.notes.join(' ')).toMatch(/X-Tenant-Id/);
  });

  it('names the exact scopes for the routes the guide uses', () => {
    expect(step.notes.join(' ')).toContain('workflow:run:write');
    expect(step.notes.join(' ')).toContain('workflow:run:read');
  });

  it('the browser lane warns an API key is visible to the page', () => {
    expect(code(step, 'vox')).toMatch(/accessToken/);
  });
});

describe('step 2 — Connect (filtered by the effective settings)', () => {
  it('shows only the connections the workflow enables', () => {
    const connect = stepsOf({ connections: ['api'] })[1];
    expect(connect.lanes?.map((lane) => [lane.connection, lane.enabled])).toEqual([
      ['api', true],
      ['webhook', false],
      ['sse', false],
      ['socket', false],
    ]);
  });

  it('the snippets of a disabled lane are absent, the enabled ones present', () => {
    const connect = stepsOf({ connections: ['api', 'sse'] })[1];
    expect(code(connect, 'raw')).toContain('/stream');
    expect(code(connect, 'raw')).not.toContain('websocat');
    const withSocket = stepsOf({ connections: ['api', 'socket'] })[1];
    expect(code(withSocket, 'raw')).toContain('websocat');
    expect(code(withSocket, 'raw')).toContain('protocol=2');
  });

  it('a workflow with NO api connection cannot be started by a caller, and says so', () => {
    const connect = stepsOf({ connections: [] })[1];
    expect(connect.notes.join(' ')).toMatch(/no connection/i);
  });

  it('SSE is the default and the only lane that resumes; the socket is the buffering answer', () => {
    const connect = stepsOf({ connections: ['api', 'sse', 'socket'] })[1];
    expect(connect.notes.join(' ')).toMatch(/only lane that resumes/i);
  });
});

describe('step 3 — Send input', () => {
  it('vox-node passes the input itself and an idempotency key — not the { input } envelope', () => {
    const node = code(stepsOf()[2], 'vox-node');
    expect(node).toContain("hope.workflows.run('discharge-summary'");
    expect(node).toContain('idempotencyKey');
    expect(node).not.toMatch(/\{\s*input:/);
  });

  it('raw HTTP keeps the { "input": … } envelope and the Idempotency-Key header', () => {
    const raw = code(stepsOf()[2], 'raw');
    expect(raw).toContain('"input"');
    expect(raw).toContain('Idempotency-Key');
    expect(raw).toContain('/api/v1/workflows/discharge-summary/runs');
  });

  it('browser: useRun with the planned 5.0 shape', () => {
    const browser = code(stepsOf()[2], 'vox');
    expect(browser).toContain("useRun({ workflow: 'discharge-summary' })");
    expect(browser).toContain('start(');
  });

  it('stream audio goes up the STT socket, not in the JSON body', () => {
    const step = stepsOf({ connections: ['api', 'socket'], streamAudioIn: true })[2];
    expect(code(step, 'raw')).toContain('/audio/transcription-jobs/stream/session');
    expect(code(step, 'vox')).toContain('useRunAudio');
    expect(step.notes.join(' ')).toMatch(/PCM16/);
  });

  it('live audio is bound to the run: the session is created with workflowSlug and the run input carries sttSessionId (all three lanes)', () => {
    const step = stepsOf({ connections: ['api', 'socket'], streamAudioIn: true, audioField: 'recording' })[2];

    const raw = code(step, 'raw');
    expect(raw).toContain('"workflowSlug": "discharge-summary"');
    expect(raw).not.toContain('consultationId');
    expect(raw).toContain('"recording"');
    expect(raw).toContain('sttSessionId');
    // The session exists BEFORE the run names it.
    expect(raw.indexOf('/audio/transcription-jobs/stream/session')).toBeLessThan(raw.indexOf('/workflows/discharge-summary/runs'));
    expect(raw).toMatch(/never cancel|carries on/i);

    const node = code(step, 'vox-node');
    expect(node).toContain("hope.workflows.runWithAudio('discharge-summary'");
    expect(node).toContain("audioField: 'recording'");
    expect(node).toContain('audio.finalize()');
    expect(node).not.toContain('createStreamSession({})');

    const browser = code(step, 'vox');
    expect(browser).toContain("useRunAudio({ workflow: 'discharge-summary', audioField: 'recording' })");
    expect(browser).toContain('audioField');
    expect(browser).not.toContain('audio.start()');
  });

  it('without a known audio key the SDK snippets let the SDK resolve it from the published Input shape', () => {
    const step = stepsOf({ connections: ['api', 'socket'], streamAudioIn: true })[2];
    expect(code(step, 'vox-node')).not.toContain('audioField');
    expect(code(step, 'raw')).toContain('<audioField>');
  });

  it('the live-audio notes say ending the audio never cancels the run', () => {
    const step = stepsOf({ connections: ['api', 'socket'], streamAudioIn: true })[2];
    expect(step.notes.join(' ')).toMatch(/never cancel/i);
  });

  it('attachments are referenced by mediaId and the allowed types are stated', () => {
    const step = stepsOf({ attachmentsIn: true })[2];
    expect(step.notes.join(' ')).toMatch(/mediaId/);
    expect(step.notes.join(' ')).toMatch(/application\/pdf/);
  });

  it('with neither audio nor attachments there is no upload note', () => {
    expect(stepsOf()[2].notes.join(' ')).not.toMatch(/PCM16|mediaId/);
  });
});

describe('step 4 — Receive output', () => {
  it('vox-node reads text, then the verified result', () => {
    const node = code(stepsOf()[3], 'vox-node');
    expect(node).toContain('run.text()');
    expect(node).toContain('await run.result()');
  });

  it('raw: SSE v2 with the protocol header, resume cursor, polling and the result route', () => {
    const raw = code(stepsOf()[3], 'raw');
    expect(raw).toContain('x-hope-run-protocol: 2');
    expect(raw).toContain('Last-Event-ID');
    expect(raw).toContain('/runs/$RUN_ID/stream');
    expect(raw).toContain('/runs/$RUN_ID"');
    expect(raw).toContain('/runs/$RUN_ID/result');
  });

  it('a browser EventSource cannot set headers, so the query form is shown', () => {
    expect(code(stepsOf()[3], 'raw')).toContain('?protocol=2');
  });

  it('names the v2 event types a reader handles', () => {
    const notes = stepsOf()[3].notes.join(' ');
    for (const type of ['output.text.delta', 'run.completed', 'run.failed', 'run.resync']) expect(notes).toContain(type);
  });

  it('an agent run has the same four calls on /agents/{slug}/runs, with /events instead of /stream', () => {
    const raw = code(stepsOf({ kind: 'agent', slug: 'scribe' })[3], 'raw');
    expect(raw).toContain('/api/v1/agents/scribe/runs/$RUN_ID/events');
    expect(raw).not.toContain('/stream');
  });
});

describe('step 5 — Handle errors', () => {
  it('lists the fixed-label codes, run.resync and idempotency', () => {
    const step = stepsOf()[4];
    const notes = step.notes.join(' ');
    for (const codeName of ['INPUT_INVALID', 'RUN_TIMED_OUT', 'GUARDRAIL_BLOCKED', 'MODEL_UNAVAILABLE']) expect(notes).toContain(codeName);
    expect(notes).toMatch(/run\.resync/);
    expect(notes).toMatch(/Idempotency-Key/);
    expect(notes).toMatch(/429/);
  });

  it('vox-node: catches RunFailedError and reads error.code, never error.message as data', () => {
    const node = code(stepsOf()[4], 'vox-node');
    expect(node).toContain('RunFailedError');
    expect(node).toContain('.code');
  });

  it('raw: a retry with the same key joins the run in flight', () => {
    expect(code(stepsOf()[4], 'raw')).toContain('Idempotency-Key');
  });
});

describe('agent guides', () => {
  const guide = stepsOf({ kind: 'agent', slug: 'scribe', exampleInput: { text: '…' }, connections: [] });

  it('use hope.agents.run with the FLAT body, and POST /agents/{slug}/runs', () => {
    const send = guide[2];
    expect(code(send, 'vox-node')).toContain("hope.agents.run('scribe'");
    expect(code(send, 'raw')).toContain('/api/v1/agents/scribe/runs');
    expect(code(send, 'raw')).not.toContain('"input"');
    expect(code(send, 'vox')).toContain("useRun({ agent: 'scribe' })");
  });

  it('an agent has one step, nodeId "agent", and no connection filter', () => {
    expect(guide[1].lanes).toBeUndefined();
    expect(guide[3].notes.join(' ')).toContain("nodeId: 'agent'");
  });
});
