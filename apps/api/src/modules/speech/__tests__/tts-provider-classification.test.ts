/**
 * + OD-4 — the ONE TTS billing classifier.
 *
 * Two things are under test here and they are separable:
 *
 *  1. **Deduplication (OD-4).** `classifyTtsProvider` and
 *     `SELF_HOSTED_TTS_PROVIDERS` existed as two verbatim copies, in
 *     `speech-proxy.controller.ts` and `tts-ws.gateway.ts`. Two hand-synced
 *     copies of a *billing* classifier is how the next mis-rating ships. Both
 *     call sites now import this module; these tests are its contract.
 *
 *  2. **Funding attribution (R3).** The classifier used to read
 *     `provider in providerOverrides` — i.e. it inferred who paid from the mere
 *     PRESENCE of an injected credential. That is true only while every
 *     credential the gateway can inject belongs to the calling tenant. The
 *     platform-default cascade breaks that assumption, so funding now travels
 *     EXPLICITLY on the override entry.
 */

import { describe, expect, it } from 'vitest';

import { SELF_HOSTED_TTS_PROVIDERS, classifyTtsProvider } from '../tts-provider-classification';

describe('classifyTtsProvider — self-hosted', () => {
  it('classifies the self-hosted engines with NO cost basis', () => {
    for (const provider of ['kokoro', 'indic_parler']) {
      expect(classifyTtsProvider(provider, undefined)).toEqual({ deployment: 'SELF_HOSTED' });
    }
  });

  it('exposes the self-hosted set so both call sites cannot drift apart', () => {
    expect([...SELF_HOSTED_TTS_PROVIDERS].sort()).toEqual(['indic_parler', 'kokoro']);
  });

  it('keeps the pre-existing precedence: a TENANT credential outranks the self-hosted set', () => {
    // Unreachable in production — `resolveTenantCloudOverrides` filters through
    // `isCloudByoProvider`, so a self-hosted engine id can never appear in the
    // map. Pinned only so the dedup is provably behaviour-preserving; R3
    // changes WHO the entry says is paying, never the ordering.
    expect(classifyTtsProvider('kokoro', { kokoro: { api_key: 'k' } })).toEqual({
      deployment: 'BYOK',
      costBasis: 'BYOK_NOTIONAL',
    });
  });

  it('a PLATFORM-funded entry does not outrank the self-hosted set', () => {
    expect(classifyTtsProvider('kokoro', { kokoro: { api_key: 'k', funding: 'platform' } })).toEqual({ deployment: 'SELF_HOSTED' });
  });
});

describe('classifyTtsProvider — cloud, no override', () => {
  it('classifies an un-overridden cloud provider as platform-funded CLOUD', () => {
    expect(classifyTtsProvider('azure', undefined)).toEqual({ deployment: 'CLOUD' });
    expect(classifyTtsProvider('sarvam', null)).toEqual({ deployment: 'CLOUD' });
    expect(classifyTtsProvider('azure', {})).toEqual({ deployment: 'CLOUD' });
  });

  it('is KEY-SPECIFIC: an override for a DIFFERENT provider changes nothing', () => {
    expect(classifyTtsProvider('azure', { sarvam: { api_key: 'k' } })).toEqual({ deployment: 'CLOUD' });
  });
});

describe('classifyTtsProvider — funding attribution', () => {
  it('TENANT-funded ⇒ BYOK + BYOK_NOTIONAL', () => {
    expect(classifyTtsProvider('azure', { azure: { api_key: 'k', funding: 'tenant' } })).toEqual({
      deployment: 'BYOK',
      costBasis: 'BYOK_NOTIONAL',
    });
  });

  it('PLATFORM-funded ⇒ CLOUD, with NO cost basis — the platform bears this spend', () => {
    // The load-bearing case. Stamped BYOK_NOTIONAL instead, the drainer would
    // contribute 0 to every COGS rollup and billing would resolve the
    // provider-agnostic baseline SELL price instead of the managed-vendor row.
    expect(classifyTtsProvider('azure', { azure: { api_key: 'k', funding: 'platform' } })).toEqual({ deployment: 'CLOUD' });
  });

  it('an ABSENT funding field means TENANT — exactly right for any pre-R3 caller', () => {
    // A resolver that does not stamp funding has no platform tier to draw
    // from, so every credential it can inject is the caller tenant's own.
    // The default is therefore correct for those callers, not a guess.
    expect(classifyTtsProvider('azure', { azure: { api_key: 'k' } })).toEqual({
      deployment: 'BYOK',
      costBasis: 'BYOK_NOTIONAL',
    });
  });

  it('an UNRECOGNIZED funding value degrades to tenant (never silently to platform)', () => {
    expect(classifyTtsProvider('azure', { azure: { api_key: 'k', funding: 'sponsored' } })).toEqual({
      deployment: 'BYOK',
      costBasis: 'BYOK_NOTIONAL',
    });
  });

  it('attributes a MIXED map per provider — the cascade merges tenant-over-platform per key', () => {
    const overrides = {
      azure: { api_key: 'tenant-key', funding: 'tenant' },
      sarvam: { api_key: 'platform-key', funding: 'platform' },
    };
    expect(classifyTtsProvider('azure', overrides)).toEqual({ deployment: 'BYOK', costBasis: 'BYOK_NOTIONAL' });
    expect(classifyTtsProvider('sarvam', overrides)).toEqual({ deployment: 'CLOUD' });
  });
});
