/**
 * Cockpit live-engine status indicator (TASK-341 A3).
 *
 * The cockpit owns the single live-summary SSE subscription and now surfaces a
 * read-only "live engine" status indicator (connecting / open / closed / error
 * + last-updated) so the clinician can see the TASK-340 realtime engine's health
 * at a glance. Ops controls (kill-switch) deliberately live in the admin console,
 * not here — this indicator is purely informational.
 *
 * The three child panes are mocked so the test drives only the cockpit's own
 * composition + status indicator (the panes are covered by their own tests).
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('../capture-panel', () => ({ CapturePanel: () => <div data-testid="capture-panel" /> }));
vi.mock('../context-panel', () => ({ ContextPanel: () => <div data-testid="context-panel" /> }));
vi.mock('../live-summary-panel', () => ({ LiveSummaryPanel: () => <div data-testid="live-summary-panel" /> }));

import { Cockpit } from '../cockpit';
import type { UseLiveSummaryStreamResult } from '../../hooks/use-live-summary-stream';

function liveSummary(overrides: Partial<UseLiveSummaryStreamResult> = {}): UseLiveSummaryStreamResult {
  return { event: null, status: 'idle', error: null, lastUpdatedAt: null, ...overrides };
}

function renderCockpit(ls: UseLiveSummaryStreamResult) {
  return render(
    <Cockpit consultationId="c1" recording={ls.status === 'open'} liveSummary={ls} onRecordingStarted={vi.fn()} onRecordingStopped={vi.fn()} />,
  );
}

describe('Cockpit — live engine status indicator', () => {
  it('composes the three cockpit panes', () => {
    renderCockpit(liveSummary({ status: 'open' }));
    expect(screen.getByTestId('capture-panel')).toBeInTheDocument();
    expect(screen.getByTestId('live-summary-panel')).toBeInTheDocument();
    expect(screen.getByTestId('context-panel')).toBeInTheDocument();
  });

  it('shows the live (open) engine state with a last-updated time', () => {
    renderCockpit(liveSummary({ status: 'open', lastUpdatedAt: '2026-06-08T00:00:00.000Z' }));
    const indicator = screen.getByTestId('live-engine-status');
    expect(indicator.getAttribute('data-status')).toBe('open');
    expect(indicator.textContent).toContain('Live');
    expect(within(indicator).getByTestId('live-engine-updated')).toBeInTheDocument();
  });

  it('shows the connecting state before the first event (no last-updated yet)', () => {
    renderCockpit(liveSummary({ status: 'connecting', lastUpdatedAt: null }));
    const indicator = screen.getByTestId('live-engine-status');
    expect(indicator.getAttribute('data-status')).toBe('connecting');
    expect(indicator.textContent).toContain('Connecting');
    expect(within(indicator).queryByTestId('live-engine-updated')).toBeNull();
  });

  it('shows the finalized state when the stream closes', () => {
    renderCockpit(liveSummary({ status: 'closed', lastUpdatedAt: '2026-06-08T00:00:00.000Z' }));
    expect(screen.getByTestId('live-engine-status').getAttribute('data-status')).toBe('closed');
  });

  it('shows a disconnected state on error', () => {
    renderCockpit(liveSummary({ status: 'error', error: 'boom' }));
    const indicator = screen.getByTestId('live-engine-status');
    expect(indicator.getAttribute('data-status')).toBe('error');
    expect(indicator.textContent).toContain('Disconnected');
  });

  it('is read-only — surfaces no ops controls (kill-switch lives in admin)', () => {
    renderCockpit(liveSummary({ status: 'open', lastUpdatedAt: '2026-06-08T00:00:00.000Z' }));
    const indicator = screen.getByTestId('live-engine-status');
    expect(within(indicator).queryByRole('button')).toBeNull();
  });
});
