import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaygroundConfig } from '../../lib/config-store';

// --- Mocks -------------------------------------------------------------------

const preSummarizeMock = vi.fn();
const summarizeSyncMock = vi.fn();

// Mock the compat SMR hook so the component talks to controllable fns instead
// of a real gateway. Only `useSMR` is consumed at runtime; the type-only
// imports resolve against the real `.d.ts`.
vi.mock('@arcaai/vox/compat', () => ({
  useSMR: () => ({
    preSummarize: preSummarizeMock,
    summarizeSync: summarizeSyncMock,
    summarize: summarizeSyncMock,
    summarizeAsync: vi.fn(),
    loading: false,
    error: null,
  }),
}));

// sonner toasts render nothing here — stub to keep the test hermetic.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Import AFTER the mocks are registered.
import { SummaryCard } from '../SummaryCard';

const CONFIG: PlaygroundConfig = {
  apiEndpoint: 'http://localhost:8868',
  apiKey: 'test-key',
  tenantId: '',
  pipelineId: '',
  languageMode: 'en',
  department: 'cardiology',
  visitType: 'New Patient',
};

beforeEach(() => {
  preSummarizeMock.mockReset();
  summarizeSyncMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SummaryCard', () => {
  it('passes the returned pre_summary as preSummaryText (with includePreSummaryInContext) into Summarize', async () => {
    // Departments fetch resolves empty → free-text fallback (keeps the DOM simple).
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
    );
    preSummarizeMock.mockResolvedValue({
      pre_summary: 'PRE_SUMMARY_TEXT',
      structured_data: { title: '', sections: [] },
      created_at: '2026-07-31T00:00:00Z',
    });
    summarizeSyncMock.mockResolvedValue({
      session_id: 's1',
      summary: { subjective: 'S', objective: 'O', assessment: 'A', plan: 'P' },
      created_at: '2026-07-31T00:00:00Z',
    });

    const user = userEvent.setup();
    render(<SummaryCard config={CONFIG} transcriptLines={['line one', 'line two']} />);

    await user.click(screen.getByRole('button', { name: 'Pre-summarize' }));

    // Wait for the pre-summary to commit to state (rendered in the DOM).
    await screen.findByText('PRE_SUMMARY_TEXT');
    expect(preSummarizeMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Summarize' }));

    await waitFor(() => expect(summarizeSyncMock).toHaveBeenCalledTimes(1));
    expect(summarizeSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'line one\nline two',
        preSummaryText: 'PRE_SUMMARY_TEXT',
        includePreSummaryInContext: true,
      }),
    );
  });

  it('renders the free-text department input when the departments fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    render(<SummaryCard config={CONFIG} transcriptLines={[]} />);

    // The Skeleton gives way to a free-text input once the fetch rejects.
    const input = await screen.findByPlaceholderText('Enter department name or code');
    expect(input).toBeInTheDocument();
  });
});
