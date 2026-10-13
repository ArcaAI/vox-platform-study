/**
 * The REST read of a consultation's document is the CURRENT encounter's document.
 *
 * Section rows outlive the append of a new encounter, so the list reads served the previous
 * encounter's sections (its draft, labelled with its lock) as the consultation's document, with
 * nothing on the item to say which encounter wrote it. These reads now default to the
 * consultation's `currentEncounterSeq`, accept an explicit encounter, and every item carries the
 * `encounterSeq` it belongs to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentSectionFactory } from '@arcaai/domains';
import { DocumentSectionService } from '../document-section.service';

const TENANT = 'tenant-enc';
const CONSULTATION = 'consultation-enc';

function row(sectionKey: string, encounterSeq?: number) {
  const entity = DocumentSectionFactory.CreateDocumentSection({
    tenantId: TENANT,
    consultationId: CONSULTATION,
    documentKey: 'soap_note',
    sectionKey,
    title: sectionKey,
    idx: 0,
  });
  if (encounterSeq !== undefined) entity.metaData = { encounterSeq };
  return entity;
}

const rows = [row('legacy'), row('first', 1), row('second', 2)];

const repository = {
  findByConsultation: vi.fn(async () => rows),
  findByDocument: vi.fn(async () => rows),
  decryptContentFromEntity: vi.fn(async () => 'body'),
};
const consultations = { findByIdOrNull: vi.fn() };
const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : undefined)), set: vi.fn() };

function build(withConsultations = true) {
  return new DocumentSectionService(
    repository as never,
    { emit: vi.fn() } as never,
    cls as never,
    undefined,
    undefined,
    withConsultations ? (consultations as never) : undefined,
  );
}

const keys = (items: { sectionKey: string }[]) => items.map((item) => item.sectionKey);

beforeEach(() => {
  vi.clearAllMocks();
  consultations.findByIdOrNull.mockResolvedValue({ id: CONSULTATION, currentEncounterSeq: 2 });
});

describe('listAllSections — encounter scope', () => {
  it('defaults to the consultation’s CURRENT encounter', async () => {
    const result = await build().listAllSections(CONSULTATION);
    expect(keys(result)).toEqual(['second']);
    expect(result[0]?.encounterSeq).toBe(2);
  });

  it('answers an explicit earlier encounter, an unstamped row counting as encounter 1', async () => {
    const result = await build().listAllSections(CONSULTATION, 1);
    expect(keys(result)).toEqual(['legacy', 'first']);
    expect(result.map((item) => item.encounterSeq)).toEqual([1, 1]);
    expect(consultations.findByIdOrNull).not.toHaveBeenCalled();
  });

  it('serves every row, each labelled, when the current encounter cannot be read', async () => {
    const result = await build(false).listAllSections(CONSULTATION);
    expect(keys(result)).toEqual(['legacy', 'first', 'second']);
    expect(result.map((item) => item.encounterSeq)).toEqual([1, 1, 2]);
  });
});

describe('listSections — encounter scope', () => {
  it('defaults to the current encounter and honours an explicit one', async () => {
    expect(keys(await build().listSections(CONSULTATION, 'soap_note'))).toEqual(['second']);
    expect(keys(await build().listSections(CONSULTATION, 'soap_note', 1))).toEqual(['legacy', 'first']);
  });
});
