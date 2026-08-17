/**
 * TASK-731 Phase C — registry-level assertions for the consultation palette's THREE registered
 * node types (`consentGate`, `phiHop`, `hitlGate`). Mirrors the properties `node-types.md`'s
 * "Registry-level assertions" section names, scoped to what is actually registered this pass —
 * see the ticket README §7 for why the other ten node types are not yet in `WORKFLOW_NODE_REGISTRY`.
 */
import { describe, expect, it } from 'vitest';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';

const CONSULTATION_KEYS = ['consultation.consentGate', 'consultation.hitlGate', 'consultation.phiHop'] as const;

describe('consultation palette node registry', () => {
  it('carries all three registered keys', () => {
    for (const key of CONSULTATION_KEYS) {
      expect(WORKFLOW_NODE_REGISTRY[key]).toBeDefined();
    }
  });

  it('CR-14: only consentGate and hitlGate are critical', () => {
    expect(WORKFLOW_NODE_REGISTRY['consultation.consentGate'].critical).toBe(true);
    expect(WORKFLOW_NODE_REGISTRY['consultation.hitlGate'].critical).toBe(true);
    expect(WORKFLOW_NODE_REGISTRY['consultation.phiHop'].critical).toBe(false);
  });

  it('hitlGate is implemented:false and externalWrite:true; consentGate/phiHop are implemented:true', () => {
    expect(WORKFLOW_NODE_REGISTRY['consultation.hitlGate'].implemented).toBe(false);
    expect(WORKFLOW_NODE_REGISTRY['consultation.hitlGate'].externalWrite).toBe(true);
    expect(WORKFLOW_NODE_REGISTRY['consultation.consentGate'].implemented).toBe(true);
    expect(WORKFLOW_NODE_REGISTRY['consultation.phiHop'].implemented).toBe(true);
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

  it('every consultation activityName is in the interpreter.consultation_* namespace', () => {
    for (const key of CONSULTATION_KEYS) {
      expect(WORKFLOW_NODE_REGISTRY[key].activityName.startsWith('interpreter.consultation_')).toBe(true);
    }
  });
});
