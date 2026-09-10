// TASK-944 lane C — sign and verify resolve the SAME secret, at the SAME moment.
//
// ## The outage this pins
//
// Measured on `hope-v2-dev` 2026-09-10 while closing a Vault↔k8s `JWT_SECRET_KEY`
// drift. After the new value was written to Vault:
//
//   - the SIGN path picked it up inside the SecretsService re-warm (~150 s), because
//     every mint site re-resolves through `SecretsService` on each call;
//   - the VERIFY path never did. `JwtStrategy` read the secret ONCE in its
//     constructor and handed the string to passport as `secretOrKey`.
//
// So `POST /auth/login` issued tokens that every authenticated route then rejected
// with 401, and it stayed that way until `hope-api` was restarted. Proven inside the
// pod by HMAC-ing a freshly issued token against both candidate secrets: the new
// value signed it and the guard still refused it.
//
// ## The contract these tests encode (option (a) of the ticket)
//
// Verification resolves the secret PER REQUEST through the same exported resolver the
// mint paths use, so a rotation converges on both halves together and needs no
// restart. There is deliberately no previous-key grace window — see the ticket's
// Implementation Plan for why that trade was taken, not missed. The cost of a
// rotation is therefore one 401 and a re-login per live session, which self-heals;
// the cost before this change was a platform-wide auth outage.
//
// The strongest available form of "the same source" is ONE function, so that is what
// is asserted: not that two call sites happen to call `getSecretSync`, but that they
// call the same resolver.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nestjs/passport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/passport')>();
  return {
    ...actual,
    // Capture what the strategy hands to passport — that object IS the contract.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    PassportStrategy: (_Strategy: any, _name: string) =>
      class MockPassportStrategy {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        constructor(opts: any) {
          capturedOptions = opts;
        }
      },
  };
});

vi.mock('passport-jwt', () => ({
  ExtractJwt: { fromAuthHeaderAsBearerToken: vi.fn().mockReturnValue(() => null) },
  Strategy: class {},
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let capturedOptions: any;

import { JWT_SECRET_KEY_NAME, resolveJwtSecret } from '../jwt-secret';
import { JwtStrategy } from '../jwt.strategy';

/** A SecretsService stand-in whose value can be changed after construction. */
function secretsServiceReturning(initial: string | undefined) {
  const state = { value: initial };
  return {
    state,
    service: {
      getSecretSync: vi.fn(() => state.value),
      getSecretOptional: vi.fn(async () => state.value),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

const cls = { set: vi.fn(), get: vi.fn() };

describe('TASK-944 — resolveJwtSecret is the one source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions = undefined;
  });

  it('prefers the warm sync cache and falls back to the async provider fetch', async () => {
    const warm = secretsServiceReturning('warm-secret');
    await expect(resolveJwtSecret(warm.service)).resolves.toBe('warm-secret');
    expect(warm.service.getSecretSync).toHaveBeenCalledWith(JWT_SECRET_KEY_NAME);
    expect(warm.service.getSecretOptional).not.toHaveBeenCalled();

    // A cold sync cache (TTL lapsed) must NOT be read as "no secret" — that is what
    // used to 401 the mint paths while verification kept working off its captured copy.
    const cold = {
      getSecretSync: vi.fn().mockReturnValue(undefined),
      getSecretOptional: vi.fn().mockResolvedValue('refetched-secret'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await expect(resolveJwtSecret(cold)).resolves.toBe('refetched-secret');
    expect(cold.getSecretOptional).toHaveBeenCalledWith(JWT_SECRET_KEY_NAME);
  });

  it('returns undefined when the provider genuinely has nothing (fail-closed at the call site)', async () => {
    const none = secretsServiceReturning(undefined);
    await expect(resolveJwtSecret(none.service)).resolves.toBeUndefined();
  });
});

describe('TASK-944 — JwtStrategy verifies against the CURRENT secret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions = undefined;
  });

  it('hands passport a provider, never a frozen secretOrKey string', () => {
    const secrets = secretsServiceReturning('boot-secret');

    // eslint-disable-next-line @typescript-eslint/no-new
    new JwtStrategy(secrets.service, cls as never);

    expect(typeof capturedOptions.secretOrKeyProvider).toBe('function');
    expect(capturedOptions.secretOrKey).toBeUndefined();
  });

  it('resolves a secret ROTATED AFTER construction — the outage case', async () => {
    const secrets = secretsServiceReturning('old-secret');
    // eslint-disable-next-line @typescript-eslint/no-new
    new JwtStrategy(secrets.service, cls as never);

    secrets.state.value = 'rotated-secret';

    const resolved = await new Promise<unknown>((resolve, reject) => {
      capturedOptions.secretOrKeyProvider(undefined, 'raw.jwt.token', (err: unknown, secret: unknown) =>
        err ? reject(err) : resolve(secret),
      );
    });

    expect(resolved).toBe('rotated-secret');
  });

  it('refuses rather than verifying against nothing when the secret cannot be resolved', async () => {
    const secrets = secretsServiceReturning('boot-secret');
    // eslint-disable-next-line @typescript-eslint/no-new
    new JwtStrategy(secrets.service, cls as never);

    secrets.state.value = undefined;

    const error = await new Promise<unknown>((resolve) => {
      capturedOptions.secretOrKeyProvider(undefined, 'raw.jwt.token', (err: unknown) => resolve(err));
    });

    expect(error).toBeInstanceOf(Error);
  });
});
