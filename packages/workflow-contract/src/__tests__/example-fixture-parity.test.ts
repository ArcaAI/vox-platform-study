/**
 * `fixtures/example-compiled-config.json` is the ONE shared worked example this ticket's
 * Python mirror (`packages/py-workflow-contract`, TASK-716 Task 7b) round-trips against, so
 * TypeScript and Python assert the SAME document rather than two hand-typed near-copies that
 * could silently diverge (§2.8's twin-drift concern, generalised to the fixture level, not just
 * the algorithm level). This test is the guard: it re-derives the same document from the same
 * graph/ctx `compiled-config-schema.test.ts` already uses and asserts byte-identical JSON, so an
 * engine change that alters the compiled shape fails HERE — the signal to regenerate the shared
 * fixture — rather than silently leaving the Python side pinned to a stale shape.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../compiler';
import type { CompilerContext } from '../compiler';
import type { WorkflowGraph } from '../graph-model';

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/example-compiled-config.json');

const graph: WorkflowGraph = {
  version: 1,
  nodes: [
    { id: 'n_start', type: 'core.start', config: {} },
    { id: 'n_gate', type: 'consent.gate', config: { gateType: 'hitl', onTimeout: 'TIMED_OUT' } },
    { id: 'n_a1', type: 'summarization.generate', config: { onError: 'fail' } },
    { id: 'n_end', type: 'core.end', config: {} },
  ],
  edges: [
    { id: 'e1', from: 'n_start', fromPort: 'out', to: 'n_gate', toPort: 'in' },
    { id: 'e2', from: 'n_gate', fromPort: 'out', to: 'n_a1', toPort: 'text' },
    { id: 'e3', from: 'n_a1', fromPort: 'out', to: 'n_end', toPort: 'in' },
  ],
};

const ctx: CompilerContext = {
  definitionId: '018f1e0a-0000-7000-8000-000000000001',
  slug: 'summarization-default',
  versionNumber: 1,
  tenantId: '00000000-0000-0000-0000-000000000000',
  paletteKey: 'summarization',
  compilerVersion: '0.1.0',
  registryChecksum: 'reg-checksum-abc',
  ruleSetVersion: 1,
  caps: { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 },
  policyBindings: {
    guardrailProfile: 'STANDARD',
    redactionRuleSetId: null,
    promptTemplateRefs: [],
    documentTemplateRefs: [],
    contextSchemaVersionId: null,
    entitlementKeys: [],
  },
  compiledAt: '2026-08-16T00:00:00.000Z',
  nodeInfo: (type: string) => {
    if (type === 'core.start' || type === 'core.end') return { activity: 'noop', classes: ['terminal'] };
    if (type === 'consent.gate') return { activity: 'record_gate_decision', classes: ['gate'] };
    return { activity: 'generate', classes: [] };
  },
};

describe('shared TS/Python example fixture', () => {
  it('the checked-in fixture matches a fresh compile() of the same graph/ctx', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const result = compile(graph, ctx);
    expect('config' in result).toBe(true);
    expect((result as { config: unknown }).config).toEqual(fixture);
  });
});
