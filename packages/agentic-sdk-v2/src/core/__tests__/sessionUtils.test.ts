/**
 * Session Utilities Tests (REFACTOR-02)
 *
 * Tests for shared session operations extracted from useArca and useArcaSession.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openSessionOperation, loadConsultationOperation, getPatientHistoryOperation } from '../sessionUtils';

const mockApiClient = {
  post: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

const mockStore = {
  setSessionLoading: vi.fn(),
  setSessionError: vi.fn(),
  setConsultation: vi.fn(),
  clearContext: vi.fn(),
  addContextItem: vi.fn(),
};

const mockLogger = {
  startOperation: vi.fn().mockReturnValue({ end: vi.fn(), error: vi.fn() }),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('sessionUtils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('openSessionOperation', () => {
    /**
     * / — department scoping.
     *
     * `OpenConsultationRequest` accepts `departmentId`, and `SummaryService`
     * resolves the department prompt tier off `consultation.departmentId`. The
     * SDK type previously exposed only a `department` name field, which the
     * gateway's `forbidNonWhitelisted` validation pipe REJECTS — so the tier
     * was structurally unreachable through this SDK.
 */
    it('forwards departmentId to the gateway so department scoping can resolve', async () => {
      mockApiClient.post.mockResolvedValue({ id: 'c-9', patientId: 'p-1', doctorId: 'd-1' });

      await openSessionOperation(mockApiClient as any, mockStore as any, mockLogger as any, {
        patientId: 'p-1',
        departmentId: 'dept-cardiology',
      });

      expect(mockApiClient.post).toHaveBeenCalledWith('/consultations/open', {
        patientId: 'p-1',
        departmentId: 'dept-cardiology',
      });
    });

    it('should call OPEN endpoint and update store', async () => {
      const consultation = {
        id: 'c-1',
        patientId: 'p-1',
        doctorId: 'd-1',
        appointmentDate: '2026-02-21',
        isNew: true,
      };
      mockApiClient.post.mockResolvedValue(consultation);

      const result = await openSessionOperation(mockApiClient as any, mockStore as any, mockLogger as any, {
        patientId: 'p-1',
        appointmentDate: '2026-02-21',
      });

      expect(result).toEqual(consultation);
      expect(mockStore.setSessionLoading).toHaveBeenCalledWith(true);
      expect(mockStore.setConsultation).toHaveBeenCalledWith(consultation);
      expect(mockStore.clearContext).toHaveBeenCalled();
      expect(mockStore.setSessionLoading).toHaveBeenCalledWith(false);
    });

    it('should load context items from consultation response', async () => {
      const items = [{ id: 'ci-1', type: 'transcription', content: 'hello' }];
      const consultation = { id: 'c-1', contextItems: items };
      mockApiClient.post.mockResolvedValue(consultation);

      await openSessionOperation(mockApiClient as any, mockStore as any, undefined, { patientId: 'p-1', appointmentDate: '2026-02-21' });

      expect(mockStore.addContextItem).toHaveBeenCalledWith(items[0]);
    });

    it('should set session error on failure', async () => {
      const error = new Error('Network error');
      mockApiClient.post.mockRejectedValue(error);

      await expect(
        openSessionOperation(mockApiClient as any, mockStore as any, undefined, { patientId: 'p-1', appointmentDate: '2026-02-21' }),
      ).rejects.toThrow('Network error');

      expect(mockStore.setSessionError).toHaveBeenCalledWith(error);
      expect(mockStore.setSessionLoading).toHaveBeenCalledWith(false);
    });
  });

  describe('loadConsultationOperation', () => {
    it('should call GET endpoint and update store', async () => {
      const consultation = { id: 'c-1', patientId: 'p-1' };
      mockApiClient.get.mockResolvedValue(consultation);

      const result = await loadConsultationOperation(mockApiClient as any, mockStore as any, mockLogger as any, 'c-1');

      expect(result).toEqual(consultation);
      expect(mockStore.setConsultation).toHaveBeenCalledWith(consultation);
      expect(mockStore.clearContext).toHaveBeenCalled();
    });

    it('should set session error on failure', async () => {
      const error = new Error('Not found');
      mockApiClient.get.mockRejectedValue(error);

      await expect(loadConsultationOperation(mockApiClient as any, mockStore as any, undefined, 'bad-id')).rejects.toThrow('Not found');

      expect(mockStore.setSessionError).toHaveBeenCalledWith(error);
    });
  });

  describe('getPatientHistoryOperation', () => {
    it('should call PATIENT_HISTORY endpoint', async () => {
      const history = [{ id: 'c-1' }, { id: 'c-2' }];
      mockApiClient.get.mockResolvedValue(history);

      const result = await getPatientHistoryOperation(mockApiClient as any, undefined, 'p-1');

      expect(result).toEqual(history);
    });

    it('should append pagination query params', async () => {
      mockApiClient.get.mockResolvedValue([]);

      await getPatientHistoryOperation(mockApiClient as any, undefined, 'p-1', { page: 2, limit: 10 });

      const calledUrl = mockApiClient.get.mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=10');
    });
  });
});
