/**
 * TASK-806 lane A — the TARGET NODE CATALOGUE (TASK-809 DD-6/DD-9), the `guard.*` node types
 * (DD-7) and the four contract corrections that ride with them.
 *
 * Everything asserted here was an OPEN ITEM at the end of TASK-809 (§2z "Open owner decisions
 * surfaced") or a §10 lane-status gap. Each `describe` names the item it closes so a reader can
 * go back to the ticket rather than guess why the assertion exists.
 */
import { describe, expect, it } from 'vitest';
import { NODE_CONFIG_SCHEMAS } from '../node-config-schemas';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';
import { isValidConnection, nodeDescriptorContractProblems, workflowPublishProblems } from '../port-validation';
import { TERMINOLOGY_PURPOSE_SCOPES } from '../node-config-schemas';

const REGISTRY = WORKFLOW_NODE_REGISTRY;

/** DD-9's target catalogue, verbatim, plus DD-6's pre-summarization entry and the
 *  DNA-redaction node TASK-815 §11 turns from a resolver flag into a node. */
const AGENT_CATALOGUE = [
  'agent.transcription',
  'agent.normalization',
  'agent.ner',
  'agent.presummarization',
  'agent.summarization',
  'agent.discharge_summary',
  'agent.retrieval',
  'agent.feedback',
  'agent.dna_redaction',
] as const;

const GUARD_CATALOGUE = ['guard.phi', 'guard.moderation', 'guard.groundedness'] as const;

describe('DD-9 — the nine-node agent.* catalogue is registered', () => {
  it.each(AGENT_CATALOGUE)('%s is a registered, implemented node type', (key) => {
    const descriptor = REGISTRY[key];
    expect(descriptor, `${key} is missing from WORKFLOW_NODE_REGISTRY`).toBeDefined();
    expect(descriptor.implemented).toBe(true);
    expect(descriptor.configSchema, `${key} must carry a config schema`).toBeDefined();
    expect(nodeDescriptorContractProblems(descriptor)).toEqual([]);
  });

  it('DD-6 — pre-summarization runs on-start over ADMIN-SELECTED CONTEXT, never the transcript', () => {
    const node = REGISTRY['agent.presummarization'];
    expect(node.trigger).toBe('on-start');
    expect(node.inputs.filter((p) => p.primitive !== 'control').map((p) => [p.name, p.primitive])).toEqual([['in', 'context<schemaRef>']]);
    expect(node.outputs.filter((p) => p.primitive !== 'control').map((p) => [p.name, p.primitive])).toEqual([['out', 'document']]);
    // The anti-laundering rule holds for the new catalogue too: a transcript producer cannot
    // satisfy a `context<schemaRef>` consumer, and a pre-summary document cannot reach NER.
    expect(isValidConnection('agent.transcription', 'out', 'agent.presummarization', 'in')).toBe(false);
    expect(isValidConnection('agent.presummarization', 'out', 'agent.ner', 'in')).toBe(false);
  });

  it('DD-9 — three palette entries, ONE generation engine: they differ only in trigger/ports', () => {
    const trio = ['agent.presummarization', 'agent.summarization', 'agent.discharge_summary'].map((k) => REGISTRY[k]);
    for (const node of trio) {
      expect(node.classes).toContain('generation');
      expect(node.outputs.some((p) => p.primitive === 'document')).toBe(true);
    }
    expect(trio.map((n) => n.trigger)).toEqual(['on-start', 'on-end', 'on-end']);
  });

  it('every agent.* node is discoverable in the consultation palette rail', () => {
    for (const key of AGENT_CATALOGUE) expect(REGISTRY[key].paletteKey).toBe('consultation');
  });
});

describe('DD-7 / item 17 — the guard.* node types exist and requires[] gates something', () => {
  it.each(GUARD_CATALOGUE)('%s is a registered, implemented node type', (key) => {
    const descriptor = REGISTRY[key];
    expect(descriptor, `${key} is missing from WORKFLOW_NODE_REGISTRY`).toBeDefined();
    expect(descriptor.implemented).toBe(true);
    expect(descriptor.classes).toContain('guard');
    // A guard is palette-agnostic: it attaches to a generation node in ANY palette.
    expect(descriptor.paletteKey).toBeNull();
    expect(nodeDescriptorContractProblems(descriptor)).toEqual([]);
  });

  it('every generation entry of the new catalogue REQUIRES a groundedness guard', () => {
    for (const key of ['agent.presummarization', 'agent.summarization', 'agent.discharge_summary']) {
      expect(REGISTRY[key].requires, key).toContain('guard.groundedness');
    }
  });

  it('agent.transcription REQUIRES a PHI guard', () => {
    expect(REGISTRY['agent.transcription'].requires).toContain('guard.phi');
  });

  it('publish REFUSES a graph whose agent.summarization has no guard attached to THAT instance', () => {
    const graph = {
      version: 1,
      nodes: [
        { id: 'n_prompt', type: 'prompt.template_ref', config: {} },
        { id: 'n_sum', type: 'agent.summarization', config: {} },
      ],
      edges: [{ id: 'e1', from: 'n_prompt', fromPort: 'out', to: 'n_sum', toPort: 'in' }],
    };
    const problems = workflowPublishProblems(graph as never);
    expect(problems.some((p) => p.includes('guard.groundedness'))).toBe(true);
  });

  it('publish ACCEPTS the same graph once a guard.groundedness node is wired to that instance', () => {
    const graph = {
      version: 1,
      nodes: [
        { id: 'n_prompt', type: 'prompt.template_ref', config: {} },
        { id: 'n_sum', type: 'agent.summarization', config: {} },
        { id: 'n_guard', type: 'guard.groundedness', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'n_prompt', fromPort: 'out', to: 'n_sum', toPort: 'in' },
        { id: 'e2', from: 'n_sum', fromPort: 'out', to: 'n_guard', toPort: 'in' },
      ],
    };
    expect(workflowPublishProblems(graph as never)).toEqual([]);
  });
});

