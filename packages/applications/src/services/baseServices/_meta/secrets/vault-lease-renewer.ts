import { Logger } from '@nestjs/common';

/**
 * VaultLeaseRenewer — periodic worker that refreshes a Vault DB-engine
 * lease BEFORE expiry to keep the underlying short-lived PostgreSQL
 * user alive while the pod holds it.
 *
 * TASK-302 Phase 5 Task 5.7 (Stream B).
 *
 * Cadence:
 *   - First renewal is scheduled at 50% of the initial TTL.
 *   - On each successful renew(), the next tick is scheduled at 50%
 *     of the freshly-returned TTL — handling the case where Vault's
 *     `default_ttl` differs from `max_ttl - elapsed` at renewal time.
 *   - On renewal failure, the renewer increments `failureCount` and
 *     reschedules at 50% of the LAST KNOWN TTL (not the failed call's
 *     TTL, which is undefined) so that subsequent attempts cluster
 *     close enough to keep the lease alive on transient errors.
 *
 * Degraded health (Gate 5 fail-closed-at-boot vs stale-while-revalidate
 * for already-connected pods — we choose SWR semantics):
 *   - After 3 consecutive failures, `degraded = true` and (optionally)
 *     `onDegraded()` fires exactly once. The renewer KEEPS trying.
 *   - Health endpoints (`SecretsService.health()` etc.) read `.degraded`
 *     to surface the warning without dropping the active credential.
 *   - First successful renewal after a failure run resets the counter
 *     and clears `degraded`.
 *
 * Secret-residency Gate 5:
 *   - The leaseId is held in a single private field.
 *   - Log lines redact the leaseId tail (first 24 chars only) so a
 *     scraped log does not surface the full Vault-internal identifier.
 *   - The constructor signature does NOT accept a password.
 */

export interface VaultLeaseRenewerOptions {
  /** Vault lease id (`database/creds/<role>/<token>`). */
  leaseId: string;
  /** Initial lease TTL in seconds (from Vault's lease_duration). */
  ttlSec: number;
  /**
   * Async callback that performs the renewal RPC. Receives the
   * leaseId so node-vault `leaseRenew({ lease_id })` can be wired
   * here without us pulling node-vault into this file. Returns the
   * new TTL in seconds.
   */
  renew(leaseId: string): Promise<{ ttlSec: number }>;
  /** Callback fired exactly once when degraded flips from false→true. */
  onDegraded?: (failureCount: number) => void;
  /** Logger override (defaults to a Nest Logger). */
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** Failure threshold before `degraded` flips. Default 3. */
  failureThreshold?: number;
}

export class VaultLeaseRenewer {
  /** Last known good TTL — used to schedule the next retry on failure. */
  private lastTtlSec: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private _failureCount = 0;
  private _degraded = false;
  private readonly leaseId: string;
  private readonly renew: VaultLeaseRenewerOptions['renew'];
  private readonly onDegraded: VaultLeaseRenewerOptions['onDegraded'];
  private readonly logger: NonNullable<VaultLeaseRenewerOptions['logger']>;
  private readonly failureThreshold: number;

  constructor(opts: VaultLeaseRenewerOptions) {
    if (!opts.leaseId) throw new Error('VaultLeaseRenewer: leaseId is required');
    if (!opts.ttlSec || opts.ttlSec <= 0) {
      throw new Error('VaultLeaseRenewer: ttlSec must be a positive integer');
    }
    if (typeof opts.renew !== 'function') {
      throw new Error('VaultLeaseRenewer: renew callback is required');
    }
    this.leaseId = opts.leaseId;
    this.lastTtlSec = opts.ttlSec;
    this.renew = opts.renew;
    this.onDegraded = opts.onDegraded;
    this.logger = opts.logger ?? new Logger(VaultLeaseRenewer.name);
    this.failureThreshold = opts.failureThreshold ?? 3;
  }

  /** True after `failureThreshold` consecutive renewal failures. */
  get degraded(): boolean {
    return this._degraded;
  }

  /** Consecutive renewal failures since the last success (or start). */
  get failureCount(): number {
    return this._failureCount;
  }

  /** Last observed TTL in seconds (initial value, then per-tick update). */
  get currentTtlSec(): number {
    return this.lastTtlSec;
  }

  /** Lease id, with the tail redacted (Gate 5 residency). */
  private redactedLeaseId(): string {
    return this.leaseId.length <= 24
      ? this.leaseId
      : `${this.leaseId.slice(0, 24)}…`;
  }

  /** Start the periodic renewal loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.log(
      `VaultLeaseRenewer started (lease=${this.redactedLeaseId()}, ttl=${this.lastTtlSec}s)`,
    );
    this.scheduleNext(this.lastTtlSec);
  }

  /** Stop the loop and clear any pending tick. Idempotent. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.log(`VaultLeaseRenewer stopped (lease=${this.redactedLeaseId()})`);
  }

  /**
   * Schedule the next renewal at 50% of the supplied TTL. We intentionally
   * compute the interval against the LATEST known TTL (not a fixed initial
   * value) so a Vault server that capped a renewal short doesn't leave us
   * stranded with a too-late next attempt.
   */
  private scheduleNext(ttlSec: number): void {
    if (!this.running) return;
    const intervalMs = Math.max(1, Math.floor((ttlSec * 1000) / 2));
    this.timer = setTimeout(() => {
      void this.tick();
    }, intervalMs);
  }

  /**
   * One renewal cycle. Public-visible side-effects only mutate the
   * three observable bits: lastTtlSec, _failureCount, _degraded.
   */
  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const { ttlSec } = await this.renew(this.leaseId);
      const wasDegraded = this._degraded;
      this.lastTtlSec = ttlSec;
      this._failureCount = 0;
      this._degraded = false;
      if (wasDegraded) {
        this.logger.log(
          `VaultLeaseRenewer recovered (lease=${this.redactedLeaseId()}, ttl=${ttlSec}s)`,
        );
      }
    } catch (err: unknown) {
      this._failureCount += 1;
      const msg = (err as Error).message;
      this.logger.warn(
        `VaultLeaseRenewer renewal failed (lease=${this.redactedLeaseId()}, attempt=${this._failureCount}): ${msg}`,
      );
      if (this._failureCount >= this.failureThreshold && !this._degraded) {
        this._degraded = true;
        this.logger.error(
          `VaultLeaseRenewer DEGRADED after ${this._failureCount} consecutive failures (lease=${this.redactedLeaseId()}); secrets-health will report degraded until a renewal succeeds.`,
        );
        try {
          this.onDegraded?.(this._failureCount);
        } catch (cbErr) {
          this.logger.error(
            `VaultLeaseRenewer onDegraded callback threw: ${(cbErr as Error).message}`,
          );
        }
      }
    } finally {
      // Schedule the next cycle even on failure so the renewer keeps
      // trying until either it recovers or the consuming app shuts it
      // down. The interval falls back to the last-known TTL on failure.
      this.scheduleNext(this.lastTtlSec);
    }
  }
}
