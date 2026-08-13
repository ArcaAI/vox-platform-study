import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// --- Mocks -------------------------------------------------------------------
//
// The whole compat surface is stubbed: this suite is about the TAB SHELL, not
// about the SDK. Everything returns inert values so the console can be
// connected and driven without a gateway, a mic, or a WebSocket.
//
// NOTE: no JSX inside the factory — `vi.mock` is hoisted above the imports, so
// the provider stub returns its children directly (legal for a React 19
// component) instead of reaching for the JSX runtime.

vi.mock('@arcaai/vox/compat', () => ({
  ArcaCompatProvider: ({ children }: { children: ReactNode }) => children,
  useArcaSessionManager: () => ({ session: null, isLoading: false, error: null }),
  useAudioCapture: () => ({
    isRecording: false,
    deviceStatus: null,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    getDeviceStatus: vi.fn(),
    error: null,
    isReady: true,
  }),
  useArcaSpeechToText: () => ({
    transcript: '',
    startTranscription: vi.fn(),
    stopTranscription: vi.fn(),
    sendAudioData: vi.fn(),
    uploadAudioFile: vi.fn(),
    getTranscriptionStatus: vi.fn(),
    isUploading: false,
    uploadProgress: 0,
    error: null,
  }),
  useArcaSttLanguageModes: () => ({ modes: [], isLoading: false, error: null, refresh: vi.fn() }),
  // The provider also mounts the batch-upload queue; an idle stub is
  // all these suites need (batch behaviour is covered in BatchUploadTab.test.tsx).
  useArcaBatchTranscription: () => ({
    items: [],
    enqueue: vi.fn(() => []),
    cancel: vi.fn(),
    retry: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    isUploading: false,
    isStreaming: false,
    activeCount: 0,
    error: null,
  }),
  useArcaSttProvider: () => ({
    usePipeline: false,
    switchStatus: 'idle',
    activeProvider: null,
    isFallbackActive: false,
    switchToPipeline: vi.fn(),
    switchToDefault: vi.fn(),
  }),
  useSMR: () => ({
    preSummarize: vi.fn(),
    summarize: vi.fn(),
    summarizeSync: vi.fn(),
    summarizeAsync: vi.fn(),
    loading: false,
    error: null,
  }),
}));

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Import AFTER the mocks are registered.
import { App } from '../../App';

const PANEL_IDS = ['connection-panel', 'live-transcription-panel', 'batch-upload-panel', 'summarization-panel'] as const;

/** Connect the console so both gated tabs become reachable. */
async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.clear(screen.getByLabelText(/API endpoint/i));
  await user.type(screen.getByLabelText(/API endpoint/i), 'http://localhost:8868');
  await user.type(screen.getByLabelText(/API key/i), 'test-key');
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByRole('button', { name: 'Disconnect' });
}

beforeEach(() => {
  window.localStorage.clear();
  // SummaryCard's department fetch runs as soon as the (force-mounted)
  // Summarization panel renders — resolve it to the free-text fallback.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App — four-tab console shell', () => {
  it('gates the three session tabs with a VISIBLE reason until connected', () => {
    render(<App />);

    expect(screen.getByRole('tab', { name: 'Live transcription' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Batch upload' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Summarization' })).toBeDisabled();
    // A disabled control must say why it is disabled, on screen.
    expect(screen.getByText(/Connect on the Connection tab to enable Live transcription, Batch upload and Summarization\./)).toBeInTheDocument();
  });

  it('enables the session tabs once connected', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connect(user);

    expect(screen.getByRole('tab', { name: 'Live transcription' })).toBeEnabled();
    expect(screen.getByRole('tab', { name: 'Batch upload' })).toBeEnabled();
    expect(screen.getByRole('tab', { name: 'Summarization' })).toBeEnabled();
  });

  // ---------------------------------------------------------------------------
  // THE regression this file exists for.
  //
  // Radix unmounts the CONTENTS of an inactive `<TabsContent>` by default. If a
  // panel loses its `forceMount`, switching tabs mid-recording silently tears
  // the live session down — the mic keeps running, the transcript vanishes, and
  // nothing errors.
  //
  // The assertion has to look INSIDE the panel: Radix's `Presence` keeps the
  // panel wrapper `<div role="tabpanel">` in the DOM either way (it needs it to
  // detect exit animations) and only gates `present && children`. So an
  // assertion on the wrapper node would pass even with `forceMount` removed —
  // identity of the panel's first CHILD is what actually proves nothing was
  // unmounted.
  // ---------------------------------------------------------------------------
  it('keeps EVERY panel body mounted when the active tab changes (forceMount invariant)', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connect(user);

    const bodyOf = (id: string) => screen.getByTestId(id).firstElementChild;
    const before = PANEL_IDS.map((id) => bodyOf(id));
    // Every body exists up front — that is what `forceMount` buys.
    before.forEach((body) => expect(body).not.toBeNull());

    for (const tabName of ['Live transcription', 'Batch upload', 'Summarization', 'Connection']) {
      await user.click(screen.getByRole('tab', { name: tabName }));
      PANEL_IDS.forEach((id, i) => {
        // Same DOM node object ⇒ React never unmounted and re-created it.
        expect(bodyOf(id)).toBe(before[i]);
        expect(before[i]?.isConnected).toBe(true);
      });
    }
  });

  it('marks inactive panels inactive rather than emptying them', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connect(user);
    await user.click(screen.getByRole('tab', { name: 'Live transcription' }));

    expect(screen.getByTestId('live-transcription-panel')).toHaveAttribute('data-state', 'active');
    for (const id of ['connection-panel', 'summarization-panel'] as const) {
      const panel = screen.getByTestId(id);
      expect(panel).toHaveAttribute('data-state', 'inactive');
      // Inactive but still populated — hidden by CSS, not unmounted.
      expect(panel.childElementCount).toBeGreaterThan(0);
    }
  });

  it('returns the user to the Connection tab on disconnect (never strands them on a disabled tab)', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connect(user);
    await user.click(screen.getByRole('tab', { name: 'Summarization' }));
    expect(screen.getByTestId('summarization-panel')).toHaveAttribute('data-state', 'active');

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(screen.getByTestId('connection-panel')).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tab', { name: 'Summarization' })).toBeDisabled();
  });
});

describe('SummarizationTab', () => {
  it('reads the live transcript from the session context, not a prop', async () => {
    const user = userEvent.setup();
    render(<App />);
    await connect(user);

    // Zero live lines and nothing pasted → Summarize stays disabled with a
    // visible reason. This proves the card is wired to the context (it renders
    // the live line count) rather than to a `transcriptLines` prop.
    await user.click(screen.getByRole('tab', { name: 'Summarization' }));
    expect(await screen.findByText('0 live lines')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Summarize' })).toBeDisabled();
  });
});
