// TASK-302 Phase 6 Task 6.6 (Stream B) — Scheduled rotation processor.
import { describe, it, expect, vi } from 'vitest';
import { ScheduledRotationProcessor } from '../scheduled-rotation.processor';

describe('ScheduledRotationProcessor.processOnce (Phase 6 Task 6.6)', () => {
  it('rotates every due key, publishes invalidation, and writes audit entries (key only, never value)', async () => {
    const publisher = {
      publish: vi.fn(async () => 1),
    };
    const vaultPut = vi.fn(async (key: string, _value: string) => ({ keyVersion: 7 }));
    const auditAppend = vi.fn(async () => {});
    const newSecret = vi.fn(() => 'redacted-new-value');
    const now = new Date('2026-05-25T00:00:00Z').getTime();

    const proc = new ScheduledRotationProcessor({
      policies: [
        { key: 'API_KEY_PEPPER', maxAgeDays: 180 },
        { key: 'OIDC_CLIENT_SECRET', maxAgeDays: 90 },
      ],
      lastRotated: { OIDC_CLIENT_SECRET: now - 30 * 86400_000 },
      now: () => now,
      vaultPut,
      publisher,
      auditAppend,
      newSecret,
      channel: 'arca:secrets:invalidate',
    });

    const result = await proc.processOnce();

    expect(result.rotated).toEqual(['API_KEY_PEPPER']);
    expect(result.skipped).toEqual(['OIDC_CLIENT_SECRET']);

    expect(vaultPut).toHaveBeenCalledTimes(1);
    expect(vaultPut.mock.calls[0][0]).toBe('API_KEY_PEPPER');

    expect(publisher.publish).toHaveBeenCalledWith(
      'arca:secrets:invalidate',
      JSON.stringify({ key: 'API_KEY_PEPPER' }),
    );

    expect(auditAppend).toHaveBeenCalledWith({
      action: 'vault.kv.rotate',
      key: 'API_KEY_PEPPER',
      keyVersion: 7,
      timestamp: now,
    });

    // Critical: no audit entry must include the rotated value.
    const auditPayload = JSON.stringify(auditAppend.mock.calls[0][0]);
    expect(auditPayload).not.toContain('redacted-new-value');
  });

  it('continues processing remaining keys when one rotation fails (best-effort)', async () => {
    const publisher = { publish: vi.fn(async () => 1) };
    const vaultPut = vi.fn(async (key: string) => {
      if (key === 'OIDC_CLIENT_SECRET') throw new Error('Vault forbidden');
      return { keyVersion: 1 };
    });
    const auditAppend = vi.fn(async () => {});
    const newSecret = vi.fn(() => 'X');
    const now = new Date('2026-05-25T00:00:00Z').getTime();

    const proc = new ScheduledRotationProcessor({
      policies: [
        { key: 'API_KEY_PEPPER', maxAgeDays: 180 },
        { key: 'OIDC_CLIENT_SECRET', maxAgeDays: 90 },
      ],
      lastRotated: {}, // both due
      now: () => now,
      vaultPut,
      publisher,
      auditAppend,
      newSecret,
    });

    const result = await proc.processOnce();
    expect(result.rotated).toEqual(['API_KEY_PEPPER']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].key).toBe('OIDC_CLIENT_SECRET');
    expect(result.failed[0].error).toMatch(/forbidden/i);
  });

  it('returns empty when no keys are due', async () => {
    const now = new Date('2026-05-25T00:00:00Z').getTime();
    const proc = new ScheduledRotationProcessor({
      policies: [{ key: 'API_KEY_PEPPER', maxAgeDays: 180 }],
      lastRotated: { API_KEY_PEPPER: now - 10 * 86400_000 },
      now: () => now,
      vaultPut: vi.fn(),
      publisher: { publish: vi.fn() },
      auditAppend: vi.fn(),
      newSecret: vi.fn(),
    });
    const r = await proc.processOnce();
    expect(r).toEqual({ rotated: [], skipped: ['API_KEY_PEPPER'], failed: [] });
  });
});
