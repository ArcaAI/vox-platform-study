/**
 * TASK-1036 — the normative compiled-config schema declares the data contract the compiler emits
 * under `emitDataContract` (per-node `bindings` and `consultationReads`, top-level `settings`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { compile } from '../compiler';
import type { WorkflowGraph } from '../graph-model';
import { nodeInfo, registryChecksum } from '../node-registry';

const SCHEMA = JSON.parse(readFileSync(path.resolve(__dirname, '../../schemas/compiled-config.schema.json'), 'utf8'));

const graph = {
  version: 1,
  nodes: [
    { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['consultation', 'api'] } },
    { id: 'n_a', type: 'core.agent', config: { agentRef: { slug: 'gen' } } },
    { id: 'n_b', type: 'core.agent', config: { agentRef: { slug: 'gen' } } },
    { id: 'n_c', type: 'core.agent', config: { agentRef: { slug: 'gen' }, inputs: { context: { from: 'consultation.patient.age', at: 'runStart' } } } },
    { id: 'n_output', type: 'core.output', config: { protocols: ['http', 'socket'] } },
  ],
  edges: [
    { id: 'e1', from: 'n_trigger', fromPort: 'out', to: 'n_a', toPort: 'context' },
    { id: 'e2', from: 'n_trigger', fromPort: 'out', to: 'n_b', toPort: 'context' },
    { id: 'e3', from: 'n_a', fromPort: 'out', to: 'n_c', toPort: 'in' },
    { id: 'e4', from: 'n_b', fromPort: 'out', to: 'n_c', toPort: 'in' },
    { id: 'e5', from: 'n_c', fromPort: 'out', to: 'n_output', toPort: 'in' },
  ],
  settings: { connections: ['api', 'socket'], sources: ['consultation'] },
} as WorkflowGraph;

describe('compiled-config schema — the data contract', () => {
  it('a compile() output WITH the data contract (from, value, firstOf, consultationReads, settings) validates', () => {
    const result = compile(graph, {
      definitionId: '018f1e0a-0000-7000-8000-000000000001',
      slug: 'schema-check',
      versionNumber: 1,
      tenantId: '00000000-0000-0000-0000-000000000000',
      paletteKey: 'core',
      compilerVersion: '0.1.0',
      registryChecksum: registryChecksum(),
      ruleSetVersion: 1,
      caps: { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 },
      policyBindings: { guardrailProfile: 'STANDARD', redactionRuleSetId: null, promptTemplateRefs: [], documentTemplateRefs: [], contextSchemaVersionId: null, entitlementKeys: [] },
      compiledAt: '2026-10-04T00:00:00.000Z',
      nodeInfo,
      agents: { gen: { task: 'TEXT_GENERATION' } },
      emitDataContract: true,
    });
    if (!('config' in result)) throw new Error(JSON.stringify(result.findings));
    const nodes = result.config.stages.flatMap((stage) => stage.nodes);
    expect(nodes.find((node) => node.nodeId === 'n_c')?.bindings?.message).toEqual({ firstOf: ['nodes.n_b.outputs.text', 'nodes.n_a.outputs.text'] });

    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(SCHEMA);
    if (!validate(result.config)) throw new Error(JSON.stringify(validate.errors, null, 2));
  });

  it('an authored-only shape (firstOf with one path) is refused by the schema', () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validateBinding = ajv.compile({ $defs: SCHEMA.$defs, $ref: '#/$defs/compiledBinding' });
    expect(validateBinding({ firstOf: ['only.one'] })).toBe(false);
    expect(validateBinding({ from: 'a', value: 1 })).toBe(false);
    expect(validateBinding({ from: 'nodes.a.outputs.text' })).toBe(true);
  });
});
