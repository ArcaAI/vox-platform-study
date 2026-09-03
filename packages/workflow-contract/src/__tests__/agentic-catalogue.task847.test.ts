/**
 * the GENERIC node catalogue (`agentic.*`), the eight node types the owner's
 * specification names.
 *
 * This file is the have/missing table of program finding F-12 turned into assertions. Everything
 * it checks is a CONTRACT property, not an implementation detail: what the eight types are, what
 * they may be wired to, and — the single most important review item in Track D — what their
 * config schemas are structurally incapable of holding.
 *
 * The fixed-purpose `agent.*` catalogue stays registered and untouched (ticket step 1: *"do not
 * delete the fixed types in this ticket"*), so this file also pins that both live side by side.
 */
import { describe, expect, it } from 'vitest';
// Namespace imports throughout — see the note in `port-kinds.task847.test.ts`: a named import of
// a not-yet-exported symbol hangs the runner instead of failing, which makes RED unobservable.
import * as configSchemas from '../node-config-schemas';
import * as nodePorts from '../node-ports';
import * as agenticContract from '../agentic-contract';
import * as nodeRegistry from '../node-registry';
import * as portModel from '../port-model';

const { NODE_CONFIG_SCHEMAS } = configSchemas;
const { NODE_PORTS } = nodePorts;
const { AGENTIC_NODE_TYPES, AGENTIC_PALETTE_KEY, WORKFLOW_NODE_REGISTRY, nodeInfo, paletteOf } = nodeRegistry;
const { portPrimitiveSatisfies } = portModel;

/** Every key the ticket's eight node types occupy. */
const EXPECTED_KEYS = [
  'agentic.input',
  'agentic.output',
  'agentic.agent',
  'agentic.guardrail',
  'agentic.data',
  'agentic.loop',
  'agentic.stt',
  'agentic.tts',
] as const;

function schemaOf(key: string): Record<string, unknown> {
  const schema = NODE_CONFIG_SCHEMAS[key];
  expect(schema, `${key} must carry a config schema`).toBeDefined();
  return schema as Record<string, unknown>;
}

function propertiesOf(key: string): Record<string, Record<string, unknown>> {
  return (schemaOf(key).properties ?? {}) as Record<string, Record<string, unknown>>;
}

describe('the eight generic node types exist', () => {
  it('registers all eight, under one palette', () => {
    expect([...AGENTIC_NODE_TYPES].sort()).toEqual([...EXPECTED_KEYS].sort());
    for (const key of EXPECTED_KEYS) {
      expect(WORKFLOW_NODE_REGISTRY[key], `${key} missing from the registry`).toBeDefined();
      expect(paletteOf(key)).toBe(AGENTIC_PALETTE_KEY);
    }
  });

  it('leaves the fixed-purpose agent.* catalogue in place — this ticket adds, never replaces', () => {
    for (const legacy of ['agent.summarization', 'agent.ner', 'agent.transcription', 'agent.grammar']) {
      expect(WORKFLOW_NODE_REGISTRY[legacy], `${legacy} must survive`).toBeDefined();
      expect(paletteOf(legacy)).toBe('consultation');
    }
  });

  it('makes every one of them compilable — an unimplemented type is refused by compile()', () => {
    for (const key of EXPECTED_KEYS) {
      expect(nodeInfo(key), `${key} must resolve for the compiler`).toBeDefined();
    }
  });

  it('declares ports for every one of them', () => {
    for (const key of EXPECTED_KEYS) {
      const ports = NODE_PORTS[key];
      expect(ports, `${key} must declare ports`).toBeDefined();
      expect(ports.inputs.length + ports.outputs.length).toBeGreaterThan(0);
    }
  });

  it('runs every one of them on the DURABLE lane, and therefore idempotently', () => {
    for (const key of EXPECTED_KEYS) {
      const descriptor = WORKFLOW_NODE_REGISTRY[key];
      expect(descriptor.lane).toBe('durable');
      expect(descriptor.idempotent).toBe(true);
    }
  });
});

describe('the audio boundary is a type, not a convention', () => {
  it('takes a STORED artifact into `agentic.stt`, never a live stream', () => {
    const input = NODE_PORTS['agentic.stt'].inputs.find((port) => port.name === 'in');
    expect(input?.primitive).toBe('audio');
    // The realtime lane's `stream<audio>` cannot reach it. That refusal is the determinism
    // boundary: per-frame audio never enters a Temporal workflow.
    expect(portPrimitiveSatisfies('stream<audio>', 'audio')).toBe(false);
  });

  it('emits a stored artifact from `agentic.tts`', () => {
    const output = NODE_PORTS['agentic.tts'].outputs.find((port) => port.name === 'out');
    expect(output?.primitive).toBe('audio');
    expect(output?.outputKey).toBeTruthy();
  });
});

