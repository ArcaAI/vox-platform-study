/**
 * TASK-825 — the mapper must carry a CLEARED `encryptedContent` through to the
 * persistence payload as an explicit `null`.
 *
 * This is the invisible dependency of the repository fix: clearing the columns
 * on the entity accomplishes nothing if `AutoEntityChangeMapper`'s custom-handler
 * pass (`if (result) model[key] = result`) drops the null on the way out. It does
 * not — the GENERIC pass above it has already copied the change — but that is a
 * property of a shared auto-mapper that no `ContextItem` test asserted, so a
 * refactor there could silently re-open TASK-825 with the repository fix still in
 * place. Pinned here, where the dependency actually lives.
 *
 * Mirrors `DocumentSectionEntityMapper.encryptedContent.test.ts` (TASK-820).
 */
import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { ContextItemEntityMapper } from '../generated/core/ContextItemEntityMapper';
import { ContextItemEntity } from '../../entities/generated/core/ContextItemEntity';
import { ContextItemType, ContextItemSource } from '../../enums';

function makeEntity(overrides: Record<string, unknown> = {}): ContextItemEntity {
  return new ContextItemEntity({
    id: 'c0000000-0000-0000-0000-000000000001',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: null,
    updatedBy: null,
    tenantId: 'tenant-1',
    consultationId: 'consult-1',
    type: ContextItemType.CASE_NOTE,
    source: ContextItemSource.USER,
    currentVersionNumber: 1,
    content: null,
    encryptedContent: Buffer.from('vault:v1:the-old-body', 'utf8'),
    contentKeyVersion: 1,
    qdrantSynced: false,
    ...overrides,
  } as never);
}

describe('ContextItemEntityMapper — a cleared encryptedContent reaches Prisma', () => {
  it('emits an explicit null for BOTH columns when the body was cleared', () => {
    const entity = makeEntity();
    entity.encryptedContent = null;
    entity.contentKeyVersion = null;

    const payload = ContextItemEntityMapper.getInstance().toPersistenceChanges(entity);

    expect(payload).toEqual({ encryptedContent: null, contentKeyVersion: null });
  });

  it('omits the key entirely when the body was never touched', () => {
    const entity = makeEntity();
    entity.currentVersionNumber = 2;

    const payload = ContextItemEntityMapper.getInstance().toPersistenceChanges(entity);

    expect(payload).not.toHaveProperty('encryptedContent');
    expect(payload).not.toHaveProperty('contentKeyVersion');
  });

  it('carries a NEW ciphertext through as a Buffer (never destructured into a byte map)', () => {
    // The `$toPersistence` custom handler exists to stop `convertEntityValue()`
    // walking `Object.keys` over a Buffer; a regression there would write
    // `{0: 118, 1: 97, …}` into a `Bytes` column.
    const entity = makeEntity();
    const fresh = Buffer.from('vault:v3:the-new-body', 'utf8');
    entity.encryptedContent = fresh;

    const payload = ContextItemEntityMapper.getInstance().toPersistenceChanges(entity);

    expect(Buffer.isBuffer(payload.encryptedContent)).toBe(true);
    expect(Buffer.from(payload.encryptedContent!).toString('utf8')).toBe('vault:v3:the-new-body');
  });
});
