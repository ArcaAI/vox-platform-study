/**
 * TASK-790 W5 — `ContextItemEntityMapper` must not write `_version` (TASK-789 finding M-4).
 *
 * Rule 03 mandates `FIELDS_NOT_WRITABLE = ['version']` plus `stripNonWritableFields` on every
 * OCC-written mapper: `_version` is DATABASE-OWNED and its only legitimate writer is
 * `Repository.updateWithVersion`'s compare-and-set. `ContextItem` IS OCC-written — the
 * clinician SOAP-note edit path goes through `updateWithVersion` (`context.service.ts`) — but
 * this mapper carried neither the constant nor the strip, while its direct sibling
 * `SummaryMetaEntityMapper` has both.
 *
 * Not exploitable today: `Repository.updateWithVersion` deletes `version` from the payload
 * defensively. That defense is one layer; this is the layer rule 03 actually specifies, and
 * relying on the far one means any future write path that does not go through
 * `updateWithVersion` leaks `_version` into a Prisma write and silently breaks OCC.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { ContextItemEntityMapper } from '../ContextItemEntityMapper';
import { ContextItemEntity } from '../../../../entities/generated/core/ContextItemEntity';

const entity = () =>
  new ContextItemEntity({
    id: 'ci-1',
    tenantId: 't-1',
    version: 7,
    metaData: null,
    createdBy: 'u-1',
    updatedBy: 'u-1',
    createdAt: new Date('2026-08-22T00:00:00Z'),
    updatedAt: new Date('2026-08-22T00:00:00Z'),
    consultationId: 'c-1',
    type: 'SUMMARY',
    source: 'AI_GENERATED',
    currentVersionNumber: 1,
    encryptedContent: null,
    contentKeyVersion: null,
    mediaId: null,
    dnaWritingStyleId: null,
    kindKey: null,
    contextSchemaVersionId: null,
    qdrantSynced: false,
    qdrantSyncedAt: null,
    resourceStatus: 'ENABLED',
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
  } as any);

describe('ContextItemEntityMapper — _version is never written (rule 03)', () => {
  const mapper = new ContextItemEntityMapper();

  it('toPersistence strips version', () => {
    expect(mapper.toPersistence(entity())).not.toHaveProperty('version');
  });

  it('toPersistenceChanges carries the real change but never version', () => {
    // `version` is getter-only on BaseEntity, so a caller cannot set it directly — one more
    // layer, and not the one rule 03 asks for. `AutoEntityChangeMapper` builds its payload from
    // the MODEL's field list, so `version` can still be echoed into an update payload
    // independently of change tracking.
    const item = entity();
    item.currentVersionNumber = 2;

    const changes = mapper.toPersistenceChanges(item);

    expect(changes.currentVersionNumber).toBe(2);
    expect(changes).not.toHaveProperty('version');
  });

  it('toDomainEntity still carries the row version onto the entity — reads are unaffected', () => {
    const row: any = { id: 'ci-1', tenantId: 't-1', version: 7, consultationId: 'c-1', encryptedContent: null };

    expect(mapper.toDomainEntity(row).version).toBe(7);
  });
});
