import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Counter } from 'prom-client';
import { QuotaExceededException } from '@arcaai/exceptions';
import { EntityId } from '@arcaai/domains';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';
import { IMetricsService } from '../baseServices/metrics/IMetricsService';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import { ProviderQuota, providerQuotaFor } from '../entitlements/provider-quotas';
import { IProviderCapacityService } from './IProviderCapacityService';
import {
  PROVIDER_CAPACITY_BLOCKED_EVENT,
  PROVIDER_CAPACITY_SKIPPED_METRIC,
  PROVIDER_RPM_CAPABILITY,
  PROVIDER_RPM_KEY_PREFIX,
  PROVIDER_RPM_KEY_TTL_SECONDS,
  PROVIDER_RPM_LUA,
  PROVIDER_RPM_WINDOW_SECONDS,
  PROVIDER_STREAMS_CAPABILITY,
  PROVIDER_STREAMS_KEY_PREFIX,
  PROVIDER_STREAM_ACQUIRE_LUA,
  PROVIDER_STREAM_OWNER_KEY_PREFIX,
  PROVIDER_STREAM_SLOT_TTL_SECONDS,
} from './provider-capacity.constants';

/** `-1` is the Lua sentinel for "unlimited"; a real limit is `>= 0`. */
const UNLIMITED_SENTINEL = -1;

/** Which dimension a skip/block belongs to (a bounded metric label). */
type CapacityDimension = 'requestsPerMinute' | 'maxConcurrentStreams';

/**
 * TASK-998 OD-4 — enforces the per-provider OUTBOUND capacity resolved by the
 * entitlements plane, with a Redis counter shared by every API replica.
 *
 * Contract, fail posture and the "why a second limiter" table live on
 * {@link IProviderCapacityService} and `provider-capacity.constants.ts`; this
 * file is the mechanism.
 *
 * The counters are Redis and NOT in-process on purpose: a per-replica counter
 * multiplies the vendor's ceiling by the replica count, which is the one thing
 * a vendor-capacity guard must never do. Both operations are single atomic Lua
 * calls for the same reason — a read-then-write pair lets N concurrent session
 * opens all observe `active = limit - 1`.
 */
@Injectable()
export class ProviderCapacityService implements IProviderCapacityService {
  private readonly logger = new Logger(ProviderCapacityService.name);

  /** Fail-open observability. `null` when metrics are unwired or registration failed. */
  private readonly skippedCounter: Counter<string> | null;

  constructor(
    @Inject(IEntitlementsService) private readonly entitlements: IEntitlementsService,
    private readonly eventEmitter: EventEmitter2,
    // Optional for the same reason the socket registry is optional on
    // `EntitlementsService`: this is a guard ON a clinical path, never a
    // precondition FOR it. Absent ⇒ every check fails open.
    @Optional() @Inject(IRedisCacheService) private readonly cache?: IRedisCacheService,
    @Optional() @Inject(IMetricsService) metrics?: IMetricsService,
  ) {
    this.skippedCounter = this.registerSkippedCounter(metrics);
  }

