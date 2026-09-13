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
import { AgentsResource, HopeClient, WorkflowsResource } from '@arcaai/vox-node';
import { agentVoxNodeSnippet, workflowVoxNodeSnippet } from '../sdk-snippets';

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
};

const SNIPPETS: ReadonlyArray<{ name: string; code: string }> = [
  { name: 'agent — TEXT_GENERATION', code: agentVoxNodeSnippet('clinic-summarizer', 'TEXT_GENERATION') },
  { name: 'agent — TEXT_TO_SPEECH', code: agentVoxNodeSnippet('voice', 'TEXT_TO_SPEECH') },
  { name: 'agent — SPEECH_TO_TEXT', code: agentVoxNodeSnippet('asr', 'SPEECH_TO_TEXT') },
  { name: 'workflow', code: workflowVoxNodeSnippet('discharge-summary') },
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
