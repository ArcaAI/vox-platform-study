/**
 * TASK-971 lane A — the snippets the publish dialogs render must name methods that EXIST.
 *
 * Every string in `sdk-snippets.ts` is copy-pasted by a tenant's developer the moment they
 * publish. A snippet that references a method the SDK does not carry is not a typo — it is a
 * dead end the console handed them with the authority of the product. Two shipped examples of
 * exactly that are what this file exists to stop coming back:
 *
 *   - `hope.workflows.runs.create(...)` — `WorkflowsResource` has no `runs` sub-resource, so
 *     this is a TypeError on the property access, before any request is made.
 *   - `new HopeClient({ apiKey })` with no `baseUrl` — the constructor throws.
 *
 * Checking the snippets against the REAL `@arcaai/vox-node` exports (a devDependency, imported
 * only here) is what makes this a drift gate rather than a second copy of the same assumption:
 * when the SDK renames a method, this test goes red instead of the snippet going quietly wrong.
 */
import { describe, expect, it } from 'vitest';
import { AgentsResource, HopeClient, JobsResource, SttResource, WorkflowsResource } from '@arcaai/vox-node';
import { agentVoxNodeSnippet, agentVoxNodeStreamSnippet, workflowVoxNodeSnippet } from '../sdk-snippets';
import { sttBatchVoxNodeSnippet } from '../batch-job-protocol';
import { sttRealtimeVoxNodeSnippet } from '../socket-snippets';

/** Method names a resource class actually carries, constructor excluded. */
function methodsOf(resource: abstract new (...args: never[]) => object): Set<string> {
  return new Set(Object.getOwnPropertyNames(resource.prototype).filter((name) => name !== 'constructor'));
}

/**
 * Every `hope.<resource>.<path…>(` call a snippet makes, as its dotted path after `hope.`.
 * Deliberately greedy about depth: `workflows.runs.create` must be CAPTURED so it can FAIL,
 * not skipped for not matching a two-segment shape.
 */
