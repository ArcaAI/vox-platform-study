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
});
