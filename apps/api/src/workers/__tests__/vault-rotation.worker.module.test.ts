// VaultRotationWorkerService.
//
// We DO NOT spin up Nest's full DI container here; the service is
// straightforward and the value of an integration test is in the
// underlying VaultRotationWorker (already covered by
// vault-rotation-worker.test.ts). Instead, we drive the service
// directly with stubbed Redis dependencies and assert:
//   - The bootstrap noops when SECRETS_PROVIDER != vault.
//   - The bootstrap noops when VAULT_AUDIT_LOG_PATH is unset.
//   - The leader lock is attempted via Redis SET …NX EX.
//   - The worker does not start when the leader lock is taken.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  VaultRotationWorkerService,
} from '../vault-rotation.worker.module';

function makePub() {
  return { publish: vi.fn(async () => 1) };
}

function makeLeader({ acquire = true }: { acquire?: boolean } = {}) {
  // Typed signature matches the redis SET ... NX EX <seconds> usage in the
  // worker; without it `mock.calls[i]` is inferred as an empty tuple and the
  // tests can't index args[0..4].
  const set = vi.fn(async (_key: string, _value: string, _ex: 'EX', _ttl: number, _nx: 'NX') =>
    acquire ? 'OK' : null,
  );
  const get = vi.fn(async () => 'self-pod');
  const expire = vi.fn(async () => 1);
  const evalFn = vi.fn(async () => 1);
  return {
    set,
    get,
    expire,
    eval: evalFn,
  };
}

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('VaultRotationWorkerService bootstrap guards', () => {
  it('noops when SECRETS_PROVIDER != vault', async () => {
    process.env.SECRETS_PROVIDER = 'env';
    process.env.VAULT_AUDIT_LOG_PATH = '/tmp/foo';
    const pub = makePub();
    const leader = makeLeader();
    const svc = new VaultRotationWorkerService(
      undefined,
      pub as never,
      leader as never,
    );
    await svc.onApplicationBootstrap();
    expect(leader.set).not.toHaveBeenCalled();
    expect(pub.publish).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('noops when VAULT_AUDIT_LOG_PATH is unset', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    delete process.env.VAULT_AUDIT_LOG_PATH;
    const pub = makePub();
    const leader = makeLeader();
    const svc = new VaultRotationWorkerService(
      undefined,
      pub as never,
      leader as never,
    );
    await svc.onApplicationBootstrap();
    expect(leader.set).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });

  it('noops when Redis publisher / leader are missing', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    process.env.VAULT_AUDIT_LOG_PATH = '/tmp/foo';
    const svc = new VaultRotationWorkerService(undefined, undefined, undefined);
    await svc.onApplicationBootstrap();
    await svc.onModuleDestroy();
  });

  it('attempts leader acquisition via Redis SET …NX EX', async () => {
    process.env.SECRETS_PROVIDER = 'vault';
    // Point at a non-existent path; the worker startup is best-effort
    // (statSync may throw but the bootstrap returns synchronously after
    // the lock acquisition).
    process.env.VAULT_AUDIT_LOG_PATH = '/tmp/__nonexistent_audit_log__';
    const pub = makePub();
    const leader = makeLeader({ acquire: false }); // simulate peer pod
    const svc = new VaultRotationWorkerService(
      undefined,
      pub as never,
      leader as never,
    );
    await svc.onApplicationBootstrap();
    expect(leader.set).toHaveBeenCalledTimes(1);
    const args = leader.set.mock.calls[0];
    expect(args[0]).toBe('arca:secrets:rotation-worker:leader');
    expect(args[2]).toBe('EX');
    expect(args[3]).toBe(30);
    expect(args[4]).toBe('NX');
    await svc.onModuleDestroy();
  });
});
