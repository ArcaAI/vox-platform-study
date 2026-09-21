/**
 * TASK-998 OD-4 — the OUTBOUND cloud-ASR vendor-capacity limiter.
 *
 * What is pinned here, and why each one matters:
 *
 *   · an explicit over-limit verdict FAILS CLOSED with the capability string the
 *     gateway maps to 429 (`QUOTA_RATE_CAPABILITIES`), not the default 409;
 *   · Redis being unavailable FAILS OPEN — this sits on "start recording";
 *   · a slot held by a process that died is RECLAIMED by the TTL sweep, so a
 *     crash cannot permanently shrink a tenant's vendor capacity;
 *   · re-acquiring the same session is idempotent, so a resume is never refused
 *     by the slot it already owns;
 *   · release/heartbeat never throw — both run on teardown paths.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaExceededException } from '@arcaai/exceptions';
import { ProviderCapacityService } from '../provider-capacity.service';
import {
  PROVIDER_RPM_CAPABILITY,
  PROVIDER_STREAMS_CAPABILITY,
  PROVIDER_STREAM_SLOT_TTL_SECONDS,
  PROVIDER_STREAM_OWNER_KEY_PREFIX,
} from '../provider-capacity.constants';
import type { IEntitlementsService } from '../../entitlements/IEntitlementsService';
import type { IRedisCacheService } from '../../baseServices/redis/redis-cache.service';
import type { ProviderQuota } from '../../entitlements/provider-quotas';

const TENANT = 'tenant-1';

function entitlementsStub(quota: Partial<ProviderQuota>, opts: { enabled?: boolean; gated?: boolean } = {}): IEntitlementsService {
  return {
    isEnforcementEnabled: () => opts.enabled ?? true,
    resolveForTenant: vi.fn(async () => ({
      gated: opts.gated ?? true,
      providerQuotas: { sarvam: { requestsPerMinute: null, maxConcurrentStreams: null, ...quota } },
    })),
    // The rest of the contract is unused by this service.
  } as unknown as IEntitlementsService;
}

/**
 * A minimal Redis double that MODELS the two admission scripts' contract: a
 * fixed-window counter and a sorted set that is swept by the cutoff before it is
 * counted. It is deliberately not a Lua interpreter — the scripts themselves are
 * reviewed as SQL-adjacent artifacts — but it is the only way to assert the
 * behaviour the cutoff exists to produce (a dead process's slot ages out).
 */
function redisDouble() {
  const counters = new Map<string, number>();
  const zsets = new Map<string, Map<string, number>>();
  const strings = new Map<string, string>();
  const calls: { keys: string[]; argv: string[] }[] = [];

  const cache: IRedisCacheService = {
    get: vi.fn(async (key: string) => strings.get(key) ?? null),
    eval: vi.fn(async (script: string, numKeys: number, ...args: (string | number)[]) => {
      const keys = args.slice(0, numKeys).map(String);
      const argv = args.slice(numKeys).map(String);
      calls.push({ keys, argv });

      if (script.includes('ZREMRANGEBYSCORE')) {
        const [member, now, cutoff, limit, , owner] = argv;
        const zset = zsets.get(keys[0]) ?? new Map<string, number>();
        for (const [held, score] of [...zset]) if (score <= Number(cutoff)) zset.delete(held);
        const alreadyHeld = zset.has(member);
        if (!alreadyHeld && Number(limit) >= 0 && zset.size + 1 > Number(limit)) return [0, zset.size];
        zset.set(member, Number(now));
        zsets.set(keys[0], zset);
        strings.set(keys[1], owner);
        return [1, zset.size];
      }
      if (script.includes('INCR')) {
        const [limit] = argv;
        const used = counters.get(keys[0]) ?? 0;
        if (Number(limit) >= 0 && used + 1 > Number(limit)) return [0, used];
        counters.set(keys[0], used + 1);
        return [1, used + 1];
      }
      if (script.includes('ZREM')) {
        zsets.get(keys[0])?.delete(argv[0]);
        strings.delete(keys[1]);
        return 1;
      }
      if (script.includes('ZADD')) {
        zsets.get(keys[0])?.set(argv[0], Number(argv[1]));
        return 1;
      }
      return null;
    }),
  } as unknown as IRedisCacheService;

  return { cache, counters, zsets, strings, calls };
}

const emitter = () => ({ emit: vi.fn() }) as never;

