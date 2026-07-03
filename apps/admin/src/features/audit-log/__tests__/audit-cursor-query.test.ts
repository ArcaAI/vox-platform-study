import { describe, expect, it } from 'vitest';
import { auditCursorFilterKey, type AuditCursorFilters } from '../audit-cursor-query';

describe('auditCursorFilterKey (cursor reset key)', () => {
  it('produces equal keys for equivalent filter sets regardless of object identity', () => {
    const a: AuditCursorFilters = { action: 'CREATE', resourceType: 'User' };
    const b: AuditCursorFilters = { action: 'CREATE', resourceType: 'User' };
    expect(auditCursorFilterKey(a, 20)).toBe(auditCursorFilterKey(b, 20));
  });

  it('changes when the page size changes', () => {
    const filters: AuditCursorFilters = { action: 'CREATE' };
    expect(auditCursorFilterKey(filters, 20)).not.toBe(auditCursorFilterKey(filters, 50));
  });

  it('changes when any filter field changes', () => {
    const base: AuditCursorFilters = { action: 'CREATE' };
    expect(auditCursorFilterKey(base, 20)).not.toBe(auditCursorFilterKey({ action: 'DELETE' }, 20));
    expect(auditCursorFilterKey(base, 20)).not.toBe(auditCursorFilterKey({ action: 'CREATE', userId: 'u-1' }, 20));
  });

  it('treats missing and empty filters as equal (normalized to "")', () => {
    expect(auditCursorFilterKey({}, 20)).toBe(auditCursorFilterKey({ action: undefined, from: undefined }, 20));
  });
});
