import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '@/store/audio-store';
import { upsertTranscriptEntry } from '../transcript-state';

function entry(id: string, text: string, isFinal = true): TranscriptEntry {
    return {
        id,
        segment: 1,
        text,
        timestamp: Date.now(),
        isFinal,
        start: 0,
        end: 0,
        duration: 0,
        inference: 0,
    };
}

describe('upsertTranscriptEntry', () => {
    it('keeps final entries and appends a new final entry', () => {
        const previous = [entry('1', 'hello'), entry('2', 'world')];

        const next = upsertTranscriptEntry(previous, entry('3', 'done'));

        expect(next).toHaveLength(3);
        expect(next[2]?.id).toBe('3');
    });

    it('replaces only the trailing partial entry', () => {
        const previous = [entry('1', 'final-a'), entry('2', 'partial-a', false)];

        const next = upsertTranscriptEntry(previous, entry('3', 'partial-b', false));

        expect(next).toHaveLength(2);
        expect(next[0]?.id).toBe('1');
        expect(next[1]?.id).toBe('3');
        expect(next[1]?.isFinal).toBe(false);
    });

    it('drops oldest entries when max length is reached', () => {
        const previous = [entry('1', 'a'), entry('2', 'b'), entry('3', 'c')];

        const next = upsertTranscriptEntry(previous, entry('4', 'd'), 3);

        expect(next.map((item) => item.id)).toEqual(['2', '3', '4']);
    });

    // -----------------------------------------------------------------------
    // TASK-351 P0-6 (H7) — identity stability: untouched rows must keep their
    // references so memoized list rows skip re-rendering on every upsert.
    // -----------------------------------------------------------------------

    it('preserves entry identity for untouched rows when appending a final', () => {
        const previous = [entry('1', 'a'), entry('2', 'b'), entry('3', 'c')];

        const next = upsertTranscriptEntry(previous, entry('4', 'd'));

        expect(next).toHaveLength(4);
        for (let i = 0; i < previous.length; i++) {
            expect(next[i]).toBe(previous[i]);
        }
    });

    it('preserves entry identity for retained rows when replacing a trailing partial', () => {
        const previous = [entry('1', 'a'), entry('2', 'b'), entry('3', 'partial', false)];

        const next = upsertTranscriptEntry(previous, entry('4', 'partial-2', false));

        expect(next).toHaveLength(3);
        expect(next[0]).toBe(previous[0]);
        expect(next[1]).toBe(previous[1]);
        expect(next[2]?.id).toBe('4');
    });

    it('preserves entry identity for surviving rows when trimming to max length', () => {
        const previous = [entry('1', 'a'), entry('2', 'b'), entry('3', 'c')];

        const next = upsertTranscriptEntry(previous, entry('4', 'd'), 3);

        expect(next[0]).toBe(previous[1]);
        expect(next[1]).toBe(previous[2]);
        expect(next[2]?.id).toBe('4');
    });

    it('repeated trailing-partial upserts keep the list stable', () => {
        let entries = [entry('1', 'final-a')];
        const stableFirst = entries[0];

        for (let i = 0; i < 50; i++) {
            entries = upsertTranscriptEntry(entries, entry(`p-${i}`, `partial-${i}`, false));
        }

        expect(entries).toHaveLength(2);
        expect(entries[0]).toBe(stableFirst);
        expect(entries[1]?.id).toBe('p-49');
    });
});
