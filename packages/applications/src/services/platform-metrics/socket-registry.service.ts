import { Inject, Injectable, Logger } from '@nestjs/common';
import * as os from 'os';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';

/**
 * (decision #5 / #17) — multi-instance open-socket aggregation.
 *
 * Each API instance periodically publishes its LOCAL live-socket count
 * (`SttWsGateway.getActiveSessionCount()`) to Redis under a per-instance key
 * with a short TTL. The platform-metrics endpoint reads the AGGREGATE by
 * scanning those keys and summing — so a horizontally-scaled deployment reports
 * the true platform-wide socket total, and a dead instance's count self-expires.
 */
export interface ISocketRegistryService {
  /** Publish THIS instance's current open-socket count (TTL-bounded). */
  publishLocalCount(count: number): Promise<void>;
  /** Sum the live per-instance counts across all instances. */
  getAggregateCount(): Promise<number>;
  /**
   * (concurrency) — publish THIS instance's per-tenant open-socket
   * breakdown (`{tenantId: count}`) under a single TTL-bounded key. Zero/dropped
   * tenants are simply omitted from the new map (no per-tenant deletes needed),
   * and a crashed instance's whole map self-expires.
   */
  publishLocalTenantCounts(counts: Record<string, number>): Promise<void>;
  /**
   * (concurrency) — sum ONE tenant's live open-socket count across
   * every instance's published map. The signal the concurrency gate compares
   * against `maxConcurrentSessions`.
   */
  getTenantAggregateCount(tenantId: string): Promise<number>;
}

export const ISocketRegistryService = Symbol('ISocketRegistryService');

/** Redis key prefix for per-instance socket counts. */
const KEY_PREFIX = 'hope:platform:sockets:inst:';
/** Redis key prefix for the per-instance {tenantId: count} map. */
const TENANT_MAP_PREFIX = 'hope:platform:sockets:tmap:';
/**
 * Per-instance key TTL. Must exceed the publish cadence (the gateway republishes
 * on every connect/disconnect plus a heartbeat) so a live instance never expires
 * between updates, while a crashed instance drops out within this window.
 */
const KEY_TTL_SECONDS = 45;

@Injectable()
export class SocketRegistryService implements ISocketRegistryService {
  private readonly logger = new Logger(SocketRegistryService.name);
  /** Stable, unique id for this process across its lifetime. */
  private readonly instanceId = `${os.hostname()}:${process.pid}`;

  constructor(@Inject(IRedisCacheService) private readonly cache: IRedisCacheService) {}

  async publishLocalCount(count: number): Promise<void> {
    const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    await this.cache.setex(`${KEY_PREFIX}${this.instanceId}`, KEY_TTL_SECONDS, String(safe));
  }

  async getAggregateCount(): Promise<number> {
    const keys = await this.cache.scan(`${KEY_PREFIX}*`);
    if (keys.length === 0) return 0;

    const values = await Promise.all(keys.map((key) => this.cache.get(key)));
    let total = 0;
    for (const value of values) {
      const parsed = parseInt(value ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) total += parsed;
    }
    return total;
  }

  async publishLocalTenantCounts(counts: Record<string, number>): Promise<void> {
    // Keep only positive, finite integer counts — a tenant that dropped to 0 is
    // omitted so it contributes nothing once this map overwrites the previous
    // one (avoids any explicit per-tenant delete; TTL handles instance death).
    const safe: Record<string, number> = {};
    for (const [tenantId, count] of Object.entries(counts)) {
      if (tenantId && Number.isFinite(count) && count > 0) {
        safe[tenantId] = Math.floor(count);
      }
    }
    await this.cache.setex(`${TENANT_MAP_PREFIX}${this.instanceId}`, KEY_TTL_SECONDS, JSON.stringify(safe));
  }

  async getTenantAggregateCount(tenantId: string): Promise<number> {
    if (!tenantId) return 0;
    const keys = await this.cache.scan(`${TENANT_MAP_PREFIX}*`);
    if (keys.length === 0) return 0;

    const values = await Promise.all(keys.map((key) => this.cache.get(key)));
    let total = 0;
    for (const value of values) {
      if (!value) continue;
      try {
        const map = JSON.parse(value) as Record<string, unknown>;
        const parsed = Number(map?.[tenantId]);
        if (Number.isFinite(parsed) && parsed > 0) total += Math.floor(parsed);
      } catch {
        // Corrupt/partial map — ignore this instance's contribution rather than
        // failing the whole aggregate (a Redis blip must not break the gate).
      }
    }
    return total;
  }
}
