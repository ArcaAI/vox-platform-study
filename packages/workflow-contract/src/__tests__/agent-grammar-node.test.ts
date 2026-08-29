/**
 * Lane R (R1) — `agent.grammar`, the REALTIME grammar/spelling corrector.
 *
 * ## Why a sibling and not a lane flip on `consultation.proposeCorrections`
 *
 * `lane` is a property of the node TYPE, and the durable interpreter SKIPS a `realtime` node
 * (`workflow.py`, reason `realtime_lane`) so exactly one runtime owns a given node. There is
 * therefore no way for one type to serve both runtimes, and both uses are real:
 *
 *  - the seeded ArcaAI graphs wire `n_synth -> n_correct`, i.e. `consultation.proposeCorrections`
 *    reviews the FINISHED synthesized note on the durable path. Flipping its lane deletes that
 *    capability from every graph that already uses it;
 *  - the owner's live loop needs corrections over the RAW PARTIAL TRANSCRIPT, per turn, inside
 *    the flush budget.
 *
 * The two also want different INPUT TYPES, and the type is the safety property.
 * `consultation.proposeCorrections.in` is `text` precisely so it may review a generated note.
 * This node's `in` is `transcript`, which makes "the grammar pass corrects what was SAID, not
 * what the model WROTE" structural rather than a wiring convention.
 *
 * Its product is `edits`, which no extraction node consumes and which nothing here applies:
 * corrected transcript is ALWAYS ADVISORY alongside the raw. Promotion happens only through the
 * accepted-proposal path (DD-8) — `feedback.capture` / `agent.feedback` are the only `edits`
 * consumers that also write.
 */
import { describe, expect, it } from 'vitest';
import { NODE_CONFIG_SCHEMAS } from '../node-config-schemas';
import { NODE_PORTS } from '../node-ports';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';
import { portPrimitiveSatisfies } from '../port-model';
import { nodeDescriptorContractProblems } from '../port-validation';

const KEY = 'agent.grammar';

describe('agent.grammar — the realtime grammar/spelling corrector', () => {
  it('is registered, implemented, and delegates to a real interpreter activity', () => {
    const descriptor = WORKFLOW_NODE_REGISTRY[KEY];
    expect(descriptor).toBeDefined();
    expect(descriptor.implemented).toBe(true);
    expect(descriptor.activityName).toBe('interpreter.agent_grammar');
    expect(descriptor.paletteKey).toBe('consultation');
  });

  it('runs on the REALTIME lane, per turn — that is the whole point of the node', () => {
    const descriptor = WORKFLOW_NODE_REGISTRY[KEY];
    expect(descriptor.lane).toBe('realtime');
    expect(descriptor.trigger).toBe('per-turn');
  });

  it('PROPOSES and never applies: externalWrite is false, exactly as its durable sibling', () => {
    // A system that silently rewrites a drug name or a dose in clinical text is a patient-safety
    // defect. `externalWrite: false` is that property stated in the contract.
    expect(WORKFLOW_NODE_REGISTRY[KEY].externalWrite).toBe(false);
    expect(WORKFLOW_NODE_REGISTRY['consultation.proposeCorrections'].externalWrite).toBe(false);
  });

  it('carries a REALTIME budget, not the durable sibling’s', () => {
    const realtime = WORKFLOW_NODE_REGISTRY[KEY];
    const durable = WORKFLOW_NODE_REGISTRY['consultation.proposeCorrections'];
    // The realtime executor races each node against its own budget on a flush cadence; 150s is a
    // durable-shaped number and would outlive the flush that started it.
    expect(realtime.defaultTimeoutSeconds).toBeLessThan(durable.defaultTimeoutSeconds);
    // A realtime retry inside a flush that may be superseded is discarded as `stale`, so a
    // second attempt buys latency and nothing else.
    expect(realtime.defaultMaxAttempts).toBe(1);
  });

  it('satisfies every descriptor contract rule (idempotent in either lane, schemaVersion pinned)', () => {
    expect(nodeDescriptorContractProblems(WORKFLOW_NODE_REGISTRY[KEY])).toEqual([]);
    expect(WORKFLOW_NODE_REGISTRY[KEY].idempotent).toBe(true);
    expect(WORKFLOW_NODE_REGISTRY[KEY].schemaVersion).toBe(1);
  });

  it('consumes TRANSCRIPT — a generated note can never be wired into the live grammar pass', () => {
    const input = NODE_PORTS[KEY].inputs.find((port) => port.name === 'in');
    expect(input).toMatchObject({ primitive: 'transcript', required: true });

    const generated = NODE_PORTS['consultation.realtimeSummary'].outputs.find((port) => port.name === 'out')!;
    expect(generated.primitive).toBe('document');
    // `document` and `transcript` are lattice siblings under `text`, so this edge is a TYPE
    // ERROR — the same structural guarantee `agent.ner` carries.
    expect(portPrimitiveSatisfies(generated.primitive as never, 'transcript')).toBe(false);
  });

  it('accepts the entities the SAME flush already extracted, rather than re-detecting them', () => {
    const entities = NODE_PORTS[KEY].inputs.find((port) => port.name === 'entities');
    // Optional: a lane with no NER node still proposes, it just has no detector hints.
    expect(entities).toMatchObject({ primitive: 'entities', required: false, multiple: true });

    const produced = NODE_PORTS['agent.ner'].outputs.find((port) => port.name === 'out')!;
    expect(portPrimitiveSatisfies(produced.primitive as never, 'entities')).toBe(true);
  });

  it('produces `edits` under a declared outputKey — advisory, and consumed only by the DD-8 path', () => {
    const output = NODE_PORTS[KEY].outputs.find((port) => port.name === 'out');
    expect(output).toMatchObject({ primitive: 'edits', outputKey: 'proposals' });

    // The only `edits`-consuming nodes that also write are the promotion nodes. A proposal
    // becomes real there or nowhere; this node opens no second promotion channel.
    const editsConsumersThatWrite = Object.values(WORKFLOW_NODE_REGISTRY)
      .filter((descriptor) => NODE_PORTS[descriptor.key]?.inputs.some((port) => port.primitive === 'edits') && descriptor.externalWrite)
      .map((descriptor) => descriptor.key)
      .sort();
    expect(editsConsumersThatWrite).toEqual(['agent.feedback', 'feedback.capture']);
  });

  it('reuses the correction engine’s CONFIG SURFACE — one engine, one authorable schema (DD-9)', () => {
    expect(NODE_CONFIG_SCHEMAS[KEY]).toStrictEqual(NODE_CONFIG_SCHEMAS['consultation.proposeCorrections']);
    // The prompt is CONFIG, bound per node instance — never a literal in runtime code.
    expect(Object.keys(NODE_CONFIG_SCHEMAS[KEY].properties as Record<string, unknown>)).toContain('promptTemplateId');
  });
});
