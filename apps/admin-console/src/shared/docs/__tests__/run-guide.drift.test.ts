/**
 * TASK-1036 lane C4 — every vox-node snippet in the run guide names a method that exists on the
 * 5.0 SDK, and every option key it passes is one the SDK reads.
 *
 * Two layers, because the second needs a built 5.0 `@arcaai/vox-node` (the package resolves to its
 * `dist/`) and a suite must not go red merely because nobody has rebuilt it:
 *
 *  1. STATIC — an allow-list pinned from the SDK's own source (`resources/workflows.ts`,
 *     `resources/agents.ts`, `core/run-handle.ts`, `resources/stt.ts`). Always runs. It is what
 *     catches `hope.workflows.runs.create(...)`-class mistakes.
 *  2. LIVE — the same names against the built classes. A NAMED skip against a pre-5.0 build.
 */
import { describe, expect, it } from 'vitest';
import * as voxNode from '@arcaai/vox-node';
import { buildRunGuide, type RunGuideInput } from '../run-guide';

const KINDS: RunGuideInput['kind'][] = ['workflow', 'agent'];
const FULL: Omit<RunGuideInput, 'kind' | 'slug'> = {
  connections: ['api', 'webhook', 'sse', 'socket'],
  exampleInput: { message: '…' },
  streamAudioIn: true,
  attachmentsIn: true,
  streamAudioOut: true,
  baseUrl: 'https://api.example.com',
};

const NODE_SNIPPETS = KINDS.flatMap((kind) =>
  buildRunGuide({ ...FULL, kind, slug: 'scribe' }).flatMap((step) => step.snippets.filter((snippet) => snippet.lane === 'vox-node').map((snippet) => ({ name: snippet.label, code: snippet.code }))),
);

/** Pinned from the SDK source. Adding a name here means finding it in the SDK first. */
const HOPE_METHODS: Record<string, readonly string[]> = {
  workflows: ['run', 'attach', 'runAndWait'],
  agents: ['run', 'attach'],
  stt: ['createStreamSession', 'socket'],
};
const HANDLE_METHODS = ['events', 'text', 'wait', 'result', 'cancel'] as const;
const SOCKET_METHODS = ['connect', 'sendPcm16', 'finalize'] as const;
const OPTION_KEYS: Record<string, readonly string[]> = {
  // RunStartOptions: idempotencyKey, signal, timeoutMs, maxReconnects, reconnectDelayMs.
  run: ['idempotencyKey'],
  // RunWaitOptions: poll, intervalMs (+ RunEventsOptions: signal, after, autoResume, maxReconnects).
  wait: ['poll', 'intervalMs'],
  events: ['after'],
};

describe('the run guide’s vox-node snippets (static)', () => {
  it('there are snippets to check, for both kinds (a guard that cannot pass vacuously)', () => {
    expect(NODE_SNIPPETS.length).toBeGreaterThanOrEqual(10);
  });

  it('every hope.<resource>.<method>( call is a pinned direct method', () => {
    for (const { name, code } of NODE_SNIPPETS) {
      for (const match of code.matchAll(/\bhope\.([A-Za-z]+)\.([A-Za-z]+)\s*\(/g)) {
        expect(HOPE_METHODS[match[1]], `${name}: hope.${match[1]}`).toBeDefined();
        expect(HOPE_METHODS[match[1]], `${name}: hope.${match[1]}.${match[2]}()`).toContain(match[2]);
      }
      // A sub-resource reach (hope.workflows.runs.create) is the dead end this file exists to stop.
      expect(code, name).not.toMatch(/\bhope\.[A-Za-z]+\.[A-Za-z]+\.[A-Za-z]+\s*\(/);
    }
  });

  it('every run.<method>( call is a RunHandle method', () => {
    for (const { name, code } of NODE_SNIPPETS) {
      for (const match of code.matchAll(/\brun\.([A-Za-z]+)\s*\(/g)) expect(HANDLE_METHODS, `${name}: run.${match[1]}()`).toContain(match[1]);
    }
  });

  it('every socket.<method>( call is a RealtimeSttSocket method', () => {
    for (const { name, code } of NODE_SNIPPETS) {
      for (const match of code.matchAll(/\bsocket\.([A-Za-z0-9]+)\s*\(/g)) expect(SOCKET_METHODS, `${name}: socket.${match[1]}()`).toContain(match[1]);
    }
  });

  it('options passed to run / wait / events are keys the SDK reads', () => {
    for (const { name, code } of NODE_SNIPPETS) {
      for (const [method, allowed] of Object.entries(OPTION_KEYS)) {
        for (const match of code.matchAll(new RegExp(`\\.${method}\\([^)]*?\\{([^{}]*)\\}\\s*\\)`, 'g'))) {
          for (const key of match[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) expect(allowed, `${name}: ${method}({ ${key[1]} })`).toContain(key[1]);
        }
      }
    }
  });

  it('HopeClient is constructed only with options its constructor reads, and always with a baseUrl', () => {
    const allowed = new Set(['baseUrl', 'apiKey', 'clientId', 'clientSecret', 'workingTenantId']);
    for (const { name, code } of NODE_SNIPPETS) {
      for (const match of code.matchAll(/new HopeClient\(\{([^}]*)\}\)/g)) {
        const keys = [...match[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((key) => key[1]);
        expect(keys, `${name}`).toContain('baseUrl');
        for (const key of keys) expect(allowed, `${name}: new HopeClient({ ${key} })`).toContain(key);
      }
    }
  });

  it('the error classes it imports are real exports of the package source', () => {
    for (const { code } of NODE_SNIPPETS) {
      for (const match of code.matchAll(/import \{([^}]*)\} from '@arcaai\/vox-node'/g)) {
        for (const name of match[1].split(',').map((entry) => entry.trim())) {
          expect(['HopeClient', 'RunFailedError', 'RunStreamInterruptedError']).toContain(name);
        }
      }
    }
  });
});

function methodsOf(resource: abstract new (...args: never[]) => object): Set<string> {
  return new Set(Object.getOwnPropertyNames(resource.prototype).filter((name) => name !== 'constructor'));
}

const sdk = voxNode as unknown as Record<string, (abstract new (...args: never[]) => object) | undefined>;
const SDK_IS_5 = sdk.RunHandle !== undefined && sdk.WorkflowsResource !== undefined && methodsOf(sdk.WorkflowsResource).has('attach');

describe.skipIf(!SDK_IS_5)('the run guide’s vox-node snippets against the built SDK (needs a 5.0 build of @arcaai/vox-node)', () => {
  it('every pinned method exists', () => {
    for (const method of HOPE_METHODS.workflows) expect(methodsOf(sdk.WorkflowsResource!)).toContain(method);
    for (const method of HOPE_METHODS.agents) expect(methodsOf(sdk.AgentsResource!)).toContain(method);
    for (const method of HOPE_METHODS.stt) expect(methodsOf(sdk.SttResource!)).toContain(method);
    for (const method of HANDLE_METHODS) expect(methodsOf(sdk.RunHandle!)).toContain(method);
  });

  it('the error classes are exported', () => {
    expect(sdk.RunFailedError).toBeDefined();
    expect(sdk.RunStreamInterruptedError).toBeDefined();
  });
});
