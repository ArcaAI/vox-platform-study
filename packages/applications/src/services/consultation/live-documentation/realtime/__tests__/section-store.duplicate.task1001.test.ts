/**
 * TASK-1001 (wave 2) — the `duplicate` flag is PERSISTED on the row and PUBLISHED on the patch, and
 * it SURVIVES later appends.
 *
 * The turn contract puts `duplicate` annotations on a write, addressed into that write's own
 * `content` (the new part, on an append). Only the store knows the body the write lands on, so the
 * store re-bases them and merges them into the section's annotation list — which is the one field
 * both the persisted row and `toPatch` read.
 *
 * Every other annotation kind is recomputed over the post-turn note on every write, so replacing the
 * list is right for them. A `duplicate` is a fact about the turn that WROTE the text and cannot be
 * recomputed, so the store must carry it across appends — and must drop it when the text it
 * addressed is gone (a replace, or a clinician's rewrite).
 */
import { describe, expect, it, vi } from 'vitest';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import type { DocumentSectionEntity } from '@arcaai/domains';

import { DocumentSectionStore, type SectionWriteInput } from '../section-store';
import { SECTION_ANNOTATION_KINDS, type SectionAnnotationDto } from '../dto/section-patch.dto';

const CID = 'consultation-1001-xsection';
const TENANT = 'tenant-1001';

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

const PARAGRAPH = [
  'The patient mentioned that symptoms such as cough and fever are caused by bacteria in the gut.',
  'The patient also noted that arthritis is related to gut issues.',
].join(' ');
const PRIOR = 'Suspected inflammatory arthritis.';

const write = (over: Partial<SectionWriteInput> = {}): SectionWriteInput => ({
  consultationId: CID,
  tenantId: TENANT,
  documentKey: 'clinical_note',
  sectionKey: 'diagnosis',
  title: 'Diagnosis',
  idx: 1,
  content: PRIOR,
  mode: 'append',
  generation: 1,
  ...over,
});

/** The flag the turn contract would put on a write of `content`, addressed into `content`. */
const flagOn = (content: string, span: string = content): SectionAnnotationDto => ({
  kind: 'duplicate',
  start: content.indexOf(span),
  end: content.indexOf(span) + span.length,
  duplicateOf: 'family_history',
  duplicateOfTitle: 'Family History',
});

const storeWith = (repo: ReturnType<typeof repositoryDouble>) => new DocumentSectionStore(repo as never, undefined);
const rowOf = (repo: ReturnType<typeof repositoryDouble>) => repo.rows.get('clinical_note::diagnosis')!;
const duplicatesIn = (annotations: unknown) => ((annotations ?? []) as SectionAnnotationDto[]).filter((a) => a.kind === 'duplicate');

describe('TASK-1001 (wave 2) — `duplicate` is a declared annotation kind', () => {
  it('is in SECTION_ANNOTATION_KINDS', () => {
    expect(SECTION_ANNOTATION_KINDS).toContain('duplicate');
  });
});

describe('TASK-1001 (wave 2) — the flag is persisted and published', () => {
  it('RE-BASES the write`s flag onto the body the append lands on — on the row AND on the patch', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write());

    const result = await store.applyFlushPatch(write({ content: PARAGRAPH, generation: 2, contentAnnotations: [flagOn(PARAGRAPH)] }));

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    const body = `${PRIOR}\n\n${PARAGRAPH}`;
    // Content is exactly what the append would have written without the flag.
    expect(rowOf(repo).content).toBe(body);
    expect(result.patch.content).toBe(body);

    const expected = {
      kind: 'duplicate',
      start: PRIOR.length + 2,
      end: body.length,
      duplicateOf: 'family_history',
      duplicateOfTitle: 'Family History',
    };
    // PERSISTED …
    expect(duplicatesIn(rowOf(repo).annotations)).toEqual([expected]);
    // … and PUBLISHED, from the same field.
    expect(duplicatesIn(result.patch.annotations)).toEqual([expected]);
    expect(result.patch.content.slice(expected.start, expected.end)).toBe(PARAGRAPH);
  });

  it('MERGES the flag with the annotations the write was handed, in position order', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write());

    const body = `${PRIOR}\n\n${PARAGRAPH}`;
    const at = body.indexOf('arthritis');
    const entity: SectionAnnotationDto = { kind: 'entity', start: at, end: at + 'arthritis'.length, type: 'CONDITION' };
    const result = await store.applyFlushPatch(
      write({ content: PARAGRAPH, generation: 2, annotations: [entity], contentAnnotations: [flagOn(PARAGRAPH)] }),
    );

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.patch.annotations!.map((a) => a.kind)).toEqual(['entity', 'duplicate']);
    expect(result.patch.annotations![0]).toEqual(entity);
    expect(rowOf(repo).annotations).toEqual(result.patch.annotations);
  });

  it('places a first write`s flag at the write`s own offsets — there is no prior body to land after', async () => {
    const repo = repositoryDouble();
    const result = await storeWith(repo).applyFlushPatch(write({ content: PARAGRAPH, contentAnnotations: [flagOn(PARAGRAPH)] }));

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(duplicatesIn(result.patch.annotations)).toEqual([flagOn(PARAGRAPH)]);
  });

  it('places a first-write REPLACE`s flag at the write`s own offsets — a replace IS the body', async () => {
    const repo = repositoryDouble();
    const content = `${PRIOR} ${PARAGRAPH}`;
    const result = await storeWith(repo).applyFlushPatch(write({ mode: 'replace', content, contentAnnotations: [flagOn(content, PARAGRAPH)] }));

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    const [flag] = duplicatesIn(result.patch.annotations);
    expect(result.patch.content.slice(flag!.start, flag!.end)).toBe(PARAGRAPH);
  });

  it('drops a flag that does not lie inside the written text rather than clamping it', async () => {
    const repo = repositoryDouble();
    const result = await storeWith(repo).applyFlushPatch(
      write({ content: PARAGRAPH, contentAnnotations: [{ ...flagOn(PARAGRAPH), end: PARAGRAPH.length + 5 }] }),
    );

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(duplicatesIn(result.patch.annotations)).toEqual([]);
  });

  it('a write with no flag persists EXACTLY what it persisted before this ticket', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write());
    await store.applyFlushPatch(write({ content: 'Now also reports chills.', generation: 2 }));

    // `annotations` absent ⇒ the row's list is null, as it always was.
    expect(rowOf(repo).annotations).toBeNull();
  });
});

