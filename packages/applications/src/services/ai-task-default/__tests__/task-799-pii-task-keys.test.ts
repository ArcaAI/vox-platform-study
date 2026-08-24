// TASK-799 R6 — the PII selections are registered AND super-admin-only.
//
// Both halves matter and neither implies the other. Registering the keys is
// what makes them manageable at all (`assertKnownTaskKey` rejected them on
// every admin route, and no `models.*` descriptor was generated). Locking them
// is the owner decision of 2026-08-24: they select nlp-hosted
// TOKEN_CLASSIFICATION models, which D-4 makes platform-shared, and PII
// redaction is a PHI control where one vetted model serving every tenant is the
// point. The `guardrail.` PREFIX stays tenant-configurable (TASK-735 Phase 0),
// so this is a KEY-level exception and the sibling keys must prove unaffected.
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { AI_TASK_KEYS, AI_TASK_MODEL_TASK_TYPES, isSuperAdminOnlyTaskKey } from '../constants';

const PII_KEYS = ['guardrail.pii', 'guardrail.pii.spans'] as const;

describe('TASK-799 R6 — guardrail PII task keys', () => {
  it('are declared, so the admin routes stop rejecting them', () => {
    for (const k of PII_KEYS) expect(AI_TASK_KEYS as readonly string[]).toContain(k);
  });

  it('bind to TOKEN_CLASSIFICATION, matching the GLiNER2 rows they point at', () => {
    for (const k of PII_KEYS) expect(AI_TASK_MODEL_TASK_TYPES[k]).toBe('TOKEN_CLASSIFICATION');
  });

  it('are SUPER_ADMIN-only by KEY, not by prefix', () => {
    for (const k of PII_KEYS) expect(isSuperAdminOnlyTaskKey(k), k).toBe(true);
  });

  // The regression this guards: widening the `guardrail.` prefix instead of
  // using a key list would silently re-lock these three and reverse an owner
  // decision as a side effect.
  it('leave the rest of the guardrail prefix tenant-configurable', () => {
    for (const k of ['guardrail.validate', 'guardrail.safety', 'guardrail.groundedness']) {
      expect(isSuperAdminOnlyTaskKey(k), k).toBe(false);
    }
  });

  it('generate globalOnly, fail-closed descriptors so the console gates them', () => {
    for (const k of PII_KEYS) {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(`models.${k}`);
      expect(d.globalOnly, k).toBe(true);
      expect(d.failMode, k).toBe('closed');
    }
  });
});
