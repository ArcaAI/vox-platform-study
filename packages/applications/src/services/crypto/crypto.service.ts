import { Injectable, OnModuleInit, Logger, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { EventTypes } from '@arcaai/domains';
import { ICryptoService } from './ICryptoService';
import { IAppSettingsService } from '../baseServices/_meta/appSettings';

/**
 * Symmetric crypto + password hashing helper.
 *
 * TASK-369 Phase 5 (finding APP-002) — `encrypt()` now uses AUTHENTICATED
 * AES-256-GCM instead of the legacy unauthenticated AES-256-CBC. GCM detects
 * tampering via an auth tag (CBC silently returns garbage / is malleable). The
 * old CBC scheme is retained ONLY on the decrypt path so any ciphertext
 * produced by the previous implementation stays readable during a migration
 * window; nothing writes CBC anymore.
 *
 * Ciphertext formats:
 *   - GCM (new):   `gcm:v1:<ivHex>:<authTagHex>:<ciphertextHex>`
 *   - CBC (legacy, decrypt-only): `<ivHex>:<ciphertextHex>`
 */
@Injectable()
export class CryptoService implements ICryptoService, OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private readonly DEFAULT_SALT_ROUNDS = 10;

  private readonly GCM_ALGORITHM = 'aes-256-gcm';
  private readonly GCM_IV_LENGTH = 12; // 96-bit nonce — the GCM standard
  private readonly GCM_PREFIX = 'gcm:v1:';
  // Legacy scheme — used ONLY to decrypt pre-existing ciphertext.
  private readonly LEGACY_CBC_ALGORITHM = 'aes-256-cbc';

  private saltRounds: number = this.DEFAULT_SALT_ROUNDS;

  constructor(@Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService) {}

  async onModuleInit() {
    await this.loadSettings();
  }

  @OnEvent(EventTypes.AppSettingsUpdated)
  private async handleSettingsUpdate() {
    this.logger.log('Reloading crypto settings due to AppSettings update');
    await this.loadSettings();
  }

  private async loadSettings() {
    // Only the bcrypt cost factor remains configurable. The cipher is now fixed
    // to authenticated AES-256-GCM (no longer operator-selectable), so the
    // previous `crypto.algorithm` / `crypto.ivLength` knobs are gone.
    this.saltRounds = this.appSettings.getValueWithDefault('crypto.saltRounds', this.DEFAULT_SALT_ROUNDS);
    this.logger.debug('Crypto settings loaded', { saltRounds: this.saltRounds });
  }

  async hash(password: string): Promise<string> {
    return bcrypt.hash(password, this.saltRounds);
  }

  async verify(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Encrypt with authenticated AES-256-GCM. A fresh 96-bit IV is generated per
   * call and the GCM auth tag is embedded so tampering is detected on decrypt.
   * `key` must be a 32-byte AES-256 key (Node throws otherwise).
   */
  async encrypt(data: string, key: string): Promise<string> {
    const iv = crypto.randomBytes(this.GCM_IV_LENGTH);
    const cipher = crypto.createCipheriv(this.GCM_ALGORITHM, Buffer.from(key), iv);
    const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${this.GCM_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypt the new authenticated GCM format, or — for backward compatibility
   * during the migration window — the legacy CBC format. GCM ciphertext is
   * recognised by the `gcm:v1:` prefix; anything else is treated as legacy CBC.
   */
  async decrypt(encryptedData: string, key: string): Promise<string> {
    if (encryptedData.startsWith(this.GCM_PREFIX)) {
      return this.decryptGcm(encryptedData, key);
    }
    return this.decryptLegacyCbc(encryptedData, key);
  }

  private decryptGcm(encryptedData: string, key: string): string {
    const [ivHex, authTagHex, ciphertextHex] = encryptedData.slice(this.GCM_PREFIX.length).split(':');
    // ciphertextHex may legitimately be '' (empty plaintext), so check for
    // presence (undefined) rather than truthiness — only iv + tag are required.
    if (ivHex === undefined || authTagHex === undefined || ciphertextHex === undefined) {
      throw new Error('Invalid GCM ciphertext format');
    }
    const decipher = crypto.createDecipheriv(this.GCM_ALGORITHM, Buffer.from(key), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    // .final() throws if the auth tag does not verify (tamper / wrong key).
    const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  }

  private decryptLegacyCbc(encryptedData: string, key: string): string {
    const [ivHex, encryptedHex] = encryptedData.split(':');
    if (!ivHex || !encryptedHex) {
      throw new Error('Invalid ciphertext format');
    }
    const decipher = crypto.createDecipheriv(this.LEGACY_CBC_ALGORITHM, Buffer.from(key), Buffer.from(ivHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  }
}
