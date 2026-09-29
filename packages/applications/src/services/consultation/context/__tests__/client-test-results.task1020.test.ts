/**
 * TASK-1020 — `formatted_test_results` finally has a source: the client's `investigations` kind.
 *
 * Until now every prompt surface rendered `formatted_test_results` as `''` because no context kind
 * carried lab results (`pre-summary-variables.ts`). At a same-day return visit the afternoon is
 * exactly where the morning's labs are read, so the kind (`{ results: [{ name, value, unit?,
 * refRange?, collectedAt?, flag? }] }`) is rendered one line per result.
 *
 * The read is a SEPARATE reader method, not a third kind inside `read()`: `read()` is memoised and
 * pinned at two round trips per consultation by its own contract tests, and a surface that has no
 * use for lab results must not start paying for them.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CLIENT_INVESTIGATIONS_KIND_KEY,
  ClientClinicalContextReader,
  formatTestResultsForPrompt,
  latestContextItemOfKind,
} from '../client-clinical-context';

const CID = 'consultation-1020';

const item = (kindKey: string, payload: unknown, createdAt = new Date('2026-09-29T08:00:00.000Z')) => ({
  id: `ci-${kindKey}-${createdAt.getTime()}`,
  kindKey,
  content: payload === null ? null : JSON.stringify(payload),
  createdAt,
});

const plainDecrypt = async (entity: { content?: string | null }) => entity.content ?? null;

describe('TASK-1020 — formatTestResultsForPrompt', () => {
  it('renders one line per result with every optional part in its declared order', () => {
    expect(
      formatTestResultsForPrompt({
        results: [
          { name: 'Haemoglobin', value: '10.2', unit: 'g/dL', refRange: '13-17', flag: 'L', collectedAt: '2026-09-29T09:10:00Z' },
          { name: 'Serum creatinine', value: 1.1, unit: 'mg/dL' },
          { name: 'Urine culture', value: 'No growth' },
        ],
      }),
    ).toBe(
      ['- Haemoglobin: 10.2 g/dL (ref 13-17) [L] — 2026-09-29T09:10:00Z', '- Serum creatinine: 1.1 mg/dL', '- Urine culture: No growth'].join('\n'),
    );
  });

  it('is empty for an absent payload, an empty list, or a payload that is not the declared shape', () => {
    expect(formatTestResultsForPrompt(undefined)).toBe('');
    expect(formatTestResultsForPrompt({ results: [] })).toBe('');
    expect(formatTestResultsForPrompt({ results: 'CBC normal' } as never)).toBe('');
    expect(formatTestResultsForPrompt({} as never)).toBe('');
  });

  it('drops an entry with no name or no value rather than rendering half a result', () => {
    expect(
      formatTestResultsForPrompt({
        results: [{ name: 'CRP' } as never, { value: '5' } as never, null as never, { name: 'ESR', value: '22', unit: 'mm/h' }],
      }),
    ).toBe('- ESR: 22 mm/h');
  });

  it('keeps a numeric zero — absence is not falsiness', () => {
    expect(formatTestResultsForPrompt({ results: [{ name: 'Troponin I', value: 0, unit: 'ng/mL' }] })).toBe('- Troponin I: 0 ng/mL');
  });
});

describe('TASK-1020 — ClientClinicalContextReader.readTestResults', () => {
  it('reads the NEWEST `investigations` item and renders it', async () => {
    const items = [
      item(CLIENT_INVESTIGATIONS_KIND_KEY, { results: [{ name: 'CBC', value: 'old' }] }, new Date('2026-09-29T08:00:00Z')),
      item(CLIENT_INVESTIGATIONS_KIND_KEY, { results: [{ name: 'CBC', value: 'new' }] }, new Date('2026-09-29T10:00:00Z')),
    ];
    const repo = { findLatestByKindKey: vi.fn(async (_cid: string, kindKey: string) => latestContextItemOfKind(items as never, kindKey)) };
    const reader = new ClientClinicalContextReader(repo as never, plainDecrypt as never);

    await expect(reader.readTestResults(CID)).resolves.toBe('- CBC: new');
    expect(CLIENT_INVESTIGATIONS_KIND_KEY).toBe('investigations');
    expect(repo.findLatestByKindKey).toHaveBeenCalledWith(CID, 'investigations');
  });

  it('memoises per consultation and does NOT touch the two-kind `read()` contract', async () => {
    const repo = { findLatestByKindKey: vi.fn(async () => null) };
    const reader = new ClientClinicalContextReader(repo as never, plainDecrypt as never);

    await Promise.all([reader.readTestResults(CID), reader.readTestResults(CID)]);
    expect(repo.findLatestByKindKey).toHaveBeenCalledTimes(1);

    await reader.read(CID);
    // `read()` still asks for exactly its two kinds.
    expect(repo.findLatestByKindKey.mock.calls.map(([, kind]) => kind).sort()).toEqual(['investigations', 'previous_case_notes', 'vitals']);
  });

  it('answers `` — never throws — for no repository, a throwing read, an undecryptable or malformed body', async () => {
    await expect(new ClientClinicalContextReader(undefined, plainDecrypt as never).readTestResults(CID)).resolves.toBe('');

    const throwing = { findLatestByKindKey: vi.fn(async () => Promise.reject(new Error('down'))) };
    await expect(new ClientClinicalContextReader(throwing as never, plainDecrypt as never).readTestResults(CID)).resolves.toBe('');

    const garbage = { findLatestByKindKey: vi.fn(async () => ({ ...item('investigations', null), content: 'not json' })) };
    await expect(new ClientClinicalContextReader(garbage as never, plainDecrypt as never).readTestResults(CID)).resolves.toBe('');

    const badDecrypt = async () => {
      throw new Error('vault sealed');
    };
    const ok = { findLatestByKindKey: vi.fn(async () => item('investigations', { results: [{ name: 'CBC', value: 'x' }] })) };
    await expect(new ClientClinicalContextReader(ok as never, badDecrypt as never).readTestResults(CID)).resolves.toBe('');
  });
});
