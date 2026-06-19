import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as crypto from 'crypto';
import { AuditLogEntity, AuditLogRepository, type AuditLogDek } from '@arcaai/domains';
import { ICryptoService } from '../crypto/ICryptoService';
import { SecretsService } from '../baseServices/_meta/secrets';

/**
 * TASK-369 (Data Encryption Initiative) Phase 3D — AuditLog envelope encryption.
 *
 * AuditLog is the highest-volume write path in the system, so a Vault Transit
 * round-trip PER ROW (the per-field pattern used by ContextItem & the other
 * Phase 3 models) is far too costly. This service implements ENVELOPE
 * ENCRYPTION instead:
 *
 *   1. A Data Encryption Key (DEK) is generated ONCE per process and wrapped
 *      ONCE via Vault Transit (`hope-phi`). The wrapped DEK + its Transit key
 *      version are cached in memory and persisted PER ROW (`dekWrapped` /
 *      `dekKeyVersion`) so rows stay decryptable after key rotation.
 *   2. Each row's `data`/`previousData` is then encrypted LOCALLY with the
 *      authenticated AES-256-GCM CryptoService under that DEK — ZERO Vault
 *      calls on the hot path.
 *
 * Best-effort by contract (mirrors the ContextItem dual-write soak): if the
 * CryptoService or a Vault-capable SecretsService is unavailable, the write
 * degrades to plaintext-only (the plaintext JSONB columns are retained for the
 * dual-read soak) and NEVER throws into the audit write path. A failed DEK
 * bootstrap is backed off for {@link DEK_RETRY_BACKOFF_MS} so a Vault outage
 * does not turn into a per-row round-trip storm while still recovering later.
 *
 * The DEK is a 32-character ASCII string (base64 of 24 random bytes), so
 * `Buffer.from(dek, 'utf8').length === 32` and it can be used directly as the
 * AES-256 key for CryptoService.encrypt() while round-tripping losslessly
 * through Vault wrap/unwrap. 192 bits of entropy in the 256-bit key slot — a
 * deliberate, documented trade-off so the existing CryptoService string-key API
 * (which utf8-decodes its key) can be reused unchanged for a binary-ish DEK.
 */
@Injectable()
export class AuditLogEncryptionService {
  private readonly logger = new Logger(AuditLogEncryptionService.name);

  /** Re-attempt window after a failed DEK bootstrap (Vault outage / non-Vault provider). */
  private static readonly DEK_RETRY_BACKOFF_MS = 60_000;

  /** The active per-process DEK used for all NEW writes (generated + wrapped once). */
  private dek: AuditLogDek | null = null;
  /** Epoch ms of the last failed DEK bootstrap; gates retries during an outage. */
  private lastDekFailureAt = 0;
  /** `dekWrapped` → unwrapped DEK key, for decrypting rows wrapped by another DEK/process. */
  private readonly unwrapCache = new Map<string, string>();

  constructor(
    @Optional() @Inject(ICryptoService) private readonly crypto?: ICryptoService,
    @Optional() @Inject(SecretsService) private readonly secrets?: SecretsService,
    @Optional() private readonly auditLogRepository?: AuditLogRepository,
  ) {}

  /** True only when both crypto + a SecretsService are wired (Vault capability is probed lazily). */
  private get capable(): boolean {
    return Boolean(this.crypto && this.secrets && this.auditLogRepository);
  }

  /**
   * Encrypt `data`/`previousData` into the entity's `encrypted*` columns under
   * the cached DEK. Best-effort: a missing/failing dependency leaves the row
   * plaintext-only (encrypted* NULL) and is logged (message only, never PHI).
   * Plaintext columns are intentionally retained for the dual-read soak.
   */
  async encryptIntoEntity(entity: AuditLogEntity): Promise<void> {
    if (!this.capable) return;
    let dek: AuditLogDek | null;
    try {
      dek = await this.getOrCreateDek();
    } catch (err) {
      this.lastDekFailureAt = Date.now();
      this.logger.error(`AuditLog DEK bootstrap failed; writing plaintext-only (dual-read soak): ${this.errMsg(err)}`);
      return;
    }
    if (!dek) return;
    try {
      await this.auditLogRepository!.encryptEnvelopeIntoEntity(entity, this.crypto!, dek);
    } catch (err) {
      this.logger.error(`AuditLog payload encryption skipped (dual-write soak): ${this.errMsg(err)}`);
    }
  }