function calledPaths(snippet: string): string[] {
  return [...snippet.matchAll(/\bhope\.((?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g)].map((match) => match[1]);
}

const RESOURCE_METHODS: Record<string, Set<string>> = {
  agents: methodsOf(AgentsResource),
  workflows: methodsOf(WorkflowsResource),
  // TASK-983 lane I — the Batch and Realtime views reach two more planes.
  jobs: methodsOf(JobsResource),
  stt: methodsOf(SttResource),
};

const SNIPPETS: ReadonlyArray<{ name: string; code: string }> = [
  { name: 'agent — TEXT_GENERATION', code: agentVoxNodeSnippet('clinic-summarizer', 'TEXT_GENERATION') },
  { name: 'agent — TEXT_TO_SPEECH', code: agentVoxNodeSnippet('voice', 'TEXT_TO_SPEECH') },
  { name: 'agent — SPEECH_TO_TEXT', code: agentVoxNodeSnippet('asr', 'SPEECH_TO_TEXT') },
  { name: 'workflow', code: workflowVoxNodeSnippet('discharge-summary') },
  // TASK-983 lane I — the snippets the Batch and Realtime views print are drift-checked too.
  { name: 'agent — TEXT_GENERATION (streamed)', code: agentVoxNodeStreamSnippet('clinic-summarizer') },
  { name: 'agent — SPEECH_TO_TEXT (batch job)', code: sttBatchVoxNodeSnippet('asr') },
  { name: 'agent — SPEECH_TO_TEXT (realtime)', code: sttRealtimeVoxNodeSnippet('asr') },
];

describe('vox-node snippets name methods that exist', () => {
  it.each(SNIPPETS)('$name', ({ code }) => {
    const paths = calledPaths(code);
    expect(paths.length).toBeGreaterThan(0);

    for (const path of paths) {
      const [resource, ...rest] = path.split('.');
      const methods = RESOURCE_METHODS[resource];
      expect(methods, `hope.${resource} is not a known resource namespace`).toBeDefined();
      // A snippet must call a method DIRECTLY on the resource. Anything deeper is a sub-resource
      // that has to be proven to exist; `workflows.runs.create` fails here, which is the point.
      expect(rest, `hope.${path}() reaches through a sub-resource that does not exist`).toHaveLength(1);
      expect(methods).toContain(rest[0]);
    }
  });
});

describe('vox-node snippets construct a usable client', () => {
  it('HopeClient refuses construction without a baseUrl', () => {
    // Pins the reason the rule below exists, so a future SDK change that relaxes it shows up here.
    expect(() => new HopeClient({ apiKey: 'k' } as unknown as ConstructorParameters<typeof HopeClient>[0])).toThrow(/baseUrl/);
  });

  it.each(SNIPPETS)('$name passes a baseUrl', ({ code }) => {
    expect(code).toMatch(/new HopeClient\(/);
    const construction = code.slice(code.indexOf('new HopeClient('));
    expect(construction).toMatch(/baseUrl:/);
  });
});

/**
 * TASK-983 lane I — a method name is only half of a snippet's promise; the OPTION KEYS are the
 * other half. A snippet that calls a real method with an option the SDK does not accept is the
 * same dead end as calling a method that does not exist, and it fails at runtime rather than at
 * the property access, which is worse.
 *
 * The keys below are read from the SDK's own published types (`packages/vox-node/src/types/`):
 *   - `TranscribeSource` — `{ file, filename?, language? } | { mediaId, language? }`;
 *   - `SpeechRequest` — what `synthesize` accepts;
 *   - `InvokeAgentOptions` (= `StartRunOptions`) — the third argument of `invoke` /
 *     `invokeAndStream`.
 */
describe('vox-node snippets pass options the SDK really accepts', () => {
  /** Every `{ … }` object literal passed to `name(` in a snippet, as its top-level keys. */
  function optionKeysOf(snippet: string, name: string): string[][] {
    const pattern = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\(([^)]*)\\)`, 'g');
    return [...snippet.matchAll(pattern)].flatMap((match) => {
      const braces = [...match[1].matchAll(/\{([^{}]*)\}/g)];
      return braces.map((brace) => [...brace[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((key) => key[1]));
    });
  }

  it('the option extractor actually extracts (a guard that cannot pass vacuously)', () => {
    // Only `key: value` pairs are extracted — a shorthand (`{ mediaId }`) carries no colon and is
    // therefore invisible here. That is why `batch-job-protocol.test.ts` matches shorthand too;
    // between them, both spellings are covered.
    expect(optionKeysOf("hope.agents.transcribe('x', { mediaId: id, language: 'en' })", 'transcribe')).toEqual([['mediaId', 'language']]);
  });

  it('transcribe is called only with TranscribeSource keys', () => {
    const allowed = new Set(['file', 'filename', 'language', 'mediaId']);
    for (const { name, code } of SNIPPETS) {
      for (const keys of optionKeysOf(code, 'transcribe')) {
        for (const key of keys) expect(allowed, `${name}: transcribe({ ${key} })`).toContain(key);
      }
    }
  });

  it('synthesize is called only with SpeechRequest keys', () => {
    // `SpeechRequest` — packages/vox-node/src/types/agent.ts. `text` XOR `ssml`, plus voice knobs.
    const allowed = new Set(['text', 'ssml', 'voice', 'language', 'format', 'sampleRate', 'speed']);
    for (const { name, code } of SNIPPETS) {
      for (const keys of optionKeysOf(code, 'synthesize')) {
        for (const key of keys) expect(allowed, `${name}: synthesize({ ${key} })`).toContain(key);
      }
    }
  });

  it('HopeClient is constructed only with options its constructor reads', () => {
    const allowed = new Set(['baseUrl', 'apiKey', 'clientId', 'clientSecret', 'workingTenantId', 'fetch', 'timeoutMs', 'maxRetries', 'userAgent', 'defaultHeaders']);
    for (const { name, code } of SNIPPETS) {
      for (const keys of optionKeysOf(code, 'new HopeClient')) {
        for (const key of keys) expect(allowed, `${name}: new HopeClient({ ${key} })`).toContain(key);
      }
    }
  });

  /**
   * The realtime socket's own surface. `stop()` is a DEPRECATED alias for `finalize()` whose old
   * doc comment ("the SESSION stays open") was wrong and cost two integrators the rest of a
   * consultation — so no snippet here may print it, even though it works.
   */
  it('no snippet reaches for the deprecated socket alias', () => {
    for (const { name, code } of SNIPPETS) {
      expect(code, `${name} calls the deprecated socket.stop() alias`).not.toMatch(/\bsocket\.stop\(/);
    }
  });
});
