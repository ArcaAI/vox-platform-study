/**
 * An ATTACHMENT belongs to the visit it was added in: a write that names no encounter is stamped
 * with the consultation's CURRENT encounter, like a case note. FULL_TRANSCRIPT stays
 * consultation-wide.
 */
import { ContextItemSource, ContextItemType } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@arcaai/domains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/domains')>();
  return {
    ...actual,
    ContextItemFactory: {
      CreateContextItem: vi.fn((init: Record<string, unknown>) => ({
        id: 'ctx-new',
        ...init,
        changes: {} as Record<string, unknown>,
        metaData: undefined,
      })),
    },
    ContextItemVersionFactory: {
      CreateInitialVersion: vi.fn((ci: { id: string }) => ({ id: 'v1', contextItemId: ci.id, versionNumber: 1 })),
    },
  };
});

import { ContextService } from '../context.service';

const contextItemRepository = {
  findById: vi.fn(),
  create: vi.fn(),
  encryptContentIntoEntity: vi.fn(async () => undefined),
};
const contextItemVersionRepository = { create: vi.fn(), encryptFieldsIntoEntity: vi.fn(async () => undefined) };
const consultationRepository = { findById: vi.fn() };
const cls = { get: vi.fn(), set: vi.fn() };

function makeService(): ContextService {
  return new ContextService(
    contextItemRepository as never,
    contextItemVersionRepository as never,
    {} as never,
    { create: vi.fn() } as never,
    { create: vi.fn() } as never,
    consultationRepository as never,
    { emit: vi.fn() } as never,
    cls as never,
  );
}

const created = () => contextItemRepository.create.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  consultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1', doctorId: 'doctor-1', currentEncounterSeq: 2 });
  contextItemRepository.create.mockResolvedValue({
    id: 'ctx-new',
    consultationId: 'consultation-1',
    type: ContextItemType.ATTACHMENT,
    source: ContextItemSource.USER,
    mediaId: 'media-1',
    createdAt: new Date('2026-10-13T00:00:00Z'),
    updatedAt: new Date('2026-10-13T00:00:00Z'),
  });
  cls.get.mockImplementation((key: string) => (key === 'user' ? { id: 'user-1' } : key === 'tenantId' ? 'tenant-1' : null));
});

describe('ATTACHMENT — stamped with the encounter it was added in', () => {
  it('addContext stamps an ATTACHMENT with the consultation’s current encounter when the write names none', async () => {
    await makeService().addContext('consultation-1', { type: ContextItemType.ATTACHMENT, mediaId: 'media-1' });

    expect(created()).toMatchObject({ type: ContextItemType.ATTACHMENT, encounterSeq: 2 });
  });

  it('addAttachment stamps the current encounter', async () => {
    await makeService().addAttachment('consultation-1', undefined, 'media-1');

    expect(created()).toMatchObject({ type: ContextItemType.ATTACHMENT, encounterSeq: 2 });
  });

  it('honours an encounter the caller names', async () => {
    await makeService().addContext('consultation-1', { type: ContextItemType.ATTACHMENT, mediaId: 'media-1', encounterSeq: 1 });

    expect(created()).toMatchObject({ encounterSeq: 1 });
  });

  it('FULL_TRANSCRIPT stays consultation-wide', async () => {
    await makeService().addContext('consultation-1', { type: ContextItemType.FULL_TRANSCRIPT, content: 'body' });

    expect(created().encounterSeq).toBeUndefined();
  });
});
