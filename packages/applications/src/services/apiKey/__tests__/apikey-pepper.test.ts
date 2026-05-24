// TASK-302 Phase 3 Task 3.3 — pin the API_KEY_PEPPER migration.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiKeyService } from '../apikey.service';

describe('apikey.service.ts — API_KEY_PEPPER migration', () => {
  it('does not read process.env.API_KEY_PEPPER', () => {
    const path = resolve(__dirname, '../apikey.service.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/process\.env\.API_KEY_PEPPER/);
  });

  it('uses SecretsService.getSecretOptional for API_KEY_PEPPER', () => {
    const path = resolve(__dirname, '../apikey.service.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/secretsService.*getSecretOptional\(['"]API_KEY_PEPPER['"]\)/s);
  });

  it('hashKeyForStorage resolves the pepper via SecretsService', async () => {
    const mockSecrets = {
      getSecretOptional: vi.fn().mockResolvedValue('integration-test-pepper'),
    } as unknown as ConstructorParameters<typeof ApiKeyService>[3];
    const service = new ApiKeyService(
      {} as never,
      { emit: vi.fn() } as never,
      { get: vi.fn(), set: vi.fn() } as never,
      mockSecrets,
    );
    const out = await service.hashKeyForStorage('raw-key');
    const { createHmac } = await import('crypto');
    expect(out).toBe(
      createHmac('sha256', 'integration-test-pepper').update('raw-key').digest('hex'),
    );
  });

  it('hashKeyForStorage falls back to plain SHA-256 when SecretsService is absent', async () => {
    const service = new ApiKeyService(
      {} as never,
      { emit: vi.fn() } as never,
      { get: vi.fn(), set: vi.fn() } as never,
    );
    const out = await service.hashKeyForStorage('raw-key');
    const { createHash } = await import('crypto');
    expect(out).toBe(createHash('sha256').update('raw-key').digest('hex'));
  });
});
