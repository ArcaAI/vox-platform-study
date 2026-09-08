/**
 * TASK-893 Phase 2 — the action catalogue is a FIRST-CLASS table, not a filtered view of the
 * deprecation table (README §2.7: "the deprecated entries are not residue, they are the current
 * implementation of `core.action`"). Every descriptor here is what a `core.action` instance
 * actually runs on: config schema, ports, safety flags, activity name and lane.
 */
import { describe, expect, it } from 'vitest';
import { ACTION_CATALOGUE, ACTION_KEYS, actionDelegateOf } from '../action-catalogue';
import { actionConfigSchemaOf, coreNodeConfigProblems, effectivePorts } from '../core-contract';

const KEPT = [
  'consultation.consentGate',
  'consultation.bindTerminology',
  'consultation.phiHop',
  'consultation.retrieveEvidence',
  'consultation.sensors',
  'consultation.inferentialSensors',
  'consultation.persistDraft',
  'consultation.finalizeAssurance',
  'guard.phi',
  'guard.moderation',
  'guard.groundedness',
  'session.timeout',
  'feedback.capture',
  'livedoc.stop',
  'harness.finalize',
  'summary.finalize',
  'prompt.template_ref',
];

/** Agent-shaped keys, now `core.agent` (INTERFACES §7.2) — must NOT be actions any more. */
const DROPPED = [
  'consultation.captureBinding',
  'consultation.extractEntities',
  'consultation.assemblePrompt',
  'consultation.realtimeSummary',
  'consultation.suggestions',
  'consultation.proposeCorrections',
  'agent.transcription',
  'agent.normalization',
  'agent.ner',
  'agent.grammar',
  'agent.important_findings',
  'agent.retrieval',
  'agent.feedback',
  'agent.dna_redaction',
  'agent.dna_style',
  'guardrail.check',
  'agentic.guardrail',
];

describe('ACTION_CATALOGUE — the 17 kept fixed-purpose clinical steps', () => {
  it('carries exactly the 17 kept keys, in the contract order, and none of the 17 dropped ones', () => {
    expect(Object.keys(ACTION_CATALOGUE)).toEqual(KEPT);
    expect([...ACTION_KEYS]).toEqual(KEPT);
    for (const key of DROPPED) expect(ACTION_CATALOGUE[key]).toBeUndefined();
  });

  it('every descriptor is total: schema, ports, activity, flags, lane, a label and a ≤80-char summary', () => {
    for (const key of KEPT) {
      const descriptor = ACTION_CATALOGUE[key];
      expect(descriptor.key).toBe(key);
      expect(descriptor.activityName).toMatch(/^interpreter\./);
      expect(descriptor.configSchema).toBeDefined();
      expect(descriptor.ports.inputs.length + descriptor.ports.outputs.length).toBeGreaterThan(0);
      expect(descriptor.classes.length).toBeGreaterThan(0);
      expect(['durable', 'realtime']).toContain(descriptor.lane);
      expect(descriptor.defaultTimeoutSeconds).toBeGreaterThan(0);
      expect(descriptor.defaultMaxAttempts).toBeGreaterThanOrEqual(1);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.summary.length).toBeGreaterThan(0);
      expect(descriptor.summary.length).toBeLessThanOrEqual(80);
      // `outputKeys` lists the runtime keys of the DATA output ports, in port order.
      expect(descriptor.outputKeys).toEqual(descriptor.ports.outputs.flatMap((port) => (port.outputKey ? [port.outputKey] : [])));
      expect(Object.isFrozen(descriptor)).toBe(true);
    }
  });

  it('the safety flags match the registry entries they were copied from (verbatim copy, TASK-893 §7.2)', () => {
    expect(ACTION_CATALOGUE['consultation.consentGate']).toMatchObject({ critical: true, externalWrite: false, defaultTimeoutSeconds: 30, defaultMaxAttempts: 3 });
    expect(ACTION_CATALOGUE['consultation.persistDraft']).toMatchObject({ critical: false, externalWrite: true, defaultTimeoutSeconds: 150, defaultMaxAttempts: 3 });
    expect(ACTION_CATALOGUE['consultation.inferentialSensors']).toMatchObject({ defaultTimeoutSeconds: 900, defaultMaxAttempts: 2 });
    expect(ACTION_CATALOGUE['guard.groundedness']).toMatchObject({ critical: false, externalWrite: false, defaultTimeoutSeconds: 150, defaultMaxAttempts: 2, lane: 'durable' });
    expect(ACTION_CATALOGUE['summary.finalize']).toMatchObject({ externalWrite: true, defaultTimeoutSeconds: 60 });
    expect(ACTION_CATALOGUE['prompt.template_ref'].outputKeys).toEqual(['content']);
    expect(ACTION_CATALOGUE['guard.phi'].outputKeys).toEqual(['verdict', 'text']);
    expect(ACTION_CATALOGUE['session.timeout'].outputKeys).toEqual([]);
  });

  it('actionDelegateOf resolves an instance to its catalogue descriptor, and nothing else', () => {
    const delegate = actionDelegateOf({ actionKey: 'consultation.phiHop' });
    expect(delegate).toBe(ACTION_CATALOGUE['consultation.phiHop']);
    expect(actionDelegateOf({ actionKey: 'agent.ner' })).toBeUndefined();
    expect(actionDelegateOf({ actionKey: 42 })).toBeUndefined();
    expect(actionDelegateOf(undefined)).toBeUndefined();
  });

  it('core-contract reads the catalogue: the action`s schema, its effective ports, and the publish check', () => {
    const config = { actionKey: 'guard.phi', action: { mode: 'pseudonymize' } };
    expect(actionConfigSchemaOf(config)).toBe(ACTION_CATALOGUE['guard.phi'].configSchema);
    expect(effectivePorts('core.action', config)).toEqual(ACTION_CATALOGUE['guard.phi'].ports);
    expect(coreNodeConfigProblems({ id: 'a', type: 'core.action', config })).toEqual([]);
    expect(coreNodeConfigProblems({ id: 'a', type: 'core.action', config: { actionKey: 'agent.ner' } })).toHaveLength(1);
  });
});
