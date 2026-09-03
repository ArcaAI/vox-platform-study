/**
 * **`document -> ner` is a TYPE ERROR.** The single most important test in
 * this ticket.
 *
 * The rule, stated clinically: **NER must never see LLM-generated text, only the raw
 * transcript.** A model that hallucinates a drug name into a generated note, whose note is then
 * fed to the entity extractor, produces a coded, structured, persisted clinical entity with no
 * human utterance behind it — a hallucination LAUNDERED into the record with the authority of
 * structured data. Nothing downstream can tell it apart from an entity a clinician actually
 * said.
 *
 * This file proves the rule is STRUCTURAL, not procedural. It is not enforced by a lint, a
 * review checklist, or a runtime guard that can be bypassed — it is enforced by the port type
 * lattice, which makes the edge unrepresentable:
 *
 *   - `consultation.synthesize` (and every other generation node) outputs `document`.
 *   - `consultation.extractEntities` — the NER node (`interpreter.consultation_extract_entities`,
 *     which calls apps/nlp) — accepts only `transcript`.
 *   - `transcript` and `document` are SIBLINGS under `text` in `WORKFLOW_PORT_SUPERTYPE`.
 *     Widening is one-directional, so a `document` can reach a `text` consumer (a guardrail
 *     legitimately checks generated prose) but can NEVER reach a `transcript` consumer, not
 *     directly and not through any chain of widenings.
 *
 * The last clause is the one that matters: a laundering path only needs ONE hole. So this file
 * asserts the property EXHAUSTIVELY over the whole registry rather than on the one obvious
 * pair.
 */
import { describe, expect, it } from 'vitest';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';
import { WORKFLOW_PORT_PRIMITIVES, portPrimitiveSatisfies } from '../port-model';
import type { WorkflowPortPrimitive } from '../port-model';
import { isValidConnection, workflowEdgePortProblems } from '../port-validation';

/** The NER node: the one that turns clinical text into structured, codeable entities. */
const NER_NODE = 'consultation.extractEntities';
/** A generation node: prose a language model authored, not a human utterance. */
const GENERATION_NODE = 'consultation.synthesize';
/** The transcription node: the verbatim record of what was actually said. */
const TRANSCRIPT_NODE = 'consultation.captureBinding';

describe('document -> ner is a TYPE ERROR (the anti-hallucination-laundering rule)', () => {
  it('the NER node accepts ONLY transcript on its data input', () => {
    const ner = WORKFLOW_NODE_REGISTRY[NER_NODE];
    const dataInputs = ner.inputs.filter((port) => port.primitive !== 'control');
    expect(dataInputs.map((port) => port.primitive)).toEqual(['transcript']);
  });

  it('the generation node emits `document`, never `transcript`', () => {
    const generation = WORKFLOW_NODE_REGISTRY[GENERATION_NODE];
    const dataOutputs = generation.outputs.filter((port) => port.primitive !== 'control');
    expect(dataOutputs.map((port) => port.primitive)).toEqual(['document']);
  });

  it('REFUSES the connection consultation.synthesize[out] -> consultation.extractEntities[in]', () => {
    expect(isValidConnection(GENERATION_NODE, 'out', NER_NODE, 'in')).toBe(false);
  });

  it('reports it as an edge type error on an authored graph, naming both primitives', () => {
    const problems = workflowEdgePortProblems({
      version: 1,
      nodes: [
        { id: 'synth', type: GENERATION_NODE, config: {} },
        { id: 'ner', type: NER_NODE, config: {} },
      ],
      edges: [{ id: 'e1', from: 'synth', fromPort: 'out', to: 'ner', toPort: 'in' }],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('document');
    expect(problems[0]).toContain('transcript');
  });

  it('ALLOWS the legitimate edge consultation.captureBinding[out] -> consultation.extractEntities[in]', () => {
    expect(isValidConnection(TRANSCRIPT_NODE, 'out', NER_NODE, 'in')).toBe(true);
    expect(
      workflowEdgePortProblems({
        version: 1,
        nodes: [
          { id: 'capture', type: TRANSCRIPT_NODE, config: {} },
          { id: 'ner', type: NER_NODE, config: {} },
        ],
        edges: [{ id: 'e1', from: 'capture', fromPort: 'out', to: 'ner', toPort: 'in' }],
      }),
    ).toEqual([]);
  });

  it('cannot be laundered by widening — no chain of widenings takes document to transcript', () => {
    // Transitive closure of `portPrimitiveSatisfies` from `document`.
    const reachable = new Set<WorkflowPortPrimitive>();
    const queue: WorkflowPortPrimitive[] = ['document'];
    while (queue.length > 0) {
      const current = queue.pop() as WorkflowPortPrimitive;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const candidate of WORKFLOW_PORT_PRIMITIVES) {
        if (portPrimitiveSatisfies(current, candidate)) queue.push(candidate);
      }
    }
    expect([...reachable].sort()).toEqual(['document', 'text']);
    expect(reachable.has('transcript')).toBe(false);
  });

  it('NO node in the whole registry can route a document into any transcript-typed input', () => {
    const documentProducers = Object.values(WORKFLOW_NODE_REGISTRY).flatMap((descriptor) =>
      descriptor.outputs.filter((port) => port.primitive === 'document').map((port) => `${descriptor.key}[${port.name}]`),
    );
    const transcriptConsumers = Object.values(WORKFLOW_NODE_REGISTRY).flatMap((descriptor) =>
      descriptor.inputs.filter((port) => port.primitive === 'transcript').map((port) => `${descriptor.key}[${port.name}]`),
    );
    // The property is vacuous if either side is empty — assert both exist before asserting the rule.
    expect(documentProducers.length).toBeGreaterThan(0);
    expect(transcriptConsumers.length).toBeGreaterThan(0);
    expect(portPrimitiveSatisfies('document', 'transcript')).toBe(false);
  });

  it('every generation-classed node emits document (or a non-text product), never transcript', () => {
    const generators = Object.values(WORKFLOW_NODE_REGISTRY).filter((descriptor) => descriptor.classes.includes('generation'));
    expect(generators.length).toBeGreaterThan(0);
    for (const descriptor of generators) {
      for (const port of descriptor.outputs) {
        expect(port.primitive).not.toBe('transcript');
      }
    }
  });

  it('the ONLY producers of `transcript` are transcription/redaction nodes, never a model author', () => {
    const transcriptProducers = Object.values(WORKFLOW_NODE_REGISTRY)
      .filter((descriptor) => descriptor.outputs.some((port) => port.primitive === 'transcript'))
      .map((descriptor) => descriptor.key)
      .sort();
    // lane A — `agent.transcription` is the target catalogue's capture entry. It
    // belongs on this list for exactly the reason the list exists: it is a TRANSCRIPTION node,
    // not a generation node, and the loop below is what enforces that distinction.
    // `agentic.stt` joins the list, and the loop below is why that is safe rather
    // than merely expected: it is a TRANSCRIPTION node (it dispatches a batch ASR job and
    // publishes what the recogniser returned), it carries no `generation` class, and the
    // generic `agentic.agent` deliberately produces `text` rather than `transcript` precisely so
    // it can never appear here.
    expect(transcriptProducers).toEqual([
      'agent.transcription',
      'agentic.stt',
      'consultation.captureBinding',
      'consultation.phiHop',
      'stt.asrEngine',
      'stt.phiHop',
    ]);
    for (const key of transcriptProducers) {
      expect(WORKFLOW_NODE_REGISTRY[key].classes).not.toContain('generation');
    }
  });
});
