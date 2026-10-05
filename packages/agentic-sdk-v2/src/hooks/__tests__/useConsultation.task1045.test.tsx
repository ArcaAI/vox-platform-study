/**
 * `useConsultation` — the single consultation handle for the browser.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConsultation } from '../useConsultation';

const apiClient = {
  get: vi.fn(),
  post: vi.fn(),
  postWithHeaders: vi.fn(),
  postFormData: vi.fn(),
};

const streamingManager = {
  getSessionId: vi.fn<() => string | null>(() => 'stt-sess-1'),
  pauseCapture: vi.fn(),
  resumeCapture: vi.fn(),
};

const pluginManager = {
  getTranscriptionPipeline: () => ({ getStreamingSessionManager: () => streamingManager }),
};

vi.mock('../../store', () => ({
  useAgenticStore: () => ({ apiClient, logger: undefined, pluginManager }),
}));

const session = {
  consultation: { id: 'c1', status: 'OPEN', version: 4 } as Record<string, unknown> | null,
  error: null,
  open: vi.fn(),
  close: vi.fn(),
  reopen: vi.fn(),
  addContext: vi.fn(),
};
const audio = {
  isCapturing: false,
  level: 0,
  transcriptSegments: [] as unknown[],
  error: null,
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
};
const summary = { generateSummaryAsync: vi.fn(async () => ({ jobId: 'j1' })) };

vi.mock('../useArcaSession', () => ({ useArcaSession: () => session }));
vi.mock('../useArcaAudio', () => ({ useArcaAudio: () => audio }));
vi.mock('../useArcaSummary', () => ({ useArcaSummary: () => summary }));

const captureState = (over: Record<string, unknown> = {}) => ({
  consultationId: 'c1',
  status: 'RECORDING',
  processing: 'IDLE',
  encounterSeq: 1,
  recording: true,
  paused: false,
  version: 5,
  updatedAt: '2026-10-05T00:00:00Z',
  ...over,
});

const LIFECYCLE = { 'X-Hope-Lifecycle': '2' };

beforeEach(() => {
  vi.clearAllMocks();
  streamingManager.getSessionId.mockReturnValue('stt-sess-1');
  session.consultation = { id: 'c1', status: 'OPEN', version: 4 };
});

describe('useConsultation', () => {
  it('start() opens capture then calls POST :id/start with the STT session id and the lifecycle header', async () => {
    apiClient.postWithHeaders.mockResolvedValue(captureState());
    const { result } = renderHook(() => useConsultation());

    await act(async () => {
      await result.current.start({ agentSlug: 'asr' });
    });

    expect(audio.start).toHaveBeenCalledWith({ agentSlug: 'asr' });
    expect(apiClient.postWithHeaders).toHaveBeenCalledWith(
      '/consultations/c1/start',
      { sessionId: 'stt-sess-1' },
      expect.objectContaining(LIFECYCLE),
    );
    expect(result.current.status).toBe('RECORDING');
  });

  it('pause() sends the pause frame and POST :id/pause', async () => {
    apiClient.postWithHeaders.mockResolvedValue(captureState({ status: 'PAUSED', paused: true }));
    const { result } = renderHook(() => useConsultation());

    await act(async () => {
      await result.current.pause();
    });

    expect(streamingManager.pauseCapture).toHaveBeenCalledTimes(1);
    expect(apiClient.postWithHeaders).toHaveBeenCalledWith('/consultations/c1/pause', {}, expect.objectContaining(LIFECYCLE));
    expect(result.current.status).toBe('PAUSED');
  });

  it('stop() resolves only once the final transcript is complete', async () => {
    const pending = { ...captureState({ status: 'STOPPED', processing: 'FINALIZING_TRANSCRIPT' }), finalTranscript: { state: 'pending', contextItemId: null, versionNumber: null, segmentCount: 0, lastSegmentSeq: 0 } };
    const complete = { ...captureState({ status: 'STOPPED', processing: 'IDLE' }), finalTranscript: { state: 'complete', contextItemId: 'ctx1', versionNumber: 1, segmentCount: 3, lastSegmentSeq: 3 } };
    apiClient.postWithHeaders.mockResolvedValueOnce(pending).mockResolvedValueOnce(complete);
    const { result } = renderHook(() => useConsultation({ stopPollIntervalMs: 1 }));

    let out: { finalTranscript: { state: string } } | undefined;
    await act(async () => {
      out = await result.current.stop();
    });

    expect(audio.stop).toHaveBeenCalled();
    expect(apiClient.postWithHeaders).toHaveBeenCalledTimes(2);
    expect(apiClient.postWithHeaders).toHaveBeenCalledWith('/consultations/c1/stop', { waitForFinal: true }, expect.objectContaining(LIFECYCLE));
    expect(out?.finalTranscript.state).toBe('complete');
  });

  it('approve() sends If-Match from the loaded version and the lifecycle header', async () => {
    apiClient.postWithHeaders.mockResolvedValue({ id: 'c1', status: 'APPROVED', processing: 'IDLE', version: 5 });
    const { result } = renderHook(() => useConsultation());

    await act(async () => {
      await result.current.approve();
    });

    const [url, , headers] = apiClient.postWithHeaders.mock.calls[0];
    expect(url).toBe('/consultations/c1/approve');
    expect(headers).toMatchObject({ ...LIFECYCLE });
    expect(headers['If-Match']).toContain('4');
    expect(result.current.status).toBe('APPROVED');
  });

  it('generateSummary() forwards sectionKeys through the summary hook', async () => {
    const { result } = renderHook(() => useConsultation());
    await act(async () => {
      await result.current.generateSummary({ sectionKeys: ['plan'] });
    });
    expect(summary.generateSummaryAsync).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ sectionKeys: ['plan'] }) }));
  });

  it('normalises a legacy status from the session row', () => {
    session.consultation = { id: 'c1', status: 'PENDING_REVIEW', version: 4 };
    const { result } = renderHook(() => useConsultation());
    expect(result.current.status).toBe('STOPPED');
    expect(result.current.processing).toBe('AWAITING_REVIEW');
  });
});