  private registerSkippedCounter(metrics?: IMetricsService): Counter<string> | null {
    if (!metrics) return null;
    try {
      return metrics.createCounter({
        name: PROVIDER_CAPACITY_SKIPPED_METRIC,
        help: 'Outbound provider-capacity checks skipped because the Redis counter was unavailable (fail-open). Non-zero means vendor capacity is NOT being enforced.',
        labelNames: ['dimension'],
      });
    } catch (err) {
      this.logger.warn({
        message: 'Could not register the provider-capacity skip counter — fail-open events will only be visible in logs',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // --- requests per minute (batch / sync REST) ----------------------------

  async assertRequestRate(tenantId: EntityId, provider: string | null | undefined): Promise<void> {
    const quota = await this.resolveQuota(tenantId, provider);
    const limit = quota?.requestsPerMinute ?? null;
    if (!provider || limit === null) return; // unlimited / ungated / self-hosted

    // The bucket id is derived from wall-clock minutes so every replica agrees
    // on the window without coordinating. Skew between replicas shifts a call
    // into the neighbouring bucket at worst — which the 2x key TTL absorbs.
    const bucket = Math.floor(Date.now() / (PROVIDER_RPM_WINDOW_SECONDS * 1000));
    const key = `${PROVIDER_RPM_KEY_PREFIX}${provider}:${tenantId}:${bucket}`;

    const verdict = await this.evalVerdict(PROVIDER_RPM_LUA, [key], [String(limit), String(PROVIDER_RPM_KEY_TTL_SECONDS)], 'requestsPerMinute');
    if (verdict === null) return; // FAIL OPEN — Redis could not answer
    if (verdict.allowed) return;

    this.block({
      tenantId,
      provider,
      dimension: 'requestsPerMinute',
      capability: PROVIDER_RPM_CAPABILITY,
      limit,
      used: verdict.count,
      message:
        `Cloud ASR provider '${provider}' is at its per-minute request allocation for this tenant ` +
        `(${verdict.count}/${limit} in the current minute). This bounds what the vendor account will accept; retry shortly, ` +
        `or raise the tenant allocation / platform default on /entitlements.`,
    });
  }

  // --- concurrent streams (live sockets) ----------------------------------

  async acquireStreamSlot(input: { tenantId: EntityId; provider: string | null | undefined; sessionId: string }): Promise<void> {
    const { tenantId, provider, sessionId } = input;
    const quota = await this.resolveQuota(tenantId, provider);
    // `null` here is the "do not enforce AND do not record" case — kill-switch
    // off, an ungated tenant, a self-hosted engine, or a failed resolve — so the
    // hot session-open path touches no Redis at all in any of them.
    if (!provider || !sessionId || quota === null) return;
    const limit = quota.maxConcurrentStreams;

    // A slot IS still recorded when the dimension itself is unlimited (quota is
    // present, the number is null): the reverse index is what a later
    // heartbeat/release resolves through, and recording it means turning a limit
    // ON mid-flight counts the streams that are already open instead of starting
    // from a false zero.
    // One clock read, used for both the member's score and the stale cutoff:
    // two reads could straddle a millisecond and sweep by a cutoff that does not
    // match the score being written.
    const now = Date.now();
    const verdict = await this.evalVerdict(
      PROVIDER_STREAM_ACQUIRE_LUA,
      [this.streamsKey(provider, tenantId), this.ownerKey(sessionId)],
      [
        sessionId,
        String(now),
        String(now - PROVIDER_STREAM_SLOT_TTL_SECONDS * 1000),
        String(limit ?? UNLIMITED_SENTINEL),
        String(PROVIDER_STREAM_SLOT_TTL_SECONDS),
        `${provider}|${tenantId}`,
      ],
      'maxConcurrentStreams',
    );
    if (verdict === null) return; // FAIL OPEN — Redis could not answer
    if (verdict.allowed) return;

    this.block({
      tenantId,
      provider,
      dimension: 'maxConcurrentStreams',
      capability: PROVIDER_STREAMS_CAPABILITY,
      limit: limit as number,
      used: verdict.count,
      message:
        `Cloud ASR provider '${provider}' is at its concurrent-stream allocation for this tenant ` +
        `(${verdict.count}/${limit} live streams). This bounds the vendor account's simultaneous sockets; end a live session, ` +
        `or raise the tenant allocation / platform default on /entitlements.`,
    });
  }

  async heartbeatStreamSlot(sessionId: string): Promise<void> {
    const owner = await this.readOwner(sessionId);
    if (!owner) return;
    try {
      // Re-score, re-extend. Not a full acquire: a live session must never be
      // refused by the cap its own slot is part of, and the member is present
      // by construction here.
      await this.cache?.eval(
        "redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])\nredis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))\nredis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))\nreturn 1",
        2,
        this.streamsKey(owner.provider, owner.tenantId),
        this.ownerKey(sessionId),
        sessionId,
        String(Date.now()),
        String(PROVIDER_STREAM_SLOT_TTL_SECONDS),
      );
    } catch (err) {
      // Never throws: a missed heartbeat only shortens the slot's life, and the
      // TTL is the backstop that makes that safe.
      this.logger.debug({ message: 'Provider-capacity heartbeat failed (slot will age out)', sessionId, error: errText(err) });
    }
  }

  async releaseStreamSlot(sessionId: string): Promise<void> {
    const owner = await this.readOwner(sessionId);
    if (!owner) return;
    try {
      await this.cache?.eval(
        "redis.call('ZREM', KEYS[1], ARGV[1])\nredis.call('DEL', KEYS[2])\nreturn 1",
        2,
        this.streamsKey(owner.provider, owner.tenantId),
        this.ownerKey(sessionId),
        sessionId,
      );
    } catch (err) {
      // Never throws — teardown is finalising a consultation, and an unreleased
      // slot is reclaimed by the TTL sweep on the next acquire anyway.
      this.logger.debug({ message: 'Provider-capacity release failed (slot will age out)', sessionId, error: errText(err) });
    }
  }

  // --- internals -----------------------------------------------------------

  private streamsKey(provider: string, tenantId: string): string {
    return `${PROVIDER_STREAMS_KEY_PREFIX}${provider}:${tenantId}`;
  }

  private ownerKey(sessionId: string): string {
    return `${PROVIDER_STREAM_OWNER_KEY_PREFIX}${sessionId}`;
  }

  private async readOwner(sessionId: string): Promise<{ provider: string; tenantId: string } | null> {
    if (!sessionId || !this.cache) return null;
    try {
      const raw = await this.cache.get(this.ownerKey(sessionId));
      if (!raw) return null;
      const separator = raw.indexOf('|');
      if (separator <= 0) return null;
      return { provider: raw.slice(0, separator), tenantId: raw.slice(separator + 1) };
    } catch (err) {
      this.logger.debug({ message: 'Provider-capacity owner lookup failed', sessionId, error: errText(err) });
      return null;
    }
  }

  /**
   * The tenant's resolved capacity for one provider, or `null` when nothing is
   * to be enforced (kill-switch off, ungated tenant, self-hosted engine, or a
   * failed resolve).
   *
   * A failed resolve returns `null` — FAIL OPEN — for the same reason
   * `assertMeterQuota` fails open on a metering read: this is a billing-adjacent
   * control on the clinical path, and a lookup outage must not become a 500 on
   * "start recording".
   */
  private async resolveQuota(tenantId: EntityId, provider: string | null | undefined): Promise<ProviderQuota | null> {
    if (!provider) return null;
    if (!this.entitlements.isEnforcementEnabled()) return null;
    try {
      const resolved = await this.entitlements.resolveForTenant(tenantId);
      if (!resolved.gated) return null;
      return providerQuotaFor(resolved.providerQuotas, provider);
    } catch (err) {
      this.logger.warn({
        message: 'Provider-capacity entitlement resolve failed — capacity check SKIPPED (fail-open)',
        tenantId,
        provider,
        error: errText(err),
      });
      return null;
    }
  }

  /**
   * Run one admission script. `null` means Redis could not answer and the
   * caller must fail open; the skip is logged and counted so a silently
   * unenforced platform is visible to an alert rule.
   */
  private async evalVerdict(
    script: string,
    keys: string[],
    argv: string[],
    dimension: CapacityDimension,
  ): Promise<{ allowed: boolean; count: number } | null> {
    if (!this.cache) {
      this.recordSkip(dimension, 'no Redis cache service wired');
      return null;
    }
    let raw: unknown;
    try {
      raw = await this.cache.eval(script, keys.length, ...keys, ...argv);
    } catch (err) {
      this.recordSkip(dimension, errText(err));
      return null;
    }
    // `IRedisCacheService.eval` already swallows connection/script errors and
    // answers `null`, so an unusable reply is indistinguishable from an outage
    // and is treated the same way.
    if (!Array.isArray(raw) || raw.length < 2) {
      this.recordSkip(dimension, 'Redis returned no usable verdict');
      return null;
    }
    return { allowed: Number(raw[0]) === 1, count: Number(raw[1]) || 0 };
  }

  private recordSkip(dimension: CapacityDimension, reason: string): void {
    this.logger.warn({
      message: 'Provider-capacity check SKIPPED (fail-open) — outbound vendor capacity was NOT enforced for this call',
      dimension,
      reason,
    });
    try {
      this.skippedCounter?.inc({ dimension });
    } catch {
      // Recording a skip must never become a second way to fail the request.
    }
  }

  /** Emit the audit event, then throw the typed error the gateway maps to 429. */
  private block(input: {
    tenantId: EntityId;
    provider: string;
    dimension: CapacityDimension;
    capability: string;
    limit: number;
    used: number;
    message: string;
  }): never {
    this.eventEmitter.emit(PROVIDER_CAPACITY_BLOCKED_EVENT, {
      tenantId: input.tenantId,
      provider: input.provider,
      dimension: input.dimension,
      capability: input.capability,
      limit: input.limit,
      used: input.used,
      at: new Date(),
    });

    throw new QuotaExceededException(input.message, {
      capability: input.capability,
      limit: input.limit,
      used: input.used,
      requested: 1,
      tenantId: input.tenantId,
    });
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
