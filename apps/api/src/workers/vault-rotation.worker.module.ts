// VaultRotationWorker deployment unit.
//
// Registers VaultRotationWorker as a NestJS provider that starts on
// `onApplicationBootstrap` ONLY when:
//   - SECRETS_PROVIDER=vault            (no-op otherwise)
//   - VAULT_AUDIT_LOG_PATH is set       (no path → nothing to tail)
//   - This pod acquires the cluster-wide rotation-worker leader lock
//     (single-leader pattern via Redis SET NX EX, refreshed every
//     half the lease duration).
//
// Why single-leader? Multiple workers tailing the same audit log
// would publish duplicate invalidation events. The events are
// structurally idempotent (cache.delete on an absent key is a no-op),
// so this is "correct" with N pods — but
// wasteful (N×Redis publish ops, N×log lines). The leader lease
// keeps exactly one pod active.
import { Inject, Injectable, Logger, Module, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { VaultRotationWorker, type RotationPublisher } from '@arcaai/applications';
import { IConfigService } from '@arcaai/applications';

/**
 * Token used to inject the Redis publisher into the rotation worker
 * service. The NestJS module wires a real ioredis instance under this
 * token (in production) or a stub (in tests).
 */
export const ROTATION_REDIS_PUBLISHER = Symbol.for('ROTATION_REDIS_PUBLISHER');
export const ROTATION_REDIS_LEADER = Symbol.for('ROTATION_REDIS_LEADER');

const LEADER_LOCK_KEY = 'arca:secrets:rotation-worker:leader';
const LEADER_LOCK_TTL_SEC = 30;
const LEADER_REFRESH_INTERVAL_MS = (LEADER_LOCK_TTL_SEC * 1000) / 2;

@Injectable()
export class VaultRotationWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(VaultRotationWorkerService.name);
  private readonly podId: string;
  private worker: VaultRotationWorker | null = null;
  private abortController: AbortController | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private isLeader = false;

  constructor(
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
    @Optional() @Inject(ROTATION_REDIS_PUBLISHER) private readonly publisher?: RotationPublisher,
    @Optional() @Inject(ROTATION_REDIS_LEADER) private readonly leaderRedis?: Redis,
  ) {
    this.podId = `${process.env.HOSTNAME ?? 'unknown-host'}-${process.pid}`;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.SECRETS_PROVIDER !== 'vault') {
      this.logger.log('SECRETS_PROVIDER != vault — rotation worker disabled');
      return;
    }
    const auditPath = process.env.VAULT_AUDIT_LOG_PATH;
    if (!auditPath) {
      this.logger.log('VAULT_AUDIT_LOG_PATH not set — rotation worker disabled');
      return;
    }
    if (!this.publisher || !this.leaderRedis) {
      this.logger.warn('Redis publisher / leader client not provided — rotation worker disabled');
      return;
    }

    const acquired = await this.tryAcquireLeaderLock();
    if (!acquired) {
      this.logger.log(`another pod holds ${LEADER_LOCK_KEY}; this pod will not run the rotation worker`);
      // Periodically re-attempt — if the leader pod dies, the lease
      // expires and one of the followers takes over.
      this.refreshTimer = setInterval(() => {
        void this.tryAcquireLeaderLockBackground();
      }, LEADER_REFRESH_INTERVAL_MS);
      return;
    }

    this.startWorker(auditPath);
    this.refreshTimer = setInterval(() => {
      void this.refreshLeaderLock();
    }, LEADER_REFRESH_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.abortController?.abort();
    this.worker = null;
    if (this.isLeader && this.leaderRedis) {
      // Best-effort release of the lock so a peer pod can pick up
      // without waiting for the TTL to expire.
      try {
        await this.releaseLeaderLock();
      } catch (e) {
        this.logger.warn(`leader lock release failed: ${(e as Error).message}`);
      }
    }
  }

  private async tryAcquireLeaderLock(): Promise<boolean> {
    if (!this.leaderRedis) return false;
    try {
      const res = await this.leaderRedis.set(LEADER_LOCK_KEY, this.podId, 'EX', LEADER_LOCK_TTL_SEC, 'NX');
      const acquired = res === 'OK';
      this.isLeader = acquired;
      if (acquired) {
        this.logger.log(`acquired rotation-worker leader lock as ${this.podId}`);
      }
      return acquired;
    } catch (e) {
      this.logger.error(`leader lock acquisition failed: ${(e as Error).message}`);
      return false;
    }
  }

  private async tryAcquireLeaderLockBackground(): Promise<void> {
    if (this.isLeader) return;
    const acquired = await this.tryAcquireLeaderLock();
    if (acquired) {
      const auditPath = process.env.VAULT_AUDIT_LOG_PATH;
      if (auditPath) this.startWorker(auditPath);
    }
  }

  private async refreshLeaderLock(): Promise<void> {
    if (!this.leaderRedis || !this.isLeader) return;
    try {
      // Refresh only if we still own the lock. Uses GET + conditional
      // SET to avoid stomping a successor that took over after a brief
      // hiccup.
      const current = await this.leaderRedis.get(LEADER_LOCK_KEY);
      if (current !== this.podId) {
        this.logger.warn('lost rotation-worker leader lock (taken over by another pod); stopping worker');
        this.isLeader = false;
        this.abortController?.abort();
        return;
      }
      await this.leaderRedis.expire(LEADER_LOCK_KEY, LEADER_LOCK_TTL_SEC);
    } catch (e) {
      this.logger.warn(`leader lock refresh failed: ${(e as Error).message}`);
    }
  }

  private async releaseLeaderLock(): Promise<void> {
    if (!this.leaderRedis) return;
    // Conditional delete via a small Lua script so we never delete a
    // lock owned by a successor pod (between our check and the DEL,
    // a peer might have acquired the slot — though our refresh logic
    // should have already detected this).
    const script = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
    await this.leaderRedis.eval(script, 1, LEADER_LOCK_KEY, this.podId);
  }

  private startWorker(auditPath: string): void {
    if (!this.publisher) return;
    if (this.worker) return;
    this.worker = new VaultRotationWorker({
      publisher: this.publisher,
      kvPrefix: process.env.VAULT_KV_PREFIX ?? 'hope',
    });
    this.abortController = new AbortController();
    this.logger.log(`starting rotation worker on ${auditPath} (kvPrefix=${process.env.VAULT_KV_PREFIX ?? 'hope'})`);
    void this.worker.run(auditPath, this.abortController.signal).catch((e) => this.logger.error(`rotation worker crashed: ${(e as Error).message}`));
  }
}

