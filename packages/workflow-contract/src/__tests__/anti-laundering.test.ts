/**
 * **`document -> transcript` is a TYPE ERROR.** The single most important test in this ticket.
 *
 * The rule, stated clinically: **the entity extractor must never see LLM-generated text, only
 * the raw transcript.** A model that hallucinates a drug name into a generated note, whose note
 * is then fed to the extractor, produces a coded, structured, persisted clinical entity with no
 * human utterance behind it — a hallucination LAUNDERED into the record with the authority of
 * structured data. Nothing downstream can tell it apart from an entity a clinician actually said.
 *
 * This file proves the rule is STRUCTURAL, not procedural. It is not enforced by a lint, a
 * review checklist, or a runtime guard that can be bypassed — it is enforced by the port type
 * lattice, which makes the edge unrepresentable:
 *
 *   - a generation step outputs `document`.
 *   - a transcript consumer (the redaction actions) accepts only `transcript`.
 *   - `transcript` and `document` are SIBLINGS under `text` in `WORKFLOW_PORT_SUPERTYPE`.
 *     Widening is one-directional, so a `document` can reach a `text` consumer (a guardrail
 *     legitimately checks generated prose) but can NEVER reach a `transcript` consumer, not
 *     directly and not through any chain of widenings.
 *
 * The last clause is the one that matters: a laundering path only needs ONE hole. So this file
 * asserts the property EXHAUSTIVELY over the whole port surface rather than on the one obvious
 * pair.
 *
 * ## What TASK-893 Phase 4 changed, and what it did NOT
 *
 * The node types this file used to name are gone. `consultation.extractEntities` and
 * `consultation.synthesize` are retired; the clinical steps that survive are ACTIONS behind
 * `core.action`, resolved per instance by `actionKey`, so every case below is expressed as an
 * action instance instead of a node type. The LATTICE is untouched, so the property is
 * untouched — and it is now asserted across BOTH port tables.
 *
 * One consequence is a genuine WEAKENING, pinned by its own test at the foot of this file rather
 * than left to be discovered: named-entity recognition is no longer a node type with a
 * `transcript`-typed socket. It is a `core.agent` whose resolved task is
 * `NAMED_ENTITY_RECOGNITION`, and an agent's data input is `text` — which `document` widens to.
 * The port lattice therefore no longer refuses `generated document -> NER`; only the runtime
 * task resolution does. That is a policy question for the agent contract, not a lattice bug.
 */
import { describe, expect, it } from 'vitest';
import { ACTION_PORTS, NODE_PORTS } from '../node-ports';
import { WORKFLOW_PORT_PRIMITIVES, portPrimitiveSatisfies } from '../port-model';
import type { WorkflowPortPrimitive } from '../port-model';
import { isValidConnection, workflowEdgePortProblems } from '../port-validation';

/** A generation step: prose a language model authored, not a human utterance. The assurance
 *  sensors take a draft document in and hand the (annotated) document back out. */
const GENERATION = { actionKey: 'consultation.sensors', action: {} } as const;
/** The redaction step: the one that consumes the verbatim record of what was actually said. */
const TRANSCRIPT_CONSUMER = { actionKey: 'consultation.phiHop', action: {} } as const;
/** The ASR agent: the only legitimate source of a `transcript`. */
const TRANSCRIPT_PRODUCER = { agentRef: { slug: 'asr-agent' } } as const;

