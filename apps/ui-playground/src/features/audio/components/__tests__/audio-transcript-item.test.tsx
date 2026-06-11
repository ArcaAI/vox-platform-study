/**
 * AudioTranscriptItem rendering tests (TASK-351 P1-1)
 *
 * Partials carrying `stableChars` (committed-prefix length from stt-v2's
 * local-agreement gate) render the committed prefix like final text and only
 * the tentative tail dimmed. Entries without the field — older stt-v2
 * results — keep today's full-dim italic styling.
 */

import { render, screen } from '@testing-library/react';
import React from 'react';
import type { TranscriptEntry } from '@/store/audio-store';

vi.mock('@arcaai/ui/badge', () => ({
    Badge: ({ children, variant, ...props }: React.PropsWithChildren<{ variant?: string } & Record<string, unknown>>) => (
        <span data-testid="badge" data-variant={variant} {...props}>{children}</span>
    ),
}));

vi.mock('@arcaai/ui/button', () => ({
    Button: ({ children, ...props }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => (
        <button {...props}>{children}</button>
    ),
}));

vi.mock('lucide-react', () => ({
    Clock: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon-clock" {...props} />,
    Play: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon-play" {...props} />,
    Square: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon-square" {...props} />,
    User: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon-user" {...props} />,
}));

import { AudioTranscriptItem } from '../audio-transcript-item';

function makeEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
    return {
        id: 'e-1',
        segment: 1,
        text: 'hello world',
        timestamp: 0,
        isFinal: false,
        start: 0,
        end: 1,
        duration: 1,
        inference: 0,
        ...overrides,
    };
}

describe('AudioTranscriptItem — stableChars split rendering (TASK-351 P1-1)', () => {
    it('renders the committed prefix normally and the tentative tail dimmed on partials with stableChars', () => {
        render(<AudioTranscriptItem entry={makeEntry({ text: 'hello world', isFinal: false, stableChars: 6 })} />);

        const tail = screen.getByText('world');
        expect(tail).toHaveClass('text-muted-foreground/70', 'italic');

        const paragraph = tail.closest('p');
        expect(paragraph).not.toBeNull();
        expect(paragraph).toHaveTextContent('hello world');
        // The committed prefix shares the paragraph's normal (non-dim) style.
        expect(paragraph).not.toHaveClass('text-muted-foreground');
        expect(paragraph).not.toHaveClass('italic');
    });

    it('falls back to the full-dim italic style when a partial has no stableChars', () => {
        render(<AudioTranscriptItem entry={makeEntry({ text: 'plain partial', isFinal: false })} />);

        const paragraph = screen.getByText('plain partial');
        expect(paragraph.tagName).toBe('P');
        expect(paragraph).toHaveClass('text-muted-foreground', 'italic');
    });

    it('falls back to the full-dim italic style when stableChars is 0 (nothing committed yet)', () => {
        render(<AudioTranscriptItem entry={makeEntry({ text: 'all tentative', isFinal: false, stableChars: 0 })} />);

        const paragraph = screen.getByText('all tentative');
        expect(paragraph.tagName).toBe('P');
        expect(paragraph).toHaveClass('text-muted-foreground', 'italic');
    });

    it('ignores stableChars on final entries — finals render plain', () => {
        render(<AudioTranscriptItem entry={makeEntry({ text: 'final text', isFinal: true, stableChars: 4 })} />);

        const paragraph = screen.getByText('final text');
        expect(paragraph.tagName).toBe('P');
        expect(paragraph).toHaveClass('text-sm');
        expect(paragraph).not.toHaveClass('italic');
        expect(paragraph.querySelector('span')).toBeNull();
    });
});

describe('AudioTranscriptItem — gloss secondary line (TASK-351 P1-1 follow-up)', () => {
    it('renders the English gloss as a subtle secondary line when present', () => {
        render(<AudioTranscriptItem entry={makeEntry({ text: 'xin chào', isFinal: true, englishText: 'hello' })} />);

        // Main text stays primary; the gloss is its own muted line.
        expect(screen.getByText('xin chào')).toHaveClass('text-sm');
        const gloss = screen.getByText('hello');
        expect(gloss).toHaveClass('text-muted-foreground');
        expect(gloss).not.toBe(screen.getByText('xin chào'));
    });

    it('renders no gloss line when englishText is absent', () => {
        const { container } = render(<AudioTranscriptItem entry={makeEntry({ text: 'xin chào', isFinal: true })} />);

        // Only the main transcript paragraph exists in the text column.
        expect(container.querySelectorAll('p')).toHaveLength(1);
    });
});