describe('ProviderCapacityService — requestsPerMinute (batch / sync REST)', () => {
  let redis: ReturnType<typeof redisDouble>;

  beforeEach(() => {
    redis = redisDouble();
  });

  it('allows calls under the limit and refuses the one that would exceed it', async () => {
    const service = new ProviderCapacityService(entitlementsStub({ requestsPerMinute: 2 }), emitter(), redis.cache);

    await expect(service.assertRequestRate(TENANT, 'sarvam')).resolves.toBeUndefined();
    await expect(service.assertRequestRate(TENANT, 'sarvam')).resolves.toBeUndefined();
    await expect(service.assertRequestRate(TENANT, 'sarvam')).rejects.toBeInstanceOf(QuotaExceededException);
  });

  it('carries the 429-mapped capability string, not the 409 default', async () => {
    const service = new ProviderCapacityService(entitlementsStub({ requestsPerMinute: 0 }), emitter(), redis.cache);

    await service.assertRequestRate(TENANT, 'sarvam').then(
      () => expect.unreachable('expected the limiter to refuse'),
      (error: QuotaExceededException) => {
        expect(error).toBeInstanceOf(QuotaExceededException);
        expect((error.metadata as { capability: string }).capability).toBe(PROVIDER_RPM_CAPABILITY);
      },
    );
  });

  it('a REFUSED call does not consume the vendor budget', async () => {
    const service = new ProviderCapacityService(entitlementsStub({ requestsPerMinute: 1 }), emitter(), redis.cache);

    await service.assertRequestRate(TENANT, 'sarvam');
    await expect(service.assertRequestRate(TENANT, 'sarvam')).rejects.toBeInstanceOf(QuotaExceededException);

    // The refused call never reached the vendor, so it must not be counted —
    // otherwise a client that backs off correctly stays locked out anyway.
    expect([...redis.counters.values()]).toEqual([1]);
  });

  it('does nothing when the provider is null (a self-hosted engine)', async () => {
    const service = new ProviderCapacityService(entitlementsStub({ requestsPerMinute: 0 }), emitter(), redis.cache);

    await expect(service.assertRequestRate(TENANT, null)).resolves.toBeUndefined();
    expect(redis.cache.eval).not.toHaveBeenCalled();
  });

  it('does nothing while the entitlements kill-switch is off', async () => {
    const service = new ProviderCapacityService(entitlementsStub({ requestsPerMinute: 0 }, { enabled: false }), emitter(), redis.cache);

    await expect(service.assertRequestRate(TENANT, 'sarvam')).resolves.toBeUndefined();
    expect(redis.cache.eval).not.toHaveBeenCalled();
  });

  it('does nothing for an ungated (null-plan) tenant', async () => {
    const service = new ProviderCapacityService(entitlementsStub({ requestsPerMinute: 0 }, { gated: false }), emitter(), redis.cache);

    await expect(service.assertRequestRate(TENANT, 'sarvam')).resolves.toBeUndefined();
    expect(redis.cache.eval).not.toHaveBeenCalled();
  });
});