describe('document -> transcript is a TYPE ERROR (the anti-hallucination-laundering rule)', () => {
  it('the transcript consumer accepts ONLY transcript on its data input', () => {
    const dataInputs = ACTION_PORTS['consultation.phiHop'].inputs.filter((port) => port.primitive !== 'control');
    expect(dataInputs.map((port) => port.primitive)).toEqual(['transcript']);
  });

  it('the generation step emits `document`, never `transcript`', () => {
    const dataOutputs = ACTION_PORTS['consultation.sensors'].outputs.filter((port) => port.primitive !== 'control');
    expect(dataOutputs.map((port) => port.primitive).sort()).toEqual(['document', 'verdict']);
    expect(dataOutputs.map((port) => port.primitive)).not.toContain('transcript');
  });

  it('REFUSES the connection generation[document] -> redaction[in]', () => {
    expect(
      isValidConnection('core.action', 'document', 'core.action', 'in', { fromNodeConfig: GENERATION, toNodeConfig: TRANSCRIPT_CONSUMER }),
    ).toBe(false);
  });

  it('reports it as an edge type error on an authored graph, naming both primitives', () => {
    const problems = workflowEdgePortProblems({
      version: 1,
      nodes: [
        { id: 'synth', type: 'core.action', config: GENERATION },
        { id: 'redact', type: 'core.action', config: TRANSCRIPT_CONSUMER },
      ],
      edges: [{ id: 'e1', from: 'synth', fromPort: 'document', to: 'redact', toPort: 'in' }],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('document');
    expect(problems[0]).toContain('transcript');
  });

  it('ALLOWS the legitimate edge asrAgent[transcript] -> redaction[in]', () => {
    expect(
      isValidConnection('core.agent', 'transcript', 'core.action', 'in', {
        fromNodeConfig: TRANSCRIPT_PRODUCER,
        toNodeConfig: TRANSCRIPT_CONSUMER,
      }),
    ).toBe(true);
    expect(
      workflowEdgePortProblems({
        version: 1,
        nodes: [
          { id: 'asr', type: 'core.agent', config: TRANSCRIPT_PRODUCER },
          { id: 'redact', type: 'core.action', config: TRANSCRIPT_CONSUMER },
        ],
        edges: [{ id: 'e1', from: 'asr', fromPort: 'transcript', to: 'redact', toPort: 'in' }],
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
        // `any` (TASK-864) is a CONSUMER-side wildcard, not a widening target: it accepts every
        // data primitive and satisfies nothing but itself, so it is a SINK of the closure, never a
        // step in it. `core-any-wildcard.test.ts` asserts that half; here it is skipped so the
        // widening chain is measured over the lattice alone.
        if (candidate === 'any') continue;
        if (portPrimitiveSatisfies(current, candidate)) queue.push(candidate);
      }
    }
    expect([...reachable].sort()).toEqual(['document', 'text']);
    expect(reachable.has('transcript')).toBe(false);
  });

  it('NO port anywhere can route a document into a transcript-typed input', () => {
    const tables = { ...NODE_PORTS, ...ACTION_PORTS };
    const documentProducers = Object.entries(tables).flatMap(([key, ports]) =>
      ports.outputs.filter((port) => port.primitive === 'document').map((port) => `${key}[${port.name}]`),
    );
    const transcriptConsumers = Object.entries(tables).flatMap(([key, ports]) =>
      ports.inputs.filter((port) => port.primitive === 'transcript').map((port) => `${key}[${port.name}]`),
    );
    // The property is vacuous if either side is empty — assert both exist before asserting the rule.
    expect(documentProducers.length).toBeGreaterThan(0);
    expect(transcriptConsumers.length).toBeGreaterThan(0);
    expect(portPrimitiveSatisfies('document', 'transcript')).toBe(false);
  });

  it('the ONLY producers of `transcript` are transcription/redaction steps, never a model author', () => {
    const tables = { ...NODE_PORTS, ...ACTION_PORTS };
    const transcriptProducers = Object.entries(tables)
      .filter(([, ports]) => ports.outputs.some((port) => port.primitive === 'transcript'))
      .map(([key]) => key)
      .sort();
    // `core.agent` is the ASR agent's home — the retired transcription node types were deprecated
    // in its favour. Its `transcript` socket is LIVE only for an agent whose task is
    // SPEECH_TO_TEXT: an LLM agent's activity emits `text`/`data` and never the `transcript` key,
    // so nothing model-authored can arrive on that socket at runtime.
    // `consultation.phiHop` is the redaction action — it takes a transcript in and hands a
    // redacted transcript out, which is a transformation of a human utterance, not an authoring
    // of one. (`guard.phi` shares the activity but is typed on `text`, so it is not a producer.)
    expect(transcriptProducers).toEqual(['consultation.phiHop', 'core.agent']);
  });

  /**
   * The weakening the vocabulary change introduces, asserted so it is a KNOWN fact rather than an
   * assumption someone reads off this file's title.
   *
   * Until Phase 4 the extractor was `consultation.extractEntities`, whose only data input was
   * `transcript`, so `document -> NER` was refused by the lattice. NER is now a `core.agent` with
   * `resolved.task === 'NAMED_ENTITY_RECOGNITION'`, and every agent's data input is `text`, which
   * `document` widens to by design (a guardrail must be able to read generated prose). So the
   * structural refusal no longer covers NER; what stands between a generated document and the
   * extractor is the agent's task resolution at runtime, not the port type.
   */
  it('KNOWN GAP: an agent-hosted extractor accepts `text`, so the lattice no longer refuses a document', () => {
    const agentDataInputs = NODE_PORTS['core.agent'].inputs.filter((port) => port.primitive !== 'control');
    expect(agentDataInputs.map((port) => port.primitive)).toContain('text');
    expect(agentDataInputs.map((port) => port.primitive)).not.toContain('transcript');
    expect(portPrimitiveSatisfies('document', 'text')).toBe(true);
    expect(
      isValidConnection('core.action', 'document', 'core.agent', 'in', {
        fromNodeConfig: GENERATION,
        toNodeConfig: { agentRef: { slug: 'ner-agent' } },
      }),
    ).toBe(true);
  });
});
