/**
 * TASK-1001 (wave 2, final note) — `GET consultations/:id/summary/latest` carries the
 * cross-section `duplicate` flag over the FINAL note.
 *
 * ## The gap this closes
 *
 * The live note flags a passage the model filed into two sections (owner decision 2026-09-23:
 * FLAG, never drop). The reference client (ALaaS) shows, once the consultation ends, the FINAL note:
 * `note.final` carries this route's `content` as its narrative, split at its headings, and that
 * text outranks the live section it replaces. The route carried no annotations, so a flagged
 * passage lost its flag at the moment of review.
 *
 * ## What is pinned
 *
 *  - `content` is BYTE-IDENTICAL to what is persisted — the flag never drops or alters text;
 *  - `sections[i].annotations` holds `duplicate` flags ONLY, section-local, on the later copy;
 *  - the flag names the section by the consultation's OWN document key when the title matches one;
 *  - unrelated sections carry no annotation; a note with no headings carries no `sections` at all
 *    and costs no extra read; a failed section read degrades to heading-derived keys.
 *
 * Driven through the real public method with the repositories mocked. The note is SYNTHETIC.
 */
import { describe, expect, it, vi } from 'vitest';
import { DocumentSectionRepository } from '@arcaai/domains';

import { SummaryService } from '../summary.service';
import { SummaryServiceModule } from '../summary.service.module';
import { SummaryDtoMapper } from '../summary.dto.mapper';
import { resolvableTokens } from '../../../gate-edit-mining/__tests__/module-graph.helper';

const TENANT = 'tenant-1001';
const CID = 'consultation-1001';

const P1 = 'The patient mentioned that many of the symptoms such as cough, repeated fever and fatigue are caused by bacteria in the gut.';
const P2 = 'The patient also noted that rheumatoid arthritis and psoriasis conditions are related to gut issues.';
const PARAGRAPH = `${P1} ${P2}`;

const REPEATED_NOTE = [
  '## Family History',
  'Mother has type 2 diabetes.',
  '',
  PARAGRAPH,
  '',
  '## Diagnosis',
  'Suspected inflammatory arthritis.',
  '',
  PARAGRAPH,
  '',
  '## Plan of Care',
  'Start Tab Methotrexate 7.5 mg weekly. Review in two weeks with a CBC and LFT.',
].join('\n');

const UNRELATED_NOTE = [
  '## Family History',
  'Mother has type 2 diabetes. Father had a myocardial infarction at 60.',
  '## Diagnosis',
  'Suspected inflammatory arthritis. Differential includes reactive arthritis.',
].join('\n');

interface Wiring {
  content: string;
  /** The consultation's document section rows (`sectionKey` / `title`). `null` ⇒ no repository wired. */
  rows?: Array<{ sectionKey: string; title: string }> | null;
  rowsThrow?: boolean;
}

function build(wiring: Wiring) {
  const entity = {
    id: 'summary-1',
    consultationId: CID,
    type: 'summary',
    content: wiring.content,
    dnaWritingStyleId: null,
    createdAt: new Date('2026-09-23T04:02:16.000Z'),
    updatedAt: new Date('2026-09-23T04:02:16.000Z'),
    version: 3,
  };
  const findByConsultation = vi.fn(async () => {
    if (wiring.rowsThrow) throw new Error('database unavailable');
    return wiring.rows ?? [];
  });

  // Positional, BY INDEX (the convention of the neighbouring suites), so a constructor change fails
  // here rather than sliding a mock into the wrong slot. 38 = `documentSectionRepository`.
  const args: unknown[] = new Array(39).fill(undefined);
  args[0] = {
    findLatestModifiedSummary: vi.fn().mockResolvedValue(null),
    findLatestRawSummary: vi.fn().mockResolvedValue(entity),
  };
  args[5] = { get: vi.fn(() => undefined) };
  args[6] = { emit: vi.fn() };
  args[7] = {
    get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : null)),
    set: vi.fn(),
    run: vi.fn((callback: () => unknown) => callback()),
  };
  args[38] = wiring.rows === null ? undefined : { findByConsultation };

  const service = new (SummaryService as unknown as new (...a: unknown[]) => SummaryService)(...args);
  return { service, entity, findByConsultation };
}

const bodyOf = (content: string, section: { start: number; end: number }) => content.slice(section.start, section.end);

