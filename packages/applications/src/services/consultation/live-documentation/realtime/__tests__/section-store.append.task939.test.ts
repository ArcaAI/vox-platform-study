/**
 * TASK-939 — `applyFlushPatch` gains an APPEND mode, and the `section.patch` it publishes says
 * which part is new.
 *
 * ## The two rules this file pins
 *
 * 1. **An append is allowed where a replace is refused.** A replace on a CONFIRMED section is
 *    refused (`confirmed-no-overwrite`) because it would destroy what the clinician wrote. An
 *    append cannot destroy it, so it proceeds — which is what the entity doc, the store doc and
 *    the shipped OpenAPI description of the clinician PATCH route have all promised since they
 *    were written. A CONFIRMED section that stops accumulating stops being the record of the
 *    encounter halfway through it.
 * 2. **`appended` is additive, `content` stays whole.** The published patch keeps carrying the
 *    full body, so every existing consumer (`@arcaai/vox-node`'s `onSectionPatch`, the browser
 *    SDK, the console fold) is untouched; `appended` is extra information for a renderer that
 *    wants to mark the new part.
 *
 * LOCKED still refuses both — `isWritable()` is the gate that governs every writer.
 */
import { describe, expect, it, vi } from 'vitest';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { DocumentSectionState, type DocumentSectionEntity } from '@arcaai/domains';

import { DocumentSectionStore, type SectionWriteInput } from '../section-store';

const CID = 'consultation-939';
const TENANT = 'tenant-939';

function repositoryDouble() {
  const rows = new Map<string, DocumentSectionEntity>();
  const key = (documentKey: string, sectionKey: string) => `${documentKey}::${sectionKey}`;

  return {
    rows,
    findSection: vi.fn(async (_t: string, _c: string, documentKey: string, sectionKey: string) => rows.get(key(documentKey, sectionKey)) ?? null),
    create: vi.fn(async (entity: DocumentSectionEntity) => {
      rows.set(key(entity.documentKey, entity.sectionKey), entity);
      return entity;
    }),
    updateWithVersion: vi.fn(async (_id: string, entity: DocumentSectionEntity, expectedVersion: number) => {
      const stored = rows.get(key(entity.documentKey, entity.sectionKey));
      if (stored && stored.version !== expectedVersion) {
        throw new OptimisticConcurrencyException('DocumentSection', entity.id, expectedVersion, stored.version);
      }
      (entity as unknown as { _version: number })._version = expectedVersion + 1;
      rows.set(key(entity.documentKey, entity.sectionKey), entity);
      return entity;
    }),
    encryptContentIntoEntity: vi.fn(async () => undefined),
  };
}

const write = (over: Partial<SectionWriteInput> = {}): SectionWriteInput => ({
  consultationId: CID,
  tenantId: TENANT,
  documentKey: 'soap_note',
  sectionKey: 'subjective',
  title: 'Subjective',
  idx: 0,
  content: 'Cough for three days.',
  generation: 1,
  ...over,
});

const storeWith = (repo: ReturnType<typeof repositoryDouble>) => new DocumentSectionStore(repo as never, undefined);

