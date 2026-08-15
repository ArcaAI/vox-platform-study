/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useText } from '../useText';
import { useAgenticStore } from '../../store/agenticStore';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

const mockClient = {
  // baseUrl carries /api/v1; useText strips it to reach the origin-level shim.
  getBaseUrl: vi.fn(() => 'https://api.arcaai.com/api/v1'),
  getApiKey: vi.fn(() => 'tenant-key-123'),
};

function installClient(client: unknown) {
  (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: { apiClient: unknown }) => unknown) =>
    selector({ apiClient: client }),
  );
}

const fetchMock = vi.fn();

/** Build a mock fetch Response whose `body` streams the given raw SSE frame text. */
function sseResponse(rawFrames: string[]): { ok: true; status: 200; body: ReadableStream<Uint8Array>; json: () => Promise<unknown> } {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of rawFrames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream, json: async () => ({}) };
}

describe('useText', () => {
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
    const { result } = renderHook(() => useText());
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
    const { result } = renderHook(() => useText());
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
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.summarize({ text: 'Doctor: hello\nPatient: hi there' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.session_data.conversation_segments.length).toBeGreaterThan(1);
    expect(body.session_data.conversation_segments[0].speaker).toBe('Doctor');
  });

  it('sends session_data.session_type from visitType (v1 parity, gateway-whitelisted)', async () => {
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.summarize({ text: 'a', visitType: 'Follow-up' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.session_data.session_type).toBe('Follow-up');
  });

  it('never sends previous_visit_summary (gateway forbids the undeclared key)', async () => {
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.summarize({ text: 'a' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect('previous_visit_summary' in body.session_data).toBe(false);
  });

  it('writes the CANONICAL session_metadata.department key (=departmentId) alongside department_id', async () => {
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.summarize({ text: 'a', departmentId: 'Cardiology', visitType: 'Follow-up' });
    });
    const meta = JSON.parse(fetchMock.mock.calls[0][1].body).session_data.session_metadata;
    // canonical key the gateway resolver reads first
    expect(meta.department).toBe('Cardiology');
    // legacy key kept for the older provider-path interpretation
    expect(meta.department_id).toBe('Cardiology');
    // visit_type stays canonical too
    expect(meta.visit_type).toBe('Follow-up');
  });

  it('forwards top-level specialty + encounter_type ONLY when provided', async () => {
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.summarize({ text: 'a', specialty: 'Interventional Cardiology', encounter_type: 'inpatient' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.specialty).toBe('Interventional Cardiology');
    expect(body.encounter_type).toBe('inpatient');
  });

  it('accepts the camelCase encounterType alias for encounter_type', async () => {
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.summarize({ text: 'a', encounterType: 'outpatient' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.encounter_type).toBe('outpatient');
  });

  it('omits specialty/encounter_type keys entirely when not provided (backward-compatible)', async () => {
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.summarize({ text: 'a' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect('specialty' in body).toBe(false);
    expect('encounter_type' in body).toBe(false);
  });

  it('summarizeSync sends top-level doctor_id when doctorId is provided (DNA writing-style)', async () => {
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.summarizeSync({ text: 'a', doctorId: 'doc-42' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.doctor_id).toBe('doc-42');
    // legacy nested key preserved
    expect(body.session_data.session_metadata.doctor_id).toBe('doc-42');
  });

  it('summarizeSync omits top-level doctor_id when doctorId is not provided', async () => {
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.summarizeSync({ text: 'a' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect('doctor_id' in body).toBe(false);
  });

  it('summarizeSync sends top-level translate_to_english:true when translateToEnglish is true', async () => {
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.summarizeSync({ text: 'a', translateToEnglish: true });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.translate_to_english).toBe(true);
  });

  it('summarizeSync omits translate_to_english when translateToEnglish is not provided', async () => {
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.summarizeSync({ text: 'a' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect('translate_to_english' in body).toBe(false);
  });

  it('preSummarize sends top-level doctor_id when doctorId is provided (DNA writing-style)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pre_summary: 'x', structured_data: { title: '', sections: [] }, created_at: 'now' }),
    });
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.preSummarize({ current_department: 'Cardiology', visit_type: 'Follow Up', doctorId: 'doc-42' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.doctor_id).toBe('doc-42');
  });

  it('preSummarize omits top-level doctor_id when doctorId is not provided', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pre_summary: 'x', structured_data: { title: '', sections: [] }, created_at: 'now' }),
    });
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.preSummarize({ current_department: 'Cardiology', visit_type: 'Follow Up' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect('doctor_id' in body).toBe(false);
  });

  it('preSummarize still sends current_department + visit_type (presummary contract unchanged)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pre_summary: 'x', structured_data: { title: '', sections: [] }, created_at: 'now' }),
    });
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.preSummarize({ current_department: 'Cardiology', visit_type: 'Follow Up' });
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.current_department).toBe('Cardiology');
    expect(body.visit_type).toBe('Follow Up');
  });

  it('preSummarize POSTs to /api/smr/api/v1/presummary', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pre_summary: 'x', structured_data: { title: '', sections: [] }, created_at: 'now' }),
    });
    const { result } = renderHook(() => useText());
    await act(async () => {
      await result.current.preSummarize({ current_department: 'Cardiology', visit_type: 'Follow Up' });
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.arcaai.com/api/smr/api/v1/presummary');
  });

  it('passes the shim response through unchanged', async () => {
    const payload = { session_id: 's9', summary: { subjective: 'x', objective: '', assessment: '', plan: '' }, created_at: 'now' };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => payload });
    const { result } = renderHook(() => useText());
    let out: unknown;
    await act(async () => {
      out = await result.current.summarizeSync({ text: 'hi' });
    });
    expect(out).toEqual(payload);
  });

  it('throws when the SDK is not initialized (no apiClient)', async () => {
    installClient(null);
    const { result } = renderHook(() => useText());
    await expect(result.current.summarize({ text: 'hi' })).rejects.toThrow(/SDK not initialized/);
  });

  // ---------------------------------------------------------------------
  // summarizeAsync deprecation (i) — the compat gateway
  // has no `summary/async` route (that path exists only on the native
  // consultation controller), so the method must reject BEFORE any network
  // call rather than 404 at fetch time.
  // ---------------------------------------------------------------------

  describe('summarizeAsync (deprecated)', () => {
    it('rejects synchronously-before-network with a descriptive error and issues no fetch', async () => {
      const { result } = renderHook(() => useText());

      await expect(result.current.summarizeAsync({ text: 'hi' })).rejects.toThrow(
        /summarizeAsync is deprecated.*compat gateway has no `summary\/async` route.*(summarizeSync|summarize).*generateSummaryAsync/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fires onError with the same descriptive message and never flips loading to true', async () => {
      const onError = vi.fn();
      const { result } = renderHook(() => useText({ onError }));

      await expect(result.current.summarizeAsync({ text: 'hi' })).rejects.toThrow();

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'ASYNC_SUMMARIZATION_ERROR',
          message: expect.stringMatching(/summarizeAsync is deprecated/),
        }),
      );
      expect(result.current.loading).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // Streaming — `stream:true` + `onDelta`
  // ---------------------------------------------------------------------

  describe('streaming', () => {
    it('summarizeSync({stream:true, onDelta}) parses SSE deltas + terminal result, resolves and fires onComplete', async () => {
      const finalResult = { session_id: 's1', summary: { subjective: 'x', objective: '', assessment: '', plan: '' }, created_at: 'now' };
      fetchMock.mockResolvedValue(
        sseResponse(['event: delta\ndata: {"text":"He"}\n\n', 'event: delta\ndata: {"text":"llo"}\n\n', `event: result\ndata: ${JSON.stringify(finalResult)}\n\n`]),
      );

      const onDelta = vi.fn();
      const onComplete = vi.fn();
      const { result } = renderHook(() => useText({ onComplete }));

      let out: unknown;
      await act(async () => {
        out = await result.current.summarizeSync({ text: 'hi', stream: true, onDelta });
      });

      expect(onDelta).toHaveBeenNthCalledWith(1, 'He', 'He');
      expect(onDelta).toHaveBeenNthCalledWith(2, 'llo', 'Hello');
      expect(out).toEqual(finalResult);
      expect(onComplete).toHaveBeenCalledWith(finalResult);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.arcaai.com/api/smr/api/v1/summary/sync');
      expect(init.headers['accept']).toBe('text/event-stream');
      const body = JSON.parse(init.body);
      expect(body.stream).toBe(true);
      expect('onDelta' in body).toBe(false);
    });

    it('preSummarize({stream:true, onDelta}) parses SSE deltas + terminal result for PreSummaryResponse', async () => {
      const finalResult = { pre_summary: 'x', structured_data: { title: '', sections: [] }, created_at: 'now' };
      fetchMock.mockResolvedValue(sseResponse(['event: delta\ndata: {"text":"## Pre"}\n\n', `event: result\ndata: ${JSON.stringify(finalResult)}\n\n`]));

      const onDelta = vi.fn();
      const { result } = renderHook(() => useText());

      let out: unknown;
      await act(async () => {
        out = await result.current.preSummarize({ current_department: 'Cardiology', visit_type: 'Follow Up', stream: true, onDelta });
      });

      expect(onDelta).toHaveBeenCalledWith('## Pre', '## Pre');
      expect(out).toEqual(finalResult);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.arcaai.com/api/smr/api/v1/presummary');
      expect(init.headers['accept']).toBe('text/event-stream');
      const body = JSON.parse(init.body);
      expect(body.stream).toBe(true);
      expect('onDelta' in body).toBe(false);
    });

    it('rejects with the detail message and fires onError on an SSE error event', async () => {
      fetchMock.mockResolvedValue(sseResponse(['event: error\ndata: {"detail":"SMR unavailable"}\n\n']));

      const onError = vi.fn();
      const { result } = renderHook(() => useText({ onError }));

      await expect(result.current.summarizeSync({ text: 'hi', stream: true })).rejects.toThrow(/SMR unavailable/);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('SMR unavailable') }));
    });

    it('stream omitted stays on the unchanged JSON path — no Accept: text/event-stream header (regression)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ session_id: 's1', summary: {}, created_at: 'now' }),
      });
      const { result } = renderHook(() => useText());
      await act(async () => {
        await result.current.summarizeSync({ text: 'hi' });
      });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers['accept']).toBeUndefined();
      const body = JSON.parse(init.body);
      expect('stream' in body).toBe(false);
    });
  });
});