describe('GET summary/latest — the FINAL note carries the cross-section duplicate flag', () => {
  it('flags the later copy of a two-section repeated paragraph, section-locally, naming the earlier section by its document key', async () => {
    const { service, findByConsultation } = build({
      content: REPEATED_NOTE,
      rows: [
        { sectionKey: 'family_history', title: 'Family History' },
        { sectionKey: 'diagnosis', title: 'Diagnosis' },
      ],
    });

    const response = (await service.getLatestSummary(CID))!;

    expect(findByConsultation).toHaveBeenCalledWith(TENANT, CID);
    expect(response.sections!.map((section) => section.title)).toEqual(['Family History', 'Diagnosis', 'Plan of Care']);
    expect(response.sections![0]).not.toHaveProperty('annotations');
    expect(response.sections![2]).not.toHaveProperty('annotations');

    const diagnosis = response.sections![1]!;
    const body = bodyOf(response.content, diagnosis);
    expect(diagnosis.annotations).toEqual([
      {
        kind: 'duplicate',
        start: body.indexOf(P1),
        end: body.indexOf(P1) + PARAGRAPH.length,
        duplicateOf: 'family_history',
        duplicateOfTitle: 'Family History',
      },
    ]);
    const [flag] = diagnosis.annotations!;
    expect(body.slice(flag!.start, flag!.end)).toBe(PARAGRAPH);
  });

  it('content is BYTE-IDENTICAL to what is persisted, and every other field is what the mapper always returned', async () => {
    const { service, entity } = build({ content: REPEATED_NOTE, rows: [] });

    const response = (await service.getLatestSummary(CID))!;

    expect(response.content).toBe(REPEATED_NOTE);
    // Both copies of the paragraph are still there — flagged, never dropped.
    expect(response.content.split(PARAGRAPH)).toHaveLength(3);
    const { sections, ...rest } = response;
    expect(sections).toBeDefined();
    expect(rest).toEqual(SummaryDtoMapper.toResponse(entity as never));
  });

  it('names a section by the consultation`s OWN key when the title matches, not by a derived one', async () => {
    const { service } = build({ content: REPEATED_NOTE, rows: [{ sectionKey: 'fam_hx', title: 'FAMILY HISTORY' }] });

    const response = (await service.getLatestSummary(CID))!;

    expect(response.sections!.map((section) => section.sectionKey)).toEqual(['fam_hx', 'diagnosis', 'plan_of_care']);
    expect(response.sections![1]!.annotations![0]!.duplicateOf).toBe('fam_hx');
  });

  it('carries no flag when the sections are unrelated', async () => {
    const { service } = build({ content: UNRELATED_NOTE, rows: [] });

    const response = (await service.getLatestSummary(CID))!;

    expect(response.sections).toHaveLength(2);
    expect(response.sections!.some((section) => 'annotations' in section)).toBe(false);
  });

  it('a note with no headings carries no `sections`, and the document rows are never read', async () => {
    const { service, findByConsultation } = build({ content: PARAGRAPH, rows: [] });

    const response = (await service.getLatestSummary(CID))!;

    expect(response).not.toHaveProperty('sections');
    expect(response.content).toBe(PARAGRAPH);
    expect(findByConsultation).not.toHaveBeenCalled();
  });

  it('a failed section read still answers — keys derived from the headings, the flag intact', async () => {
    const { service } = build({ content: REPEATED_NOTE, rowsThrow: true });

    const response = (await service.getLatestSummary(CID))!;

    expect(response.content).toBe(REPEATED_NOTE);
    expect(response.sections![1]!.annotations!.map((flag) => flag.duplicateOf)).toEqual(['family_history']);
  });

  it('an unwired section repository derives the keys from the headings', async () => {
    const { service } = build({ content: REPEATED_NOTE, rows: null });

    const response = (await service.getLatestSummary(CID))!;

    expect(response.sections!.map((section) => section.sectionKey)).toEqual(['family_history', 'diagnosis', 'plan_of_care']);
  });
});

describe('SummaryServiceModule — the section keys are actually reachable', () => {
  it('resolves DocumentSectionRepository, so a final flag names the consultation`s own section key', () => {
    // `@Optional()` makes a missing provider SILENT: every key would quietly fall back to one
    // derived from the heading.
    expect(resolvableTokens(SummaryServiceModule).has(DocumentSectionRepository)).toBe(true);
  });
});
