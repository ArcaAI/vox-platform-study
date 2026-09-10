/**
 * TASK-950 (Lane A) — `UserProfile.staffId`.
 *
 * The tenant staff identifier a context-schema "user identity" field maps to
 * (`ContextUserIdentityService`, built in Lane L1). This file locks in the
 * domain-layer half only: the factory accepts and defaults it, the entity
 * exposes it through the standard `setProperty` change-tracking getter/setter
 * pair like every other nullable string field on this entity
 * (`preferredPromptTemplateId` is the sibling this mirrors), and the mapper
 * round-trips it in both directions without ever writing `_version` — the
 * OCC guard `03-domain-layer.md` requires staying intact on every mapper
 * touched by this ticket.
 */
import { describe, it, expect } from 'vitest';

import { UserProfileFactory } from '../../../../factories/generated/core/UserProfileFactory';
import { UserProfileEntityMapper } from '../../../../mappers/generated/core/UserProfileEntityMapper';
import { UserProfile } from '../../../../models/generated/core/UserProfileModel';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';

const USER_ID = '60000000-0000-0000-0000-000000000001';

const makeEntity = (staffId: string | null = 'DR-1') =>
  UserProfileFactory.CreateUserProfile({
    userId: USER_ID,
    staffId,
  });

const profileRow = (overrides: Partial<UserProfile> = {}): UserProfile =>
  new UserProfile({
    id: 'up-950-1',
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    avatarId: null,
    preferredPromptTemplateId: null,
    staffId: 'DR-1',
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    userId: USER_ID,
    User: undefined,
    version: 1,
    metaData: null,
    ...overrides,
  } as UserProfile);

describe('TASK-950 — UserProfileFactory.CreateUserProfile(staffId)', () => {
  it('carries staffId through the factory and exposes it via the getter', () => {
    const entity = makeEntity('DR-1');

    expect(entity.staffId).toBe('DR-1');
  });

  it('defaults staffId to null when omitted, like the factory does for every other optional nullable field', () => {
    const entity = UserProfileFactory.CreateUserProfile({ userId: USER_ID });

    expect(entity.staffId).toBeNull();
  });
});

describe('TASK-950 — UserProfileEntity.staffId change tracking', () => {
  it('records a tracked change when staffId is reassigned via the setter', () => {
    const entity = makeEntity(null);

    entity.staffId = 'DR-2';

    expect(entity.staffId).toBe('DR-2');
    expect(entity.changes).toMatchObject({ staffId: 'DR-2' });
  });

  it('accepts staffId up to 255 characters and rejects longer values (mirrors the sibling nullable string fields)', () => {
    const entity = makeEntity('x'.repeat(255));
    expect(() => entity.validate()).not.toThrow();

    const tooLong = makeEntity('x'.repeat(256));
    expect(() => tooLong.validate()).toThrow('User profile staffId must not exceed 255 characters');
  });
});

describe('TASK-950 — UserProfileEntityMapper.staffId round trip', () => {
  const mapper = new UserProfileEntityMapper();

  it('toDomainEntity carries staffId from the persisted row onto the entity', () => {
    const entity = mapper.toDomainEntity(profileRow({ staffId: 'DR-1' }));

    expect(entity.staffId).toBe('DR-1');
  });

  it('toPersistence (full insert path) round-trips staffId', () => {
    // UserProfile is a NON-OCC model: its mapper carries no `FIELDS_NOT_WRITABLE` strip, so a full
    // insert legitimately includes the row's own `version` (identical to every sibling field's
    // behaviour). The OCC guard is asserted on the UPDATE path below, where it matters.
    const entity = mapper.toDomainEntity(profileRow({ staffId: 'DR-1' }));

    const persisted = mapper.toPersistence(entity);

    expect(persisted.staffId).toBe('DR-1');
  });

  it('toPersistenceChanges (update path) carries an edited staffId and never writes `version`', () => {
    const entity = mapper.toDomainEntity(profileRow({ staffId: 'DR-1' }));

    entity.staffId = 'DR-2';
    const changes = mapper.toPersistenceChanges(entity);

    expect(changes.staffId).toBe('DR-2');
    expect(changes).not.toHaveProperty('version');
  });

  it('round-trips a null staffId (no identity mapped yet) in both directions', () => {
    const entity = mapper.toDomainEntity(profileRow({ staffId: null }));
    expect(entity.staffId).toBeNull();

    const persisted = mapper.toPersistence(entity);
    expect(persisted.staffId).toBeNull();
  });
});