/**
 * Module registers VaultRotationWorkerService along with two Redis
 * clients (publisher + leader-election). The `useFactory` pattern
 * tolerates `IConfigService` not being available in tests by short-
 * circuiting to null — `VaultRotationWorkerService.onApplicationBootstrap`
 * then logs and noops.
 */
@Module({
  providers: [
    {
      provide: ROTATION_REDIS_PUBLISHER,
      useFactory: (config?: IConfigService): Redis | null => {
        if (process.env.SECRETS_PROVIDER !== 'vault') return null;
        if (!process.env.VAULT_AUDIT_LOG_PATH) return null;
        if (!config?.isRedisConfigured?.()) return null;
        const cfg = config.getRedisConfig();
        return new Redis({
          host: cfg.host,
          port: cfg.port,
          password: cfg.password,
          // Lazy connect — the worker is the only thing that uses this
          // client; if VAULT_AUDIT_LOG_PATH is absent we skip
          // construction entirely.
          lazyConnect: true,
        });
      },
      inject: [{ token: IConfigService, optional: true }],
    },
    {
      provide: ROTATION_REDIS_LEADER,
      useFactory: (config?: IConfigService): Redis | null => {
        if (process.env.SECRETS_PROVIDER !== 'vault') return null;
        if (!process.env.VAULT_AUDIT_LOG_PATH) return null;
        if (!config?.isRedisConfigured?.()) return null;
        const cfg = config.getRedisConfig();
        return new Redis({
          host: cfg.host,
          port: cfg.port,
          password: cfg.password,
          lazyConnect: true,
        });
      },
      inject: [{ token: IConfigService, optional: true }],
    },
    VaultRotationWorkerService,
  ],
  exports: [VaultRotationWorkerService],
})
export class VaultRotationWorkerModule {}
