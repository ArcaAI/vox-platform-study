/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSessionManager, mapV2StatusToV1 } from '../useArcaSessionManager';
import { useArcaSession } from '../../hooks/useArcaSession';

vi.mock('../../hooks/useArcaSession', () => ({
  useArcaSession: vi.fn(),
}));

const mockConsultation = {
  id: 'consultation-1',
  patientId: 'patient-1',
  doctorId: 'doctor-derived-from-auth',
  appointmentDate: '2026-07-27',
  status: 'OPEN' as const,
  metadata: {},
  createdAt: '2026-07-27T10:00:00.000Z',
  updatedAt: '2026-07-27T10:00:00.000Z',
};

function makeSessionMock() {
  return {
    consultation: null as unknown,
    context: [],
    isLoading: false,
    error: null,
    open: vi.fn().mockResolvedValue(mockConsultation),
    close: vi.fn().mockResolvedValue({ ...mockConsultation, status: 'CLOSED' }),
    loadConsultation: vi.fn().mockResolvedValue(mockConsultation),
    update: vi.fn().mockResolvedValue(mockConsultation),
    addContext: vi.fn(),
    getSharedContext: vi.fn(),
    getPatientHistory: vi.fn(),
    loadSummaries: vi.fn(),
    reopen: vi.fn(),
  };
}

const props = {
  doctorId: 'doc-1',
  doctorName: 'Dr. One',
  patientId: 'patient-1',
  patientName: 'Pat One',
};

describe('useArcaSessionManager', () => {
  let sessionMock: ReturnType<typeof makeSessionMock>;

  beforeEach(() => {
    sessionMock = makeSessionMock();
    (useArcaSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(sessionMock);
  });

  it('createSession + startSession collapse onto a SINGLE open()', async () => {
    const { result } = renderHook(() => useArcaSessionManager(props));

    await act(async () => {
      await result.current.createSession();
    });
    // Simulate the store now having the consultation on subsequent renders.
    sessionMock.consultation = mockConsultation;
    await act(async () => {
      await result.current.startSession();
    });

    expect(sessionMock.open).toHaveBeenCalledTimes(1);
  });

  it('does not send doctorId as a top-level open() field (kept in metadata.legacyDoctorId)', async () => {
    const { result } = renderHook(() => useArcaSessionManager(props));
    await act(async () => {
      await result.current.createSession();
    });

    const arg = sessionMock.open.mock.calls[0][0];
    expect(arg).not.toHaveProperty('doctorId');
    expect(arg.patientId).toBe('patient-1');
    expect(arg.metadata.legacyDoctorId).toBe('doc-1');
  });

  it('maps v2 status → v1 status enum', () => {
    expect(mapV2StatusToV1('OPEN')).toBe('IDLE');
    expect(mapV2StatusToV1('RECORDING')).toBe('ACTIVE');
    expect(mapV2StatusToV1('CLOSED')).toBe('TERMINATED');
    expect(mapV2StatusToV1('CANCELLED')).toBe('TERMINATED');
    expect(mapV2StatusToV1(undefined)).toBe('IDLE');
  });

  it('endSession → close()', async () => {
    sessionMock.consultation = mockConsultation;
    const { result } = renderHook(() => useArcaSessionManager(props));
    await act(async () => {
      await result.current.endSession();
    });
    expect(sessionMock.close).toHaveBeenCalledTimes(1);
  });

  it('loadSession → loadConsultation()', async () => {
    const { result } = renderHook(() => useArcaSessionManager(props));
    await act(async () => {
      await result.current.loadSession('consultation-1');
    });
    expect(sessionMock.loadConsultation).toHaveBeenCalledWith('consultation-1');
  });

  it('surfaces a synthesized MedicalSession from the v2 consultation', () => {
    sessionMock.consultation = { ...mockConsultation, status: 'RECORDING' };
    const { result } = renderHook(() => useArcaSessionManager(props));
    expect(result.current.session?.id).toBe('consultation-1');
    expect(result.current.session?.status).toBe('ACTIVE');
  });
});
