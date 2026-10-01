import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantCheckpointRestoreRepository } from '@arcaai/domains';
import { IRedisCacheService } from '../../baseServices/redis';
import { RedisSubscriberService } from '../../stt/realtime/redisSubscriber.service';
import { TENANT_RESTORE_COMPLETED_EVENT, type TenantRestoreCompletedPayload } from './tenant-restore-events';
import { ITenantLockService, TENANT_LOCKING_STATUSES, TENANT_LOCK_CHANNEL, TenantLockState } from '../contracts';

/** How long a node trusts its own answer before asking the database again. */
export const TENANT_LOCK_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  state: TenantLockState;
  expiresAt: number;
}

/**
 * Per-tenant read-only lock. A tenant is locked while it has a restore in a locking status.
 *
 * State is cached per process for a few seconds; a restore publishes on the lock channel when
 * its status changes so every node drops the entry immediately. A failed read is never turned
 * into "unlocked" — it rethrows and the caller fails closed.
 */
@Injectable()
export class TenantLockService implements ITenantLockService, OnModuleInit {
  private readonly logger = new Logger(TenantLockService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /** Tenants this node last saw locked; an unlock seen for one of them is a restore ending. */
  private readonly seenLocked = new Set<string>();

  constructor(
    @Inject(TenantCheckpointRestoreRepository) private readonly restores: TenantCheckpointRestoreRepository,
    @Optional() @Inject(IRedisCacheService) private readonly redisCache?: IRedisCacheService,
    @Optional() private readonly redisSubscriber?: RedisSubscriberService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.redisSubscriber) return;
    try {
      const messages$ = await this.redisSubscriber.subscribeToChannel(TENANT_LOCK_CHANNEL);
      messages$.subscribe({
        next: (message) => this.handleMessage(message),
        error: (error) => this.logger.warn({ message: 'Tenant lock subscription errored — falling back to the cache TTL', error: String(error) }),
      });
    } catch (error) {
      this.logger.warn({ message: 'Tenant lock subscription failed — falling back to the cache TTL', error: String(error) });
    }
  }

  async state(tenantId: string): Promise<TenantLockState> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.state;
    return this.read(tenantId, false);
  }

  /** Reads and caches the lock state. `emitOnUnlock` makes an unlocked answer announce the restore's end. */
  private async read(tenantId: string, emitOnUnlock: boolean): Promise<TenantLockState> {
    const active = await this.restores.findActiveByTenant(tenantId);
    const locked = !!active && (TENANT_LOCKING_STATUSES as readonly string[]).includes(active.status);
    const state: TenantLockState = locked
      ? {
          locked: true,
          restoreId: active!.id,
          categories: active!.categories?.length ? ([...active!.categories] as TenantLockState['categories']) : undefined,
        }
      : { locked: false };
    this.cache.set(tenantId, { state, expiresAt: Date.now() + TENANT_LOCK_CACHE_TTL_MS });
    this.noteTransition(tenantId, locked, emitOnUnlock);
    return state;
  }

  async publishChange(tenantId: string): Promise<void> {
    this.cache.delete(tenantId);
    if (!this.redisCache) return;
    try {
      await this.redisCache.publish(TENANT_LOCK_CHANNEL, JSON.stringify({ tenantId }));
    } catch (error) {
      // Peers still converge when their cache entry expires.
      this.logger.warn({ message: 'Failed to publish tenant lock change', tenantId, error: String(error) });
    }
  }

  /**
   * Emits once per locked -> unlocked transition this node observes — and, when `force` is set (a
   * lock-channel message just proved the restore ended), on every unlocked answer, so a node that
   * missed the lock start still drops its caches. Handlers are idempotent.
   */
  private noteTransition(tenantId: string, locked: boolean, force = false): void {
    if (locked) {
      this.seenLocked.add(tenantId);
      return;
    }
    if (!this.seenLocked.delete(tenantId) && !force) return;
    const payload: TenantRestoreCompletedPayload = { tenantId };
    try {
      this.eventEmitter?.emit(TENANT_RESTORE_COMPLETED_EVENT, payload);
    } catch (error) {
      this.logger.error({ message: 'A tenant-restore.completed listener threw', tenantId, error: String(error) });
    }
  }

  /** Drop the cached answer and re-read it now, so an unlock is noticed without waiting for a request. */
  private refresh(tenantId: string): void {
    this.cache.delete(tenantId);
    this.read(tenantId, true).catch((error) =>
      this.logger.warn({ message: 'Tenant lock refresh failed — the next request will retry', tenantId, error: String(error) }),
    );
  }

  private handleMessage(raw: string): void {
    try {
      const { tenantId } = JSON.parse(raw) as { tenantId?: string };
      if (typeof tenantId === 'string') {
        this.refresh(tenantId);
        return;
      }
    } catch {
      // swallow-ok: an unreadable message is treated as "anything may have changed" (every tenant refreshed below)
    }
    for (const tenantId of [...this.seenLocked]) this.refresh(tenantId);
    this.cache.clear();
  }
}
