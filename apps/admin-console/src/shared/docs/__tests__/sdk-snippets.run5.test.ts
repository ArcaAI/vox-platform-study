/**
 * TASK-1036 lane C4 / TASK-1039 — the snippets move from the 4.x run shape to the 5.0 API.
 *
 * Before: `hope.workflows.run(slug, { input })` returned the bare 202 body and the reader then
 * called `streamRun(slug, run.runId)` — a legacy-envelope generator that resumed by an opaque token.
 * After: `hope.workflows.run(slug, input, { idempotencyKey })` returns a `RunHandle` with `.text()`,
 * `.events()`, `.wait()`, `.result()` and `.cancel()`, speaking run protocol v2 and resuming by seq.
 *
 * The drift half checks the vox-node text against the REAL `@arcaai/vox-node` classes, exactly as
 * `sdk-snippets.drift.test.ts` does for the older snippets: a method the SDK does not carry is a dead
 * end handed out with the authority of the product.
 */
import { describe, expect, it } from 'vitest';
import * as voxNode from '@arcaai/vox-node';
import {
  agentRunCurlSnippet,
  agentRunVoxNodeSnippet,
  agentRunVoxSnippet,
  workflowCurlSnippet,
  workflowVoxNodeSnippet,
  workflowVoxSnippet,
} from '../sdk-snippets';
import { workflowSocketVoxNodeSnippet } from '../socket-snippets';

const BODY = { dischargeDate: '…' };

const { AgentsResource, WorkflowsResource } = voxNode;
const RunHandle = (voxNode as unknown as Record<string, unknown>).RunHandle as (abstract new (...args: never[]) => object) | undefined;

function methodsOf(resource: abstract new (...args: never[]) => object): Set<string> {
  return new Set(Object.getOwnPropertyNames(resource.prototype).filter((name) => name !== 'constructor'));
}

describe('workflowVoxNodeSnippet — the 5.0 RunHandle', () => {
  const code = workflowVoxNodeSnippet('discharge-summary', BODY);

  it('passes the input ITSELF, with an idempotency key — not the { input } envelope', () => {
    expect(code).toContain("hope.workflows.run('discharge-summary', {");
    expect(code).toContain('"dischargeDate": "…"');
    expect(code).toContain('idempotencyKey');
    expect(code).not.toMatch(/\binput:\s*\{/);
  });

  it('reads text and the verified result off the handle', () => {
    expect(code).toContain('run.text()');
    expect(code).toContain('await run.result()');
  });

  it('no longer teaches the legacy streamRun generator', () => {
    expect(code).not.toContain('streamRun');
  });
});

describe('workflowVoxSnippet — useRun, marked 5.0', () => {
  const code = workflowVoxSnippet('discharge-summary', BODY);

  it('uses the planned useRun({ workflow }) shape and says it is vox 5.0', () => {
    expect(code).toContain("useRun({ workflow: 'discharge-summary' })");
    expect(code).toMatch(/\b5\.0\b/);
    expect(code).toContain('start(');
    expect(code).not.toContain('useWorkflowRun');
  });
});

describe('workflowCurlSnippet — protocol v2 on the wire', () => {
  const code = workflowCurlSnippet('discharge-summary', BODY, ['async', 'blocking'], 'https://api.example.com');

  it('keeps the { "input" } envelope on the raw body', () => {
    expect(code).toContain('"input"');
  });

  it('follows the run with the protocol header and a resume cursor, and reads the result route', () => {
    expect(code).toContain('x-hope-run-protocol: 2');
    expect(code).toContain('Last-Event-ID');
    expect(code).toContain('/runs/$RUN_ID/result');
  });
});

describe('agent runs — hope.agents.run', () => {
  const options = { exampleBody: { text: 'Summarise this.' }, baseUrl: 'https://api.example.com' };

  it('vox-node: FLAT input, a handle, text and result', () => {
    const code = agentRunVoxNodeSnippet('scribe', options);
    expect(code).toContain("hope.agents.run('scribe', {");
    expect(code).toContain('"text": "Summarise this."');
    expect(code).toContain('run.text()');
    expect(code).toContain('await run.result()');
    expect(code).not.toMatch(/\binput:\s*\{/);
  });

  it('vox: useRun({ agent }), marked 5.0', () => {
    const code = agentRunVoxSnippet('scribe', options);
    expect(code).toContain("useRun({ agent: 'scribe' })");
    expect(code).toMatch(/\b5\.0\b/);
  });

  it('curl: POST /agents/{slug}/runs flat, then /events with the protocol header', () => {
    const code = agentRunCurlSnippet('scribe', options);
    expect(code).toContain('/api/v1/agents/scribe/runs');
    expect(code).toContain('Idempotency-Key');
    expect(code).toContain('/runs/$RUN_ID/events');
    expect(code).toContain('x-hope-run-protocol: 2');
    expect(code).not.toContain('"input"');
  });
});

/**
 * The drift half needs a BUILT `@arcaai/vox-node` that carries the 5.0 `RunHandle` (the package
 * resolves to its `dist/`). Against a pre-5.0 build there is nothing true to compare against, so the
 * group is a NAMED skip rather than a red suite: `pnpm --filter @arcaai/vox-node build` and it runs.
 */
const SDK_IS_5 = RunHandle !== undefined && methodsOf(WorkflowsResource).has('attach');

describe.skipIf(!SDK_IS_5)('the vox-node snippets name methods that exist in 5.0 (needs a 5.0 build of @arcaai/vox-node)', () => {
  const SNIPPETS = [
    workflowVoxNodeSnippet('discharge-summary', BODY),
    agentRunVoxNodeSnippet('scribe'),
    workflowSocketVoxNodeSnippet('discharge-summary'),
  ];

  it('hope.workflows.run / hope.agents.run are real methods that return a handle', () => {
    expect(methodsOf(WorkflowsResource)).toContain('run');
    expect(methodsOf(WorkflowsResource)).toContain('attach');
    expect(methodsOf(AgentsResource)).toContain('run');
  });

  it('every handle method a snippet calls exists on RunHandle', () => {
    const handle = methodsOf(RunHandle!);
    for (const code of SNIPPETS) {
      for (const match of code.matchAll(/\brun\.([A-Za-z]+)\(/g)) expect(handle, `run.${match[1]}()`).toContain(match[1]);
    }
  });

  it('every hope.<resource>.<method>() a snippet calls is a direct method of that resource', () => {
    const resources: Record<string, Set<string>> = { workflows: methodsOf(WorkflowsResource), agents: methodsOf(AgentsResource) };
    for (const code of SNIPPETS) {
      for (const match of code.matchAll(/\bhope\.([A-Za-z]+)\.([A-Za-z]+)\s*\(/g)) {
        expect(resources[match[1]], `hope.${match[1]}`).toBeDefined();
        expect(resources[match[1]], `hope.${match[1]}.${match[2]}()`).toContain(match[2]);
      }
    }
  });
});
