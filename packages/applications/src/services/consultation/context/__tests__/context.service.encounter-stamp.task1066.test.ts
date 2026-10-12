/**
 * Context items that belong to ONE visit carry the encounter they were written in.
 *
 * Owner decision: STRUCTURED, CASE_NOTE (and its WORKNOTE sibling), the note (RAW_SUMMARY) and
 * PRE_SUMMARY are stamped with `encounterSeq`; a write that names none gets the consultation's
 * CURRENT encounter. FULL_TRANSCRIPT stays consultation-wide, and a plain TRANSCRIPT is untouched.
 * A caller may name an encounter explicitly — never one that does not exist yet.
 */
import { BadRequestException } from '@nestjs/common';
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
      CreateRawSummary: vi.fn((tenantId: string, consultationId: string, content: string) => ({
        id: 'sum-new',
        tenantId,
        consultationId,
        content,
        type: actual.ContextItemType.RAW_SUMMARY,
        changes: {} as Record<string, unknown>,
      })),
    },
    ContextItemVersionFactory: {
      CreateInitialVersion: vi.fn((ci: { id: string }) => ({ id: 'v1', contextItemId: ci.id, versionNumber: 1 })),
    },
    SummaryMetaFactory: {
      CreateWithContext: vi.fn(() => ({ id: 'meta-1' })),
    },
  };
});

import { ContextService } from '../context.service';

const contextItemRepository = {
  findById: vi.fn(),
  create: vi.fn(),
  findWithSummaryMeta: vi.fn(),
  encryptContentIntoEntity: vi.fn(async () => undefined),
};
const contextItemVersionRepository = { create: vi.fn(), encryptFieldsIntoEntity: vi.fn(async () => undefined) };
const summaryMetaRepository = { create: vi.fn(), encryptFieldsIntoEntity: vi.fn(async () => undefined) };
const consultationRepository = { findById: vi.fn() };
const cls = { get: vi.fn(), set: vi.fn() };

function saved(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ctx-new',
    consultationId: 'consultation-1',
    type: ContextItemType.CASE_NOTE,
    source: ContextItemSource.USER,
    content: 'x',
    createdAt: new Date('2026-10-05T00:00:00Z'),
    updatedAt: new Date('2026-10-05T00:00:00Z'),
    ...overrides,
  };
}

function makeService(): ContextService {
  return new ContextService(
    contextItemRepository as never,
    contextItemVersionRepository as never,
    {} as never,
    summaryMetaRepository as never,
    { create: vi.fn() } as never,
    consultationRepository as never,
    { emit: vi.fn() } as never,
    cls as never,
  );
}

const created = () => contextItemRepository.create.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  consultationRepository.findById.mockResolvedValue({ id: 'consultation-1', tenantId: 'tenant-1', doctorId: 'doctor-1', currentEncounterSeq: 3 });
  contextItemRepository.create.mockResolvedValue(saved());
  contextItemRepository.findWithSummaryMeta.mockResolvedValue(saved({ type: ContextItemType.RAW_SUMMARY }));
  cls.get.mockImplementation((key: string) => (key === 'user' ? { id: 'user-1' } : key === 'tenantId' ? 'tenant-1' : null));
});

describe('addContext — the encounter a visit-scoped item belongs to', () => {
  it.each([ContextItemType.STRUCTURED, ContextItemType.CASE_NOTE, ContextItemType.WORKNOTE, ContextItemType.PRE_SUMMARY])(
    'stamps a %s with the consultation’s CURRENT encounter when the write names none',
    async (type) => {
      await makeService().addContext('consultation-1', { type, content: 'body' });

      expect(created()).toMatchObject({ encounterSeq: 3 });
    },
  );

  it('the pre-summary writer (addPreSummary) stamps the current encounter', async () => {
    await makeService().addPreSummary('consultation-1', 'pre-summary body');

    expect(created()).toMatchObject({ type: ContextItemType.PRE_SUMMARY, encounterSeq: 3 });
  });

  it.each([ContextItemType.TRANSCRIPT, ContextItemType.FULL_TRANSCRIPT])('leaves a %s unstamped (consultation-wide)', async (type) => {
    await makeService().addContext('consultation-1', { type, content: 'body' });

    expect(created().encounterSeq).toBeUndefined();
  });

  it('honours an encounter the caller names', async () => {
    await makeService().addContext('consultation-1', { type: ContextItemType.CASE_NOTE, content: 'body', encounterSeq: 2 });

    expect(created()).toMatchObject({ encounterSeq: 2 });
  });

  it('refuses an encounter that does not exist yet (400) and writes nothing', async () => {
    await expect(
      makeService().addContext('consultation-1', { type: ContextItemType.CASE_NOTE, content: 'body', encounterSeq: 4 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(contextItemRepository.create).not.toHaveBeenCalled();
  });
});

describe('addRawSummary — the note belongs to the encounter it was written in', () => {
  it('stamps the RAW_SUMMARY with the consultation’s current encounter', async () => {
    await makeService().addRawSummary('consultation-1', { content: 'the note' });

    expect(created()).toMatchObject({ type: ContextItemType.RAW_SUMMARY, encounterSeq: 3 });
  });
});
