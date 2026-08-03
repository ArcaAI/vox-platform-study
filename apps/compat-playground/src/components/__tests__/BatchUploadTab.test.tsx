import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// --- Mocks -------------------------------------------------------------------
//
// Same posture as `App.tabs.test.tsx`: the whole compat surface is stubbed so
// the tab can be driven without a gateway, a mic or a socket. The ONE hook this
// suite actually cares about is `useArcaBatchTranscription` — it is driven from
// `batchState` below, which the tests mutate to stage each queue state.
//
// No JSX in the factory (`vi.mock` is hoisted above the imports).

const enqueueMock = vi.fn((_files: File[]): string[] => ['batch-item-1']);
const cancelMock = vi.fn();
const retryMock = vi.fn();
const removeMock = vi.fn();
const clearMock = vi.fn();

type StubItem = {
  id: string;
  fileName: string;
  size: number;
  status: string;
  uploadProgress: number;
  jobId: string | null;
  segments: Array<{ text: string; isFinal: boolean; startTime?: number; speakerLabel?: string }>;
  text: string;
  error: string | null;
  job: unknown;
};

const batchState: { items: StubItem[] } = { items: [] };

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
  useArcaBatchTranscription: () => ({
    items: batchState.items,
    enqueue: enqueueMock,
    cancel: cancelMock,
    retry: retryMock,
    remove: removeMock,
    clear: clearMock,
    isUploading: batchState.items.some((i) => i.status === 'uploading'),
    isStreaming: batchState.items.some((i) => i.status === 'processing'),
    activeCount: batchState.items.filter((i) => i.status === 'uploading' || i.status === 'processing').length,
    error: null,
  }),
  useArcaSttProvider: () => ({
    isOn: true,
    canSwitch: false,
    isSwitching: false,
    activePipeline: null,
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
import { toast } from 'sonner';

function makeItem(overrides: Partial<StubItem> = {}): StubItem {
  return {
    id: 'batch-item-1',
    fileName: 'clip.wav',
    size: 2048,
    status: 'pending',
    uploadProgress: 0,
    jobId: null,
    segments: [],
    text: '',
    error: null,
    job: null,
    ...overrides,
  };
}

/** Connect the console so the gated tabs become reachable, then open Batch upload. */
async function openBatchTab(user: ReturnType<typeof userEvent.setup>) {
  await user.clear(screen.getByLabelText(/API endpoint/i));
  await user.type(screen.getByLabelText(/API endpoint/i), 'http://localhost:8868');
  await user.type(screen.getByLabelText(/API key/i), 'test-key');
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByRole('button', { name: 'Disconnect' });
  await user.click(screen.getByRole('tab', { name: 'Batch upload' }));
}

beforeEach(() => {
  window.localStorage.clear();
  batchState.items = [];
  enqueueMock.mockClear();
  cancelMock.mockClear();
  retryMock.mockClear();
  removeMock.mockClear();
  clearMock.mockClear();
  // SummaryCard's department fetch + the pipeline picker's catalog fetch both
  // run as soon as the force-mounted panels render.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
});

describe('Batch upload tab', () => {
  it('is gated behind the connection, like the other session tabs', () => {
    render(<App />);
    expect(screen.getByRole('tab', { name: 'Batch upload' })).toBeDisabled();
    expect(screen.getByText(/Batch upload becomes available once the console is connected\./)).toBeInTheDocument();
  });

  it('enqueues the chosen files', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openBatchTab(user);

    const input = screen.getByLabelText(/Audio files/i);
    await user.upload(input, [
      new File([new Uint8Array(16)], 'a.wav', { type: 'audio/wav' }),
      new File([new Uint8Array(16)], 'b.wav', { type: 'audio/wav' }),
    ]);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enqueued = enqueueMock.mock.calls[0]?.[0] ?? [];
    expect(enqueued.map((f) => f.name)).toEqual(['a.wav', 'b.wav']);
  });

  it('shows the job id and upload progress for an in-flight row', async () => {
    batchState.items = [makeItem({ status: 'uploading', uploadProgress: 42, jobId: 'job-7' })];
    const user = userEvent.setup();
    render(<App />);
    await openBatchTab(user);

    expect(screen.getByText('clip.wav')).toBeInTheDocument();
    // Status is spelled out in text, never colour alone.
    expect(screen.getByText('Uploading')).toBeInTheDocument();
    expect(screen.getByText(/job: job-7/)).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('cancels an in-flight row and retries a failed one', async () => {
    batchState.items = [makeItem({ status: 'processing', jobId: 'job-7' })];
    const user = userEvent.setup();
    const { rerender } = render(<App />);
    await openBatchTab(user);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelMock).toHaveBeenCalledWith('batch-item-1');

    batchState.items = [makeItem({ status: 'failed', error: 'network down' })];
    rerender(<App />);
    await waitFor(() => expect(screen.getByText('Failed')).toBeInTheDocument());
    expect(screen.getByText('network down')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryMock).toHaveBeenCalledWith('batch-item-1');
  });

  it('hands a completed transcript to the Summarization tab as the pasted source', async () => {
    batchState.items = [
      makeItem({
        status: 'completed',
        jobId: 'job-7',
        text: 'patient reports chest pain',
        segments: [{ text: 'patient reports chest pain', isFinal: true, startTime: 0 }],
      }),
    ];
    const user = userEvent.setup();
    render(<App />);
    await openBatchTab(user);

    // Two entry points (queue row + result panel); either lands the transcript.
    await user.click(screen.getAllByRole('button', { name: 'Send to Summarization' })[0]);

    await user.click(screen.getByRole('tab', { name: 'Summarization' }));
    await waitFor(() => expect(screen.getByDisplayValue('patient reports chest pain')).toBeInTheDocument());
    // The source selector switched to `pasted` — the live transcript no longer wins.
    expect(screen.getByRole('combobox', { name: /transcript source/i })).toHaveTextContent('Pasted');
  });
});

describe('All-results view (TASK-606)', () => {
  it('defaults to the selected-file view — the existing master-detail flow is unchanged', async () => {
    const user = userEvent.setup();
    render(<App />);
    await openBatchTab(user);

    expect(screen.getByRole('button', { name: 'Selected file' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /All results/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Nothing selected.')).toBeInTheDocument();
  });

  it('lists every queued item, in queue order, once switched to All results', async () => {
    batchState.items = [
      makeItem({ id: 'batch-item-1', fileName: 'a.wav', status: 'completed', jobId: 'job-a', text: 'alpha transcript' }),
      makeItem({
        id: 'batch-item-2',
        fileName: 'b.wav',
        status: 'processing',
        jobId: 'job-b',
        segments: [{ text: 'beta so far', isFinal: true }],
        text: 'beta so far',
      }),
      makeItem({ id: 'batch-item-3', fileName: 'c.wav', status: 'pending', jobId: null }),
    ];
    const user = userEvent.setup();
    render(<App />);
    await openBatchTab(user);

    await user.click(screen.getByRole('button', { name: /All results/ }));

    const region = screen.getByTestId('batch-all-results');
    expect(within(region).getByText('a.wav')).toBeInTheDocument();
    expect(within(region).getByText('b.wav')).toBeInTheDocument();
    expect(within(region).getByText('c.wav')).toBeInTheDocument();
    expect(within(region).getByText('1 of 3 completed')).toBeInTheDocument();
  });

  it('switches back to the selected-file view without losing it', async () => {
    batchState.items = [makeItem({ status: 'completed', text: 'alpha transcript' })];
    const user = userEvent.setup();
    render(<App />);
    await openBatchTab(user);

    await user.click(screen.getByRole('button', { name: /All results/ }));
    expect(screen.getByTestId('batch-all-results')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Selected file' }));
    expect(screen.queryByTestId('batch-all-results')).not.toBeInTheDocument();
    // The single-result view is exactly what it was before this feature — still
    // gated on `batch.selectedId`, which this suite never sets.
    expect(screen.getByText('Nothing selected.')).toBeInTheDocument();
  });

  it('renders the right affordance for every mixed status — nothing is hidden', async () => {
    batchState.items = [
      makeItem({ id: 'batch-item-1', fileName: 'ok.wav', status: 'completed', text: 'done transcript' }),
      makeItem({
        id: 'batch-item-2',
        fileName: 'mid.wav',
        status: 'processing',
        segments: [{ text: 'partial segment', isFinal: true }],
        text: 'partial segment',
      }),
      makeItem({ id: 'batch-item-3', fileName: 'wait.wav', status: 'pending' }),
      makeItem({ id: 'batch-item-4', fileName: 'bad.wav', status: 'failed', error: 'disk full' }),
      makeItem({ id: 'batch-item-5', fileName: 'stopped.wav', status: 'cancelled' }),
    ];
    const user = userEvent.setup();
    render(<App />);
    await openBatchTab(user);
    await user.click(screen.getByRole('button', { name: /All results/ }));

    const region = screen.getByTestId('batch-all-results');
    expect(within(region).getByText('done transcript')).toBeInTheDocument();
    expect(within(region).getByText('partial segment')).toBeInTheDocument();
    expect(within(region).getByText('disk full')).toBeInTheDocument();
    expect(within(region).getByText('Cancelled.')).toBeInTheDocument();

    // The still-queued item shows a Skeleton placeholder — never a spinner.
    const pendingRow = within(region).getByText('wait.wav').closest('li');
    expect(pendingRow?.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(pendingRow?.querySelector('svg[class*="animate-spin"]')).toBeNull();

    // Nothing is dropped from the list just because it isn't finished/successful.
    expect(within(region).getByText('bad.wav')).toBeInTheDocument();
    expect(within(region).getByText('stopped.wav')).toBeInTheDocument();
  });

  it('keeps "Send to Summarization" reachable per-item in the all-results view', async () => {
    batchState.items = [makeItem({ status: 'completed', text: 'patient reports chest pain' })];
    const user = userEvent.setup();
    render(<App />);
    await openBatchTab(user);
    await user.click(screen.getByRole('button', { name: /All results/ }));

    const region = screen.getByTestId('batch-all-results');
    await user.click(within(region).getByRole('button', { name: 'Send to Summarization' }));

    await user.click(screen.getByRole('tab', { name: 'Summarization' }));
    await waitFor(() => expect(screen.getByDisplayValue('patient reports chest pain')).toBeInTheDocument());
  });

  it('copies every transcript to the clipboard from the all-results header', async () => {
    batchState.items = [
      makeItem({ id: 'batch-item-1', fileName: 'a.wav', status: 'completed', text: 'alpha transcript' }),
      makeItem({ id: 'batch-item-2', fileName: 'b.wav', status: 'failed', error: 'boom' }),
    ];
    const user = userEvent.setup();
    render(<App />);
    await openBatchTab(user);
    await user.click(screen.getByRole('button', { name: /All results/ }));
    // Spy on the REAL clipboard's method rather than replacing `navigator.clipboard`
    // wholesale — happy-dom lazily (re)creates the Clipboard instance, and a
    // wholesale replacement made earlier in the test does not survive to the click.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    await user.click(screen.getByRole('button', { name: 'Copy all' }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toContain('a.wav');
    expect(copied).toContain('alpha transcript');
    expect(copied).toContain('b.wav');
    expect(copied).toContain('boom');
    expect(toast.success).toHaveBeenCalled();
  });

  it('downloads every transcript as a text file from the all-results header', async () => {
    const createObjectURL = vi.fn(() => 'blob:all-results');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    // Same posture as `ScorecardPanel.test.tsx`'s export test: happy-dom's anchor
    // `click()` attempts a real navigation once `href` is set, which throws
    // against the stubbed `URL` above — stub the click itself, same as that suite.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    batchState.items = [makeItem({ status: 'completed', text: 'alpha transcript' })];
    const user = userEvent.setup();
    render(<App />);
    await openBatchTab(user);
    await user.click(screen.getByRole('button', { name: /All results/ }));

    await user.click(screen.getByRole('button', { name: 'Download all' }));

    expect(clickSpy).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:all-results');
  });

  it('copies a single item transcript from its own Copy button', async () => {
    batchState.items = [makeItem({ fileName: 'solo.wav', status: 'completed', text: 'solo transcript' })];
    const user = userEvent.setup();
    render(<App />);
    await openBatchTab(user);
    await user.click(screen.getByRole('button', { name: /All results/ }));
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    const region = screen.getByTestId('batch-all-results');
    await user.click(within(region).getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith('solo transcript');
  });
});
