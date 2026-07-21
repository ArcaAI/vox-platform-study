import { Injectable, Logger } from '@nestjs/common';
import { ISecretsProvider, SecretFetchOptions, SecretsHealth } from '../ISecretsProvider';

/**
 * EnvSecretsProvider.
 *
 * The default provider in NODE_ENV=development. Reads from process.env
 * exactly as today, preserving behaviour for local devs who run
 * `pnpm dev` without any Vault setup.
 */
@Injectable()
export class EnvSecretsProvider implements ISecretsProvider {
  // Logger is kept on the instance to allow downstream tests to spy on
  // log lines without surfacing a public API surface.
  private readonly logger = new Logger(EnvSecretsProvider.name);

  async getSecret(key: string, opts?: SecretFetchOptions): Promise<string> {
    const v = process.env[key];
    if (v === undefined || v === '') {
      if (opts?.required === false) return '';
      throw new Error(`EnvSecretsProvider: required secret '${key}' is not set in process.env`);
    }
    return v;
  }

  async getSecretOptional(key: string): Promise<string | undefined> {
    const v = process.env[key];
    return v && v.length > 0 ? v : undefined;
  }

  async getSecretJson<T>(key: string, opts?: SecretFetchOptions): Promise<T> {
    const raw = await this.getSecret(key, opts);
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`EnvSecretsProvider: secret '${key}' is not valid JSON`);
    }
  }

  async getSecrets(keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = process.env[k];
      if (v !== undefined && v !== '') out[k] = v;
    }
    return out;
  }

  async rotateSecret(_key: string): Promise<void> {
    throw new Error('EnvSecretsProvider does not support rotation; restart pod with new env');
  }

  async health(): Promise<SecretsHealth> {
    return { ok: true, latencyMs: 0, provider: 'env' };
  }
}
