/**
 * TASK-1020 — the `same_day_prequel_summary` PRODUCER.
 *
 * A same-day return visit (morning consultation → labs → afternoon return) is a NEW consultation
 * chained to the morning one by `parentConsultationId`. The afternoon prompt must carry the
 * morning's note — and only notes from earlier visits of the SAME patient on the SAME day. This
 * suite pins the walk (depth cap, cycle safety, stop conditions), the per-ancestor note choice
 * (the SAME authority order the prior-visit carry-forward uses), and the rendered block.
 */
import { describe, expect, it, vi } from 'vitest';
import { ContextItemType } from '@arcaai/domains';

import {
  SAME_DAY_PREQUEL_BLOCK_MAX_CHARS,
  SAME_DAY_PREQUEL_MAX_DEPTH,
  SAME_DAY_PREQUEL_TRUNCATION_MARKER,
  hasSameDayPrequel,
  resolveSameDayPrequel,
  resolveSameDayPrequelTimeZone,
} from '../same-day-prequel';
import { selectAuthoritativeNoteText } from '../prior-visit-summary';

const TENANT = 'tenant-1020';
const PATIENT = 'patient-1020';
const DAY = new Date('2026-09-29T00:00:00.000Z');

interface Row {
  id: string;
  tenantId?: string;
  patientId?: string;
  appointmentDate?: Date | string;
  parentConsultationId?: string | null;
  status?: string;
  createdAt?: Date;
}

const row = (over: Partial<Row> & { id: string }): Row => ({
  tenantId: TENANT,
  patientId: PATIENT,
  appointmentDate: DAY,
  parentConsultationId: null,
  status: 'SIGNED',
  createdAt: new Date('2026-09-29T04:15:00.000Z'),
  ...over,
});

const note = (content: string, createdAt = new Date('2026-09-29T05:00:00.000Z')) => ({ content, createdAt });

function readers(rows: Row[], notes: Record<string, Partial<Record<ContextItemType, Array<{ content: string; createdAt: Date }>>>>) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const consultationRepository = {
    // The real repository THROWS for an absent row (DataNotFoundException); mirror that.
    findById: vi.fn(async (id: string) => {
      const found = byId.get(id);
      if (!found) throw new Error('DataNotFound');
      return found;
    }),
  };
  const contextItemRepository = {
    findByType: vi.fn(async (consultationId: string, type: ContextItemType) => notes[consultationId]?.[type] ?? []),
  };
  return { consultationRepository, contextItemRepository };
}

