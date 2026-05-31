// TASK-302 Phase 6 Task 6.6 (Stream B) — Scheduled rotation processor.
//
// OPTIONAL. Disabled by default; opt-in via VAULT_ROTATION_SCHEDULE
// (cron string, e.g. '0 3 * * 0' for weekly 03:00 Sunday). Mirrors the
// pattern in the SRE rotation runbook (§16 of the deployment doc).
//
// What it does:
//   1. Loads the rotation policy table (key → maxAgeDays).
//   2. Reads the last-rotation timestamp per key from `auditLog`.
//   3. For each due key:
//        - generates a fresh random secret value
//        - writes it to Vault kv-v2 under secret/data/<prefix>/<KEY>
//        - publishes {"key":"<KEY>"} to arca:secrets:invalidate
//        - records an audit entry (key + timestamp only, never value)
//
// This processor is a SEED — it's small and self-contained so the
// security team can refine the policy table + secret generators per
// secret type as a follow-up (e.g. OIDC_CLIENT_SECRET requires
// out-of-band coordination with the IdP). The kept-tiny scope avoids
// over-fitting to a single rotation procedure when the long-term
// answer may be Vault Enterprise's static-role rotation.
import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { RotationPolicy, LastRotatedMap } from '@arcaai/applications';
import { policyDueKeys } from '@arcaai/applications';

interface RotationPublisher {
  publish(channel: string, message: string): Promise<number> | number;
}

interface VaultPutFn {
  (key: string, value: string): Promise<{ keyVersion: number }>;
}

interface AuditAppendFn {
  (entry: { action: 'vault.kv.rotate'; key: string; keyVersion: number; timestamp: number }): Promise<void>;
}

interface NewSecretFn {
  (key: string): string;
}

export interface ScheduledRotationProcessorOptions {
  policies: RotationPolicy[];
  lastRotated: LastRotatedMap;
  now: () => number;
  vaultPut: VaultPutFn;
  publisher: RotationPublisher;
  auditAppend: AuditAppendFn;
  /** Optional generator override (tests). Default: 32-byte hex. */
  newSecret?: NewSecretFn;
  /** Pub/Sub channel. Default: arca:secrets:invalidate. */
  channel?: string;
}

export interface ScheduledRotationResult {
  rotated: string[];
  skipped: string[];
  failed: Array<{ key: string; error: string }>;
}

@Injectable()
export class ScheduledRotationProcessor {
  private readonly logger = new Logger(ScheduledRotationProcessor.name);
  private readonly channel: string;
  private readonly newSecret: NewSecretFn;

  constructor(private readonly opts: ScheduledRotationProcessorOptions) {
    this.channel = opts.channel ?? 'arca:secrets:invalidate';
    this.newSecret = opts.newSecret ?? defaultNewSecret;
  }

  /**
   * Single pass of the rotation loop. The BullMQ scheduled job (when
   * wired) invokes processOnce() per cron tick. Returns a structured
   * summary for the caller to log + alert on.
   */
  async processOnce(): Promise<ScheduledRotationResult> {
    const now = this.opts.now();
    const due = policyDueKeys(now, this.opts.policies, this.opts.lastRotated);
    const skipped = this.opts.policies.map((p) => p.key).filter((k) => !due.includes(k));

    const rotated: string[] = [];
    const failed: Array<{ key: string; error: string }> = [];

    for (const key of due) {
      const value = this.newSecret(key);
      try {
        const { keyVersion } = await this.opts.vaultPut(key, value);
        await this.opts.publisher.publish(this.channel, JSON.stringify({ key }));
        await this.opts.auditAppend({
          action: 'vault.kv.rotate',
          key,
          keyVersion,
          timestamp: now,
        });
        rotated.push(key);
        this.logger.log(`rotated key=${key} → version=${keyVersion}`);
      } catch (e) {
        const msg = (e as Error).message;
        // CRITICAL: do not include `value` in the error log — even on
        // failure the new value must never reach a log line. The catch
        // path also intentionally skips publish + audit so the cache
        // remains coherent (the new value never got written if vaultPut
        // threw).
        this.logger.error(`rotation failed for key=${key}: ${msg}`);
        failed.push({ key, error: msg });
      }
    }

    return { rotated, skipped, failed };
  }
}

function defaultNewSecret(_key: string): string {
  return randomBytes(32).toString('hex');
}
