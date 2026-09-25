/**
 * TASK-1006 (A-2) — the consultation graphs accept a FINISHED transcript as well as live audio.
 *
 * A client that transcribed a recording itself (ALaaS's queued / uploaded recordings, on the
 * unbound plane) sends the text on the trigger's `transcript` kind (`{ text }`). The trigger's one
 * data socket is `context<schemaRef>`, which widens to `object` and never to `text`, so
 * `n_transcript` — a `core.data` reshape, `in.transcript.text -> text` — lifts it onto
 * `core.data`'s `text` socket and into `n_ner.in`, the socket `n_asr.transcript` feeds on the live
 * path. `n_ner.out` then carries it to every summarizer, exactly as for a recording.
 *
 * `transcript` is its own kind, never `work_note`: a work note is the clinician's own writing.
 * The engine half (validate / compile / publish gate) is proven by `task-930-workflow-seeds.test.ts`
 * re-running the regen script; the runtime half by the harness suite
 * (`test_consultation_transcript_ingress_task1006.py`).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CONSULTATION_TRANSCRIPT_KIND,
  CONSULTATION_TRANSCRIPT_KIND_KEY,
  NOTE_CONTEXT_SCHEMA_DEFINITION,
  payloadSchemaFromDefinition,
} from '../07e-consultation-note-context-schema';
import { ARCAAI_CONSULTATION_SCRIBE_DEFINITION } from '../07g-arcaai-two-schemas';
import { WORKFLOW_LIBRARY_TARGETS, type SeedGraph } from '../28-workflow-library';
import { ARCAAI_WORKFLOW_TARGETS } from '../29-arcaai-agents-and-workflows';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIST = path.resolve(HERE, '../../../../../../workflow-contract/dist/index.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const contract: any = await import(/* @vite-ignore */ CONTRACT_DIST);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const kindOf = (definition: Record<string, unknown>, key: string) =>
  (definition.kinds as Array<Record<string, any>>).find((kind) => kind.key === key);

const CONSULTATION_TARGETS = [...WORKFLOW_LIBRARY_TARGETS, ...ARCAAI_WORKFLOW_TARGETS].filter((target) => target.slug.endsWith('-consultation'));
const edgeTuples = (graph: SeedGraph) => graph.edges.map((edge) => [edge.from, edge.fromPort, edge.to, edge.toPort].join(' '));

describe('the `transcript` kind', () => {
  it('is ONE declaration, shared by reference by the note-context schema and the ArcaAI scribe', () => {
    expect(CONSULTATION_TRANSCRIPT_KIND_KEY).toBe('transcript');
    expect(kindOf(NOTE_CONTEXT_SCHEMA_DEFINITION, 'transcript')).toBe(CONSULTATION_TRANSCRIPT_KIND);
    expect(kindOf(ARCAAI_CONSULTATION_SCRIBE_DEFINITION, 'transcript')).toBe(CONSULTATION_TRANSCRIPT_KIND);
    expect(CONSULTATION_TRANSCRIPT_KIND).toMatchObject({ primitive: 'TEXT', cardinality: 'ONE', producedBy: ['CLIENT'], phiClass: 'PHI' });
  });

  it('leaves `work_note` meaning the clinician’s own notes', () => {
    for (const definition of [NOTE_CONTEXT_SCHEMA_DEFINITION, ARCAAI_CONSULTATION_SCRIBE_DEFINITION]) {
      expect(kindOf(definition, 'work_note')?.description).toBe("The clinician's own working notes for this consultation.");
    }
  });

  it('is an OPTIONAL property of both derived trigger payload schemas', () => {
    for (const definition of [NOTE_CONTEXT_SCHEMA_DEFINITION, ARCAAI_CONSULTATION_SCRIBE_DEFINITION]) {
      const payload = payloadSchemaFromDefinition(definition) as { properties: Record<string, unknown>; required?: string[] };
      expect(payload.properties.transcript).toEqual({ type: 'object' });
      expect(payload.required ?? []).not.toContain('transcript');
    }
  });
});

describe('every consultation graph reads the caller’s transcript where it reads the live one', () => {
  it('covers the eleven ArcaAI graphs and both library copies', () => {
    expect(CONSULTATION_TARGETS).toHaveLength(13);
  });

  it.each(CONSULTATION_TARGETS.map((target) => [target.key, target] as const))('%s', (_key, target) => {
    const node = target.graph.nodes.find((candidate) => candidate.id === 'n_transcript');
    expect(node).toEqual({ id: 'n_transcript', type: 'core.data', config: { mappings: [{ from: 'in.transcript.text', to: 'text' }] } });

    const tuples = edgeTuples(target.graph);
    // Both sources feed the SAME socket; the live one is untouched.
    expect(tuples).toContain('n_asr transcript n_ner in');
    expect(tuples).toContain('n_trigger out n_transcript in');
    expect(tuples).toContain('n_transcript text n_ner in');
    // Nothing else touches the reshape, and it feeds nothing but NER.
    expect(tuples.filter((tuple) => tuple.includes('n_transcript'))).toEqual(['n_trigger out n_transcript in', 'n_transcript text n_ner in']);
    // Appended LAST, so every pre-existing edge id is unchanged.
    expect(target.graph.edges.slice(-2).map((edge) => `${edge.from}->${edge.to}`)).toEqual(['n_trigger->n_transcript', 'n_transcript->n_ner']);

    // The port lattice accepts both new edges (the regen script's publish gate runs the same check).
    expect(contract.workflowEdgePortProblems(target.graph)).toEqual([]);
  });
});
