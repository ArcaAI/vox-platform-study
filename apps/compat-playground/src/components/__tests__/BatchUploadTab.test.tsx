import { render, screen, waitFor } from '@testing-library/react';
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
