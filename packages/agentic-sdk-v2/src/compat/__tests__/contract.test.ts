/**
 * @vitest-environment jsdom
 *
 * TASK-563 — cross-version SDK contract lock for `@arcaai/vox/compat`.
 *
 * Asserts the compat hook RETURN SHAPES and the v1 TYPE SURFACE still match the
 * frozen contracts in TASK-560 §5.2 / §5.3 / §5.4, so a future v2 change that
 * would silently alter what a migrated v1 app receives fails CI here.
 *
 * Two layers:
 *  - type-level (`expectTypeOf`) — the hook return interfaces expose the v1
 *    members with the v1 signatures;
 *  - runtime — the compat barrel exports the v1 hook names, `mapV2StatusToV1`
 *    honors §5.2, and `useSMR` passes the shim response through UNCHANGED (§5.4).
 */

import { describe, it, expect, beforeEach, vi, expectTypeOf } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Public compat surface (the barrel a migrating app imports).
import * as compat from '../../compat';
import {
  useSMR,
  mapV2StatusToV1,
  type UseArcaSessionManagerReturn,
  type UseArcaSessionManagerProps,
  type UseAudioCaptureReturn,
  type UseArcaSpeechToTextReturn,
  type UseSMRReturn,
  type MedicalSession,
  type SessionStatus,
  type SummaryResponse,
  type PreSummaryResponse,
  type SMRRequest,
  type PreSummaryRequest,
} from '../../compat';
import { useAgenticStore } from '../../store/agenticStore';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

// ===========================================================================
// Runtime: the compat barrel ships the v1 names (TASK-561 §3 / TASK-560 §5).
// ===========================================================================
describe('@arcaai/vox/compat barrel', () => {
  it('exports the five v1 runtime members + the config adapter', () => {
    expect(typeof compat.ArcaCompatProvider).toBe('function');
    expect(typeof compat.mapV1ConfigToAgenticConfig).toBe('function');
    expect(typeof compat.useArcaSessionManager).toBe('function');
    expect(typeof compat.useAudioCapture).toBe('function');
    expect(typeof compat.useArcaSpeechToText).toBe('function');
    expect(typeof compat.useSMR).toBe('function');
    expect(typeof compat.mapV2StatusToV1).toBe('function');
  });
});

// ===========================================================================
// Type-level: §5.2 session hook contract.
// ===========================================================================
describe('useArcaSessionManager return shape (TASK-560 §5.2)', () => {
  it('exposes the v1 session-manager members with v1 signatures', () => {
    expectTypeOf<UseArcaSessionManagerReturn['session']>().toEqualTypeOf<MedicalSession | null>();
    expectTypeOf<UseArcaSessionManagerReturn['isLoading']>().toEqualTypeOf<boolean>();
    expectTypeOf<UseArcaSessionManagerReturn['createSession']>().parameters.toMatchTypeOf<[unknown?]>();
    expectTypeOf<UseArcaSessionManagerReturn['createSession']>().returns.resolves.toEqualTypeOf<MedicalSession>();
    expectTypeOf<UseArcaSessionManagerReturn['startSession']>().returns.resolves.toBeVoid();
    expectTypeOf<UseArcaSessionManagerReturn['pauseSession']>().toBeFunction();
    expectTypeOf<UseArcaSessionManagerReturn['resumeSession']>().toBeFunction();
    expectTypeOf<UseArcaSessionManagerReturn['endSession']>().returns.resolves.toBeVoid();
    expectTypeOf<UseArcaSessionManagerReturn['loadSession']>().returns.resolves.toEqualTypeOf<MedicalSession>();
    expectTypeOf<UseArcaSessionManagerReturn['updateSession']>().toBeFunction();
    expectTypeOf<UseArcaSessionManagerReturn['clearError']>().toBeFunction();
  });

  it('accepts the v1 identity props (doctorId/doctorName/patientId/patientName)', () => {
    expectTypeOf<UseArcaSessionManagerProps>().toMatchTypeOf<{
      doctorId: string;
      doctorName: string;
      patientId: string;
      patientName: string;
    }>();
  });

  it('MedicalSession is the synthesized v1 view (id/status/timestamps/metadata)', () => {
    expectTypeOf<MedicalSession['id']>().toEqualTypeOf<string>();
    expectTypeOf<MedicalSession['status']>().toEqualTypeOf<SessionStatus>();
    expectTypeOf<MedicalSession['startTime']>().toEqualTypeOf<Date>();
    expectTypeOf<MedicalSession['lastActivity']>().toEqualTypeOf<Date>();
    expectTypeOf<MedicalSession>().toHaveProperty('metadata');
  });
});

// ===========================================================================
// Type-level: §5.3 audio + STT hook contracts.
// ===========================================================================
describe('audio + STT hook shapes (TASK-560 §5.3)', () => {
  it('useAudioCapture exposes the v1 capture members', () => {
    expectTypeOf<UseAudioCaptureReturn['isRecording']>().toEqualTypeOf<boolean>();
    expectTypeOf<UseAudioCaptureReturn['startRecording']>().returns.resolves.toBeVoid();
    expectTypeOf<UseAudioCaptureReturn['stopRecording']>().returns.resolves.toBeVoid();
    expectTypeOf<UseAudioCaptureReturn['isReady']>().toEqualTypeOf<boolean>();
    expectTypeOf<UseAudioCaptureReturn>().toHaveProperty('getDeviceStatus');
  });

  it('useArcaSpeechToText keeps sendAudioData(buf, metadata) and the v1 members', () => {
    expectTypeOf<UseArcaSpeechToTextReturn['transcript']>().toEqualTypeOf<string>();
    expectTypeOf<UseArcaSpeechToTextReturn['startTranscription']>().returns.resolves.toBeVoid();
    expectTypeOf<UseArcaSpeechToTextReturn['stopTranscription']>().returns.resolves.toBeVoid();
    // sendAudioData is the metadata sink — still (ArrayBuffer, metadata?) => void.
    expectTypeOf<UseArcaSpeechToTextReturn['sendAudioData']>().parameters.toMatchTypeOf<
      [ArrayBuffer, (Record<string, unknown> | undefined)?]
    >();
    expectTypeOf<UseArcaSpeechToTextReturn['sendAudioData']>().returns.toBeVoid();
  });
});

