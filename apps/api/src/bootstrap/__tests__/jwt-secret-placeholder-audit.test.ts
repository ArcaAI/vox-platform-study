/**
 * TASK-307 W2.2 — boot-time JWT-secret placeholder audit pin.
 *
 * Mirrors the in-strategy assertion (W2.1) at the bootstrap layer so a
 * misconfigured deploy fails BEFORE the Nest container finishes wiring
 * (defense-in-depth — strategy + bootstrap both refuse the placeholder).
 *
 * The audit reads the cache-warmed JWT_SECRET_KEY from SecretsService
 * AFTER `await secretsService.boot({ warmupKeys: [...] })` has resolved,
 * then throws on the literal placeholder OR on undefined (warmup miss).
 */

import { describe, it, expect } from 'vitest';
import { assertJwtSecretNotPlaceholder } from '../jwt-secret-placeholder-audit';

const PLACEHOLDER = 'default-jwt-secret-key-change-in-production';

const fakeSecrets = (value: string | undefined) => ({
  getSecretSync: (_key: string) => value,
});

describe('TASK-307 W2.2 — bootstrap refuses placeholder secret', () => {
  it('throws when SecretsService returns the literal placeholder', () => {
    expect(() => assertJwtSecretNotPlaceholder(fakeSecrets(PLACEHOLDER) as never)).toThrowError(
      /JWT_SECRET_KEY is the literal placeholder.*refusing to boot/,
    );
  });

  it('throws when SecretsService returns undefined (warmup miss)', () => {
    expect(() => assertJwtSecretNotPlaceholder(fakeSecrets(undefined) as never)).toThrowError(
      /JWT_SECRET_KEY is the literal placeholder.*refusing to boot/,
    );
  });

  it('passes when SecretsService returns a real secret', () => {
    expect(() =>
      assertJwtSecretNotPlaceholder(fakeSecrets('a-real-32-byte-jwt-signing-secret-aaaa') as never),
    ).not.toThrow();
  });

  it('reads the JWT_SECRET_KEY key specifically', () => {
    const calls: string[] = [];
    const probed = {
      getSecretSync: (key: string) => {
        calls.push(key);
        return 'a-real-secret';
      },
    };
    assertJwtSecretNotPlaceholder(probed as never);
    expect(calls).toEqual(['JWT_SECRET_KEY']);
  });
});
