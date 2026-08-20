import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaygroundConfig } from '../../lib/config-store';
import { computeEffectiveTranscript } from '../summarization/TranscriptSource';

// --- Mocks -------------------------------------------------------------------

const preSummarizeMock = vi.fn();
const summarizeSyncMock = vi.fn();
// Mutable — read fresh on every `useText()` call, so a mock implementation can
// flip it mid-flight (e.g. before firing `onDelta`) to exercise the streaming
// preview branch, which is gated on `loading`.
let mockLoading = false;

// Mock the compat TEXT hook so the component talks to controllable fns instead
// of a real gateway. Only `useText` is consumed at runtime; the type-only
// imports resolve against the real `.d.ts`.
vi.mock('@arcaai/vox/compat', () => ({
  useText: () => ({
    preSummarize: preSummarizeMock,
    summarizeSync: summarizeSyncMock,
    summarize: summarizeSyncMock,
    summarizeAsync: vi.fn(),
    get loading() {
      return mockLoading;
    },
    error: null,
  }),
}));

// sonner toasts render nothing here — stub to keep the test hermetic.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The live transcript arrives through the console-wide session context
//  instead of a `transcriptLines` prop, so the card needs a
// session to read. Mock the hook rather than standing up the whole provider —
// this suite is about the TEXT call shape, not session wiring.
let mockLineTexts: string[] = [];
// `batch.handoff` is the batch-upload → summarization push ; `null`
// here means "nothing was handed over", which is the state every test below
// exercises. The dedicated hand-off assertions live in BatchUploadTab.test.tsx.
vi.mock('../../context/playground-session', () => ({
  usePlaygroundSession: () => ({ transcript: { lineTexts: mockLineTexts }, batch: { handoff: null } }),
}));

// Import AFTER the mocks are registered.
import { SummaryCard } from '../SummaryCard';
import { toast } from 'sonner';

const CONFIG: PlaygroundConfig = {
  apiEndpoint: 'http://localhost:8868',
  apiKey: 'test-key',
  tenantId: '',
  pipelineId: '',
  languageMode: 'en',
  department: 'cardiology',
  visitType: 'New Patient',
};

const FINAL_SUMMARY = {
  session_id: 's1',
  summary: { subjective: 'Subj', objective: 'Obj', assessment: 'Assess', plan: 'Plan' },
  created_at: '2026-08-01T00:00:00Z',
};

/** Departments AND doctors fetch resolve empty → free-text fallback (keeps the DOM simple). */
function stubEmptyDepartmentsFetch() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
}

/**
 * Fetch stub: departments empty (free-text) but the users listing returns real
 * doctor rows, so the Doctor `<Select>` renders in list mode. Matches the real
 * `GET /api/v1/admin/users` bare-array shape `fetchDoctors` tolerates.
 */
function stubFetchWithDoctors(doctors: Array<{ id: string; username: string }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown) => {
      const body = String(url).includes('/admin/users') ? doctors : [];
      return Promise.resolve({ ok: true, json: async () => body });
    }),
  );
}

const PRE_SUMMARY_RESULT = {
  pre_summary: 'PRE',
  structured_data: { title: '', sections: [] },
  created_at: '2026-08-01T00:00:00Z',
};

beforeAll(() => {
  // Radix Select drives its trigger through Pointer Events; happy-dom lacks the
  // pointer-capture methods userEvent calls, so stub them (same spirit as the
  // scrollIntoView/ResizeObserver stubs in src/test/setup.ts).
  const proto = Element.prototype as unknown as {
    hasPointerCapture?: () => boolean;
    setPointerCapture?: () => void;
    releasePointerCapture?: () => void;
  };
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
});