describe('TASK-939 — append mode', () => {
  it('creates the section on a first append, exactly as a first replace would', async () => {
    const repo = repositoryDouble();
    const result = await storeWith(repo).applyFlushPatch(write({ mode: 'append' }));

    expect(result.applied).toBe(true);
    const row = repo.rows.get('soap_note::subjective')!;
    expect(row.content).toBe('Cough for three days.');
    expect(row.state).toBe(DocumentSectionState.PROVISIONAL);
  });

  it('ACCUMULATES across turns — the prior body is a prefix of the new one', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);

    await store.applyFlushPatch(write({ mode: 'append', generation: 1 }));
    const afterFirst = repo.rows.get('soap_note::subjective')!.content!;
    const second = await store.applyFlushPatch(write({ mode: 'append', generation: 2, content: 'Fever since last night.' }));

    expect(second.applied).toBe(true);
    const row = repo.rows.get('soap_note::subjective')!;
    expect(row.content!.startsWith(afterFirst)).toBe(true);
    expect(row.content).toBe('Cough for three days.\n\nFever since last night.');
    expect(row.revision).toBe(2);
  });

  it('APPENDS to a CONFIRMED section — where a replace is refused', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);

    await store.applyFlushPatch(write({ mode: 'append', generation: 1 }));
    const row = repo.rows.get('soap_note::subjective')!;
    row.applyClinicianContent('Cough for three days. Reviewed by me.', 'doctor-1');
    const confirmed = row.content!;

    // The replace is still refused …
    const replaced = await store.applyFlushPatch(write({ generation: 2, content: 'Something else entirely.' }));
    // R10 — the refusal hands back the AUTHORITATIVE body, so the caller can correct the note it
    // feeds the next prompt from. The row was already read to reach this verdict.
    expect(replaced).toEqual({ applied: false, reason: 'confirmed-no-overwrite', current: confirmed });

    // … and the append is not.
    const appended = await store.applyFlushPatch(write({ mode: 'append', generation: 3, content: 'Now also reports chills.' }));
    expect(appended.applied).toBe(true);
    expect(repo.rows.get('soap_note::subjective')!.content!.startsWith(confirmed)).toBe(true);
    expect(repo.rows.get('soap_note::subjective')!.state).toBe(DocumentSectionState.CONFIRMED);
  });

  it('refuses an append to a LOCKED section — isWritable governs every writer', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write({ mode: 'append', generation: 1 }));
    repo.rows.get('soap_note::subjective')!.state = DocumentSectionState.LOCKED;

    const result = await store.applyFlushPatch(write({ mode: 'append', generation: 2, content: 'Too late.' }));

    expect(result).toEqual({ applied: false, reason: 'locked' });
  });

  it('publishes `appended` alongside the WHOLE `content`, so existing consumers are untouched', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write({ mode: 'append', generation: 1 }));

    const result = await store.applyFlushPatch(write({ mode: 'append', generation: 2, content: 'Fever since last night.' }));

    expect(result.applied).toBe(true);
    if (result.applied !== true) return;
    expect(result.patch.appended).toBe('Fever since last night.');
    expect(result.patch.content).toBe('Cough for three days.\n\nFever since last night.');
  });

  it('a REPLACE patch carries no `appended` — the field means "this much is new", not "here is the body"', async () => {
    const repo = repositoryDouble();
    const result = await storeWith(repo).applyFlushPatch(write());

    expect(result.applied).toBe(true);
    if (result.applied !== true) return;
    expect(result.patch.appended).toBeUndefined();
  });

  it('an empty addition is refused as `nothing-to-append`, and writes no row', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write({ mode: 'append', generation: 1 }));
    repo.updateWithVersion.mockClear();

    const result = await store.applyFlushPatch(write({ mode: 'append', generation: 2, content: '   ' }));

    expect(result).toEqual({ applied: false, reason: 'nothing-to-append' });
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
  });

  it('the deletion-contradiction rule does not apply to an append — an append can never delete', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write({ mode: 'append', generation: 1 }));

    // An empty-content REPLACE on a populated section needs a contradiction; the equivalent
    // append is simply nothing to add, which is not a deletion and needs no justification.
    const replace = await store.applyFlushPatch(write({ generation: 2, content: '' }));
    expect(replace).toEqual({ applied: false, reason: 'deletion-without-contradiction' });

    const append = await store.applyFlushPatch(write({ mode: 'append', generation: 3, content: '' }));
    expect(append).toEqual({ applied: false, reason: 'nothing-to-append' });
  });

  it('still honours the out-of-order generation watermark', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write({ mode: 'append', generation: 5 }));

    const late = await store.applyFlushPatch(write({ mode: 'append', generation: 4, content: 'A late arrival.' }));

    expect(late).toEqual({ applied: false, reason: 'stale-generation' });
  });
});
