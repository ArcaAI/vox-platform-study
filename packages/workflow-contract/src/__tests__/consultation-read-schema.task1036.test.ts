/**
 * TASK-1036 §9.3 (OD-30/31/34) — the platform-owned `consultation.*` read schema, its PHI classes,
 * the declared-read extraction, and the flat-alias map for the one-release deprecation.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSULTATION_READ_SCHEMA_V1,
  CONSULTATION_READ_SCHEMA_VERSION,
  PLATFORM_CONTEXT_ALIASES,
  consultationPathInfo,
  consultationReadPaths,
  declaredConsultationReads,
} from '../consultation-read-schema';
import type { WorkflowGraph } from '../graph-model';
import { PLATFORM_CONTEXT_VARIABLES } from '../platform-context-variables';

type Schema = Record<string, unknown>;

/** Every LEAF (a schema that is neither an object with properties nor an array), with its pointer. */
function leaves(schema: Schema, pointer = ''): Array<{ pointer: string; schema: Schema }> {
  const properties = schema.properties as Record<string, Schema> | undefined;
  if (properties !== undefined) return Object.entries(properties).flatMap(([key, child]) => leaves(child, `${pointer}/${key}`));
  if (schema.type === 'array' && schema.items !== undefined) return leaves(schema.items as Schema, `${pointer}/[]`);
  return [{ pointer, schema }];
}

