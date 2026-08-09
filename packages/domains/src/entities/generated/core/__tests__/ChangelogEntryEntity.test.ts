/**
 * ChangelogEntryEntity + ChangelogEntryFactory unit tests (TASK-648).
 */
import { describe, it, expect } from 'vitest';
import { ChangelogEntryFactory } from '../../../../factories/generated/core/ChangelogEntryFactory';
import { ChangelogAudience, ChangelogPublishStatus, ChangelogSeverity } from '../../../../enums';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const baseProps = {
  tenantId: SYSTEM_TENANT_ID,
  platformVersion: '2.1.0',
  title: 'HOPE 2.1.0 — Malayalam TTS and per-tenant origins',
  summary: 'Malayalam TTS, per-tenant allowed origins, and release tracking.',
  body: '## Added\n- Malayalam TTS support\n',
};

describe('ChangelogEntryFactory', () => {
  it('generates a UUIDv7 id and defaults to DRAFT/INFO/ALL', () => {
    const entry = ChangelogEntryFactory.CreateChangelogEntry(baseProps);
    expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(entry.severity).toBe(ChangelogSeverity.INFO);
    expect(entry.audience).toBe(ChangelogAudience.ALL);
    expect(entry.publishStatus).toBe(ChangelogPublishStatus.DRAFT);
    expect(entry.publishedAt).toBeNull();
    expect(entry.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('accepts an explicit severity/audience', () => {
    const entry = ChangelogEntryFactory.CreateChangelogEntry({
      ...baseProps,
      severity: ChangelogSeverity.BREAKING,
      audience: ChangelogAudience.TENANT_ADMIN,
    });
    expect(entry.severity).toBe(ChangelogSeverity.BREAKING);
    expect(entry.audience).toBe(ChangelogAudience.TENANT_ADMIN);
  });
});

describe('ChangelogEntryEntity.validate', () => {
  it('passes for a well-formed draft', () => {
    const entry = ChangelogEntryFactory.CreateChangelogEntry(baseProps);
    expect(() => entry.validate()).not.toThrow();
  });

  it('rejects a missing platformVersion', () => {
    const entry = ChangelogEntryFactory.CreateChangelogEntry({ ...baseProps, platformVersion: '' });
    expect(() => entry.validate()).toThrow(/platform version/i);
  });

  it('rejects a missing title', () => {
    const entry = ChangelogEntryFactory.CreateChangelogEntry({ ...baseProps, title: '' });
    expect(() => entry.validate()).toThrow(/title/i);
  });

  it('rejects a missing summary', () => {
    const entry = ChangelogEntryFactory.CreateChangelogEntry({ ...baseProps, summary: '' });
    expect(() => entry.validate()).toThrow(/summary/i);
  });

  it('rejects a missing body', () => {
    const entry = ChangelogEntryFactory.CreateChangelogEntry({ ...baseProps, body: '' });
    expect(() => entry.validate()).toThrow(/body/i);
  });

  it('rejects a PUBLISHED entry with no publishedAt timestamp', () => {
    const entry = ChangelogEntryFactory.CreateChangelogEntry({
      ...baseProps,
      publishStatus: ChangelogPublishStatus.PUBLISHED,
    });
    expect(() => entry.validate()).toThrow(/publishedAt/i);
  });

  it('accepts a PUBLISHED entry that carries publishedAt', () => {
    const entry = ChangelogEntryFactory.CreateChangelogEntry({
      ...baseProps,
      publishStatus: ChangelogPublishStatus.PUBLISHED,
      publishedAt: new Date('2026-08-09T12:00:00.000Z'),
    });
    expect(() => entry.validate()).not.toThrow();
  });

  it('change tracking (publish transition) routes through setProperty', () => {
    const entry = ChangelogEntryFactory.CreateChangelogEntry(baseProps);
    const publishedAt = new Date('2026-08-09T12:00:00.000Z');
    entry.publishStatus = ChangelogPublishStatus.PUBLISHED;
    entry.publishedAt = publishedAt;
    expect(entry.hasChanges).toBe(true);
    expect(entry.changes).toMatchObject({ publishStatus: ChangelogPublishStatus.PUBLISHED, publishedAt });
  });
});