beforeEach(() => {
  preSummarizeMock.mockReset();
  summarizeSyncMock.mockReset();
  mockLineTexts = [];
  mockLoading = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SummaryCard', () => {
  it('passes the returned pre_summary as preSummaryText (with includePreSummaryInContext) into Summarize', async () => {
    stubEmptyDepartmentsFetch();
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

    mockLineTexts = ['line one', 'line two'];
    const user = userEvent.setup();
    render(<SummaryCard config={CONFIG} />);

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

    render(<SummaryCard config={CONFIG} />);

    // The Skeleton gives way to a free-text input once the fetch rejects.
    const input = await screen.findByPlaceholderText('Enter department name or code');
    expect(input).toBeInTheDocument();
  });

  // -- Finding A4 -------------------------------------------------------------

  it('defaults the visit-type select to a value in the preset list on first paint', async () => {
    stubEmptyDepartmentsFetch();
    render(<SummaryCard config={{ ...CONFIG, visitType: undefined }} />);

    const combobox = await screen.findByRole('combobox', { name: 'Visit type' });
    // Must show a REAL preset — never the placeholder that renders when the
    // controlled value matches no `<SelectItem>` (the pre-fix A4 symptom).
    expect(combobox).toHaveTextContent('New / Referral');
    expect(combobox).not.toHaveTextContent('Select a visit type');
  });

  it('seeds a non-preset stored visit type (e.g. legacy "New Patient") into custom mode instead of a mismatched select value', async () => {
    stubEmptyDepartmentsFetch();
    // CONFIG.visitType is 'New Patient' — not one of the two presets.
    render(<SummaryCard config={CONFIG} />);

    const combobox = await screen.findByRole('combobox', { name: 'Visit type' });
    expect(combobox).toHaveTextContent('Custom…');
    expect(combobox).not.toHaveTextContent('Select a visit type');

    const customInput = screen.getByLabelText('Custom visit type');
    expect(customInput).toHaveValue('New Patient');
  });

  // -- R9: explicit transcript source -----------------------------------------

  it('defaults to the live transcript and shows the live line count', async () => {
    stubEmptyDepartmentsFetch();
    mockLineTexts = ['patient reports headache', 'no fever'];
    render(<SummaryCard config={CONFIG} />);

    expect(await screen.findByText('2 live lines')).toBeInTheDocument();
    const liveArea = screen.getByLabelText('Live transcript (read-only)');
    expect(liveArea).toHaveValue('patient reports headache\nno fever');
  });

  describe('computeEffectiveTranscript', () => {
    const LIVE = ['line one', 'line two'];

    it('uses the live transcript verbatim in live mode', () => {
      expect(computeEffectiveTranscript('live', LIVE, 'ignored paste', 'ignored context')).toBe('line one\nline two');
    });

    it('uses only the pasted text in pasted mode, ignoring the live buffer entirely', () => {
      expect(computeEffectiveTranscript('pasted', LIVE, 'my own transcript', 'ignored')).toBe('my own transcript');
    });

    it('appends additional context after the live transcript in live-plus-context mode', () => {
      expect(computeEffectiveTranscript('live-plus-context', LIVE, 'ignored', 'extra notes')).toBe('line one\nline two\n\nextra notes');
    });

    it('omits the additional-context block entirely when it is blank', () => {
      expect(computeEffectiveTranscript('live-plus-context', LIVE, '', '   ')).toBe('line one\nline two');
    });
  });

  // -- R10: streaming toggle ---------------------------------------------------

  it('non-streaming: Summarize omits `stream` and renders the final structured result', async () => {
    stubEmptyDepartmentsFetch();
    mockLineTexts = ['patient reports headache'];
    summarizeSyncMock.mockResolvedValue(FINAL_SUMMARY);

    const user = userEvent.setup();
    render(<SummaryCard config={CONFIG} />);

    await user.click(screen.getByRole('button', { name: 'Summarize' }));

    await waitFor(() => expect(summarizeSyncMock).toHaveBeenCalledTimes(1));
    expect(summarizeSyncMock.mock.calls[0][0]).not.toHaveProperty('stream');
    expect(summarizeSyncMock.mock.calls[0][0]).not.toHaveProperty('onDelta');

    await screen.findByText('Subj');
  });

  it('streaming: Summarize passes stream:true + onDelta, renders the live preview, then resolves to the same shape of final result', async () => {
    stubEmptyDepartmentsFetch();
    mockLineTexts = ['patient reports headache'];

    let resolveSummarize: ((value: typeof FINAL_SUMMARY) => void) | undefined;
    summarizeSyncMock.mockImplementation((req: { onDelta?: (delta: string, accumulated: string) => void }) => {
      // The mocked hook re-reads `mockLoading` on every render, so flipping it
      // here — before the delta fires the state update that triggers that
      // render — makes the component's `loading`-gated streaming branch light
      // up exactly like the real SSE path does while a request is in flight.
      mockLoading = true;
      req.onDelta?.('S O A P', 'S O A P');
      return new Promise((resolve) => {
        resolveSummarize = (value) => {
          mockLoading = false;
          resolve(value);
        };
      });
    });

    const user = userEvent.setup();
    render(<SummaryCard config={CONFIG} />);

    await user.click(screen.getByRole('switch', { name: 'Stream responses' }));
    await user.click(screen.getByRole('button', { name: 'Summarize' }));

    expect(summarizeSyncMock).toHaveBeenCalledTimes(1);
    expect(summarizeSyncMock.mock.calls[0][0]).toEqual(expect.objectContaining({ stream: true, onDelta: expect.any(Function) }));

    // Live preview shows the accumulated delta text with a token/char counter.
    await screen.findByText('S O A P');
    expect(screen.getByText(/chars ·/)).toBeInTheDocument();

    resolveSummarize?.(FINAL_SUMMARY);

    // The terminal `result` event resolves to the SAME v1-shaped body the
    // non-streaming path returns — same final render as the non-streaming test.
    await screen.findByText('Subj');
    // The LIVE streaming preview (its char/token counter) is gone once the final
    // result lands…
    expect(screen.queryByText(/chars ·/)).not.toBeInTheDocument();
    // …but the raw streamed JSON is preserved in the collapsible dev panel so it
    // does not vanish behind the structured view.
    expect(screen.getByText('Raw model output (JSON)')).toBeInTheDocument();
    expect(screen.getByText('S O A P')).toBeInTheDocument();
  });

  // -- SSE error handling -------------------------------------------------------

  it('surfaces an SSE error (or a stream-ended-without-result rejection) as toast.error, never a silent stall', async () => {
    stubEmptyDepartmentsFetch();
    const streamError = new Error('[@arcaai/vox/compat] useText: stream ended without a result event');
    preSummarizeMock.mockRejectedValue(streamError);

    const user = userEvent.setup();
    render(<SummaryCard config={CONFIG} />);

    await user.click(screen.getByRole('switch', { name: 'Stream responses' }));
    await user.click(screen.getByRole('button', { name: 'Pre-summarize' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(streamError.message));
    // No pre-summary result rendered — the failure did not silently succeed.
    expect(screen.queryByText('Pre-summary')).not.toBeInTheDocument();
  });

  // -- Phase E: doctor / DNA writing-style picker ------------------------------

  it('sends the selected doctorId into BOTH preSummarize and summarizeSync', async () => {
    stubFetchWithDoctors([{ id: 'doc-1', username: 'Dr. Alice' }]);
    preSummarizeMock.mockResolvedValue(PRE_SUMMARY_RESULT);
    summarizeSyncMock.mockResolvedValue(FINAL_SUMMARY);
    mockLineTexts = ['patient reports headache'];

    const user = userEvent.setup();
    render(<SummaryCard config={{ ...CONFIG, doctorId: undefined }} />);

    // Select the doctor from the list.
    const doctorSelect = await screen.findByRole('combobox', { name: 'Doctor' });
    await user.click(doctorSelect);
    await user.click(await screen.findByRole('option', { name: 'Dr. Alice' }));

    await user.click(screen.getByRole('button', { name: 'Pre-summarize' }));
    await waitFor(() => expect(preSummarizeMock).toHaveBeenCalledTimes(1));
    expect(preSummarizeMock.mock.calls[0][0]).toMatchObject({ doctorId: 'doc-1' });

    await user.click(screen.getByRole('button', { name: 'Summarize' }));
    await waitFor(() => expect(summarizeSyncMock).toHaveBeenCalledTimes(1));
    expect(summarizeSyncMock.mock.calls[0][0]).toMatchObject({ doctorId: 'doc-1' });
  });

  it('omits doctorId (sends undefined) when no doctor is selected — the "None" default', async () => {
    stubFetchWithDoctors([{ id: 'doc-1', username: 'Dr. Alice' }]);
    preSummarizeMock.mockResolvedValue(PRE_SUMMARY_RESULT);
    summarizeSyncMock.mockResolvedValue(FINAL_SUMMARY);
    mockLineTexts = ['patient reports headache'];

    const user = userEvent.setup();
    render(<SummaryCard config={{ ...CONFIG, doctorId: undefined }} />);

    // The picker loads (list mode) but nothing is chosen → "None (no DNA style)".
    await screen.findByRole('combobox', { name: 'Doctor' });

    await user.click(screen.getByRole('button', { name: 'Pre-summarize' }));
    await waitFor(() => expect(preSummarizeMock).toHaveBeenCalledTimes(1));
    expect(preSummarizeMock.mock.calls[0][0].doctorId).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Summarize' }));
    await waitFor(() => expect(summarizeSyncMock).toHaveBeenCalledTimes(1));
    expect(summarizeSyncMock.mock.calls[0][0].doctorId).toBeUndefined();
  });

  // -- Phase 4: translate-to-English (Sarvam) toggle ---------------------------

  it('defaults the translate toggle OFF → Summarize sends translateToEnglish falsy', async () => {
    stubEmptyDepartmentsFetch();
    mockLineTexts = ['patient reports headache'];
    summarizeSyncMock.mockResolvedValue(FINAL_SUMMARY);

    const user = userEvent.setup();
    render(<SummaryCard config={CONFIG} />);

    await user.click(screen.getByRole('button', { name: 'Summarize' }));

    await waitFor(() => expect(summarizeSyncMock).toHaveBeenCalledTimes(1));
    expect(summarizeSyncMock.mock.calls[0][0].translateToEnglish).toBeFalsy();
  });

  it('toggling the translate switch ON → Summarize sends translateToEnglish:true', async () => {
    stubEmptyDepartmentsFetch();
    mockLineTexts = ['patient reports headache'];
    summarizeSyncMock.mockResolvedValue(FINAL_SUMMARY);

    const user = userEvent.setup();
    render(<SummaryCard config={CONFIG} />);

    await user.click(screen.getByRole('switch', { name: 'Translate transcript to English (Sarvam)' }));
    await user.click(screen.getByRole('button', { name: 'Summarize' }));

    await waitFor(() => expect(summarizeSyncMock).toHaveBeenCalledTimes(1));
    expect(summarizeSyncMock.mock.calls[0][0]).toMatchObject({ translateToEnglish: true });
  });
});
