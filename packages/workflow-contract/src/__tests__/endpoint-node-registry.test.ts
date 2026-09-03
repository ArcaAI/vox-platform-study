/**
 * the ENDPOINT STAGE node types.
 *
 * The endpoint stage is the ordered sequence of actions that runs before a consultation session
 * closes. Before this ticket it existed only as a hardcoded literal in
 * `loop-config.service.ts` (`endingActionsBase = hasStreamAudio ? ['livedoc.stop',
 * 'harness.finalize'] : ['harness.finalize']`, defect D-10) and two of its three jobs had no node,
 * no activity and no code anywhere (D-11: feedback capture; D-12: a timeout that finalizes).
 *
 * These three node types are what make the stage AUTHORABLE — an admin orders and extends it in
 * the Studio instead of inheriting a literal they may only subtract from.
 *
 * All three are `trigger: 'on-end'` and `lane: 'durable'`, so publish-time rule 3
 * (`nodeDescriptorContractProblems`) requires all three to be `idempotent` — Temporal retries
 * activities, and a non-idempotent retry double-finalizes or double-captures invisibly.
 */
import { describe, expect, it } from 'vitest';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';
import { nodeDescriptorContractProblems } from '../port-validation';

/** The endpoint stage's three node types, in the order the default sequence runs them. */
const ENDPOINT_KEYS = ['session.timeout', 'summary.finalize', 'feedback.capture'] as const;

describe('endpoint-stage node types', () => {
  it.each(ENDPOINT_KEYS)('%s is registered', (key) => {
    expect(WORKFLOW_NODE_REGISTRY[key], `${key} is missing from WORKFLOW_NODE_REGISTRY`).toBeDefined();
  });

  it.each(ENDPOINT_KEYS)('%s runs on-end, on the durable lane', (key) => {
    const descriptor = WORKFLOW_NODE_REGISTRY[key];
    expect(descriptor.trigger).toBe('on-end');
    expect(descriptor.lane).toBe('durable');
  });

  it.each(ENDPOINT_KEYS)('%s is idempotent — Temporal WILL retry it', (key) => {
    expect(WORKFLOW_NODE_REGISTRY[key].idempotent).toBe(true);
    expect(nodeDescriptorContractProblems(WORKFLOW_NODE_REGISTRY[key])).toEqual([]);
  });

  it.each(ENDPOINT_KEYS)('%s belongs to the consultation palette and is implemented', (key) => {
    const descriptor = WORKFLOW_NODE_REGISTRY[key];
    expect(descriptor.paletteKey).toBe('consultation');
    expect(descriptor.implemented).toBe(true);
  });

  it('summary.finalize and feedback.capture declare externalWrite; session.timeout does too', () => {
    // All three WRITE. `summary.finalize` locks every document , `feedback.capture`
    // promotes an accepted correction onto the transcript , and `session.timeout` stamps
    // the consultation's endpoint disposition. `externalWrite` is also what makes the
    // interpreter suppress them on a SANDBOX run, which is the property that matters most here:
    // a sandbox must never lock a real clinician's note.
    for (const key of ENDPOINT_KEYS) {
      expect(WORKFLOW_NODE_REGISTRY[key].externalWrite, `${key}.externalWrite`).toBe(true);
    }
  });

  it('none of the three is `critical` — CR-14 keeps consentGate/hitlGate the only critical nodes', () => {
    for (const key of ENDPOINT_KEYS) {
      expect(WORKFLOW_NODE_REGISTRY[key].critical, `${key}.critical`).toBe(false);
    }
  });

  it('every declared data output port names its runtime outputKey (OD-15)', () => {
    for (const key of ENDPOINT_KEYS) {
      const descriptor = WORKFLOW_NODE_REGISTRY[key];
      const missing = descriptor.outputs.filter((port) => port.primitive !== 'control' && !port.outputKey).map((port) => port.name);
      expect(missing, `${key}: data output ports with no outputKey`).toEqual([]);
    }
  });

  it('feedback.capture consumes the `edits` a proposal node produces — the ONE promotion path (DD-8)', () => {
    // `consultation.proposeCorrections` outputs `edits` and writes nothing (`externalWrite:
    // false`). `feedback.capture` is the only node in the registry that CONSUMES `edits` and
    // writes, so an advisory correction can only reach the raw channel through it.
    const capture = WORKFLOW_NODE_REGISTRY['feedback.capture'];
    expect(capture.inputs.some((port) => port.primitive === 'edits')).toBe(true);

    const editsConsumingWriters = Object.values(WORKFLOW_NODE_REGISTRY)
      .filter((descriptor) => descriptor.externalWrite && descriptor.inputs.some((port) => port.primitive === 'edits'))
      .map((descriptor) => descriptor.key);
    // lane A — `agent.feedback` is the target catalogue's entry over the SAME engine
    // (`interpreter.feedback_capture`), so it carries the same property rather than opening a
    // second promotion path: two names, one implementation.
    expect(editsConsumingWriters.sort()).toEqual(['agent.feedback', 'feedback.capture']);
  });
});
