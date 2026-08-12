/**
 * useArcaSession.addContext — schema-aware writes (TASK-665).
 *
 *  - A payload is validated CLIENT-SIDE against the session-pinned schema
 *    bundle before the request is sent; an invalid payload never reaches
 *    `apiClient`.
 *  - An unrecognized `kindKey` (schema not yet loaded, or a kind the tenant
 *    hasn't declared) is NOT a client-side error — forward compatibility:
 *    the write proceeds and the server is the final authority.
 *  - When the session has a pinned `contextSchemaVersionId`, every write
 *    carries it as `X-Context-Schema-Version` via `postWithHeaders`.
 *  - With no pinned schema (the pre-TASK-658 path), `addContext` behaves
 *    byte-identically to before — plain `apiClient.post`, no header.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSession } from '../useArcaSession';
import { useAgenticStore } from '../../store/agenticStore';
import { AgenticClient } from '../../core/AgenticClient';
import { createCrossTabSync } from '../../core/SimpleCrossTabSync';
import { createMockLogger, createMockConsultation, createMockContextItem } from '../../__tests__/setup';
import type { ConsultationSchemaBundle } from '../../types/consultationSchema';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return {
    ...actual,
    useAgenticStore: vi.fn(),
  };
});

vi.mock('../../core/SimpleCrossTabSync', () => ({
  SimpleCrossTabSync: vi.fn(),
  createCrossTabSync: vi.fn(() => ({
    onContextAdded: vi.fn(),
    broadcastContext: vi.fn(),
    close: vi.fn(),
  })),
}));

const PINNED_BUNDLE: ConsultationSchemaBundle = {
  schemaId: 'schema-1',
  slug: 'default',
  name: 'Default',
  versionNumber: 3,
  contextSchemaVersionId: 'version-3',
  checksum: 'abc',
  etag: '"3"',
  definition: {
    schemaVersion: '1.0',
    kinds: [
      {
        key: 'referral_letter',
        label: 'Referral Letter',
        primitive: 'STRUCTURED',
        phiClass: 'PHI',
        cardinality: 'ONE',
        lifecycle: 'ANY',
        producedBy: ['CLIENT'],
        fields: { type: 'object', required: ['severity'], properties: { severity: { type: 'string' } } },
      },
    ],
  },
};

describe('useArcaSession.addContext — schema-aware writes (TASK-665)', () => {
  let mockApiClient: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStore: any;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockApiClient = new AgenticClient({ baseUrl: 'http://test', apiKey: 'key' }, mockLogger);
    vi.spyOn(mockApiClient, 'post').mockResolvedValue(createMockContextItem({ id: 'ctx-1' }));
    vi.spyOn(mockApiClient, 'postWithHeaders').mockResolvedValue(createMockContextItem({ id: 'ctx-2' }));

    mockStore = {
      apiClient: mockApiClient,
      consultation: createMockConsultation({ id: 'consult-1' }),
      contextItems: [],
      sessionLoading: false,
      sessionError: null,
      summaries: [],
      logger: mockLogger,
      consultationSchema: null as ConsultationSchemaBundle | null,
      setConsultation: vi.fn(),
      setSessionLoading: vi.fn(),
      setSessionError: vi.fn(),
      clearContext: vi.fn(),
      addContextItem: vi.fn(),
      setSharedContext: vi.fn(),
      setSummaries: vi.fn(),
      reset: vi.fn(),
    };

    (useAgenticStore as any).mockReturnValue(mockStore);
    (createCrossTabSync as any).mockReturnValue({
      onContextAdded: vi.fn(),
      broadcastContext: vi.fn(),
      close: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('with no pinned schema, behaves exactly as before: plain post, no header (K7-style regression)', async () => {
    mockStore.consultationSchema = null;
    const { result } = renderHook(() => useArcaSession());

    await act(async () => {
      await result.current.addContext({ type: 'CASE_NOTE', content: 'no schema here' });
    });

    expect(mockApiClient.post).toHaveBeenCalledWith('/consultations/consult-1/context', { type: 'CASE_NOTE', content: 'no schema here' });
    expect(mockApiClient.postWithHeaders).not.toHaveBeenCalled();
  });

  it('sends X-Context-Schema-Version when the session has a pinned schema', async () => {
    mockStore.consultationSchema = PINNED_BUNDLE;
    const { result } = renderHook(() => useArcaSession());

    await act(async () => {
      await result.current.addContext({ type: 'STRUCTURED', content: '', kindKey: 'referral_letter', payload: { severity: 'mild' } });
    });

    expect(mockApiClient.postWithHeaders).toHaveBeenCalledWith(
      '/consultations/consult-1/context',
      { type: 'STRUCTURED', content: '', kindKey: 'referral_letter', payload: { severity: 'mild' } },
      { 'X-Context-Schema-Version': 'version-3' },
    );
    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  it('validates a payload client-side and rejects before the request is sent', async () => {
    mockStore.consultationSchema = PINNED_BUNDLE;
    const { result } = renderHook(() => useArcaSession());

    await expect(
      act(async () => {
        await result.current.addContext({ type: 'STRUCTURED', content: '', kindKey: 'referral_letter', payload: {} });
      }),
    ).rejects.toThrow(/failed client-side schema validation/);

    expect(mockApiClient.postWithHeaders).not.toHaveBeenCalled();
    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  it('TDD: an unknown kindKey is ignored gracefully — the write proceeds, not a client-side error', async () => {
    mockStore.consultationSchema = PINNED_BUNDLE;
    const { result } = renderHook(() => useArcaSession());

    await act(async () => {
      await result.current.addContext({ type: 'STRUCTURED', content: '', kindKey: 'not_a_declared_kind', payload: { anything: 'goes' } });
    });

    expect(mockApiClient.postWithHeaders).toHaveBeenCalledWith(
      '/consultations/consult-1/context',
      expect.objectContaining({ kindKey: 'not_a_declared_kind' }),
      { 'X-Context-Schema-Version': 'version-3' },
    );
  });

  it('TDD: the session keeps its pinned version even if the caller re-reads a "newer" bundle object — no implicit re-pin inside addContext', async () => {
    mockStore.consultationSchema = PINNED_BUNDLE;
    const { result, rerender } = renderHook(() => useArcaSession());

    await act(async () => {
      await result.current.addContext({ type: 'CASE_NOTE', content: 'first write' });
    });
    expect(mockApiClient.postWithHeaders).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), { 'X-Context-Schema-Version': 'version-3' });

    // Simulate the tenant having published a NEW version server-side — the
    // hook itself never re-fetches (that is `AgenticProvider`'s job, only on
    // mount/tenant-switch), so unless the store's `consultationSchema` is
    // externally replaced, every write in this session keeps using the
    // version pinned at mount.
    rerender();
    await act(async () => {
      await result.current.addContext({ type: 'CASE_NOTE', content: 'second write, same session' });
    });
    expect(mockApiClient.postWithHeaders).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), { 'X-Context-Schema-Version': 'version-3' });
  });
});
