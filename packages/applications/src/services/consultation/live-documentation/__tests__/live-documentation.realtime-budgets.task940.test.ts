/**
 * TASK-940 Lane 3 — the seven constructor-frozen `LIVE_DOC_*` knobs become
 * governed `consultation.realtime.*` config.
 *
 * Each was `Number(this.configService.get('LIVE_DOC_…') ?? <literal>)` in the
 * constructor, so the value was frozen for the process lifetime — the exact
 * shape `09-infrastructure-devops.md` §Configuration Tiers corollary L1 rules
 * out ("an env var is immutable for the process lifetime", so anything that must
 * change without a restart is not an env var). They are tuning knobs and
 * budgets, which is the definition of `global-kv` / `open-to-default`.
 *
 * Same contract as the `consultation.realtime.textTimeoutMs` exemplar those
 * descriptors sit beside: a stored row WINS, env is an override that LOSES to it,
 * and the code default is the last fallback. A resolution failure keeps the
 * previous answer for this flush rather than lurching to a default mid-session.
 *
 * ## Granularity is declared, not assumed
 *
 * Six of the seven are consulted during a flush, so a write governs the NEXT
 * flush. `heartbeatMs` is different and is documented as such: it is read once
 * per SSE subscription (`subscribeToLiveSummary`, which is synchronous and holds
 * no tenant), so a write reaches subscriptions opened after the next flush has
 * refreshed the mirror. Claiming per-flush granularity for it would be a lie a
 * test should catch, so this file pins the mechanism (the mirror is refreshed)
 * rather than a granularity the code cannot deliver.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentationService } from '../live-documentation.service';
import {
  CONSULTATION_REALTIME_DEFAULTS,
  CONSULTATION_REALTIME_KEYS,
  CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY,
} from '../../../settings-registry/descriptors/consultation-realtime.descriptors';

const TENANT = 'tenant-budgets';

/**
 * The env names TASK-940 RETIRED outright. Nothing set either one — no deployment
 * AND no test fixture. `LIVE_DOC_DURABLE_SNAPSHOT_MS` was in this list and came out
 * of it on evidence: the deployment scan missed fixtures, and three set it (one to
 * `0`, a meaningful value here) through a harness that wires no settings facade, so
 * retiring it would have left that knob with no lane at all.
 */
const RETIRED_ENV = ['LIVE_DOC_HEARTBEAT_MS', 'LIVE_DOC_STATS_TTL_SEC'] as const;

/** The env names KEPT as pre-resolution seeds (the `textTimeoutMs` precedent). */
const KEPT_ENV = [
  'LIVE_DOC_DURABLE_SNAPSHOT_MS',
  'LIVE_DOC_TEXT_MAX_TOKENS',
  'LIVE_DOC_GROUNDEDNESS_TIMEOUT_MS',
  'LIVE_DOC_GROUNDEDNESS_MAX_RETRIES',
  'LIVE_DOC_GROUNDEDNESS_RETRY_BACKOFF_MS',
] as const;

function buildService(stored: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const cacheService = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  const configService = { get: vi.fn((key: string) => env[key]) };
  const resolveEffective = vi.fn(async (key: string) =>
    key in stored
      ? { key, tier: 'global-kv', value: stored[key], sourceScope: 'global-kv' }
      : { key, tier: 'global-kv', value: (CONSULTATION_REALTIME_DEFAULTS as Record<string, unknown>)[key], sourceScope: 'code-default' },
  );

  const service = new LiveDocumentationService(
    { axiosRef: { post: vi.fn().mockResolvedValue({ data: {} }) } } as never,
    configService as never,
    cacheService as never,
    redisSubscriber as never,
    undefined as never,
    undefined as never,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'lm-studio', model: 'm' }) } as never,
    undefined as never,
    undefined as never,
    { resolveEffective } as never,
  );
  return { service, configService, resolveEffective };
}

