// Unit tests for the environment-gated PHI field-encryption
// guard shared by every encrypt-on-write service. Asserts the two regimes:
//   - soft (dev/test): missing secrets no-ops; an encryption error is swallowed.
//   - required (SECRETS_PROVIDER=vault): missing secrets OR an encryption error
//     THROWS so the caller's write aborts instead of persisting plaintext-only.
import { describe, it, expect, vi } from 'vitest';
import { encryptPhiFields, isPhiEncryptionRequired } from '../phi-field-encryption';

const softEnv = { SECRETS_PROVIDER: 'env' } as NodeJS.ProcessEnv;
const requiredEnv = { SECRETS_PROVIDER: 'vault' } as NodeJS.ProcessEnv;
const makeLogger = () => ({ error: vi.fn() });

describe('isPhiEncryptionRequired', () => {
  it('is required only when SECRETS_PROVIDER=vault', () => {
    expect(isPhiEncryptionRequired({ SECRETS_PROVIDER: 'vault' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isPhiEncryptionRequired({ SECRETS_PROVIDER: 'env' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isPhiEncryptionRequired({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('encryptPhiFields — soft mode (dev/test)', () => {
  it('no-ops without throwing when no SecretsService is available', async () => {
    const logger = makeLogger();
    const run = vi.fn().mockResolvedValue(undefined);

    await expect(encryptPhiFields(undefined, 'ContextItem', run, logger, softEnv)).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('swallows + logs (message only) when encryption fails', async () => {
    const logger = makeLogger();
    const run = vi.fn().mockRejectedValue(new Error('vault unreachable'));

    await expect(encryptPhiFields({}, 'SummaryMeta', run, logger, softEnv)).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toContain('SummaryMeta field encryption skipped (dual-write soak)');
    expect(logger.error.mock.calls[0][0]).toContain('vault unreachable');
  });

  it('runs the encryption when a SecretsService is present', async () => {
    const logger = makeLogger();
    const run = vi.fn().mockResolvedValue(undefined);

    await encryptPhiFields({}, 'NamedEntity', run, logger, softEnv);

    expect(run).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('encryptPhiFields — required mode (SECRETS_PROVIDER=vault)', () => {
  it('throws (fail-closed) when no SecretsService is available', async () => {
    const logger = makeLogger();
    const run = vi.fn();

    await expect(encryptPhiFields(undefined, 'ContextItem', run, logger, requiredEnv)).rejects.toThrow(
      /required \(SECRETS_PROVIDER=vault\)/,
    );

    expect(run).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('rethrows (fail-closed) when encryption of a populated PHI field fails', async () => {
    const logger = makeLogger();
    const boom = new Error('transit/encrypt 503');
    const run = vi.fn().mockRejectedValue(boom);

    await expect(encryptPhiFields({}, 'NamedEntity', run, logger, requiredEnv)).rejects.toBe(boom);

    expect(run).toHaveBeenCalledOnce();
    // fail-closed must NOT swallow-and-log — the write aborts instead.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('resolves when encryption succeeds', async () => {
    const logger = makeLogger();
    const run = vi.fn().mockResolvedValue(undefined);

    await expect(encryptPhiFields({}, 'Highlight', run, logger, requiredEnv)).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
