/**
 * Attribution is the only part of the harness whose correctness decides whether
 * a run means anything, so it is pinned against the EXACT bodies and headers
 * the gateway emits — read out of `apps/api/src/filters/**`,
 * `apps/api/src/interceptors/exception.interceptor.ts` and
 * `@nestjs/throttler@6.5.0`, not invented.
 *
 * Runs under `pnpm test:unit`; needs nothing running.
 */
import { describe, expect, it } from 'vitest';
import { attribute, CEILING_CAUSES, HARNESS_FAULT_CAUSES, readRateLimit, readRetryAfter, withinPoolTimeoutBand } from '../src/attribution';

const BASE = { durationMs: 12, pgConnectTimeoutMs: 5_000 } as const;

describe('readRetryAfter — the D-4 tier suffix', () => {
  it('reads the plain header as the default tier', () => {
    expect(readRetryAfter({ 'retry-after': '37' })).toEqual({ tier: 'default', seconds: 37 });
  });

  it('reads the tier out of the suffix (`Retry-After-heavy`), which is what makes an IP-lane 429 self-identifying', () => {
    expect(readRetryAfter({ 'retry-after-heavy': '12' })).toEqual({ tier: 'heavy', seconds: 12 });
    expect(readRetryAfter({ 'retry-after-strict': '60' })).toEqual({ tier: 'strict', seconds: 60 });
  });

  it('returns undefined when no member of the family is present', () => {
    expect(readRetryAfter({ 'x-ratelimit-limit': '30' })).toBeUndefined();
  });
});

describe('readRateLimit', () => {
  it('lifts the full 2xx header set the gateway actually sends', () => {
    // Verbatim from a live `GET /api/v1/health` on the dev gateway.
    expect(
      readRateLimit({
        'x-ratelimit-limit': '30',
        'x-ratelimit-remaining': '29',
        'x-ratelimit-reset': '60',
        'ratelimit-policy': '"default";q=30;w=60',
      }),
    ).toEqual({ limit: 30, remaining: 29, resetSeconds: 60, policy: '"default";q=30;w=60', retryAfterSeconds: undefined, tier: undefined });
  });

  it('returns undefined when the response carries no rate-limit signal at all', () => {
    expect(readRateLimit({ 'content-type': 'application/json' })).toBeUndefined();
  });
});

describe('attribute — success and transport', () => {
  it('attributes nothing to a 2xx', () => {
    expect(attribute({ ...BASE, status: 200, headers: {}, body: null }).cause).toBeNull();
  });

  it('records a thrown fetch as transport, with the reason', () => {
    const result = attribute({ ...BASE, status: null, headers: {}, body: null, transportError: 'TimeoutError: signal timed out' });
    expect(result.cause).toBe('transport');
    expect(result.detail).toContain('TimeoutError');
  });
});

describe('attribute — 429 is TWO different ceilings', () => {
  // `mapQuotaCapabilityToHttp` answers 429 for every rolling-meter and
  // concurrency capability, so status alone cannot separate a rate limit from a
  // quota. If this test ever inverts, every capacity verdict inverts with it.
  it('reads the body BEFORE the status, so an entitlements 429 is never called a rate limit', () => {
    const result = attribute({
      ...BASE,
      status: 429,
      headers: {},
      body: {
        statusCode: 429,
        code: 'DOMAIN.QUOTA_EXCEEDED',
        message: 'Quota exceeded',
        correlationId: 'corr-1',
        metadata: { capability: 'monthlyConsultations', limit: 500, used: 500, requested: 1, tenantId: 't-1' },
      },
    });
    expect(result.cause).toBe('entitlement_quota');
    expect(result.detail).toContain('monthlyConsultations');
    expect(result.correlationId).toBe('corr-1');
  });

  it('calls a suffixed Retry-After the IP lane with no probe, because a non-default tier is never tenant-keyed', () => {
    const result = attribute({ ...BASE, status: 429, headers: { 'retry-after-heavy': '31' }, body: null, lane: 'per_tenant' });
    expect(result.cause).toBe('throttle_ip');
    expect(result.detail).toContain('heavy');
  });

  it('defers a default-tier 429 to the probed lane', () => {
    expect(attribute({ ...BASE, status: 429, headers: { 'retry-after': '41' }, body: null, lane: 'per_tenant' }).cause).toBe('throttle_tenant');
    expect(attribute({ ...BASE, status: 429, headers: { 'retry-after': '41' }, body: null, lane: 'per_ip' }).cause).toBe('throttle_ip');
  });

  it('refuses to guess when the lane is unknown', () => {
    expect(attribute({ ...BASE, status: 429, headers: { 'retry-after': '41' }, body: null }).cause).toBe('throttle_unknown');
    expect(attribute({ ...BASE, status: 429, headers: { 'retry-after': '41' }, body: null, lane: 'indeterminate' }).cause).toBe('throttle_unknown');
  });
});

