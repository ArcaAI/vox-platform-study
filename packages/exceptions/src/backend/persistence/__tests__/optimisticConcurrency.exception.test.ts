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

  // TASK-302 Stream D Phase E.6 — `model` and `entityId` are exposed as
  // separate public fields so observability layers (Prometheus labels,
  // structured logs) can read them without parsing the message string.
  // Critically, `metadata` is unchanged so the SDK / UI conflict-handler
  // contract (Phase D.4 / D.5) keeps working.
  it('exposes `model` and `entityId` as public fields without folding them into metadata', () => {
    const exc = new OptimisticConcurrencyException('PromptTemplate', 'tpl-42', {
      expectedVersion: 3,
      currentVersion: 4,
    });

    expect(exc.model).toBe('PromptTemplate');
    expect(exc.entityId).toBe('tpl-42');
    // metadata stays clean — only the OCC token fields the wire
    // contract documents.
    expect(exc.metadata).toEqual({ expectedVersion: 3, currentVersion: 4 });
    expect((exc.metadata as Record<string, unknown>).model).toBeUndefined();
    expect((exc.metadata as Record<string, unknown>).entityId).toBeUndefined();
  });
});
