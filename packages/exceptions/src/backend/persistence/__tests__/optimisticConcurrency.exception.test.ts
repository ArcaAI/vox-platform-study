import { describe, it, expect } from 'vitest';
import { OptimisticConcurrencyException } from '../optimisticConcurrency.exception';

describe('OptimisticConcurrencyException', () => {
  it('carries entity name, id, expected and current version', () => {
    const exc = new OptimisticConcurrencyException('GlobalSetting', 'gs-1', {
      expectedVersion: 7,
      currentVersion: 8,
    });

    expect(exc.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
    expect(exc.message).toContain('GlobalSetting');
    expect(exc.message).toContain('gs-1');
    expect(exc.metadata).toEqual({ expectedVersion: 7, currentVersion: 8 });
  });

  it('serialises to JSON with the version metadata preserved', () => {
    const exc = new OptimisticConcurrencyException('Tenant', 't-1', {
      expectedVersion: 1,
      currentVersion: 2,
    });
    const json = exc.toJSON();
    expect(json.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
    expect(json.metadata).toEqual({ expectedVersion: 1, currentVersion: 2 });
  });
});
