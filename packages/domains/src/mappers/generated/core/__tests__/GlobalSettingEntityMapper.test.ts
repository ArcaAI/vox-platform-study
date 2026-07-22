/**
 * GlobalSettingEntityMapper — version round-trip tests.
 *
 * `_version` is a database-owned column whose only legitimate writer is
 * `Repository.updateWithVersion`. The mapper must therefore:
 *  - carry `version` from the database row up into the entity (read), and
 *  - exclude `version` from both the full-insert and change-tracked write
 *    paths so the AutoMappers cannot pick it up by accident.
 *
 * `_version` is database-owned; mappers strip it from writes.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { GlobalSettingEntityMapper } from '../GlobalSettingEntityMapper';
import { GlobalSetting } from '../../../../models/generated/core/GlobalSettingModel';
import { ValueType } from '../../../../enums/generated/ValueType';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';

const sampleRow = (overrides: Partial<GlobalSetting> = {}): GlobalSetting =>
  new GlobalSetting({
    id: 'gs-1',
    tenantId: 't-1',
    name: 'n',
    key: 'k',
    value: 'v',
    defaultValue: null,
    description: null,
    namespace: null,
    dataType: ValueType.String,
    locked: false,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    tags: [],
    version: 7,
    metaData: null,
    ...overrides,
  } as GlobalSetting);

describe('GlobalSettingEntityMapper — version round-trip (Stream D Phase B)', () => {
  const mapper = new GlobalSettingEntityMapper();

  it('toDomainEntity carries `version` from the database row', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.version).toBe(7);
  });

  it('toPersistenceChanges never contains `version`, even if the change set has it', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    // simulate a buggy caller poking the internal change set
    (entity as any)._changes = { value: 'v2', version: 99 };
    const persisted = mapper.toPersistenceChanges(entity);
    expect(persisted).not.toHaveProperty('version');
    // Other legitimate changes still come through.
    expect(persisted).toMatchObject({ value: 'v2' });
  });

  it('toPersistence (full insert path) does not write `version`', () => {
    const entity = mapper.toDomainEntity(sampleRow({ version: 1 }));
    const persisted = mapper.toPersistence(entity);
    // Prisma applies @default(1); we never echo it back.
    expect(persisted).not.toHaveProperty('version');
  });
});
