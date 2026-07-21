// Vault rotation worker.
//
// Tails the Vault audit log file and publishes an
// `arca:secrets:invalidate` Pub/Sub event when a kv-v2 write under
// `secret/data/<kvPrefix>/<KEY>` is observed. The fleet of HOPE API
// pods subscribes (via SecretsService.attachRedisSubscriber)
// and evicts the rotated key from its in-process LRU cache.
//
// Scope:
//   - This worker DOES NOT rotate secrets itself. It REACTS to rotations
//     performed by operators (manual runbook §16 of the SRE blueprint)
//     or by the optional scheduled-rotation processor (Task 6.6).
//   - One worker per cluster (leader-elected by the deployment module
//     in apps/api, Task 6.5). Multiple workers would publish duplicate
//     events — non-harmful because the consumer is idempotent
//     (cache.delete on an absent key is a no-op), but wasteful.
import { Injectable, Logger } from '@nestjs/common';
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Subset of ioredis Pub/Sub interface we actually need. Typed as a
 * structural minimum so tests don't need to instantiate real Redis,
 * and so the worker doesn't drag ioredis into the wider applications
 * package import graph (it's already used by other modules but kept
 * narrow here for explicitness).
 */
export interface RotationPublisher {
  publish(channel: string, message: string): Promise<number> | number;
}

export interface VaultRotationWorkerOptions {
  publisher: RotationPublisher;
  /** Pub/Sub channel. Default: SecretsService.INVALIDATION_CHANNEL. */
  channel?: string;
  /** kv-v2 prefix under `secret/data/`. Default: 'hope'. */
  kvPrefix?: string;
  /** File-tail poll interval. Default: 1000ms. */
  pollIntervalMs?: number;
}

interface AuditEntry {
  type?: string;
  request?: {
    operation?: string;
    path?: string;
  };
}

@Injectable()
export class VaultRotationWorker {
  private readonly logger = new Logger(VaultRotationWorker.name);
  private readonly channel: string;
  private readonly kvPathRegex: RegExp;
  private readonly pollIntervalMs: number;

  constructor(private readonly opts: VaultRotationWorkerOptions) {
    this.channel = opts.channel ?? 'arca:secrets:invalidate';
    const prefix = opts.kvPrefix ?? 'hope';
    // Anchored regex: only kv-v2 data writes under our prefix qualify.
    // We intentionally ignore secret/metadata/* paths — those are
    // version-list / delete-version events, not value rotations.
    this.kvPathRegex = new RegExp(`^secret/data/${escapeRegex(prefix)}/(.+)$`);
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
  }

  /**
   * Parse a single audit-log line; if it represents
   * a kv-v2 write under our prefix, publish an invalidation event.
   *
   * Public so the unit tests can drive it without spinning up the
   * file-tail loop.
   */
  async handleAuditLine(line: string): Promise<void> {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch (e) {
      this.logger.debug(`bad audit line ignored: ${(e as Error).message} :: ${line.slice(0, 64)}`);
      return;
    }
    if (entry.type !== 'request') return;
    const op = entry.request?.operation;
    const path = entry.request?.path;
    if (!path || (op !== 'update' && op !== 'create')) return;

    const m = path.match(this.kvPathRegex);
    if (!m) return;
    const key = m[1];
    try {
      await this.opts.publisher.publish(this.channel, JSON.stringify({ key }));
      this.logger.log(`invalidation published for key=${key} on channel=${this.channel}`);
    } catch (e) {
      // Important: never include the audit-log line in the error log —
      // it may include the path which is fine, but in some Vault audit
      // configurations the JSON body includes request/response data.
      this.logger.error(`failed to publish invalidation: ${(e as Error).message}`);
    }
  }

  /**
   * File-tail loop. Polls the audit log every
   * `pollIntervalMs` ms; if the file has grown, reads the new bytes
   * and feeds each line through `handleAuditLine`. Starts at EOF so
   * historical entries are not replayed on boot.
   *
   * Honours an AbortSignal so the deployment module (Task 6.5) can
   * cancel the loop cleanly on shutdown.
   */
  async run(auditLogPath: string, signal?: AbortSignal): Promise<void> {
    let position = statSync(auditLogPath).size;
    while (!signal?.aborted) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
      if (signal?.aborted) break;
      let size: number;
      try {
        size = statSync(auditLogPath).size;
      } catch (e) {
        // File may have been rotated away momentarily; log and retry.
        this.logger.warn(`audit log stat failed (will retry): ${(e as Error).message}`);
        continue;
      }
      if (size <= position) {
        if (size < position) {
          // Log got truncated/rotated. Re-anchor at the new EOF so we
          // don't replay the entire (now smaller) file.
          this.logger.log(`audit log truncated (${position} → ${size}); re-anchoring at new EOF`);
          position = size;
        }
        continue;
      }
      const stream = createReadStream(auditLogPath, { start: position, end: size });
      const rl = createInterface({ input: stream });
      for await (const line of rl) {
        if (line.trim().length === 0) continue;
        await this.handleAuditLine(line);
      }
      position = size;
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
