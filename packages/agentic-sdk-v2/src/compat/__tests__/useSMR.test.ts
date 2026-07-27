/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSMR } from '../useSMR';
import { useAgenticStore } from '../../store/agenticStore';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

const mockClient = {
  // baseUrl carries /api/v1; useSMR strips it to reach the origin-level shim.
  getBaseUrl: vi.fn(() => 'https://api.arcaai.com/api/v1'),
  getApiKey: vi.fn(() => 'tenant-key-123'),
};

function installClient(client: unknown) {
  (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: { apiClient: unknown }) => unknown) =>
    selector({ apiClient: client }),
  );
}

const fetchMock = vi.fn();

describe('useSMR', () => {
  beforeEach(() => {
    installClient(mockClient);
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ session_id: 's1', summary: {}, created_at: 'now' }),
    });
  });

  it('summarize POSTs to /api/smr/api/v1/summary/sync with x-api-key', async () => {
    const { result } = renderHook(() => useSMR());
    await act(async () => {
      await result.current.summarize({ text: 'a\nb' });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.arcaai.com/api/smr/api/v1/summary/sync');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('tenant-key-123');
  });

  it('sends PER-TURN conversation_segments, not one collapsed segment (F2)', async () => {
    const { result } = renderHook(() => useSMR());
    await act(async () => {
      await result.current.summarize({
        text: '',
        segments: [
          { speaker: 'doctor', text: 'What brings you in?' },
          { speaker: 'patient', text: 'Chest pain.' },
        ],
      });
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.session_data.conversation_segments).toHaveLength(2);
    expect(body.session_data.conversation_segments[0].speaker).toBe('doctor');
    expect(body.session_data.conversation_segments[1].speaker).toBe('patient');
  });

  it('splits multi-line text into per-turn segments (never one collapsed blob)', async () => {
    const { result } = renderHook(() => useSMR());
    await act(async () => {
      await result.current.summarize({ text: 'Doctor: hello\nPatient: hi there' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.session_data.conversation_segments.length).toBeGreaterThan(1);
    expect(body.session_data.conversation_segments[0].speaker).toBe('Doctor');
  });

  it('preSummarize POSTs to /api/smr/api/v1/presummary', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ pre_summary: 'x', structured_data: { title: '', sections: [] }, created_at: 'now' }) });
    const { result } = renderHook(() => useSMR());
    await act(async () => {
      await result.current.preSummarize({ current_department: 'Cardiology', visit_type: 'Follow Up' });
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.arcaai.com/api/smr/api/v1/presummary');
  });

  it('passes the shim response through unchanged', async () => {
    const payload = { session_id: 's9', summary: { subjective: 'x', objective: '', assessment: '', plan: '' }, created_at: 'now' };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    const { result } = renderHook(() => useSMR());
    let out: unknown;
    await act(async () => {
      out = await result.current.summarizeSync({ text: 'hi' });
    });
    expect(out).toEqual(payload);
  });

  it('throws when the SDK is not initialized (no apiClient)', async () => {
    installClient(null);
    const { result } = renderHook(() => useSMR());
    await expect(result.current.summarize({ text: 'hi' })).rejects.toThrow(/SDK not initialized/);
  });
});
