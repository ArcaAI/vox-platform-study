/**
 * Asserts a real `compile()` output validates against the NORMATIVE contract
 * (`docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/compiled-config.schema.json`)
 * — TASK-716 Task 1's verify step: "the compiled example validates against Task 1's JSON
 * Schema (assert this in the test)". `ajv`/`ajv-formats` are devDependencies ONLY (schema
 * conformance testing) — the package's runtime `dependencies` stay empty.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { compile } from '../compiler';
import type { CompilerContext } from '../compiler';
import type { WorkflowGraph } from '../graph-model';

const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../../../docs/implementation/TASK-716-Workflow-Compiler-Validator/contracts/compiled-config.schema.json',
);

function loadValidator() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

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

describe('compiled config vs the normative schema', () => {
  it('the schema itself compiles under draft 2020-12', () => {
    expect(() => loadValidator()).not.toThrow();
  });

  it('a real compile() output validates against contracts/compiled-config.schema.json', () => {
    const validate = loadValidator();
    const result = compile(graph, ctx);
    expect('config' in result).toBe(true);
    const ok = validate((result as { config: unknown }).config);
    if (!ok) {
      throw new Error(`compiled config does not match the schema: ${JSON.stringify(validate.errors, null, 2)}`);
    }
    expect(ok).toBe(true);
  });

  it('rejects an onTimeout of "APPROVED" — INV-001/INV-147/INV-181', () => {
    const validate = loadValidator();
    const result = compile(graph, ctx) as { config: { gates: Array<{ onTimeout: string }> } };
    const tampered = { ...result.config, gates: [{ ...result.config.gates[0]!, onTimeout: 'APPROVED' }] };
    expect(validate(tampered)).toBe(false);
  });
});
