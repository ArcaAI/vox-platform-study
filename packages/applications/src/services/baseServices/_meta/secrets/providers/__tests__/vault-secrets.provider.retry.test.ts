// (B.5/B.6) — transient-error retry for Vault reads.
//
// getSecret() must ride out a short Vault blip (5xx / transport error) with
// bounded exponential backoff instead of surfacing a 5xx to the end user, but
// it must NOT retry 4xx (not-found / malformed) — those have to fail fast. The
// one exception is an AUTH 4xx (401/403), which usually means our own session
// died: that triggers a single re-login + replay, not a backoff loop. Fake timers
// drive the backoff so the suite stays sub-millisecond.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VaultSecretsProvider, VaultProviderConfig } from '../vault-secrets.provider';

function cfg(overrides: Partial<VaultProviderConfig> = {}): VaultProviderConfig {
  return {
    addr: 'http://vault:8200',
    roleId: 'rid',
    secretId: 'sid',
    kvMount: 'secret',
    kvPrefix: 'hope',
    transitMount: 'transit',
    transitKey: 'hope-globalsetting',
    ...overrides,
  };
}

/** A booted provider with a non-renewable token (no renewal timer) + a read mock. */
async function bootedWithRead(read: ReturnType<typeof vi.fn>) {
  const p = new VaultSecretsProvider(cfg());
  (p as unknown as { client: unknown }).client = {
    read,
    approleLogin: vi.fn().mockResolvedValue({
      auth: { client_token: 't', lease_duration: 1, renewable: false },
    }),
  };
  await p.boot();
  return p;
}

const err = (statusCode: number) => ({ response: { statusCode } });

describe('VaultSecretsProvider getSecret retry/backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on 5xx with backoff and returns once a later attempt succeeds', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(err(503))
      .mockRejectedValueOnce(err(503))
      .mockResolvedValue({ data: { data: { value: 'shh' } } });
    const p = await bootedWithRead(read);

    const promise = p.getSecret('JWT_SECRET_KEY');
    // Drive both backoffs (250ms then 500ms).
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBe('shh');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-auth 4xx (malformed request surfaces immediately)', async () => {
    const read = vi.fn().mockRejectedValue(err(400));
    const p = await bootedWithRead(read);

    await expect(p.getSecret('JWT_SECRET_KEY')).rejects.toBeDefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  // A 403 is NOT a permanent authz verdict here: the far commoner cause is our
  // own session dying between renewal ticks. Re-login once and replay; if the
  // replay still 403s, surface it without further backoff retries.
  it('re-authenticates once on a 403 and replays the read, then surfaces a persistent 403', async () => {
    const read = vi.fn().mockRejectedValue(err(403));
    const p = await bootedWithRead(read);
    const approleLogin = (p as unknown as { client: { approleLogin: ReturnType<typeof vi.fn> } }).client.approleLogin;

    await expect(p.getSecret('JWT_SECRET_KEY')).rejects.toBeDefined();
    expect(read).toHaveBeenCalledTimes(2); // original + one post-re-auth replay
    expect(approleLogin).toHaveBeenCalledTimes(2); // boot + one re-login
  });

  it('preserves 404 fast-fail semantics (no retry, maps to not-found)', async () => {
    const read = vi.fn().mockRejectedValue(err(404));
    const p = await bootedWithRead(read);

    await expect(p.getSecret('MISSING')).rejects.toThrow(/not found|required/i);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('gives up after the max attempts on persistent 5xx', async () => {
    const read = vi.fn().mockRejectedValue(err(500));
    const p = await bootedWithRead(read);

    const assertion = expect(p.getSecret('JWT_SECRET_KEY')).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('retries a transport error that carries no HTTP status', async () => {
    const econn = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const read = vi
      .fn()
      .mockRejectedValueOnce(econn)
      .mockResolvedValue({ data: { data: { value: 'ok' } } });
    const p = await bootedWithRead(read);

    const promise = p.getSecret('JWT_SECRET_KEY');
    await vi.advanceTimersByTimeAsync(300);
    await expect(promise).resolves.toBe('ok');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
