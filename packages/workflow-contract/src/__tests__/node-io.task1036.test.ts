/**
 * TASK-1036 §9.1 (C0a) — the standard node I/O contract: `NODE_IO`, `agentNodeIO`, `typeFits`.
 */
import { describe, expect, it } from 'vitest';
import { ACTION_KEYS } from '../action-catalogue';
import { AGENT_IO_DEFAULTS } from '../agent-schemas';
import { effectivePorts } from '../core-contract';
import { CORE_NODE_TYPES } from '../node-registry';
import {
  IO_BASE_TYPES,
  NODE_IO,
  actionNodeIO,
  agentNodeIO,
  ioTypeOfJsonSchema,
  isIoType,
  nodeIOFor,
  typeFits,
  type NodeResultEnvelope,
} from '../node-io';

describe('NODE_IO — one declaration per core node type', () => {
  it('declares every one of the 11 core node types, and nothing else', () => {
    expect(Object.keys(NODE_IO).sort()).toEqual([...CORE_NODE_TYPES].sort());
    expect(Object.keys(NODE_IO)).toHaveLength(11);
  });

  it('types every field from the closed vocabulary, and describes it', () => {
    for (const [type, io] of Object.entries(NODE_IO)) {
      for (const [name, field] of [...Object.entries(io.inputs), ...Object.entries(io.outputs)]) {
        expect(isIoType(field.type), `${type}.${name}: ${field.type}`).toBe(true);
        expect(field.description.length, `${type}.${name}`).toBeGreaterThan(0);
      }
    }
  });

  it('trigger has no inputs and publishes `context`; note has no I/O; output has no outputs', () => {
    expect(NODE_IO['core.trigger']?.inputs).toEqual({});
    expect(Object.keys(NODE_IO['core.trigger']?.outputs ?? {})).toEqual(['context']);
    expect(NODE_IO['core.note']).toEqual({ inputs: {}, outputs: {} });
    expect(NODE_IO['core.output']?.outputs).toEqual({});
  });

  it('every NON-agent output field name is the runtime outputKey of a declared DATA port (legacy translation stays faithful)', () => {
    for (const type of CORE_NODE_TYPES) {
      if (type === 'core.agent' || type === 'core.action') continue;
      const keys = new Set(
        effectivePorts(type, {})
          .outputs.filter((port) => port.primitive !== 'control')
          .map((port) => port.outputKey),
      );
      const declared = Object.keys(NODE_IO[type]?.outputs ?? {}).filter((name) => name !== 'input');
      for (const name of declared) expect(keys.has(name), `${type}.outputs.${name}`).toBe(true);
    }
  });

  it('every NON-agent input field is a declared DATA input port of the same name', () => {
    for (const type of CORE_NODE_TYPES) {
      if (type === 'core.agent' || type === 'core.action') continue;
      const ports = new Set(
        effectivePorts(type, {})
          .inputs.filter((port) => port.primitive !== 'control')
          .map((port) => port.name),
      );
      for (const name of Object.keys(NODE_IO[type]?.inputs ?? {})) expect(ports.has(name), `${type}.inputs.${name}`).toBe(true);
    }
  });

  it('the routers carry their input through as `input` (OD-19)', () => {
    expect(NODE_IO['core.condition']?.outputs.input?.type).toBe('any');
    expect(NODE_IO['core.classify']?.outputs.input?.type).toBe('any');
  });
});

