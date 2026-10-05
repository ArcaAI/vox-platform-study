import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildActivityParams,
  getConsultationActivity,
  getItemDiff,
  getItemRuns,
  getItemVersion,
  getItemVersions,
  nextActivityCursor,
  segmentRunFilters,
} from '../activity';
import { consultationKeys } from '../keys';
import { CONSULTATION_STATUSES, normalizeConsultationStatus } from '../types';
import { normalizeScribeStatus } from '../../../playground-consultation/api/types';

function installFetchMock(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({ items: [], nextCursor: null, hasMore: false });
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('activity URLs', () => {
  it('builds the activity query with csv kinds and omits unset filters', async () => {
    const urls = installFetchMock();
    await getConsultationActivity('c 1', { kinds: ['NOTE', 'FEEDBACK'], edited: true, encounterSeq: 2 }, 'cur');
    expect(urls[0]).toContain('/admin/consultations/c%201/activity?');
    const q = new URL(urls[0], 'http://x').searchParams;
    expect(q.get('kinds')).toBe('NOTE,FEEDBACK');
    expect(q.get('edited')).toBe('true');
    expect(q.get('encounterSeq')).toBe('2');
    expect(q.get('cursor')).toBe('cur');
    expect(q.has('aiRuns')).toBe(false);
  });

  it('hits the item version, diff and run routes', async () => {
    const urls = installFetchMock();
    await getItemVersions('c', 'i');
    await getItemVersion('c', 'i', 3);
    await getItemDiff('c', 'i', 3, 1);
    await getItemRuns('c', 'i', 3);
    expect(urls.map((u) => u.replace(/^.*\/admin\/consultations\//, ''))).toEqual([
      'c/items/i/versions',
      'c/items/i/versions/3',
      'c/items/i/versions/3/diff?against=1',
      'c/items/i/runs?version=3',
    ]);
  });

  it('expands a segment run with ungrouped segment filters', () => {
    const f = segmentRunFilters({ encounterSeq: 1, firstSeq: 4, lastSeq: 9 });
    expect(buildActivityParams(f)).toMatchObject({ grouping: 'none', kinds: 'TRANSCRIPT_SEGMENT', encounterSeq: 1, segmentSeqFrom: 4, segmentSeqTo: 9 });
  });
});

describe('cursor paging and keys', () => {
  it('advances on nextCursor only while hasMore', () => {
    expect(nextActivityCursor({ nextCursor: 'n', hasMore: true } as never)).toBe('n');
    expect(nextActivityCursor({ nextCursor: 'n', hasMore: false } as never)).toBeUndefined();
    expect(nextActivityCursor({ nextCursor: null, hasMore: true } as never)).toBeUndefined();
  });

  it('keys are stable regardless of kind order and distinct per filter', () => {
    const a = consultationKeys.activity('c', { kinds: ['NOTE', 'FEEDBACK'] });
    const b = consultationKeys.activity('c', { kinds: ['FEEDBACK', 'NOTE'] });
    expect(a).toEqual(b);
    expect(a).not.toEqual(consultationKeys.activity('c', { kinds: ['NOTE'] }));
    expect(consultationKeys.itemDiff('c', 'i', 2, 1)).not.toEqual(consultationKeys.itemDiff('c', 'i', 2, 0));
    expect(consultationKeys.itemVersion('c', 'i', 1)).toEqual(consultationKeys.itemVersion('c', 'i', 1));
  });
});

describe('status vocabulary', () => {
  it('lists the seven statuses', () => {
    expect(CONSULTATION_STATUSES).toEqual(['OPEN', 'RECORDING', 'PAUSED', 'STOPPED', 'APPROVED', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE']);
  });

  it('normalises legacy values for the badge and the scribe column', () => {
    expect(normalizeConsultationStatus('PENDING_REVIEW')).toEqual({ status: 'STOPPED', processing: 'AWAITING_REVIEW' });
    expect(normalizeConsultationStatus('nope')).toBeNull();
    expect(normalizeScribeStatus('signed')).toEqual({ status: 'APPROVED', processing: 'IDLE' });
    expect(normalizeScribeStatus('COMPLETED')).toBeNull();
  });
});
