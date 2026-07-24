/**
 * PromptTemplateEntityMapper — test-field round-trip.
 *
 * `lastTestScore` and `lastTestAt` are real Prisma columns the auto-mapper must
 * carry in BOTH directions by name. The plaintext `lastTestOutput` column was DROPPED
 * (free-text PHI): it now survives only as a transient entity field backed by
 * the `encryptedLastTestOutput` ciphertext column, so it must NEVER appear in a
 * persistence payload. `stripNonWritableFields` still removes the database-owned
 * `version` token.
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

describe('PromptTemplateEntityMapper — test-field round-trip', () => {
  const mapper = new PromptTemplateEntityMapper();

  it('toDomainEntity carries the non-PHI test fields from the database row', () => {
    // Phase 6 — `lastTestOutput` is no longer a column; it is a transient field
    // repopulated by decrypt-on-read, not by the mapper from a Model row.
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.lastTestScore).toBe(0.75);
    expect(entity.lastTestAt).toEqual(TESTED_AT);
  });

  it('toPersistenceChanges keeps lastTestScore/lastTestAt but never the dropped lastTestOutput', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    const newTestedAt = new Date('2026-06-02T15:30:00.000Z');
    entity.lastTestScore = 0.42;
    entity.lastTestOutput = 'New output'; // transient PHI — must not persist
    entity.lastTestAt = newTestedAt;
    const persisted = mapper.toPersistenceChanges(entity) as unknown as Record<string, unknown>;
    expect(persisted).toMatchObject({ lastTestScore: 0.42 });
    // Phase 6 — dropped plaintext column must never reach persistence.
    expect(persisted).not.toHaveProperty('lastTestOutput');
    // The auto-mapper serializes Date → ISO string on the write path; assert
    // the field survived (was not dropped) and round-trips to the same instant.
    expect(persisted.lastTestAt).toBeDefined();
    expect(new Date(persisted.lastTestAt as string).toISOString()).toBe(newTestedAt.toISOString());
    expect(persisted).not.toHaveProperty('version');
  });

  it('carries approvedVersionNumber in both directions (writable — approveTemplate persists it via OCC)', () => {
    const entity = mapper.toDomainEntity(sampleRow({ approvedVersionNumber: 4 }));
    expect(entity.approvedVersionNumber).toBe(4);

    // Re-approval bumps the pin; the CAS write must carry the new value.
    entity.approvedVersionNumber = 5;
    const persisted = mapper.toPersistenceChanges(entity) as unknown as Record<string, unknown>;
    expect(persisted.approvedVersionNumber).toBe(5);
    // Still stripped: the DB-owned OCC token.
    expect(persisted).not.toHaveProperty('version');
  });

  it('toPersistence (full insert path) writes the non-PHI test fields but not version or lastTestOutput', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    entity.lastTestOutput = 'Generated output'; // transient PHI — must not persist
    const persisted = mapper.toPersistence(entity) as unknown as Record<string, unknown>;
    expect(persisted.lastTestScore).toBe(0.75);
    // Phase 6 — dropped plaintext column must never reach persistence.
    expect(persisted).not.toHaveProperty('lastTestOutput');
    expect(persisted.lastTestAt).toBeDefined();
    expect(new Date(persisted.lastTestAt as string).toISOString()).toBe(TESTED_AT.toISOString());
    expect(persisted).not.toHaveProperty('version');
  });
});