// ===========================================================================
// Type-level: §5.4 / §5.5 SMR hook contract + v1 response shapes.
// ===========================================================================
describe('useSMR contract + v1 response shapes (TASK-560 §5.4/§5.5)', () => {
  it('exposes summarize/summarizeSync/summarizeAsync/preSummarize', () => {
    expectTypeOf<UseSMRReturn['summarize']>().returns.resolves.toEqualTypeOf<SummaryResponse>();
    expectTypeOf<UseSMRReturn['summarizeSync']>().returns.resolves.toEqualTypeOf<SummaryResponse>();
    expectTypeOf<UseSMRReturn['preSummarize']>().returns.resolves.toEqualTypeOf<PreSummaryResponse>();
    expectTypeOf<UseSMRReturn['loading']>().toEqualTypeOf<boolean>();
  });

  it('SMRRequest carries text + preferred per-turn segments (F2)', () => {
    expectTypeOf<SMRRequest['text']>().toEqualTypeOf<string>();
    expectTypeOf<SMRRequest>().toHaveProperty('segments');
    expectTypeOf<SMRRequest>().toHaveProperty('useEnhancedFormat');
  });

  it('SummaryResponse honors the v1 envelope (session_id/summary/created_at)', () => {
    expectTypeOf<SummaryResponse['session_id']>().toEqualTypeOf<string>();
    expectTypeOf<SummaryResponse['created_at']>().toEqualTypeOf<string>();
    expectTypeOf<SummaryResponse>().toHaveProperty('summary');
    expectTypeOf<SummaryResponse>().toHaveProperty('processing_time_ms');
    expectTypeOf<SummaryResponse>().toHaveProperty('token_usage');
  });

  it('PreSummaryRequest/Response honor §5.5', () => {
    expectTypeOf<PreSummaryRequest>().toHaveProperty('current_department');
    expectTypeOf<PreSummaryResponse['pre_summary']>().toEqualTypeOf<string>();
    expectTypeOf<PreSummaryResponse['structured_data']>().toHaveProperty('sections');
  });
});

// ===========================================================================
// Runtime: §5.2 status mapping.
// ===========================================================================
describe('mapV2StatusToV1 (TASK-560 §5.2)', () => {
  it('maps v2 status onto the v1 SessionStatus enum', () => {
    expect(mapV2StatusToV1('OPEN')).toBe('IDLE');
    expect(mapV2StatusToV1('RECORDING')).toBe('ACTIVE');
    expect(mapV2StatusToV1('CLOSED')).toBe('TERMINATED');
    expect(mapV2StatusToV1('CANCELLED')).toBe('TERMINATED');
    expect(mapV2StatusToV1(undefined)).toBe('IDLE');
  });
});

// ===========================================================================
// Runtime: §5.4 useSMR response pass-through — the shim body is returned
// UNCHANGED to the app (no re-mapping / key-stripping on the SDK side).
// ===========================================================================
describe('useSMR response pass-through (TASK-560 §5.4)', () => {
  const mockClient = {
    getBaseUrl: vi.fn(() => 'https://api.arcaai.com/api/v1'),
    getApiKey: vi.fn(() => 'tenant-key-123'),
  };
  const fetchMock = vi.fn();

  beforeEach(() => {
    (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (selector: (s: { apiClient: unknown }) => unknown) => selector({ apiClient: mockClient }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
  });

  it('returns the exact §5.4 SummaryResponse body the shim sent', async () => {
    // A frozen, schema-complete v1 SummaryResponse envelope.
    const shimBody = {
      session_id: 'sess-1',
      summary: {
        chief_complaint: 'Chest pain',
        symptoms: ['dyspnea'],
        medical_history: 'HTN',
        examination: 'unremarkable',
        assessment: 'stable angina',
        treatment_plan: 'aspirin',
        follow_up: '2 weeks',
        summary: 'Patient with chest pain, likely stable angina.',
      },
      created_at: '2026-07-28T00:00:00.000Z',
      processing_time_ms: 1234,
      token_usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      confidence_score: null,
      metadata: { use_enhanced_format: false, language: 'en' },
    };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => shimBody });

    const { result } = renderHook(() => useSMR());
    let out: SummaryResponse | undefined;
    await act(async () => {
      out = await result.current.summarizeSync({ text: 'Doctor: hi\nPatient: chest pain', useEnhancedFormat: false });
    });

    // Byte-for-byte pass-through: no re-shaping on the SDK side.
    expect(out).toEqual(shimBody);
  });

  it('returns the §5.5 PreSummaryResponse body unchanged', async () => {
    const preBody = {
      pre_summary: '# Pre-Summary of Medical History\n- HTN on lisinopril',
      structured_data: { title: 'Pre-Summary of Medical History', sections: [] },
      created_at: '2026-07-28T00:00:00.000Z',
    };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => preBody });

    const { result } = renderHook(() => useSMR());
    let out: PreSummaryResponse | undefined;
    await act(async () => {
      out = await result.current.preSummarize({ current_department: 'Cardiology' });
    });
    expect(out).toEqual(preBody);
  });
});