describe('TASK-1001 (wave 2) — the flag survives later appends, and only them', () => {
  it('SURVIVES a later append that says nothing about it, still addressing the same text', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write());
    await store.applyFlushPatch(write({ content: PARAGRAPH, generation: 2, contentAnnotations: [flagOn(PARAGRAPH)] }));
    const [before] = duplicatesIn(rowOf(repo).annotations);

    // The next turn's reanchored list knows nothing about the flag; the store carries it.
    const later = await store.applyFlushPatch(write({ content: 'Plan to review in clinic.', generation: 3, annotations: [] }));

    expect(later.applied).toBe(true);
    if (!later.applied) return;
    expect(later.patch.content).toBe(`${PRIOR}\n\n${PARAGRAPH}\n\nPlan to review in clinic.`);
    // Appends never move earlier text, so the offsets are unchanged and still address the paragraph.
    expect(duplicatesIn(later.patch.annotations)).toEqual([before]);
    expect(later.patch.content.slice(before!.start, before!.end)).toBe(PARAGRAPH);
    expect(duplicatesIn(rowOf(repo).annotations)).toEqual([before]);
  });

  it('shifts a carried flag by the leading whitespace the append trims off the prior body', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    // A replace stores its body verbatim, leading whitespace included.
    const padded = `  ${PARAGRAPH}`;
    await store.applyFlushPatch(write({ mode: 'replace', content: padded, contentAnnotations: [flagOn(padded, PARAGRAPH)] }));
    expect(duplicatesIn(rowOf(repo).annotations)[0]).toMatchObject({ start: 2 });

    const later = await store.applyFlushPatch(write({ content: 'Plan to review in clinic.', generation: 2 }));

    expect(later.applied).toBe(true);
    if (!later.applied) return;
    // `appendMachineContent` trims the prior body, so the paragraph now starts at 0.
    expect(later.patch.content.startsWith(PARAGRAPH)).toBe(true);
    const [flag] = duplicatesIn(later.patch.annotations);
    expect(flag).toMatchObject({ start: 0, end: PARAGRAPH.length });
    expect(later.patch.content.slice(flag!.start, flag!.end)).toBe(PARAGRAPH);
  });

  it('is DROPPED by a replace — the text it addressed is gone', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    await store.applyFlushPatch(write({ content: PARAGRAPH, contentAnnotations: [flagOn(PARAGRAPH)] }));

    const replaced = await store.applyFlushPatch(
      write({
        mode: 'replace',
        content: 'Reactive arthritis after a gut infection.',
        generation: 2,
        annotations: [],
        contradiction: { reason: 'revised' },
      }),
    );

    expect(replaced.applied).toBe(true);
    if (!replaced.applied) return;
    expect(duplicatesIn(replaced.patch.annotations)).toEqual([]);
    expect(duplicatesIn(rowOf(repo).annotations)).toEqual([]);
  });

  it('is DROPPED by a clinician edit — the clinician rewrote the text — and a later append does not resurrect it', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    const entity: SectionAnnotationDto = { kind: 'entity', start: 0, end: 3, type: 'CONDITION' };
    await store.applyFlushPatch(write({ content: PARAGRAPH, annotations: [entity], contentAnnotations: [flagOn(PARAGRAPH)] }));
    expect(duplicatesIn(rowOf(repo).annotations)).toHaveLength(1);

    const edited = await store.applyClinicianEdit(write({ mode: undefined, content: 'Clinician: reactive arthritis.', userId: 'doctor-7' }));

    expect(edited.applied).toBe(true);
    if (!edited.applied) return;
    expect(duplicatesIn(edited.patch.annotations)).toEqual([]);
    // Every OTHER kind is left exactly as this path always left it.
    expect(edited.patch.annotations).toEqual([entity]);

    const appended = await store.applyFlushPatch(write({ content: 'Plan to review in clinic.', generation: 2, annotations: [] }));
    expect(appended.applied).toBe(true);
    if (!appended.applied) return;
    expect(duplicatesIn(appended.patch.annotations)).toEqual([]);
  });

  it('a clinician edit on a row with no flag leaves its annotations untouched', async () => {
    const repo = repositoryDouble();
    const store = storeWith(repo);
    const entity: SectionAnnotationDto = { kind: 'entity', start: 0, end: 3, type: 'CONDITION' };
    await store.applyFlushPatch(write({ content: PARAGRAPH, annotations: [entity] }));
    const before = rowOf(repo).annotations;

    await store.applyClinicianEdit(write({ mode: undefined, content: 'Clinician: reactive arthritis.', userId: 'doctor-7' }));

    expect(rowOf(repo).annotations).toBe(before);
  });
});