describe('item 7 — descriptor.lane tells the truth about which runtime executes a node', () => {
  const REALTIME = ['consultation.captureBinding', 'consultation.extractEntities', 'consultation.realtimeSummary'];

  it.each(REALTIME)('%s is declared lane:realtime — the runtime that actually executes it', (key) => {
    expect(REGISTRY[key].lane).toBe('realtime');
  });

  it('a realtime node MAY declare externalWrite — publishing the running note IS its product', () => {
    // The TASK-809 rule "a realtime node MUST NOT be externalWrite" was falsified by the
    // runtime TASK-811 shipped: two of the three nodes the realtime executor implements write.
    expect(REGISTRY['consultation.realtimeSummary'].externalWrite).toBe(true);
    expect(nodeDescriptorContractProblems(REGISTRY['consultation.realtimeSummary'])).toEqual([]);
  });

  it('a realtime node MUST still be idempotent — the realtime executor retries per maxAttempts', () => {
    for (const key of REALTIME) expect(REGISTRY[key].idempotent).toBe(true);
    const problems = nodeDescriptorContractProblems({ ...REGISTRY['consultation.realtimeSummary'], idempotent: false });
    expect(problems.some((p) => p.includes('idempotent'))).toBe(true);
  });

  it('the realtime lane is exactly the three pipeline nodes plus their catalogue entries', () => {
    const realtime = Object.values(REGISTRY)
      .filter((d) => d.lane === 'realtime')
      .map((d) => d.key)
      .sort();
    // `agent.transcription`/`agent.ner` delegate to the capture/extraction engines, so they
    // belong to the runtime that actually executes those — anything else would declare a split
    // no runtime enforces.
    // Lane R (R1) adds `agent.grammar`: the live grammar/spelling pass has no pipeline
    // counterpart, because `consultation.proposeCorrections` stays DURABLE (it reviews the
    // finished note in the seeded graphs) and one node type cannot serve both runtimes.
    expect(realtime).toEqual([...REALTIME, 'agent.transcription', 'agent.ner', 'agent.grammar'].sort());
  });
});

describe('item 5 — the palette-agnostic runtime knobs compileNode reads are AUTHORABLE', () => {
  // `compiler.ts` reads `config.timeoutSeconds`, `config.retry` and `config.onError` off EVERY
  // node, yet no schema declared the first two and every schema is `additionalProperties:false`,
  // so an admin could not author them and a graph carrying them failed publish.
  const ACTIVITY_SCHEMAS = Object.entries(NODE_CONFIG_SCHEMAS).filter(([key]) => key !== 'consultation.hitlGate');

  it.each(ACTIVITY_SCHEMAS.map(([key]) => key))('%s declares timeoutSeconds and retry', (key) => {
    const properties = NODE_CONFIG_SCHEMAS[key].properties as Record<string, unknown>;
    expect(properties.timeoutSeconds, `${key} does not declare timeoutSeconds`).toBeDefined();
    expect(properties.retry, `${key} does not declare retry`).toBeDefined();
  });

  it('every schema that declares timeoutSeconds keeps additionalProperties:false', () => {
    for (const [key, schema] of Object.entries(NODE_CONFIG_SCHEMAS)) {
      expect(schema.additionalProperties, key).toBe(false);
    }
  });
});

describe('item 19 — bindTerminology.purposeScope draws from a closed taxonomy', () => {
  it('the schema constrains purposeScope to the enum', () => {
    const schema = NODE_CONFIG_SCHEMAS['consultation.bindTerminology'];
    const purposeScope = (schema.properties as Record<string, { enum?: readonly string[] }>).purposeScope;
    expect(purposeScope.enum).toEqual([...TERMINOLOGY_PURPOSE_SCOPES]);
  });

  it('every value is a ConsentPurpose member, verbatim — the correspondence must be unmistakable', () => {
    // Mirrors `ConsentPurpose` in `packages/database/src/prisma/db_main/enums.prisma`, minus
    // STYLE_LEARNING, which authorizes no outbound tool call.
    for (const value of TERMINOLOGY_PURPOSE_SCOPES) expect(value).toMatch(/^[A-Z][A-Z_]+$/);
    expect(TERMINOLOGY_PURPOSE_SCOPES).not.toContain('STYLE_LEARNING');
  });

  it('carries the purpose this node`s own egress already asks consent for', () => {
    // `call_mcp_tool` — the call `consultation.bindTerminology` makes — checks
    // `purpose="EXTERNAL_TOOL_LOOKUP"` (apps/harness/.../activities.py:1092).
    expect(TERMINOLOGY_PURPOSE_SCOPES).toContain('EXTERNAL_TOOL_LOOKUP');
  });
});

describe('item 18 — consultation.assemblePrompt declares only the inputs its activity reads', () => {
  it('declares ONE data input: the retrieved-evidence context it now folds into the prompt', () => {
    const node = REGISTRY['consultation.assemblePrompt'];
    expect(node.inputs.filter((p) => p.primitive !== 'control').map((p) => [p.name, p.primitive])).toEqual([['in', 'context<schemaRef>']]);
  });

  it('no longer declares a transcript input — the gateway assembles the transcript server-side', () => {
    expect(REGISTRY['consultation.assemblePrompt'].inputs.some((p) => p.name === 'transcript')).toBe(false);
  });
});
