/**
 * Registry-level assertions for the consultation palette (TASK-731 Phase C, extended when the
 * palette's remaining ten node types were wired). Mirrors the properties `node-types.md`'s
 * "Registry-level assertions" section names, now over the FULL thirteen-node table rather than
 * the three TASK-731 shipped.
 *
 * The last test in this file is the one that would have caught the gap in the first place: a
 * rule may only name a node type the registry actually serves.
 */
import { describe, expect, it } from 'vitest';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';
import { DRAFT_CONSULTATION_RULE_SET } from '../rule-catalogue';

/** `node-types.md`'s node table, N-1…N-13, in pipeline order. */
const CONSULTATION_KEYS = [
  'consultation.consentGate',
  'consultation.captureBinding',
  'consultation.extractEntities',
  'consultation.bindTerminology',
  'consultation.phiHop',
  'consultation.retrieveEvidence',
  'consultation.assemblePrompt',
  'consultation.synthesize',
  'consultation.sensors',
  'consultation.inferentialSensors',
  'consultation.persistDraft',
  'consultation.finalizeAssurance',
  'consultation.hitlGate',
] as const;

/** `external_write` column of the same table — the ContextItem writers. */
const EXTERNAL_WRITE_KEYS = new Set<string>([
  'consultation.extractEntities', // the persist leg
  'consultation.persistDraft',
  'consultation.finalizeAssurance',
  'consultation.hitlGate',
]);

describe('consultation palette node registry', () => {
  it('carries all thirteen node types of the node-types.md table', () => {
    for (const key of CONSULTATION_KEYS) {
      expect(WORKFLOW_NODE_REGISTRY[key], `${key} is missing from the registry`).toBeDefined();
    }
    const registered = Object.keys(WORKFLOW_NODE_REGISTRY).filter((key) => key.startsWith('consultation.'));
    expect(registered.sort()).toEqual([...CONSULTATION_KEYS].sort());
  });

  it('every node type belongs to the consultation palette', () => {
    for (const key of CONSULTATION_KEYS) {
      expect(WORKFLOW_NODE_REGISTRY[key].paletteKey).toBe('consultation');
    }
  });

  it('CR-14: only consentGate and hitlGate are critical', () => {
    for (const key of CONSULTATION_KEYS) {
      const expected = key === 'consultation.consentGate' || key === 'consultation.hitlGate';
      expect(WORKFLOW_NODE_REGISTRY[key].critical, `${key}.critical`).toBe(expected);
    }
  });

  it('externalWrite matches the node table — the ContextItem writers and nothing else', () => {
    for (const key of CONSULTATION_KEYS) {
      expect(WORKFLOW_NODE_REGISTRY[key].externalWrite, `${key}.externalWrite`).toBe(EXTERNAL_WRITE_KEYS.has(key));
    }
  });

  it('every node type is implemented — including hitlGate, since Phase B (durable wait) landed', () => {
    // hitlGate was the palette's last `implemented: false` placeholder. `compile()` refuses ANY
    // graph containing an unimplemented type, and CR-06 makes the gate non-optional, so while it
    // was a placeholder no consultation graph could compile at all. It is now backed by
    // `ConsultationGateWorkflow` (a child workflow, not an activity — see `NodeSpec.kind`).
    for (const key of CONSULTATION_KEYS) {
      expect(WORKFLOW_NODE_REGISTRY[key].implemented, `${key}.implemented`).toBe(true);
    }
  });

  it('hitlGate is the palette\'s only `gate`-classed node — the compiler lifts exactly one node into gates[]', () => {
    const gateClassed = CONSULTATION_KEYS.filter((key) => WORKFLOW_NODE_REGISTRY[key].classes.includes('gate'));
    expect(gateClassed).toEqual(['consultation.hitlGate']);
  });

  it('every entry is ungated (entitlementKey: null) — R-6, deferred to TASK-722', () => {
    for (const key of CONSULTATION_KEYS) {
      expect(WORKFLOW_NODE_REGISTRY[key].entitlementKey).toBeNull();
    }
  });

  it('no consultation.vision* key exists (README §1.3 — permanently deferred)', () => {
    expect(Object.keys(WORKFLOW_NODE_REGISTRY).some((k) => k.startsWith('consultation.vision'))).toBe(false);
  });

  it('no consultation.priming key exists (README §2.3/R-4 — deferred, no compile target)', () => {
    expect(WORKFLOW_NODE_REGISTRY['consultation.priming']).toBeUndefined();
  });

  it('no consultation descriptor mentions signing (palette-scoped restatement of assertion #6)', () => {
    for (const key of CONSULTATION_KEYS) {
      const descriptor = WORKFLOW_NODE_REGISTRY[key];
      expect(descriptor.activityName.toLowerCase()).not.toContain('sign');
      expect(descriptor.classes.join(',').toLowerCase()).not.toContain('sign');
    }
  });

  it('every consultation activityName is a distinct interpreter.consultation_* name', () => {
    const names = CONSULTATION_KEYS.map((key) => WORKFLOW_NODE_REGISTRY[key].activityName);
    for (const name of names) {
      expect(name.startsWith('interpreter.consultation_')).toBe(true);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  // The regression guard. TASK-731 shipped sixteen rules naming nine node types against a
  // registry that served three of them, so no consultation graph could be authored at all — the
  // Studio's palette rail correctly offered three nodes for a rule set demanding nine. A rule may
  // only ever name a node type the registry serves.
  it('every node type named by DRAFT_CONSULTATION_RULE_SET is registered', () => {
    const referenced = new Set<string>();
    for (const rule of DRAFT_CONSULTATION_RULE_SET) {
      const config = rule.predicateConfig as Record<string, unknown>;
      for (const field of ['entryType', 'terminalType', 'nodeType', 'fromType', 'toType', 'throughType']) {
        const value = config[field];
        if (typeof value === 'string') referenced.add(value);
      }
      const appliesTo = config.appliesTo as { nodeType?: unknown } | undefined;
      if (appliesTo && typeof appliesTo.nodeType === 'string') referenced.add(appliesTo.nodeType);
    }

    expect(referenced.size).toBeGreaterThan(0);
    const unregistered = [...referenced].filter((nodeType) => WORKFLOW_NODE_REGISTRY[nodeType] === undefined).sort();
    expect(unregistered, `rules name node types the registry does not serve: ${unregistered.join(', ')}`).toEqual([]);
  });
});
