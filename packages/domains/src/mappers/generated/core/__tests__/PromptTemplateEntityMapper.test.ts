/**
 * PromptTemplateEntityMapper — TASK-328 A4 test-field round-trip.
 *
 * The quality/score test columns (`lastTestScore`, `lastTestOutput`,
 * `lastTestAt`) are real Prisma columns that the auto-mapper must carry
 * in BOTH directions by name. `stripNonWritableFields` only removes the
 * database-owned `version` token, so the test fields must survive every
 * write path.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { PromptTemplateEntityMapper } from '../PromptTemplateEntityMapper';
import { PromptTemplate } from '../../../../models/generated/core/PromptTemplateModel';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';

const TESTED_AT = new Date('2026-06-01T09:00:00.000Z');

const sampleRow = (overrides: Partial<PromptTemplate> = {}): PromptTemplate =>
  new PromptTemplate({
    id: 'pt-1',
    tenantId: 't-1',
    name: 'Test Prompt',
    description: null,
    content: 'Hello {{name}}',
    category: 'SYSTEM',
    variables: { name: 'string' },
    currentVersionNumber: 1,
    departmentId: null,
    scope: 'TENANT_DEFAULT',
    ownerUserId: null,
    lastTestScore: 0.75,
    lastTestOutput: 'Generated output',
    lastTestAt: TESTED_AT,
    tags: [],
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 3,
    metaData: null,
    ...overrides,
  } as PromptTemplate);

describe('PromptTemplateEntityMapper — test-field round-trip (TASK-328 A4)', () => {
  const mapper = new PromptTemplateEntityMapper();

  it('toDomainEntity carries the test fields from the database row', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.lastTestScore).toBe(0.75);
    expect(entity.lastTestOutput).toBe('Generated output');
    expect(entity.lastTestAt).toEqual(TESTED_AT);
  });

  it('toPersistenceChanges includes the test fields (not dropped) while still stripping version', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    const newTestedAt = new Date('2026-06-02T15:30:00.000Z');
    entity.lastTestScore = 0.42;
    entity.lastTestOutput = 'New output';
    entity.lastTestAt = newTestedAt;
    const persisted = mapper.toPersistenceChanges(entity) as unknown as Record<string, unknown>;
    expect(persisted).toMatchObject({
      lastTestScore: 0.42,
      lastTestOutput: 'New output',
    });
    // The auto-mapper serializes Date → ISO string on the write path; assert
    // the field survived (was not dropped) and round-trips to the same instant.
    expect(persisted.lastTestAt).toBeDefined();
    expect(new Date(persisted.lastTestAt as string).toISOString()).toBe(newTestedAt.toISOString());
    expect(persisted).not.toHaveProperty('version');
  });

  it('toPersistence (full insert path) writes the test fields but not version', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    const persisted = mapper.toPersistence(entity) as unknown as Record<string, unknown>;
    expect(persisted.lastTestScore).toBe(0.75);
    expect(persisted.lastTestOutput).toBe('Generated output');
    expect(persisted.lastTestAt).toBeDefined();
    expect(new Date(persisted.lastTestAt as string).toISOString()).toBe(TESTED_AT.toISOString());
    expect(persisted).not.toHaveProperty('version');
  });
});