describe('CONSULTATION_READ_SCHEMA_V1', () => {
  it('is versioned', () => {
    expect(CONSULTATION_READ_SCHEMA_VERSION).toBe(1);
    expect(CONSULTATION_READ_SCHEMA_V1.$id).toContain('v1');
  });

  it('declares every field §9.3 names', () => {
    const top = Object.keys(CONSULTATION_READ_SCHEMA_V1.properties as Record<string, unknown>);
    for (const field of [
      'id',
      'visitType',
      'department',
      'language',
      'patient',
      'clinician',
      'transcript',
      'items',
      'notes',
      'vitals',
      'testResults',
      'previousVisits',
    ]) {
      expect(top).toContain(field);
    }
    expect(consultationPathInfo('consultation.patient.age')).toBeDefined();
    expect(consultationPathInfo('consultation.patient.gender')).toBeDefined();
    expect(consultationPathInfo('consultation.patient.dob')).toBeDefined();
    expect(consultationPathInfo('consultation.clinician.dna.style')).toBeDefined();
    expect(consultationPathInfo('consultation.clinician.dna.rules')).toBeDefined();
    expect(consultationPathInfo('consultation.transcript.text')).toBeDefined();
    expect(consultationPathInfo('consultation.transcript.segments')).toBeDefined();
    expect(consultationPathInfo('consultation.notes.preSummary')).toBeDefined();
    expect(consultationPathInfo('consultation.notes.summary')).toBeDefined();
  });

  it('every LEAF carries x-phiClass PHI or NON_PHI', () => {
    const all = leaves(CONSULTATION_READ_SCHEMA_V1 as Schema);
    expect(all.length).toBeGreaterThan(20);
    for (const leaf of all) expect(['PHI', 'NON_PHI'], leaf.pointer).toContain(leaf.schema['x-phiClass']);
  });

  it('patient demographics, transcript, notes and test values are PHI; ids and codes are not', () => {
    expect(consultationPathInfo('consultation.patient.age')?.phiClass).toBe('PHI');
    expect(consultationPathInfo('consultation.transcript.text')?.phiClass).toBe('PHI');
    expect(consultationPathInfo('consultation.notes.summary')?.phiClass).toBe('PHI');
    expect(consultationPathInfo('consultation.clinician.dna.rules')?.phiClass).toBe('PHI');
    expect(consultationPathInfo('consultation.id')?.phiClass).toBe('NON_PHI');
    expect(consultationPathInfo('consultation.visitType')?.phiClass).toBe('NON_PHI');
    expect(consultationPathInfo('consultation.clinician.dna.style')?.phiClass).toBe('NON_PHI');
  });

  it('a container is PHI when any field beneath it is', () => {
    expect(consultationPathInfo('consultation.patient')).toMatchObject({ type: 'json', phiClass: 'PHI' });
    expect(consultationPathInfo('consultation.items')?.type).toBe('list<json>');
    expect(consultationPathInfo('consultation.items')?.phiClass).toBe('PHI');
  });

  it('types paths in the node I/O vocabulary, and answers undefined for an unknown path', () => {
    expect(consultationPathInfo('consultation.patient.age')?.type).toBe('number');
    expect(consultationPathInfo('consultation.patient.dob')?.type).toBe('date');
    expect(consultationPathInfo('consultation.transcript.text')?.type).toBe('text');
    expect(consultationPathInfo('consultation.patient.shoeSize')).toBeUndefined();
    expect(consultationPathInfo('context.patient')).toBeUndefined();
  });

  it('consultationReadPaths lists every addressable path in document order, under the `consultation` root', () => {
    const paths = consultationReadPaths().map((entry) => entry.path);
    expect(paths[0]).toBe('consultation.id');
    expect(paths).toContain('consultation.patient.age');
    expect(paths.every((path) => path.startsWith('consultation.'))).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('declaredConsultationReads', () => {
  const graph: WorkflowGraph = {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['consultation'] } },
      {
        id: 'n_a',
        type: 'core.agent',
        config: {
          agentRef: { slug: 'x' },
          inputs: {
            message: { template: 'Age {{consultation.patient.age}}, sex {{ consultation.patient.gender }}' },
            context: { from: 'consultation.notes.preSummary', at: 'runStart' },
          },
          overrides: { promptVariables: { dob: '{{consultation.patient.dob}}', plain: '{{context.x}}' } },
        },
      },
      { id: 'n_b', type: 'core.agent', config: { agentRef: { slug: 'y' }, inputs: { message: { from: 'nodes.n_a.outputs.text' } } } },
      { id: 'n_output', type: 'core.output', config: {} },
    ],
    edges: [],
  };

  it('collects every consultation.* path a node references — bindings AND templates anywhere in its config', () => {
    const reads = declaredConsultationReads(graph);
    expect(reads.n_a).toEqual([
      { path: 'consultation.notes.preSummary', at: 'runStart' },
      { path: 'consultation.patient.age', at: 'nodeStart' },
      { path: 'consultation.patient.dob', at: 'nodeStart' },
      { path: 'consultation.patient.gender', at: 'nodeStart' },
    ]);
    expect(reads.n_b).toBeUndefined();
    expect(Object.keys(reads)).toEqual(['n_a']);
  });

  it('a node-start read wins over a run-start read of the same path (the fresher snapshot is the declared one)', () => {
    const twice: WorkflowGraph = {
      ...graph,
      nodes: [
        {
          id: 'n_a',
          type: 'core.agent',
          config: {
            agentRef: { slug: 'x' },
            inputs: { message: { from: 'consultation.transcript.text', at: 'runStart' }, context: { from: 'consultation.transcript.text' } },
          },
        },
      ],
    };
    expect(declaredConsultationReads(twice).n_a).toEqual([{ path: 'consultation.transcript.text', at: 'nodeStart' }]);
  });
});

describe('PLATFORM_CONTEXT_ALIASES — the 11 flat context names, mapped for the one-release deprecation', () => {
  it('maps exactly the 11 platform context variables', () => {
    expect(Object.keys(PLATFORM_CONTEXT_ALIASES).sort()).toEqual(PLATFORM_CONTEXT_VARIABLES.map((entry) => entry.path).sort());
  });

  it('every alias targets a real consultation path and states its formatting', () => {
    for (const [alias, entry] of Object.entries(PLATFORM_CONTEXT_ALIASES)) {
      expect(consultationPathInfo(entry.path), alias).toBeDefined();
      expect(entry.formatting.length, alias).toBeGreaterThan(0);
    }
    expect(PLATFORM_CONTEXT_ALIASES['context.safe_age']?.path).toBe('consultation.patient.age');
    expect(PLATFORM_CONTEXT_ALIASES['context.safe_age']?.formatting).toContain('Unknown');
  });

  it('keeps the PHI class the flat variable declared', () => {
    for (const variable of PLATFORM_CONTEXT_VARIABLES) {
      const target = consultationPathInfo(PLATFORM_CONTEXT_ALIASES[variable.path]?.path ?? '');
      expect(target?.phiClass, variable.path).toBe(variable.phiClass);
    }
  });
});