describe('attribute — downstream Python services', () => {
  // `downstreamStatusFor` maps an upstream 5xx to 502 and an unreachable peer to
  // 503. An `apps/stt` CapacityGuard 503 is an upstream 5xx, so it arrives at a
  // client as 502. Getting this backwards would report "STT is at capacity" as
  // "STT is down", and vice versa.
  it('calls 503 + GATEWAY.DOWNSTREAM_UNAVAILABLE unreachable', () => {
    const result = attribute({
      ...BASE,
      status: 503,
      headers: { 'retry-after': '5' },
      body: {
        statusCode: 503,
        code: 'GATEWAY.DOWNSTREAM_UNAVAILABLE',
        error: 'Service Unavailable',
        message: 'Transcription is temporarily unavailable. Please retry.',
      },
    });
    expect(result.cause).toBe('downstream_unreachable');
    expect(result.detail).toBe('Transcription');
  });

  it('calls 502 + GATEWAY.DOWNSTREAM_UNAVAILABLE an upstream 5xx — where a capacity-guard 503 lands', () => {
    const result = attribute({
      ...BASE,
      status: 502,
      headers: {},
      body: { statusCode: 502, code: 'GATEWAY.DOWNSTREAM_UNAVAILABLE', error: 'Bad Gateway', message: 'Transcription is unavailable.' },
    });
    expect(result.cause).toBe('downstream_5xx');
    expect(result.detail).toContain('upstream 5xx');
  });

  it('only calls a bare 503 a peer capacity guard on the direct-peer lane', () => {
    expect(attribute({ ...BASE, status: 503, headers: {}, body: { detail: 'at capacity' }, directPeer: true }).cause).toBe('peer_capacity_503');
    expect(attribute({ ...BASE, status: 503, headers: {}, body: { detail: 'at capacity' } }).cause).toBe('server_error');
  });

  it('separates a 504 from every other 5xx', () => {
    expect(attribute({ ...BASE, status: 504, headers: {}, body: null }).cause).toBe('gateway_timeout');
  });
});

describe('attribute — the Prisma pool heuristic', () => {
  it('suspects a pool timeout for a 500 that lands in the connectionTimeoutMillis band', () => {
    const result = attribute({
      status: 500,
      headers: {},
      body: { statusCode: 500, message: 'Internal server error' },
      durationMs: 5_040,
      pgConnectTimeoutMs: 5_000,
    });
    expect(result.cause).toBe('db_pool_timeout_suspected');
    expect(result.detail).toContain('5000ms pool-acquire band');
  });

  it('leaves a fast 500 as a plain server error — the band is the ONLY signal available', () => {
    expect(attribute({ status: 500, headers: {}, body: { statusCode: 500 }, durationMs: 20, pgConnectTimeoutMs: 5_000 }).cause).toBe('server_error');
  });

  it('bands from 90% to 160% of the configured timeout', () => {
    expect(withinPoolTimeoutBand(4_499, 5_000)).toBe(false);
    expect(withinPoolTimeoutBand(4_500, 5_000)).toBe(true);
    expect(withinPoolTimeoutBand(8_000, 5_000)).toBe(true);
    expect(withinPoolTimeoutBand(8_001, 5_000)).toBe(false);
  });
});

describe('attribute — harness faults are never platform capacity', () => {
  it('separates 401/403 from other 4xx, and keeps both out of the ceiling set', () => {
    expect(attribute({ ...BASE, status: 403, headers: {}, body: { code: 'HTTP.FORBIDDEN' } }).cause).toBe('auth');
    expect(attribute({ ...BASE, status: 400, headers: {}, body: { code: 'VALIDATION.FAILED' } }).cause).toBe('client_error');
    expect(CEILING_CAUSES.has('auth')).toBe(false);
    expect(CEILING_CAUSES.has('client_error')).toBe(false);
    expect(HARNESS_FAULT_CAUSES.has('auth')).toBe(true);
  });

  it('a 403 from a feature-gate quota is a QUOTA, not an auth failure — the body decides', () => {
    const result = attribute({
      ...BASE,
      status: 403,
      headers: {},
      body: { statusCode: 403, code: 'DOMAIN.QUOTA_EXCEEDED', metadata: { capability: 'featurePlatformDefaultCredential' } },
    });
    expect(result.cause).toBe('entitlement_quota');
  });
});
