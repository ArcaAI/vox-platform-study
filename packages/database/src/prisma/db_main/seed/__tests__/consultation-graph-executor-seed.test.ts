// The realtime graph executor is the switch that decides whether a tenant's
// AUTHORED consultation workflow actually drives the live session, or is merely
// a picture while a hardcoded `flush()` does the work.
//
// `consultation.realtime.graphExecutor.enabled` is a `global-kv` kill-switch, so
// its DESCRIPTOR default is OFF — correct, because a kill-switch that needs a
// redeploy to trip is not a kill-switch. The row seeded here is what turns it
// ON, exactly as `consultation.ocr.enabled` does for OCR: `value` ships true,
// `defaultValue` stays at the fail-safe so "reset to default" still disables it.
//
// Before this guard there was NO seeded row in ANY environment (verified:
// `git grep consultation.realtime.graphExecutor -- packages/database` was
// empty), so every deployment came up running the legacy engine and ignoring
// every realtime node a tenant admin had authored. TASK-852 item 1 framed the
// remedy as a one-off runtime write against a live tenant; that cannot satisfy
// "everything ready once deployment finishes", because a fresh cluster would
// still come up with the switch off.
import { describe, expect, it } from 'vitest';

import { GATES } from '../11c-consultation-gate-settings';

// Literals on purpose: `packages/database` must not import `@arcaai/applications`.
// Sources of truth, kept in lockstep by this test's own assertions:
//   key   -> applications .../consultation/consultation-gates.constants.ts
//   label -> applications .../settings-registry/descriptors/consultation-gates.descriptors.ts
const KEY = 'consultation.realtime.graphExecutor.enabled';
const LABEL = 'Realtime graph executor';

describe('consultation gate seeds — realtime graph executor', () => {
  const row = GATES.find((gate) => gate.key === KEY);

  it('seeds a platform row for the graph executor', () => {
    expect(row, `no seeded row for ${KEY}: every deployment would run the legacy engine`).toBeDefined();
  });

  it('matches the descriptor label verbatim — the row identity', () => {
    // `name` is half the GlobalSetting_tenantId_name_key unique key, so a drifted
    // label silently creates a SECOND row instead of updating this one.
    expect(row?.name).toBe(LABEL);
  });

  it('ships ON while leaving the fail-safe default OFF', () => {
    expect(row?.value).toBe('true');
    expect(row?.defaultValue).toBe('false');
  });
});
