/**
 * UserChangelogAcknowledgementEntity + UserChangelogAcknowledgementFactory
 * unit tests.
 */
import { describe, it, expect } from 'vitest';
import { UserChangelogAcknowledgementFactory } from '../../../../factories/generated/core/UserChangelogAcknowledgementFactory';

const TENANT_ID = 't-1';

const baseProps = {
  tenantId: TENANT_ID,
  userId: 'user-1',
  changelogEntryId: 'entry-1',
};

describe('UserChangelogAcknowledgementFactory', () => {
  it('generates a UUIDv7 id and defaults autoAcknowledged to false', () => {
    const ack = UserChangelogAcknowledgementFactory.CreateUserChangelogAcknowledgement(baseProps);
    expect(ack.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ack.autoAcknowledged).toBe(false);
    expect(ack.acknowledgedAt).toBeInstanceOf(Date);
    // Scoped to the ACKNOWLEDGING USER'S tenant, not SYSTEM.
    expect(ack.tenantId).toBe(TENANT_ID);
  });

  it('supports the auto-acknowledged back-fill for a user created after an entry was published', () => {
    const ack = UserChangelogAcknowledgementFactory.CreateUserChangelogAcknowledgement({
      ...baseProps,
      autoAcknowledged: true,
    });
    expect(ack.autoAcknowledged).toBe(true);
  });
});

describe('UserChangelogAcknowledgementEntity.validate', () => {
  it('passes for a well-formed acknowledgement', () => {
    const ack = UserChangelogAcknowledgementFactory.CreateUserChangelogAcknowledgement(baseProps);
    expect(() => ack.validate()).not.toThrow();
  });

  it('rejects a missing tenantId (BaseTenantEntity backstop)', () => {
    const ack = UserChangelogAcknowledgementFactory.CreateUserChangelogAcknowledgement({ ...baseProps, tenantId: '' });
    expect(() => ack.validate()).toThrow(/tenant/i);
  });

  it('rejects a missing userId', () => {
    const ack = UserChangelogAcknowledgementFactory.CreateUserChangelogAcknowledgement({ ...baseProps, userId: '' });
    expect(() => ack.validate()).toThrow(/user id/i);
  });

  it('rejects a missing changelogEntryId', () => {
    const ack = UserChangelogAcknowledgementFactory.CreateUserChangelogAcknowledgement({ ...baseProps, changelogEntryId: '' });
    expect(() => ack.validate()).toThrow(/changelog entry id/i);
  });
});