describe('LiveDocumentationService — governed realtime budgets (TASK-940)', () => {
  it('declares all seven budgets with their pre-migration code defaults', () => {
    // The defaults must be byte-identical to the constructor literals they
    // replace, or this migration silently re-tunes a live clinical loop.
    expect(CONSULTATION_REALTIME_DEFAULTS['consultation.realtime.heartbeatMs']).toBe(15000);
    expect(CONSULTATION_REALTIME_DEFAULTS['consultation.realtime.durableSnapshotMs']).toBe(30000);
    expect(CONSULTATION_REALTIME_DEFAULTS['consultation.realtime.statsTtlSec']).toBe(300);
    expect(CONSULTATION_REALTIME_DEFAULTS['consultation.realtime.textMaxTokens']).toBe(8192);
    expect(CONSULTATION_REALTIME_DEFAULTS['consultation.realtime.groundedness.timeoutMs']).toBe(5000);
    expect(CONSULTATION_REALTIME_DEFAULTS['consultation.realtime.groundedness.maxRetries']).toBe(1);
    expect(CONSULTATION_REALTIME_DEFAULTS['consultation.realtime.groundedness.retryBackoffMs']).toBe(200);
  });

  it('resolves every budget it owns through the facade on a flush-time refresh', async () => {
    const { service, resolveEffective } = buildService();

    await service.resolveRealtimeBudgets(TENANT);

    const asked = resolveEffective.mock.calls.map(([key]) => key as string);
    // `textTimeoutMs` predates this ticket and keeps its own `resolveTextTimeoutMs`
    // (TASK-891), called on the same flush path one line above this resolver. Every
    // OTHER key in the namespace is this resolver's, and asserting against the
    // namespace minus that one is what makes a key added later fail here rather
    // than silently staying frozen.
    const owned = CONSULTATION_REALTIME_KEYS.filter((k) => k !== CONSULTATION_REALTIME_TEXT_TIMEOUT_MS_KEY);
    expect(owned).toHaveLength(7);
    for (const key of owned) {
      expect(asked, `${key} must be resolved, not frozen`).toContain(key);
    }
  });

  it('a STORED row wins over both env and the code default', async () => {
    const { service } = buildService(
      { 'consultation.realtime.statsTtlSec': 900, 'consultation.realtime.textMaxTokens': 4096 },
      { LIVE_DOC_STATS_TTL_SEC: '111', LIVE_DOC_TEXT_MAX_TOKENS: '222' },
    );

    const budgets = await service.resolveRealtimeBudgets(TENANT);

    expect(budgets.statsTtlSec).toBe(900);
    expect(budgets.textMaxTokens).toBe(4096);
  });

  it('falls back to the KEPT env override when nothing is stored', async () => {
    const { service } = buildService({}, { LIVE_DOC_TEXT_MAX_TOKENS: '4096', LIVE_DOC_GROUNDEDNESS_TIMEOUT_MS: '7500' });

    const budgets = await service.resolveRealtimeBudgets(TENANT);

    expect(budgets.textMaxTokens).toBe(4096);
    expect(budgets.groundednessTimeoutMs).toBe(7500);
  });

  it('no longer reads the three RETIRED env names at all', () => {
    // Measured before retiring them: neither was set in any `.env*` file, nor in
    // `hope-v2-deployment`'s `base/config/api.env` or the dev overlay (the only
    // `LIVE_DOC_*` the cluster sets is `LIVE_DOC_TEXT_TIMEOUT_MS`), nor in any test
    // fixture. So nothing loses a configured value, and keeping a seed nobody sets
    // would have been two more names hashed into every task's cache key for nothing.
    const { configService } = buildService({}, { LIVE_DOC_HEARTBEAT_MS: '1', LIVE_DOC_STATS_TTL_SEC: '3' });

    const consulted = configService.get.mock.calls.map(([key]) => key);
    for (const name of RETIRED_ENV) {
      expect(consulted, `${name} is retired — the registry row is the only lane`).not.toContain(name);
    }
  });

  it('still reads the four KEPT env names, so the retirement was surgical', () => {
    const { configService } = buildService();

    const consulted = configService.get.mock.calls.map(([key]) => key);
    for (const name of KEPT_ENV) {
      expect(consulted, `${name} is still honoured as a pre-first-flush seed`).toContain(name);
    }
  });

  it('honours an explicit durable-snapshot 0 — "never" is a value, not an absence', async () => {
    // `0` disables periodic durable writes. A `||` fallback anywhere on this path
    // would silently promote that explicit "never" to the 30 s default, and the
    // only symptom would be durable writes a fixture asked not to happen.
    const { service } = buildService({}, { LIVE_DOC_DURABLE_SNAPSHOT_MS: '0' });

    const budgets = await service.resolveRealtimeBudgets(TENANT);

    expect(budgets.durableSnapshotMs).toBe(0);
  });

  it('keeps the previous answer when resolution fails, rather than lurching mid-session', async () => {
    const { service } = buildService({ 'consultation.realtime.statsTtlSec': 900 });
    const first = await service.resolveRealtimeBudgets(TENANT);
    expect(first.statsTtlSec).toBe(900);

    // Now the control plane breaks. A budget must not snap back to its default
    // in the middle of a consultation because of a transient settings blip.
    const broken = buildService();
    (broken.resolveEffective as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('settings backend down'));
    const before = await broken.service.resolveRealtimeBudgets(TENANT);
    const after = await broken.service.resolveRealtimeBudgets(TENANT);

    expect(after).toEqual(before);
  });
});