describe('ProviderCapacityService — maxConcurrentStreams (live sockets)', () => {
  let redis: ReturnType<typeof redisDouble>;

  beforeEach(() => {
    redis = redisDouble();
  });

  it('refuses the session that would exceed the vendor socket cap', async () => {
    const service = new ProviderCapacityService(entitlementsStub({ maxConcurrentStreams: 1 }), emitter(), redis.cache);

    await service.acquireStreamSlot({ tenantId: TENANT, provider: 'sarvam', sessionId: 's-1' });

    await service.acquireStreamSlot({ tenantId: TENANT, provider: 'sarvam', sessionId: 's-2' }).then(
      () => expect.unreachable('expected the limiter to refuse the second stream'),
      (error: QuotaExceededException) => {
        expect(error).toBeInstanceOf(QuotaExceededException);
        expect((error.metadata as { capability: string }).capability).toBe(PROVIDER_STREAMS_CAPABILITY);
      },
    );
  });

  it('is idempotent per session, so a resume is never refused by its own slot', async () => {
    const service = new ProviderCapacityService(entitlementsStub({ maxConcurrentStreams: 1 }), emitter(), redis.cache);

    await service.acquireStreamSlot({ tenantId: TENANT, provider: 'sarvam', sessionId: 's-1' });
    await expect(service.acquireStreamSlot({ tenantId: TENANT, provider: 'sarvam', sessionId: 's-1' })).resolves.toBeUndefined();
  });

  it('releases a slot at teardown, freeing it for the next session', async () => {
    const service = new ProviderCapacityService(entitlementsStub({ maxConcurrentStreams: 1 }), emitter(), redis.cache);

    await service.acquireStreamSlot({ tenantId: TENANT, provider: 'sarvam', sessionId: 's-1' });
    await service.releaseStreamSlot('s-1');

    await expect(service.acquireStreamSlot({ tenantId: TENANT, provider: 'sarvam', sessionId: 's-2' })).resolves.toBeUndefined();
  });

  it('RECLAIMS the slot of a session whose process died without releasing', async () => {
    const service = new ProviderCapacityService(entitlementsStub({ maxConcurrentStreams: 1 }), emitter(), redis.cache);

    const start = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(start);
    await service.acquireStreamSlot({ tenantId: TENANT, provider: 'sarvam', sessionId: 'crashed' });

    // The replica holding 'crashed' is SIGKILLed: no release, no heartbeat.
    // Past the slot TTL the acquire sweep drops it, so the cap is not
    // permanently shrunk by one — the whole reason this is a scored set rather
    // than an INCR/DECR pair.
    vi.spyOn(Date, 'now').mockReturnValue(start + (PROVIDER_STREAM_SLOT_TTL_SECONDS + 60) * 1000);
    await expect(service.acquireStreamSlot({ tenantId: TENANT, provider: 'sarvam', sessionId: 'fresh' })).resolves.toBeUndefined();

    vi.restoreAllMocks();
  });

  it('keeps a slot alive while it is still being heartbeaten', async () => {
    const service = new ProviderCapacityService(entitlementsStub({ maxConcurrentStreams: 1 }), emitter(), redis.cache);

    const start = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(start);
    await service.acquireStreamSlot({ tenantId: TENANT, provider: 'sarvam', sessionId: 'long-consult' });

    // Half a TTL later the gateway heartbeat re-stamps it...
    vi.spyOn(Date, 'now').mockReturnValue(start + (PROVIDER_STREAM_SLOT_TTL_SECONDS / 2) * 1000);
    await service.heartbeatStreamSlot('long-consult');

    // ...so at TTL + a bit from the ORIGINAL acquire it is still live and still
    // occupying the single slot.
    vi.spyOn(Date, 'now').mockReturnValue(start + (PROVIDER_STREAM_SLOT_TTL_SECONDS + 60) * 1000);
    await expect(service.acquireStreamSlot({ tenantId: TENANT, provider: 'sarvam', sessionId: 'other' })).rejects.toBeInstanceOf(
      QuotaExceededException,
    );

    vi.restoreAllMocks();
  });

  it('records the slot even when the dimension is unlimited, so turning a limit on counts live streams', async () => {
    const service = new ProviderCapacityService(entitlementsStub({}), emitter(), redis.cache);

    await service.acquireStreamSlot({ tenantId: TENANT, provider: 'sarvam', sessionId: 's-1' });

    expect(redis.strings.get(`${PROVIDER_STREAM_OWNER_KEY_PREFIX}s-1`)).toBe(`sarvam|${TENANT}`);
  });
});

describe('ProviderCapacityService — fail posture', () => {
  it('FAILS OPEN when Redis cannot answer', async () => {
    const dead = { get: vi.fn(async () => null), eval: vi.fn(async () => null) } as unknown as IRedisCacheService;
    const service = new ProviderCapacityService(entitlementsStub({ requestsPerMinute: 0, maxConcurrentStreams: 0 }), emitter(), dead);

    // Both limits are 0, so an enforcing limiter would refuse every call. A
    // counter outage must not stop a clinician starting a consultation.
    await expect(service.assertRequestRate(TENANT, 'sarvam')).resolves.toBeUndefined();
    await expect(service.acquireStreamSlot({ tenantId: TENANT, provider: 'sarvam', sessionId: 's-1' })).resolves.toBeUndefined();
  });

  it('FAILS OPEN when no Redis service is wired at all', async () => {
    const service = new ProviderCapacityService(entitlementsStub({ requestsPerMinute: 0 }), emitter(), undefined);

    await expect(service.assertRequestRate(TENANT, 'sarvam')).resolves.toBeUndefined();
  });

  it('FAILS OPEN when the entitlement resolve itself throws', async () => {
    const broken = {
      isEnforcementEnabled: () => true,
      resolveForTenant: vi.fn(async () => {
        throw new Error('entitlements tables unreachable');
      }),
    } as unknown as IEntitlementsService;
    const redis = redisDouble();
    const service = new ProviderCapacityService(broken, emitter(), redis.cache);

    await expect(service.assertRequestRate(TENANT, 'sarvam')).resolves.toBeUndefined();
    expect(redis.cache.eval).not.toHaveBeenCalled();
  });

  it('release and heartbeat never throw, even when Redis is dead', async () => {
    const dead = {
      get: vi.fn(async () => {
        throw new Error('down');
      }),
      eval: vi.fn(async () => {
        throw new Error('down');
      }),
    } as unknown as IRedisCacheService;
    const service = new ProviderCapacityService(entitlementsStub({}), emitter(), dead);

    await expect(service.releaseStreamSlot('s-1')).resolves.toBeUndefined();
    await expect(service.heartbeatStreamSlot('s-1')).resolves.toBeUndefined();
  });
});
