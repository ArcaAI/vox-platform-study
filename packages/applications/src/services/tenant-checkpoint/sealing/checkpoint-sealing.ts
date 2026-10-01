/**
 * Checkpoint sealing over Vault Transit:
 *   - the per-checkpoint data key is wrapped by `hope-checkpoint` (aes256-gcm96, non-exportable),
 *   - the archive digest is signed by `hope-checkpoint-sign` (ed25519, public key exportable),
 *   - the deployment identity is the hex sha256 of that signing key's public key,
 *   - an optional passphrase wrap (Argon2id) lets the owner open the file offline.
 *
 * Fail closed: on a non-Vault secrets provider every Vault-backed operation raises
 * `SEALING_UNAVAILABLE` — a checkpoint is never written unsealed or unsigned.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';

import { SecretsService } from '../../baseServices/_meta/secrets/SecretsService';
import { CHECKPOINT_SIGN_KEY, CHECKPOINT_WRAP_KEY, CheckpointError, type ICheckpointSealing, type PassphraseWrap } from '../contracts';
import { unwrapDataKeyWithPassphrase, wrapDataKeyWithPassphrase } from './passphrase';

const DATA_KEY_BYTES = 32;

@Injectable()
export class CheckpointSealing implements ICheckpointSealing {
  private deploymentIdPromise: Promise<string> | null = null;

  constructor(@Inject(SecretsService) private readonly secrets: SecretsService) {}

  private assertAvailable(): void {
    if (!this.secrets.supportsTransit() || !this.secrets.supportsSigning()) {
      throw new CheckpointError('SEALING_UNAVAILABLE', 'Checkpoint sealing requires the Vault secrets provider (SECRETS_PROVIDER=vault)');
    }
  }

  async generateDataKey(): Promise<{ plaintext: Buffer; platformWrapped: string }> {
    this.assertAvailable();
    const plaintext = randomBytes(DATA_KEY_BYTES);
    const platformWrapped = await this.secrets.encrypt(plaintext, CHECKPOINT_WRAP_KEY);
    return { plaintext, platformWrapped };
  }

  async unwrapPlatform(wrapped: string): Promise<Buffer> {
    this.assertAvailable();
    const key = await this.secrets.decrypt(wrapped, CHECKPOINT_WRAP_KEY);
    if (key.length !== DATA_KEY_BYTES) throw new Error(`checkpoint data key must be ${DATA_KEY_BYTES} bytes`);
    return key;
  }

  wrapWithPassphrase(dataKey: Buffer, passphrase: string): Promise<PassphraseWrap> {
    return wrapDataKeyWithPassphrase(dataKey, passphrase);
  }

  unwrapWithPassphrase(wrap: PassphraseWrap, passphrase: string): Promise<Buffer> {
    return unwrapDataKeyWithPassphrase(wrap, passphrase);
  }

  async sign(digest: Buffer): Promise<string> {
    this.assertAvailable();
    return this.secrets.sign(CHECKPOINT_SIGN_KEY, digest);
  }

  async verify(digest: Buffer, signature: string): Promise<boolean> {
    this.assertAvailable();
    return this.secrets.verify(CHECKPOINT_SIGN_KEY, digest, signature);
  }

  async deploymentId(): Promise<string> {
    this.assertAvailable();
    if (!this.deploymentIdPromise) {
      this.deploymentIdPromise = this.secrets
        .publicKey(CHECKPOINT_SIGN_KEY)
        .then((pk) => createHash('sha256').update(pk, 'utf8').digest('hex'))
        .catch((e: unknown) => {
          this.deploymentIdPromise = null;
          throw e;
        });
    }
    return this.deploymentIdPromise;
  }
}
