// TASK-944 lane A — the gateway→STT session-create budget is GOVERNED, not a literal.
//
// The defect this pins: `StreamingSessionService.createSession` carried
// `timeout: 15000` as a literal, and a cold STT pod answered that very call in
// 16 870 ms — so the first session after every deploy 503'd while STT was busy
// succeeding. Raising the literal is an explicit non-solution: a bare number bumped
// to 30 000 re-creates the same defect one restart later. What makes it a fix is that
// the value is resolvable at RUNTIME, which is what a descriptor buys.
//
// Shape follows `consultation.realtime.textTimeoutMs` — the same class of defect (a
// gateway→service hop budget frozen below the measured tail of the hop it budgets).

import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { STT_GATEWAY_DEFAULTS, STT_SESSION_CREATE_TIMEOUT_MS_KEY } from '../descriptors/stt-gateway.descriptors';

describe('TASK-944 — sttStreaming.sessionCreateTimeoutMs', () => {
  it('is registered in the assembled catalog', () => {
    expect(HOPE_SETTINGS_REGISTRY.has(STT_SESSION_CREATE_TIMEOUT_MS_KEY)).toBe(true);
  });

  it('is a platform-owned tuning knob that degrades to its default', () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(STT_SESSION_CREATE_TIMEOUT_MS_KEY);

    expect(descriptor.tier).toBe('global-kv');
    expect(descriptor.dataType).toBe('number');
    expect(descriptor.maxScope).toBe('system');
    expect(descriptor.globalOnly).toBe(true);
    // TUNING, not selection: an unwritten row must degrade to the code default rather
    // than turning every session open into a failure.
    expect(descriptor.failMode).toBe('open-to-default');
    // Not `consumedBy` any Python deployable — this is read by the GATEWAY, on the
    // outbound hop, through the platform AppSettings cache.
    expect(descriptor.consumedBy).toBeUndefined();
  });

  it('defaults ABOVE the measured 16 870 ms cold start it exists to survive', () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(STT_SESSION_CREATE_TIMEOUT_MS_KEY);

    expect(descriptor.default).toBe(STT_GATEWAY_DEFAULTS[STT_SESSION_CREATE_TIMEOUT_MS_KEY]);
    expect(descriptor.default as number).toBeGreaterThan(16_870);
  });
});
