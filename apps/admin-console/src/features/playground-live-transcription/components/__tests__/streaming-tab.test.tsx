/**
 * A11y contract for the degraded-connection banner. The banner
 * is the clinician-facing signal that outbound audio was silently dropped, so it
 * must: announce via a polite status live region, carry meaning in icon + text
 * (never color alone), and keep the churning per-connection frame count OUT of
 * the announcement (aria-hidden), shown only while the current connection drops.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DegradedBanner, TranscriptPane } from '../streaming-tab';
import type { LiveTranscriptRow, UseLiveSttSessionResult } from '../../api';

afterEach(cleanup);

/** Minimal `live` view for TranscriptPane — it only reads status/finals/partial/meta. */
function makeLive(finals: LiveTranscriptRow[]): UseLiveSttSessionResult {
    return {
        status: 'streaming',
        finals,
        partial: null,
        lastSeq: finals.at(-1)?.seq ?? null,
        lastLatencyMs: finals.at(-1)?.latencyMs ?? null,
    } as unknown as UseLiveSttSessionResult;
}

function finalRow(id: number, text: string, speakerLabel?: string): LiveTranscriptRow {
    return { id, text, isFinal: true, receivedAt: Date.UTC(2026, 6, 11, 12, id), latencyMs: 100, seq: id, speakerLabel };
}

describe('TranscriptPane speaker rendering (TASK-489 AC-2)', () => {
    it('renders the per-segment speaker label as a prefix before the text', () => {
        render(<TranscriptPane live={makeLive([finalRow(1, 'patient reports headache', 'Speaker 1')])} />);

        // The clinician sees "Speaker 1:" attribution ahead of the utterance.
        expect(screen.getByText(/Speaker 1:/)).toBeTruthy();
        expect(screen.getByText('patient reports headache')).toBeTruthy();
    });

    it('renders no speaker prefix when the segment carries no label (attribution absent)', () => {
        render(<TranscriptPane live={makeLive([finalRow(2, 'no attribution here')])} />);

        expect(screen.getByText('no attribution here')).toBeTruthy();
        expect(screen.queryByText(/Speaker/)).toBeNull();
    });
});

describe('DegradedBanner (C6-01)', () => {
    it('announces the permanent loss via a polite status region, in text and an icon (not color alone)', () => {
        render(<DegradedBanner droppedFrameCount={3} />);

        const status = screen.getByRole('status');
        expect(status.getAttribute('aria-live')).toBe('polite');
        // Past/stative copy — the transcript stays incomplete even after recovery.
        expect(status.textContent).toMatch(/audio was dropped/i);
        expect(status.textContent).toMatch(/transcript is incomplete/i);
        // Meaning is reinforced by an icon, so it never rides on color alone.
        expect(status.querySelector('svg')).not.toBeNull();
    });

    it('keeps the churning per-connection frame count out of the announcement (aria-hidden sub-line)', () => {
        render(<DegradedBanner droppedFrameCount={3} />);

        const countLine = screen.getByText(/3 audio frames dropped on the current connection/i);
        expect(countLine.getAttribute('aria-hidden')).toBe('true');
    });

    it('omits the count sub-line when the current connection has dropped nothing', () => {
        render(<DegradedBanner droppedFrameCount={0} />);

        // The sticky banner still shows (driven by the latch, not the count)...
        expect(screen.getByRole('status')).toBeTruthy();
        // ...but there is no "0 frames dropped" noise.
        expect(screen.queryByText(/dropped on the current connection/i)).toBeNull();
    });
});
