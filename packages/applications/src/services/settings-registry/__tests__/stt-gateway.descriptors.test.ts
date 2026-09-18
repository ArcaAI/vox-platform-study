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
import {
  STT_EGRESS_HIGH_WATERMARK_BYTES_KEY,
  STT_GATEWAY_DEFAULTS,
  STT_RESUME_GRACE_MS_KEY,
  STT_RESUME_MAX_REPLAY_AGE_MS_KEY,
  STT_SESSION_CREATE_TIMEOUT_MS_KEY,
  STT_WS_PING_INTERVAL_MS_KEY,
  STT_WS_PING_MISSES_KEY,
} from '../descriptors/stt-gateway.descriptors';

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

// TASK-985 ST-5 — the five WS TRANSPORT budgets, moved off `process.env`.
//
// Two of them (`egressHighWatermarkBytes`, `resumeGraceMs`) were module-scope `process.env`
// reads evaluated at IMPORT in `stt-ws.gateway.ts` — fixed for the process lifetime, so an
// operator's change needed a pod restart, while `turbo.json#globalEnv` and `.env.sample`
// advertised them as ordinary runtime config. That is the tier violation
// (`09-infrastructure-devops.md` §Configuration Tiers corollary L1) and the documentation
// defect (D8 §8 N-7) in one. The other three never existed and are registered here rather than
// added as fresh literals, for the same reason.
describe('TASK-985 ST-5 — the WS transport budgets are governed', () => {
  const KEYS = [
    STT_EGRESS_HIGH_WATERMARK_BYTES_KEY,
    STT_RESUME_GRACE_MS_KEY,
    STT_RESUME_MAX_REPLAY_AGE_MS_KEY,
    STT_WS_PING_INTERVAL_MS_KEY,
    STT_WS_PING_MISSES_KEY,
  ];

  it.each(KEYS)('%s is registered in the assembled catalog', (key) => {
    expect(HOPE_SETTINGS_REGISTRY.has(key)).toBe(true);
  });

  it.each(KEYS)('%s is a platform-owned tuning knob that degrades to its default', (key) => {
    const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(key);

    expect(descriptor.tier).toBe('global-kv');
    expect(descriptor.dataType).toBe('number');
    expect(descriptor.maxScope).toBe('system');
    expect(descriptor.globalOnly).toBe(true);
    expect(descriptor.failMode).toBe('open-to-default');
    // Read by the GATEWAY about its own client sockets; `apps/stt` never sees them, so putting
    // them on the Python pull route would serve a key no reader consumes.
    expect(descriptor.consumedBy).toBeUndefined();
    expect(descriptor.default).toBe(STT_GATEWAY_DEFAULTS[key as keyof typeof STT_GATEWAY_DEFAULTS]);
  });

  it('declares the two DEPRECATED env names as overrides, which is what keeps them in globalEnv', () => {
    // `envOverride` is not decoration: `scripts/env-sync.mts` folds only `tier: 'env' |
    // 'vault-kv'` descriptors into the declared surface, so without this field a `global-kv`
    // key's env name reaches `turbo.json#globalEnv` by NO mechanism at all — and an undeclared
    // read means changing its value invalidates no cached task. It is also the queryable fact
    // the deprecation register's row points at.
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow(STT_EGRESS_HIGH_WATERMARK_BYTES_KEY).envOverride).toEqual(['STT_WS_EGRESS_HIGH_WATERMARK_BYTES']);
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow(STT_RESUME_GRACE_MS_KEY).envOverride).toEqual(['STT_WS_RESUME_GRACE_MS']);
  });

  it('the three NEW keys declare no env override — there is no legacy name to honour', () => {
    for (const key of [STT_RESUME_MAX_REPLAY_AGE_MS_KEY, STT_WS_PING_INTERVAL_MS_KEY, STT_WS_PING_MISSES_KEY]) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).envOverride).toBeUndefined();
    }
  });

  it('the egress watermark defaults to 32 KiB, not the 512 KiB it replaced', () => {
    // 512 KiB of queued captions is ~50 s of transcript in flight to a client that is already
    // behind: by the time it drains, every byte of it is clinically useless.
    expect(STT_GATEWAY_DEFAULTS[STT_EGRESS_HIGH_WATERMARK_BYTES_KEY]).toBe(32 * 1024);
  });

  it('the resume grace default is unchanged at 15 s — this is a retiering, not a re-tuning', () => {
    expect(STT_GATEWAY_DEFAULTS[STT_RESUME_GRACE_MS_KEY]).toBe(15_000);
  });
});
