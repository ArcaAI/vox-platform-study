/**
 * useAdminConsultations Hook Tests
 *
 * Tenant-wide consultation supervision binding for TENANT_ADMIN / SUPER_ADMIN.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAdminConsultations } from '../useAdminConsultations';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { ADMIN_CONSULTATION_ENDPOINTS } from '../../core/constants';
import { AgenticError } from '../../types/common';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('useAdminConsultations', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStore: any;
  const mockGet = vi.fn();

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockGet.mockReset();
    mockStore = {
      apiClient: { get: mockGet },
      logger: mockLogger,
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('returns empty consultations and null current', () => {
      const { result } = renderHook(() => useAdminConsultations());
      expect(result.current.consultations).toEqual([]);
      expect(result.current.currentConsultation).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('list', () => {
    it('GETs ADMIN_CONSULTATION_ENDPOINTS.LIST and returns a paginated shape (total, not count)', async () => {
      const data = [{ id: 'c-1' }, { id: 'c-2' }];
      mockGet.mockResolvedValue({ data, count: 2, page: 1, limit: 10 });
      const { result } = renderHook(() => useAdminConsultations());

      let resp: any;
      await act(async () => {
        resp = await result.current.list();
      });

      expect(mockGet).toHaveBeenCalledWith(ADMIN_CONSULTATION_ENDPOINTS.LIST);
      expect(resp.data).toEqual(data);
      expect(resp.total).toBe(2);
      expect(resp).not.toHaveProperty('count');
      expect(result.current.consultations).toEqual(data);
    });

    it('passes page/limit pagination params', async () => {
      mockGet.mockResolvedValue({ data: [], total: 0 });
      const { result } = renderHook(() => useAdminConsultations());

      await act(async () => {
        await result.current.list({ page: 2, limit: 20 });
      });

      expect(mockGet).toHaveBeenCalledWith(`${ADMIN_CONSULTATION_ENDPOINTS.LIST}?page=2&limit=20`);
    });

    it('passes patientId/doctorId/departmentId filters', async () => {
      mockGet.mockResolvedValue({ data: [], total: 0 });
      const { result } = renderHook(() => useAdminConsultations());

      await act(async () => {
        await result.current.list({ patientId: 'p-1', doctorId: 'd-1', departmentId: 'dep-1' });
      });

      const url = mockGet.mock.calls[0][0] as string;
      expect(url).toContain('patientId=p-1');
      expect(url).toContain('doctorId=d-1');
      expect(url).toContain('departmentId=dep-1');
    });

    it('surfaces a server 403 as a clean AgenticError(FORBIDDEN)', async () => {
      mockGet.mockRejectedValue(new AgenticError('FORBIDDEN', 'Forbidden'));
      const { result } = renderHook(() => useAdminConsultations());

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.list();
        } catch (e) {
          caught = e;
        }
      });

      expect(caught).toBeInstanceOf(AgenticError);
      expect((caught as AgenticError).code).toBe('FORBIDDEN');
      expect(result.current.error).toBeInstanceOf(AgenticError);
      expect((result.current.error as AgenticError).code).toBe('FORBIDDEN');
    });
  });

  describe('get', () => {
    it('GETs ADMIN_CONSULTATION_ENDPOINTS.GET(id) and sets currentConsultation', async () => {
      const cons = { id: 'c-1', patientId: 'p-1' };
      mockGet.mockResolvedValue(cons);
      const { result } = renderHook(() => useAdminConsultations());

      let resp: any;
      await act(async () => {
        resp = await result.current.get('c-1');
      });

      expect(mockGet).toHaveBeenCalledWith(ADMIN_CONSULTATION_ENDPOINTS.GET('c-1'));
      expect(resp).toEqual(cons);
      expect(result.current.currentConsultation).toEqual(cons);
    });
  });

  describe('SDK not initialized', () => {
    it('throws when apiClient is null', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useAdminConsultations());

      await expect(
        act(async () => {
          await result.current.list();
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });
});