describe('agentNodeIO — the agent task decides the sockets', () => {
  it('TEXT_GENERATION: message (text, required) + context (json, optional) -> text', () => {
    const io = agentNodeIO('TEXT_GENERATION');
    expect(io.inputs.message).toMatchObject({ type: 'text', required: true });
    expect(io.inputs.context).toMatchObject({ type: 'json', required: false });
    expect(Object.keys(io.outputs)).toEqual(['text']);
  });

  it('TEXT_GENERATION with a STRUCTURED output schema also publishes `data` carrying that schema', () => {
    const outputSchema = { type: 'object', required: ['case_note'], properties: { case_note: { type: 'string' } } };
    const io = agentNodeIO('TEXT_GENERATION', outputSchema);
    expect(Object.keys(io.outputs)).toEqual(['text', 'data']);
    expect(io.outputs.data).toMatchObject({ type: 'json', schema: outputSchema });
  });

  it('the default TEXT_GENERATION output schema ({text}) is NOT structured', () => {
    expect(Object.keys(agentNodeIO('TEXT_GENERATION', AGENT_IO_DEFAULTS.TEXT_GENERATION.outputSchema).outputs)).toEqual(['text']);
  });

  it('SPEECH_TO_TEXT: audio -> transcript, segments, language', () => {
    const io = agentNodeIO('SPEECH_TO_TEXT');
    expect(io.inputs).toEqual({ audio: expect.objectContaining({ type: 'audio', required: true }) });
    expect(Object.keys(io.outputs)).toEqual(['transcript', 'segments', 'language']);
    expect(io.outputs.transcript?.type).toBe('text');
    expect(io.outputs.segments?.type).toBe('list<segment>');
  });

  it('TEXT_TO_SPEECH: text -> audio, durationMs', () => {
    const io = agentNodeIO('TEXT_TO_SPEECH');
    expect(io.inputs.text).toMatchObject({ type: 'text', required: true });
    expect(io.outputs.audio?.type).toBe('audio');
    expect(io.outputs.durationMs?.type).toBe('number');
  });

  it('NAMED_ENTITY_RECOGNITION: text -> entities (+ the classified text, passed through)', () => {
    const io = agentNodeIO('NAMED_ENTITY_RECOGNITION');
    expect(io.inputs.text).toMatchObject({ type: 'text', required: true });
    expect(io.outputs.entities?.type).toBe('list<entity>');
    expect(io.outputs.text?.type).toBe('text');
  });

  it('nodeIOFor resolves an agent node through the resolver, and falls back to the union without one', () => {
    const node = { type: 'core.agent', config: { agentRef: { slug: 'medical-ner' } } };
    expect(Object.keys(nodeIOFor(node, { 'medical-ner': { task: 'NAMED_ENTITY_RECOGNITION' } })?.outputs ?? {})).toEqual(['entities', 'text']);
    expect(nodeIOFor(node)).toBe(NODE_IO['core.agent']);
    expect(nodeIOFor({ type: 'nope.unknown', config: {} })).toBeUndefined();
  });

  it('nodeIOFor resolves a core.action instance from its delegate ports', () => {
    for (const key of ACTION_KEYS) {
      const io = actionNodeIO(key);
      expect(io, key).toBeDefined();
      for (const field of [...Object.values(io?.inputs ?? {}), ...Object.values(io?.outputs ?? {})]) expect(isIoType(field.type)).toBe(true);
    }
    const phi = nodeIOFor({ type: 'core.action', config: { actionKey: 'guard.phi' } });
    expect(Object.keys(phi?.inputs ?? {})).toEqual(['in']);
    expect(Object.keys(phi?.outputs ?? {}).sort()).toEqual(['text', 'verdict']);
  });
});

describe('typeFits — match / convert / blocked', () => {
  it.each([
    ['text', 'text', 'match'],
    ['text', 'number', 'convert'],
    ['text', 'date', 'convert'],
    ['text', 'json', 'convert'],
    ['text', 'list<text>', 'convert'],
    ['text', 'boolean', 'convert'],
    ['json', 'text', 'match'],
    ['json', 'list<entity>', 'match'],
    ['any', 'audio', 'match'],
    ['text', 'audio', 'blocked'],
    ['text', 'file', 'blocked'],
    ['text', 'document', 'blocked'],
    ['audio', 'text', 'blocked'],
    ['document', 'text', 'blocked'],
    ['json', 'audio', 'blocked'],
    ['audio', 'audio', 'match'],
    ['list<entity>', 'list<entity>', 'match'],
    ['list<entity>', 'list<json>', 'blocked'],
    ['list<entity>', 'json', 'blocked'],
    ['list<json>', 'list<entity>', 'match'],
    ['number', 'text', 'blocked'],
    ['text', 'any', 'convert'],
    ['audio', 'any', 'blocked'],
  ] as const)('target %s <- source %s = %s', (target, source, expected) => {
    expect(typeFits(target, source)).toBe(expected);
  });

  it('the vocabulary is exactly the §9.1 one plus the consumer wildcard', () => {
    expect([...IO_BASE_TYPES].sort()).toEqual(['any', 'audio', 'boolean', 'date', 'document', 'file', 'json', 'number', 'text']);
    expect(isIoType('list<entity>')).toBe(true);
    expect(isIoType('list<list<text>>')).toBe(true);
    expect(isIoType('list<>')).toBe(false);
    expect(isIoType('object')).toBe(false);
  });
});

describe('ioTypeOfJsonSchema', () => {
  it.each([
    [{ type: 'string' }, 'text'],
    [{ type: 'string', format: 'date' }, 'date'],
    [{ type: 'string', format: 'date-time' }, 'date'],
    [{ type: 'integer' }, 'number'],
    [{ type: 'boolean' }, 'boolean'],
    [{ type: 'object' }, 'json'],
    [{ type: 'array', items: { type: 'string' } }, 'list<text>'],
    [{ type: ['string', 'null'] }, 'text'],
    [{}, 'json'],
  ])('%j -> %s', (schema, expected) => {
    expect(ioTypeOfJsonSchema(schema)).toBe(expected);
  });
});

describe('NodeResultEnvelope', () => {
  it('is the one shape every node returns', () => {
    const envelope: NodeResultEnvelope = {
      status: 'SUCCEEDED',
      outputs: { text: 'hello' },
      artifacts: [{ kind: 'audio', ref: 's3://bucket/key', mime: 'audio/wav', size: 10 }],
      usage: { tokens: 3, costUnits: 0 },
      timing: { startedAt: '2026-10-04T00:00:00.000Z', durationMs: 5 },
    };
    expect(envelope.status).toBe('SUCCEEDED');
  });
});
