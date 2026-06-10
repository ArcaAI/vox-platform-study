/**
 * TranscriptList windowing tests (TASK-351 P0-6 / H7)
 *
 * Long sessions accumulate up to 300 entries; rendering them all on every
 * partial update is the playground's biggest render cost. The list windows
 * to the most recent entries with a "show earlier" expander.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TranscriptEntry } from '@/store/audio-store';

vi.mock('../audio-transcript-item', () => ({
    AudioTranscriptItem: ({ entry }: { entry: TranscriptEntry }) => <div data-testid="transcript-row">{entry.text}</div>,
}));

vi.mock('@arcaai/ui/scroll-area', () => ({
    ScrollArea: ({ children }: React.PropsWithChildren) => <div data-slot="scroll-area-viewport">{children}</div>,
}));

vi.mock('@arcaai/ui/button', () => ({
    Button: ({ children, ...props }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => (
        <button {...props}>{children}</button>
    ),
}));

import { TranscriptList, TRANSCRIPT_WINDOW_SIZE } from '../transcript-list';

function makeEntries(count: number): TranscriptEntry[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `e-${i}`,
        segment: i + 1,
        text: `entry-${i}`,
        timestamp: 0,
        isFinal: true,
        start: i,
        end: i + 1,
        duration: 1,
        inference: 0,
    }));
}

describe('TranscriptList', () => {
    it('exports a 60-entry default window', () => {
        expect(TRANSCRIPT_WINDOW_SIZE).toBe(60);
    });

    it('renders all rows when under the window size', () => {
        render(<TranscriptList entries={makeEntries(10)} emptyMessage="empty" />);

        expect(screen.getAllByTestId('transcript-row')).toHaveLength(10);
        expect(screen.queryByRole('button', { name: /earlier/i })).not.toBeInTheDocument();
    });

    it('windows 300 entries down to the latest 60 plus an expander', () => {
        render(<TranscriptList entries={makeEntries(300)} emptyMessage="empty" />);

        const rows = screen.getAllByTestId('transcript-row');
        expect(rows).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
        // The newest entries are the ones kept visible.
        expect(rows[0]).toHaveTextContent('entry-240');
        expect(rows[rows.length - 1]).toHaveTextContent('entry-299');
        expect(screen.getByRole('button', { name: /240 earlier/i })).toBeInTheDocument();
    });

    it('reveals all entries when the expander is clicked', async () => {
        const user = userEvent.setup();
        render(<TranscriptList entries={makeEntries(300)} emptyMessage="empty" />);

        await user.click(screen.getByRole('button', { name: /earlier/i }));

        expect(screen.getAllByTestId('transcript-row')).toHaveLength(300);
        expect(screen.queryByRole('button', { name: /earlier/i })).not.toBeInTheDocument();
    });

    it('shows the empty message when there are no entries', () => {
        render(<TranscriptList entries={[]} emptyMessage="nothing yet" />);

        expect(screen.getByText('nothing yet')).toBeInTheDocument();
        expect(screen.queryAllByTestId('transcript-row')).toHaveLength(0);
    });
});
