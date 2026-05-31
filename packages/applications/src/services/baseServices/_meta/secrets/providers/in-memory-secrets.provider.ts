import { Injectable } from '@nestjs/common';
import { ISecretsProvider, SecretFetchOptions, SecretsHealth } from '../ISecretsProvider';

/**
 * Phase 2A Task 2.4 (TASK-302 Stream B) — InMemorySecretsProvider.
 *
 * Test-only provider that mirrors the public surface of every other
 * provider. Also exposes setSecret() and a rotateSecret(key, newValue)
 * overload so test suites can simulate rotation flows.
 *
 * Never selected in production: Phase 2C's module factory only chooses
 * it when SECRETS_PROVIDER=in-memory is passed explicitly.
 */
@Injectable()
export class InMemorySecretsProvider implements ISecretsProvider {
  private store: Map<string, string>;

  constructor(seed: Record<string, string> = {}) {
    this.store = new Map(Object.entries(seed));
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async getSecret(key: string, opts?: SecretFetchOptions): Promise<string> {
    const v = this.store.get(key);
    if (v === undefined) {
      if (opts?.required === false) return '';
      throw new Error(`InMemorySecretsProvider: required secret '${key}' is not seeded`);
    }
    return v;
  }

  async getSecretOptional(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }

  async getSecretJson<T>(key: string, opts?: SecretFetchOptions): Promise<T> {
    const raw = await this.getSecret(key, opts);
    return JSON.parse(raw) as T;
  }

  async getSecrets(keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = this.store.get(k);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  async rotateSecret(key: string, newValue?: string): Promise<void> {
    if (newValue !== undefined) this.store.set(key, newValue);
  }

  async health(): Promise<SecretsHealth> {
    return { ok: true, latencyMs: 0, provider: 'in-memory' };
  }
}