describe('the agent node binds ONE provider configuration, by reference', () => {
  it('accepts a routing-policy id and a task key, and nothing that identifies a provider', () => {
    const properties = propertiesOf('agentic.agent');
    const ref = properties.providerConfigRef as { properties?: Record<string, unknown> };
    expect(ref).toBeDefined();
    expect(Object.keys(ref.properties ?? {}).sort()).toEqual(['routingPolicyId', 'taskKey']);
  });

  it('carries the hyper-parameters the owner asked for, INCLUDING the two that did not exist', () => {
    const generation = propertiesOf('agentic.agent').generation as { properties?: Record<string, unknown> };
    expect(Object.keys(generation.properties ?? {}).sort()).toEqual(
      ['frequencyPenalty', 'maxTokens', 'presencePenalty', 'seed', 'stopSequences', 'temperature', 'topP'].sort(),
    );
  });

  it('binds guardrails on input and output as NODE references', () => {
    const guards = propertiesOf('agentic.agent').guards as { properties?: Record<string, unknown> };
    expect(Object.keys(guards.properties ?? {}).sort()).toEqual(['input', 'output']);
  });

  it('binds tools as an (mcpServerId, toolName) pair and NOTHING else', () => {
    const tools = propertiesOf('agentic.agent').tools as { items?: { properties?: Record<string, unknown> } };
    expect(Object.keys(tools.items?.properties ?? {}).sort()).toEqual(['mcpServerId', 'toolName']);
  });

  it('does not declare `taskKey` at the top level, so no second model-selection source is folded in', () => {
    // `withLlmBinding` attaches `llmBinding` to any schema declaring a top-level `taskKey`. The
    // generic agent's ONE selection source is `providerConfigRef`; a second would make "bind to
    // exactly one provider configuration" unenforceable.
    const properties = propertiesOf('agentic.agent');
    expect(properties.taskKey).toBeUndefined();
    expect(properties.llmBinding).toBeUndefined();
  });
});

describe('the loop node is bounded on all three axes', () => {
  it('requires iterations, time AND a cost ceiling', () => {
    const bounds = propertiesOf('agentic.loop').bounds as { required?: string[]; properties?: Record<string, unknown> };
    expect([...(bounds.required ?? [])].sort()).toEqual(['maxDurationSeconds', 'maxIterations', 'maxTotalTokens']);
    expect(Object.keys(bounds.properties ?? {})).toContain('noProgressIterations');
  });

  it('caps every bound, because an unbounded ceiling is not a ceiling', () => {
    const bounds = propertiesOf('agentic.loop').bounds as { properties?: Record<string, { maximum?: number; minimum?: number }> };
    for (const [name, spec] of Object.entries(bounds.properties ?? {})) {
      expect(spec.minimum, `${name} needs a floor`).toBeGreaterThan(0);
      expect(spec.maximum, `${name} needs a ceiling`).toBeGreaterThan(0);
    }
  });
});

describe('the duplicated guard set cannot drift from the registry', () => {
  it('matches the registry`s `guard`-classed types exactly', () => {
    // `agentic-contract.ts` keeps `GUARD_NODE_TYPES` as a literal set because `node-registry.ts`
    // imports `node-config-schemas.ts`, so a module the registry depends on cannot read
    // `classesOf()` back without closing an import cycle — the same reason
    // `MANDATORY_NODE_TYPES` is duplicated. A duplicated set needs a test, or it is just a copy.
    const registryGuards = Object.values(WORKFLOW_NODE_REGISTRY)
      .filter((descriptor) => descriptor.classes.includes('guard'))
      .map((descriptor) => descriptor.key)
      .sort();
    // `guardrail.check` is the summarization palette's guard and is `mandatory`-classed rather
    // than `guard`-classed, so it is named explicitly rather than derived.
    expect([...agenticContract.GUARD_NODE_TYPES_FOR_TEST].sort()).toEqual([...registryGuards, 'guardrail.check'].sort());
  });
});

describe('Input/Output/Data carry tenant-defined schemas', () => {
  it('gives the boundary nodes an `ioSchema`', () => {
    expect(propertiesOf('agentic.input').ioSchema).toBeDefined();
    expect(propertiesOf('agentic.output').ioSchema).toBeDefined();
  });

  it('gives the Data node the mappings that make it the tier-2 escape hatch', () => {
    const properties = propertiesOf('agentic.data');
    expect(properties.mappings).toBeDefined();
    expect(properties.outputSchema).toBeDefined();
  });
});
