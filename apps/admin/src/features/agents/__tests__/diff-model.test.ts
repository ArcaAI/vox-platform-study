import { describe, expect, it } from 'vitest';
import type { DiffResult } from '@arcaai/vox';
import { summarizeDiff, toDiffColumns } from '../diff-model';

const diff: DiffResult = {
    changes: [
        { value: '# Rules\n- Keep\n', count: 2 },
        { value: '- old line\n', removed: true, count: 1 },
        { value: '- new line\n', added: true, count: 1 },
    ],
    patch: '',
    stats: { additions: 1, deletions: 1, unchanged: 2 },
};

describe('diff-model — DiffResult → side-by-side columns', () => {
    it('places removals on the left (numbered) with an empty placeholder on the right', () => {
        const { left, right } = toDiffColumns(diff);
        expect(left[2]).toEqual({ kind: 'remove', no: 3, text: '- old line' });
        expect(right[2]).toEqual({ kind: 'empty', no: null, text: '' });
    });

    it('places additions on the right (numbered) with an empty placeholder on the left', () => {
        const { left, right } = toDiffColumns(diff);
        expect(right[3]).toEqual({ kind: 'add', no: 3, text: '- new line' });
        expect(left[3]).toEqual({ kind: 'empty', no: null, text: '' });
    });

    it('keeps unchanged lines as aligned context on both sides', () => {
        const { left, right } = toDiffColumns(diff);
        expect(left.slice(0, 2).map((c) => c.kind)).toEqual(['context', 'context']);
        expect(right.slice(0, 2)).toEqual([
            { kind: 'context', no: 1, text: '# Rules' },
            { kind: 'context', no: 2, text: '- Keep' },
        ]);
    });

    it('summarizes additions/removals from the diff stats', () => {
        expect(summarizeDiff(diff)).toEqual({ additions: 1, removals: 1 });
    });

    it('returns empty columns for an empty diff', () => {
        expect(toDiffColumns({ changes: [], patch: '', stats: { additions: 0, deletions: 0, unchanged: 0 } })).toEqual({ left: [], right: [] });
    });
});