describe('TASK-1020 — resolveSameDayPrequel', () => {
  it('renders the same-day parent note as one dated, attributed block', async () => {
    const morning = row({ id: 'morning', createdAt: new Date('2026-09-29T04:15:00.000Z'), status: 'SIGNED' });
    const afternoon = row({ id: 'afternoon', parentConsultationId: 'morning', status: 'RECORDING' });
    const deps = readers([morning], { morning: { [ContextItemType.SIGNED_NOTE]: [note('MORNING-SIGNED-NOTE plan: CBC, LFT')] } });

    const prequel = await resolveSameDayPrequel(deps, afternoon);

    expect(prequel.summary).toBe('### Earlier visit today (04:15 UTC, status SIGNED)\nMORNING-SIGNED-NOTE plan: CBC, LFT');
    expect(prequel.hasSameDayPrequel).toBe(true);
    expect(hasSameDayPrequel(prequel.summary)).toBe(true);
  });

  /**
   * Live-replay defect D3 — an IST clinic read "Earlier visit today (16:26 UTC, …)" for a visit its
   * clinician saw at 21:56. The block's time is read in the tenant's
   * `consultation.appointmentDay.timeZone`, the same zone that decides which day the visit is on.
   */
  it('states each block`s time in the tenant time zone the caller passes', async () => {
    const morning = row({ id: 'morning', createdAt: new Date('2026-09-29T16:26:00.000Z'), status: 'CLOSED_COMPLETE' });
    const deps = readers([morning], { morning: { [ContextItemType.SIGNED_NOTE]: [note('MORNING')] } });

    const prequel = await resolveSameDayPrequel(deps, row({ id: 'pm', parentConsultationId: 'morning' }), { timeZone: 'Asia/Kolkata' });

    expect(prequel.summary).toBe('### Earlier visit today (21:56 IST, status CLOSED_COMPLETE)\nMORNING');
  });

  it('keeps a zone with a well-known abbreviation, and an offset where the zone has none', async () => {
    const morning = row({ id: 'morning', createdAt: new Date('2026-09-29T16:26:00.000Z') });
    const deps = readers([morning], { morning: { [ContextItemType.SIGNED_NOTE]: [note('M')] } });
    const at = async (timeZone: string) =>
      (await resolveSameDayPrequel(deps, row({ id: 'pm', parentConsultationId: 'morning' }), { timeZone })).summary.split('\n')[0];

    expect(await at('America/New_York')).toBe('### Earlier visit today (12:26 EDT, status SIGNED)');
    expect(await at('UTC')).toBe('### Earlier visit today (16:26 UTC, status SIGNED)');
    expect(await at('Asia/Kathmandu')).toMatch(/^### Earlier visit today \(22:11 GMT\+5:45, status SIGNED\)$/);
  });

  it('falls back to UTC for a zone this runtime cannot resolve, and when none is passed', async () => {
    const morning = row({ id: 'morning', createdAt: new Date('2026-09-29T16:26:00.000Z') });
    const deps = readers([morning], { morning: { [ContextItemType.SIGNED_NOTE]: [note('M')] } });
    const subject = row({ id: 'pm', parentConsultationId: 'morning' });

    expect((await resolveSameDayPrequel(deps, subject, { timeZone: 'Mars/Olympus' })).summary).toContain('(16:26 UTC,');
    expect((await resolveSameDayPrequel(deps, subject, { timeZone: null })).summary).toContain('(16:26 UTC,');
    expect((await resolveSameDayPrequel(deps, subject)).summary).toContain('(16:26 UTC,');
  });

  it('is empty (and false) for a first visit — no parent, no read at all', async () => {
    const deps = readers([], {});

    const prequel = await resolveSameDayPrequel(deps, row({ id: 'first' }));

    expect(prequel).toEqual({ summary: '', hasSameDayPrequel: false });
    expect(hasSameDayPrequel('')).toBe(false);
    expect(deps.consultationRepository.findById).not.toHaveBeenCalled();
    expect(deps.contextItemRepository.findByType).not.toHaveBeenCalled();
  });

  it('ignores a parent from ANOTHER DAY (a weeks-old prior visit is not a prequel)', async () => {
    const lastMonth = row({ id: 'last-month', appointmentDate: new Date('2026-08-29T00:00:00.000Z') });
    const deps = readers([lastMonth], { 'last-month': { [ContextItemType.SIGNED_NOTE]: [note('OLD-NOTE')] } });

    const prequel = await resolveSameDayPrequel(deps, row({ id: 'today', parentConsultationId: 'last-month' }));

    expect(prequel.summary).toBe('');
    expect(prequel.hasSameDayPrequel).toBe(false);
    expect(deps.contextItemRepository.findByType).not.toHaveBeenCalled();
  });

  it('treats the day as DATE-ONLY: a string date and a Date on the same day match', async () => {
    const morning = row({ id: 'morning', appointmentDate: '2026-09-29' });
    const deps = readers([morning], { morning: { [ContextItemType.RAW_SUMMARY]: [note('RAW-MORNING')] } });

    const prequel = await resolveSameDayPrequel(
      deps,
      row({ id: 'pm', parentConsultationId: 'morning', appointmentDate: new Date('2026-09-29T00:00:00Z') }),
    );

    expect(prequel.summary).toContain('RAW-MORNING');
  });

  it('ignores a parent belonging to ANOTHER PATIENT — a wrong link must not contaminate the note', async () => {
    const stranger = row({ id: 'stranger', patientId: 'someone-else' });
    const deps = readers([stranger], { stranger: { [ContextItemType.SIGNED_NOTE]: [note('STRANGER-NOTE')] } });

    const prequel = await resolveSameDayPrequel(deps, row({ id: 'pm', parentConsultationId: 'stranger' }));

    expect(prequel.summary).toBe('');
    expect(deps.contextItemRepository.findByType).not.toHaveBeenCalled();
  });

  it('ignores a parent in ANOTHER TENANT, and never throws over it', async () => {
    const foreign = row({ id: 'foreign', tenantId: 'tenant-OTHER' });
    const deps = readers([foreign], { foreign: { [ContextItemType.SIGNED_NOTE]: [note('FOREIGN-NOTE')] } });

    await expect(resolveSameDayPrequel(deps, row({ id: 'pm', parentConsultationId: 'foreign' }))).resolves.toEqual({
      summary: '',
      hasSameDayPrequel: false,
    });
  });

  it('does not match when either side lacks a patient or a date — absence is never equality', async () => {
    const bare = { id: 'bare', tenantId: TENANT } as Row;
    const deps = readers([bare], { bare: { [ContextItemType.SIGNED_NOTE]: [note('BARE-NOTE')] } });

    const prequel = await resolveSameDayPrequel(deps, { id: 'child', tenantId: TENANT, parentConsultationId: 'bare' });

    expect(prequel.summary).toBe('');
    expect(deps.contextItemRepository.findByType).not.toHaveBeenCalled();
  });

  it('walks the whole same-day chain and renders it OLDEST FIRST', async () => {
    const early = row({ id: 'early', createdAt: new Date('2026-09-29T03:00:00Z'), status: 'CLOSED_COMPLETE' });
    const noon = row({ id: 'noon', parentConsultationId: 'early', createdAt: new Date('2026-09-29T07:30:00Z'), status: 'CLOSED_INCOMPLETE' });
    const deps = readers([early, noon], {
      early: { [ContextItemType.SIGNED_NOTE]: [note('EARLY-NOTE')] },
      noon: { [ContextItemType.RAW_SUMMARY]: [note('NOON-NOTE')] },
    });

    const prequel = await resolveSameDayPrequel(deps, row({ id: 'evening', parentConsultationId: 'noon' }));

    expect(prequel.summary).toBe(
      '### Earlier visit today (03:00 UTC, status CLOSED_COMPLETE)\nEARLY-NOTE\n\n' +
        '### Earlier visit today (07:30 UTC, status CLOSED_INCOMPLETE)\nNOON-NOTE',
    );
  });

  it('stops the walk at the first ancestor from another day — earlier days are not scanned', async () => {
    const yesterday = row({ id: 'yesterday', appointmentDate: new Date('2026-09-28T00:00:00Z') });
    const morning = row({ id: 'morning', parentConsultationId: 'yesterday' });
    const deps = readers([yesterday, morning], { morning: { [ContextItemType.SIGNED_NOTE]: [note('MORNING')] } });

    const prequel = await resolveSameDayPrequel(deps, row({ id: 'pm', parentConsultationId: 'morning' }));

    expect(prequel.summary).toContain('MORNING');
    expect(deps.contextItemRepository.findByType.mock.calls.map(([cid]) => cid)).not.toContain('yesterday');
  });

  it(`caps the walk at ${SAME_DAY_PREQUEL_MAX_DEPTH} ancestors (the NEAREST ones)`, async () => {
    const chain: Row[] = [];
    for (let i = 0; i < SAME_DAY_PREQUEL_MAX_DEPTH + 3; i += 1) {
      chain.push(row({ id: `a${i}`, parentConsultationId: i === 0 ? null : `a${i - 1}`, createdAt: new Date(Date.UTC(2026, 8, 29, 1, i)) }));
    }
    const notes = Object.fromEntries(chain.map((r) => [r.id, { [ContextItemType.RAW_SUMMARY]: [note(`NOTE-${r.id}`)] }]));
    const deps = readers(chain, notes);
    const last = chain[chain.length - 1]!;

    const prequel = await resolveSameDayPrequel(deps, row({ id: 'leaf', parentConsultationId: last.id }));

    expect(deps.consultationRepository.findById).toHaveBeenCalledTimes(SAME_DAY_PREQUEL_MAX_DEPTH);
    expect(prequel.summary.match(/### Earlier visit today/g)).toHaveLength(SAME_DAY_PREQUEL_MAX_DEPTH);
    expect(prequel.summary).toContain(`NOTE-${last.id}`);
    expect(prequel.summary).not.toContain('NOTE-a0');
  });

  it('is CYCLE-SAFE: a parent link that loops back terminates, each visit rendered once', async () => {
    const a = row({ id: 'a', parentConsultationId: 'b', createdAt: new Date('2026-09-29T02:00:00Z') });
    const b = row({ id: 'b', parentConsultationId: 'a', createdAt: new Date('2026-09-29T01:00:00Z') });
    const deps = readers([a, b], {
      a: { [ContextItemType.RAW_SUMMARY]: [note('NOTE-A')] },
      b: { [ContextItemType.RAW_SUMMARY]: [note('NOTE-B')] },
    });

    const prequel = await resolveSameDayPrequel(deps, row({ id: 'c', parentConsultationId: 'a' }));

    expect(prequel.summary.match(/NOTE-A/g)).toHaveLength(1);
    expect(prequel.summary.match(/NOTE-B/g)).toHaveLength(1);
    expect(deps.consultationRepository.findById).toHaveBeenCalledTimes(2);
  });

  it('never includes the subject itself, even when its own parent link points at itself', async () => {
    const self = row({ id: 'self', parentConsultationId: 'self' });
    const deps = readers([self], { self: { [ContextItemType.RAW_SUMMARY]: [note('SELF-NOTE')] } });

    const prequel = await resolveSameDayPrequel(deps, self);

    expect(prequel.summary).toBe('');
  });

  it('truncates a long note per block with a trailing marker', async () => {
    const morning = row({ id: 'morning' });
    const long = 'z'.repeat(SAME_DAY_PREQUEL_BLOCK_MAX_CHARS + 500);
    const deps = readers([morning], { morning: { [ContextItemType.SIGNED_NOTE]: [note(long)] } });

    const prequel = await resolveSameDayPrequel(deps, row({ id: 'pm', parentConsultationId: 'morning' }));

    const body = prequel.summary.split('\n').slice(1).join('\n');
    expect(body.endsWith(SAME_DAY_PREQUEL_TRUNCATION_MARKER)).toBe(true);
    expect(body).toContain('z'.repeat(SAME_DAY_PREQUEL_BLOCK_MAX_CHARS));
    expect(body).not.toContain('z'.repeat(SAME_DAY_PREQUEL_BLOCK_MAX_CHARS + 1));
    expect(SAME_DAY_PREQUEL_TRUNCATION_MARKER).toBe('[truncated]');
  });

  it('picks each ancestor note by AUTHORITY: signed > clinician-modified > raw, newest within a tier', async () => {
    const signed = row({ id: 'signed' });
    const modified = row({ id: 'modified', parentConsultationId: 'signed' });
    const raw = row({ id: 'raw', parentConsultationId: 'modified' });
    const deps = readers([signed, modified, raw], {
      signed: {
        [ContextItemType.SIGNED_NOTE]: [note('SIGNED-WINS')],
        [ContextItemType.MODIFIED_SUMMARY]: [note('SIGNED-LOSES-MOD')],
        [ContextItemType.RAW_SUMMARY]: [note('SIGNED-LOSES-RAW')],
      },
      modified: {
        [ContextItemType.MODIFIED_SUMMARY]: [note('MOD-OLD', new Date('2026-09-29T05:00:00Z')), note('MOD-NEW', new Date('2026-09-29T06:00:00Z'))],
        [ContextItemType.RAW_SUMMARY]: [note('MOD-LOSES-RAW')],
      },
      raw: { [ContextItemType.RAW_SUMMARY]: [note('   '), note('RAW-ONLY')] },
    });

    const prequel = await resolveSameDayPrequel(deps, row({ id: 'leaf', parentConsultationId: 'raw' }));

    expect(prequel.summary).toContain('SIGNED-WINS');
    expect(prequel.summary).toContain('MOD-NEW');
    expect(prequel.summary).toContain('RAW-ONLY');
    for (const loser of ['SIGNED-LOSES-MOD', 'SIGNED-LOSES-RAW', 'MOD-OLD', 'MOD-LOSES-RAW']) expect(prequel.summary).not.toContain(loser);
  });

  it('skips an ancestor that has no note yet, without dropping the others', async () => {
    const empty = row({ id: 'empty' });
    const morning = row({ id: 'morning', parentConsultationId: 'empty' });
    const deps = readers([empty, morning], { morning: { [ContextItemType.RAW_SUMMARY]: [note('MORNING-RAW')] } });

    const prequel = await resolveSameDayPrequel(deps, row({ id: 'pm', parentConsultationId: 'morning' }));

    expect(prequel.summary).toBe('### Earlier visit today (04:15 UTC, status SIGNED)\nMORNING-RAW');
  });

  it('degrades to empty — never throws — when a store read fails', async () => {
    const morning = row({ id: 'morning' });
    const deps = readers([morning], {});
    deps.contextItemRepository.findByType.mockRejectedValue(new Error('store down'));

    await expect(resolveSameDayPrequel(deps, row({ id: 'pm', parentConsultationId: 'morning' }))).resolves.toEqual({
      summary: '',
      hasSameDayPrequel: false,
    });
  });

  it('degrades to empty when the readers are not wired at all', async () => {
    await expect(resolveSameDayPrequel({}, row({ id: 'pm', parentConsultationId: 'morning' }))).resolves.toEqual({
      summary: '',
      hasSameDayPrequel: false,
    });
  });
});

describe('TASK-1020 — the ONE authority-order selection, shared with the prior-visit carry-forward', () => {
  it('selectAuthoritativeNoteText returns the first tier that yields anything, newest in the tier', async () => {
    const findByType = vi.fn(async (_cid: string, type: ContextItemType) =>
      type === ContextItemType.MODIFIED_SUMMARY ? [note('  MOD-A  ', new Date('2026-01-01')), note('MOD-B', new Date('2026-02-01'))] : [],
    );

    await expect(selectAuthoritativeNoteText({ findByType }, 'c-1')).resolves.toBe('MOD-B');
    expect(findByType.mock.calls.map(([, type]) => type)).toEqual([ContextItemType.SIGNED_NOTE, ContextItemType.MODIFIED_SUMMARY]);
  });

  it('returns null when no tier has a usable note', async () => {
    await expect(selectAuthoritativeNoteText({ findByType: vi.fn(async () => [note('  ')]) }, 'c-1')).resolves.toBeNull();
  });
});

describe('TASK-1020 — resolveSameDayPrequelTimeZone (the zone a caller passes)', () => {
  const settings = (value: unknown) => ({ resolveEffective: vi.fn(async () => ({ value })) });

  it('reads consultation.appointmentDay.timeZone for the tenant', async () => {
    const effective = settings('Asia/Kolkata');

    await expect(resolveSameDayPrequelTimeZone(effective, TENANT)).resolves.toBe('Asia/Kolkata');
    expect(effective.resolveEffective).toHaveBeenCalledWith('consultation.appointmentDay.timeZone', { tenantId: TENANT });
  });

  it('answers UTC — never throws — when unwired, tenant-less, invalid, or the settings read fails', async () => {
    await expect(resolveSameDayPrequelTimeZone(undefined, TENANT)).resolves.toBe('UTC');
    await expect(resolveSameDayPrequelTimeZone(settings('Asia/Kolkata'), null)).resolves.toBe('UTC');
    await expect(resolveSameDayPrequelTimeZone(settings('Mars/Olympus'), TENANT)).resolves.toBe('UTC');
    await expect(resolveSameDayPrequelTimeZone({ resolveEffective: vi.fn(async () => Promise.reject(new Error('down'))) }, TENANT)).resolves.toBe(
      'UTC',
    );
  });
});