  /**
   * Decrypt an entity's `encrypted*` payloads in place (overwriting `data`/
   * `previousData` with the real values). No-op for legacy plaintext rows
   * (`encryptedData` NULL) — the plaintext columns already hold the values.
   * Best-effort: a decryption/unwrap failure leaves the plaintext fallback
   * untouched and is logged (message only).
   */
  async decryptIntoEntity(entity: AuditLogEntity): Promise<void> {
    if (!this.capable) return;
    if (!entity.encryptedData && !entity.encryptedPreviousData) return; // legacy plaintext row
    try {
      const dekKey = await this.resolveDekKeyForRow(entity);
      if (!dekKey) return;
      const { data, previousData } = await this.auditLogRepository!.decryptEnvelopeFromEntity(entity, this.crypto!, dekKey);
      entity.data = data as AuditLogEntity['data'];
      entity.previousData = previousData as AuditLogEntity['previousData'];
    } catch (err) {
      this.logger.error(`AuditLog payload decryption failed; serving plaintext fallback: ${this.errMsg(err)}`);
    }
  }

  /**
   * Lazily generate + Vault-wrap the per-process DEK, caching it for reuse.
   * Returns `null` (without throwing) while inside the post-failure backoff so
   * the hot write path is not retried on every row during a Vault outage.
   */
  private async getOrCreateDek(): Promise<AuditLogDek | null> {
    if (this.dek) return this.dek;
    if (this.lastDekFailureAt && Date.now() - this.lastDekFailureAt < AuditLogEncryptionService.DEK_RETRY_BACKOFF_MS) {
      return null;
    }
    const dekKey = crypto.randomBytes(24).toString('base64'); // 32 ASCII chars → 32-byte AES-256 key
    const phiKey = this.secrets!.getPhiTransitKeyName();
    const dekWrapped = await this.secrets!.encrypt(Buffer.from(dekKey, 'utf8'), phiKey);
    const dek: AuditLogDek = { dekKey, dekWrapped, dekKeyVersion: parseKeyVersion(dekWrapped) };
    this.dek = dek;
    this.unwrapCache.set(dekWrapped, dekKey);
    this.lastDekFailureAt = 0;
    return dek;
  }

  /**
   * Resolve the unwrapped DEK key for a stored row. Hits the active DEK / unwrap
   * cache first; otherwise unwraps `dekWrapped` via Vault Transit once and caches
   * it. Returns `null` for rows with no wrapped DEK (legacy plaintext rows).
   */
  private async resolveDekKeyForRow(entity: AuditLogEntity): Promise<string | null> {
    const wrapped = entity.dekWrapped;
    if (!wrapped) return null;
    if (this.dek && wrapped === this.dek.dekWrapped) return this.dek.dekKey;
    const cached = this.unwrapCache.get(wrapped);
    if (cached) return cached;
    const phiKey = this.secrets!.getPhiTransitKeyName();
    const dekKey = (await this.secrets!.decrypt(wrapped, phiKey)).toString('utf8');
    this.unwrapCache.set(wrapped, dekKey);
    return dekKey;
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Vault Transit ciphertext is `vault:vN:<b64>`; pull out N. Inlined here (rather
 * than importing the domain `field-encryption` helper, which is not exported
 * through the `@arcaai/domains` barrel) — a malformed shape falls back to 1.
 */
function parseKeyVersion(ct: string): number {
  const parts = ct.split(':');
  if (parts.length < 3 || parts[1].length < 2 || parts[1][0] !== 'v') return 1;
  const n = parseInt(parts[1].slice(1), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
