/**
 * Generic cursor (keyset) pagination engine.
 *
 * Behaviour-focused unit tests for the transport-agnostic primitives that the
 * cursor contract is built on: opaque cursor encode/decode, limit clamping,
 * the keyset `IFindAllProps` builder, and the page envelope assembler.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeCursor,
  decodeCursor,
  clampCursorLimit,
  buildCursorFindAllProps,
  toCursorPage,
  DEFAULT_CURSOR_LIMIT,
  MAX_CURSOR_LIMIT,
} from '../cursorPagination';

describe('TASK-373 — cursorPagination engine', () => {
  describe('encodeCursor / decodeCursor', () => {
    it('round-trips a { k, id } payload', () => {
      const token = encodeCursor({ k: '2026-06-27T10:00:00.000Z', id: 'uuid-1' });
      expect(typeof token).toBe('string');
      expect(decodeCursor(token)).toEqual({ k: '2026-06-27T10:00:00.000Z', id: 'uuid-1' });
    });

    it('is opaque — does not leak the raw key/id in the token text', () => {
      const token = encodeCursor({ k: '2026-06-27T10:00:00.000Z', id: 'uuid-1' });
      expect(token).not.toContain('uuid-1');
      expect(token).not.toContain('2026-06-27');
    });

    it('returns null for a tampered / malformed / wrong-shape token', () => {
      expect(decodeCursor('not base64 $$$')).toBeNull();
      expect(decodeCursor(Buffer.from('garbage', 'utf8').toString('base64url'))).toBeNull();
      // Valid base64url + valid JSON but wrong shape (k not a string).
      expect(decodeCursor(Buffer.from(JSON.stringify({ k: 1, id: 'x' }), 'utf8').toString('base64url'))).toBeNull();
      expect(decodeCursor(Buffer.from(JSON.stringify({ id: 'x' }), 'utf8').toString('base64url'))).toBeNull();
    });
  });

  describe('clampCursorLimit', () => {
    it('falls back to the default when missing or non-positive', () => {
      expect(clampCursorLimit(undefined)).toBe(DEFAULT_CURSOR_LIMIT);
      expect(clampCursorLimit(0)).toBe(DEFAULT_CURSOR_LIMIT);
      expect(clampCursorLimit(-5)).toBe(DEFAULT_CURSOR_LIMIT);
    });

    it('passes valid values through and clamps to the max', () => {
      expect(clampCursorLimit(25)).toBe(25);
      expect(clampCursorLimit(9999)).toBe(MAX_CURSOR_LIMIT);
    });
  });

  describe('buildCursorFindAllProps', () => {
    it('first page (no cursor): take = limit+1, (createdAt,id) DESC sort, base where only', () => {
      const props = buildCursorFindAllProps(null, 20, { where: { tenantId: 't-1' } });
      expect(props.page).toBe(1);
      expect(props.limit).toBe(21);
      expect(props.sort).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(props.where).toEqual({ tenantId: 't-1' });
    });

    it('with cursor: composes the keyset OR with the base where via AND (DESC → lt)', () => {
      const d = new Date('2026-06-27T10:00:00.000Z');
      const props = buildCursorFindAllProps({ k: d.toISOString(), id: 'uuid-9' }, 10, { where: { tenantId: 't-1' } });
      expect(props.limit).toBe(11);
      expect(props.where).toEqual({
        AND: [
          { tenantId: 't-1' },
          {
            OR: [{ createdAt: { lt: d } }, { AND: [{ createdAt: d }, { id: { lt: 'uuid-9' } }] }],
          },
        ],
      });
    });

    it('with cursor and no base where: keyset OR is the whole where', () => {
      const d = new Date('2026-06-27T10:00:00.000Z');
      const props = buildCursorFindAllProps({ k: d.toISOString(), id: 'uuid-9' }, 5, { direction: 'asc' });
      expect(props.sort).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
      expect(props.where).toEqual({
        OR: [{ createdAt: { gt: d } }, { AND: [{ createdAt: d }, { id: { gt: 'uuid-9' } }] }],
      });
    });
  });

  describe('toCursorPage', () => {
    const makeRows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, createdAt: new Date(2026, 0, 1, 0, 0, i) }));
    const getKey = (r: { createdAt: Date }) => r.createdAt.toISOString();

    it('over-fetched (limit+1 rows) → hasMore, slices to limit, nextCursor = last returned row', () => {
      const page = toCursorPage(makeRows(6), 5, getKey);
      expect(page.hasMore).toBe(true);
      expect(page.data).toHaveLength(5);
      expect(page.limit).toBe(5);
      const last = page.data[page.data.length - 1];
      expect(page.nextCursor).toBe(encodeCursor({ k: getKey(last), id: last.id }));
    });

    it('exact or under page → no more pages, null cursor', () => {
      const page = toCursorPage(makeRows(3), 5, getKey);
      expect(page.hasMore).toBe(false);
      expect(page.data).toHaveLength(3);
      expect(page.nextCursor).toBeNull();
    });

    it('empty result → no more pages, null cursor', () => {
      const page = toCursorPage([], 5, getKey);
      expect(page.hasMore).toBe(false);
      expect(page.data).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });
  });
});
