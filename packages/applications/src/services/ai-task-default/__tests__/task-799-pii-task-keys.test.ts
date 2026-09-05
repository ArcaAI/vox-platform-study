// the PII selections are registered AND super-admin-only.
//
// Both halves matter and neither implies the other. Registering the keys is
// what makes them manageable at all (`assertKnownTaskKey` rejected them on
// every admin route, and no `models.*` descriptor was generated). Locking them
// is the owner decision of 2026-08-24: they select nlp-hosted
// TOKEN_CLASSIFICATION models, which D-4 makes platform-shared, and PII
// redaction is a PHI control where one vetted model serving every tenant is the
// point. The `guardrail.` PREFIX stays tenant-configurable,
// so this is a KEY-level exception and the sibling keys must prove unaffected.
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { AI_TASK_KEYS, AI_TASK_MODEL_TASK_TYPES, isSuperAdminOnlyTaskKey } from '../constants';

const PII_KEYS = ['guardrail.pii', 'guardrail.pii.spans'] as const;

describe(' R6 — guardrail PII task keys', () => {
  it('are declared, so the admin routes stop rejecting them', () => {
    for (const k of PII_KEYS) expect(AI_TASK_KEYS as readonly string[]).toContain(k);
  });

  it('bind to TOKEN_CLASSIFICATION, matching the GLiNER2 rows they point at', () => {
    for (const k of PII_KEYS) expect(AI_TASK_MODEL_TASK_TYPES[k]).toBe('TOKEN_CLASSIFICATION');
  });

  it('are SUPER_ADMIN-only', () => {
    for (const k of PII_KEYS) expect(isSuperAdminOnlyTaskKey(k), k).toBe(true);
  });

  // TASK-872, owner decision #3 (2026-09-05): the WHOLE `guardrail.` prefix is
  // now locked, so the PII keys are covered by the prefix rather than by the
  // key-level exception that used to carry them. The assertion this replaces
  // guarded the opposite posture — that widening the prefix would wrongly
  // re-lock the sibling keys — and it is that posture the owner reversed:
  // guardrail is built-in and platform-only, no tenant admin manages any
  // guardrail setting.
  it('sit inside a fully locked guardrail prefix — the siblings are super-admin-only too', () => {
    for (const k of ['guardrail.validate', 'guardrail.safety', 'guardrail.groundedness']) {
      expect(isSuperAdminOnlyTaskKey(k), k).toBe(true);
    }
  });

  it('generate a globalOnly, fail-closed descriptor for the key guardrail resolves', () => {
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow('models.guardrail.pii');
    expect(d.globalOnly).toBe(true);
    expect(d.failMode).toBe('closed');
  });

  // TASK-872 removed the `models.*` descriptor(s) for this key: no request
  // path resolves it, so cataloguing it offered a SELECTION control with
  // nothing on the other end. The task key itself is unchanged — it stays
  // `AiRoutingPolicy` vocabulary with its own admin route and seed posture —
  // so the assertion flips to the descriptor's ABSENCE.
  // Here the evidence is direct: guardrail's `core/dependencies.py` resolves
  // `TASK_KEY_GUARDRAIL_PII` ("guardrail.pii") and nothing anywhere resolves
  // the `.spans` variant.
  it('catalogue NO descriptor for guardrail.pii.spans — nothing resolves it', () => {
    expect(HOPE_SETTINGS_REGISTRY.has('models.guardrail.pii.spans')).toBe(false);
  });
});
