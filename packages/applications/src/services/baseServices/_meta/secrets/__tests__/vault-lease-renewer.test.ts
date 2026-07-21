// VaultLeaseRenewer.
//
// Verifies:
//   - First renewal is scheduled at 50% of the initial TTL.
//   - On each successful renew(), the next tick is scheduled at 50%
//     of the NEW (possibly different) TTL.
//   - On 3 consecutive renew() failures, the renewer flips an
//     observable "degraded" flag that SecretsService.health() can read.
//   - Successful renewal after failure resets the failure counter.
//   - stop() cancels any pending tick and is idempotent.
//   - The renewer never logs the leaseId at full granularity (Gate 5).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VaultLeaseRenewer } from '../vault-lease-renewer';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VaultLeaseRenewer scheduling (Phase 5 Task 5.7)', () => {
  it('schedules the first renewal at 50% of the initial TTL', async () => {
    const renew = vi.fn(async () => ({ ttlSec: 3600 }));
    const renewer = new VaultLeaseRenewer({
      leaseId: 'database/creds/hope-app-role/abc',
      ttlSec: 3600,
      renew,
    });

    renewer.start();

    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_800_000 - 1);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith('database/creds/hope-app-role/abc');

    await renewer.stop();
  });

  it('schedules the next renewal at 50% of the NEW TTL returned by renew()', async () => {
    // Initial ttl=600s → first tick at 300_000ms.
    // renew #1 returns ttlSec=120 → next tick scheduled 60_000ms later
    // (50% of 120s), NOT 300_000ms (i.e. the renewer must adopt the
    // freshly-returned TTL, not stay glued to the initial one).
    let call = 0;
    const renew = vi.fn(async () => {
      call += 1;
      return { ttlSec: call === 1 ? 120 : 60 };
    });
    const renewer = new VaultLeaseRenewer({
      leaseId: 'lid',
      ttlSec: 600,
      renew,
    });

    renewer.start();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renewer.currentTtlSec).toBe(120);

    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(renewer.currentTtlSec).toBe(60);

    await renewer.stop();
  });

  it('does not start a new tick if start() is called twice (idempotent start)', async () => {
    const renew = vi.fn(async () => ({ ttlSec: 60 }));
    const renewer = new VaultLeaseRenewer({ leaseId: 'lid', ttlSec: 60, renew });

    renewer.start();
    renewer.start();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(renew).toHaveBeenCalledTimes(1);

    await renewer.stop();
  });

  it('stop() cancels pending tick and is idempotent', async () => {
    const renew = vi.fn(async () => ({ ttlSec: 60 }));
    const renewer = new VaultLeaseRenewer({ leaseId: 'lid', ttlSec: 60, renew });

    renewer.start();
    await renewer.stop();
    await renewer.stop();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(renew).not.toHaveBeenCalled();
  });
});

describe('VaultLeaseRenewer failure handling — degraded health', () => {
  it('flips degraded=true after 3 consecutive renewal failures and keeps trying', async () => {
    const renew = vi.fn(async () => {
      throw new Error('vault unreachable');
    });
    const renewer = new VaultLeaseRenewer({ leaseId: 'lid', ttlSec: 60, renew });

    renewer.start();

    expect(renewer.degraded).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renewer.failureCount).toBe(1);
    expect(renewer.degraded).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(renew).toHaveBeenCalledTimes(2);
    expect(renewer.failureCount).toBe(2);
    expect(renewer.degraded).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(renew).toHaveBeenCalledTimes(3);
    expect(renewer.failureCount).toBe(3);
    expect(renewer.degraded).toBe(true);

    await renewer.stop();
  });

  it('resets the failure counter and clears degraded on a successful renewal', async () => {
    let attempts = 0;
    const renew = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error('transient');
      return { ttlSec: 60 };
    });
    const renewer = new VaultLeaseRenewer({ leaseId: 'lid', ttlSec: 60, renew });

    renewer.start();

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(renewer.failureCount).toBe(2);

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(renew).toHaveBeenCalledTimes(3);
    expect(renewer.failureCount).toBe(0);
    expect(renewer.degraded).toBe(false);

    await renewer.stop();
  });

  it('invokes optional onDegraded callback exactly once at the 3rd failure', async () => {
    const onDegraded = vi.fn();
    const renew = vi.fn(async () => {
      throw new Error('vault down');
    });
    const renewer = new VaultLeaseRenewer({
      leaseId: 'lid',
      ttlSec: 60,
      renew,
      onDegraded,
    });

    renewer.start();

    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(onDegraded).toHaveBeenCalledTimes(1);
    await renewer.stop();
  });
});

describe('VaultLeaseRenewer secret residency (Gate 5)', () => {
  it('never logs the full leaseId to console', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const leaseId = 'database/creds/hope-app-role/very-secret-lease-id-VERIFY';
    const renew = vi.fn(async () => ({ ttlSec: 60 }));
    const renewer = new VaultLeaseRenewer({ leaseId, ttlSec: 60, renew });

    renewer.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await renewer.stop();

    const allCalls = [
      ...logSpy.mock.calls.flat(),
      ...errSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
    ].map((c) => (typeof c === 'string' ? c : JSON.stringify(c)));
    for (const line of allCalls) {
      expect(line).not.toContain('very-secret-lease-id-VERIFY');
    }

    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
