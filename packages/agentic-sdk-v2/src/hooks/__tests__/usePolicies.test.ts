/**
 * usePolicies Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePolicies } from '../usePolicies';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { POLICY_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('usePolicies', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStore: any;
  const mockGet = vi.fn();
  const mockPost = vi.fn();
  const mockPut = vi.fn();
  const mockDelete = vi.fn();

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockGet.mockReset();
    mockPost.mockReset();
    mockPut.mockReset();
    mockDelete.mockReset();

    mockStore = {
      apiClient: { get: mockGet, post: mockPost, put: mockPut, patch: vi.fn(), delete: mockDelete },
      logger: mockLogger,
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should return empty policies and null currentPolicy', () => {
      const { result } = renderHook(() => usePolicies());
      expect(result.current.policies).toEqual([]);
      expect(result.current.currentPolicy).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('list', () => {
    it('should GET from POLICY_ENDPOINTS.LIST and update state', async () => {
      const policies = [
        { id: 'p-1', name: 'admin-access', scope: 'GLOBAL', rules: [] },
        { id: 'p-2', name: 'tenant-read', scope: 'TENANT', rules: [] },
      ];
      mockGet.mockResolvedValue(policies);
      const { result } = renderHook(() => usePolicies());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.list();
      });

      expect(mockGet).toHaveBeenCalledWith(POLICY_ENDPOINTS.LIST);
      expect(result.current.policies).toEqual(policies);
      expect(resp).toEqual(policies);
    });

    it('should pass pagination params', async () => {
      mockGet.mockResolvedValue([]);
      const { result } = renderHook(() => usePolicies());

      await act(async () => {
        await result.current.list({ page: 2, limit: 10 });
      });

      expect(mockGet).toHaveBeenCalledWith(`${POLICY_ENDPOINTS.LIST}?page=2&limit=10`);
    });
  });

  describe('get', () => {
    it('should GET from POLICY_ENDPOINTS.GET(id) and set currentPolicy', async () => {
      const policy = { id: 'p-1', name: 'admin-access', scope: 'GLOBAL', rules: [{ action: 'manage', subject: 'all' }] };
      mockGet.mockResolvedValue(policy);
      const { result } = renderHook(() => usePolicies());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.get('p-1');
      });

      expect(mockGet).toHaveBeenCalledWith(POLICY_ENDPOINTS.GET('p-1'));
      expect(result.current.currentPolicy).toEqual(policy);
      expect(resp).toEqual(policy);
    });
  });

  describe('create', () => {
    it('should POST to POLICY_ENDPOINTS.CREATE with input data', async () => {
      const input = { name: 'new-policy', rules: [{ action: 'read', subject: 'User' }] };
      const created = { id: 'p-new', ...input, scope: 'TENANT' };
      mockPost.mockResolvedValue(created);
      const { result } = renderHook(() => usePolicies());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.create(input);
      });

      expect(mockPost).toHaveBeenCalledWith(POLICY_ENDPOINTS.CREATE, input);
      expect(resp).toEqual(created);
    });

    it('should add created policy to policies array', async () => {
      const existing = [{ id: 'p-1', name: 'existing' }];
      const created = { id: 'p-new', name: 'new-policy' };
      mockGet.mockResolvedValue(existing);
      mockPost.mockResolvedValue(created);
      const { result } = renderHook(() => usePolicies());

      await act(async () => {
        await result.current.list();
      });
      await act(async () => {
        await result.current.create({ name: 'new-policy', rules: [] });
      });

      expect(result.current.policies).toEqual([...existing, created]);
    });
  });

  describe('update', () => {
    it('should PUT to POLICY_ENDPOINTS.UPDATE(id) with data', async () => {
      const updated = { id: 'p-1', name: 'updated-policy', rules: [] };
      mockPut.mockResolvedValue(updated);
      const { result } = renderHook(() => usePolicies());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.update('p-1', { name: 'updated-policy' });
      });

      expect(mockPut).toHaveBeenCalledWith(POLICY_ENDPOINTS.UPDATE('p-1'), { name: 'updated-policy' });
      expect(resp).toEqual(updated);
    });
  });

  describe('remove', () => {
    it('should DELETE from POLICY_ENDPOINTS.DELETE(id)', async () => {
      mockDelete.mockResolvedValue(undefined);
      const { result } = renderHook(() => usePolicies());

      await act(async () => {
        await result.current.remove('p-1');
      });

      expect(mockDelete).toHaveBeenCalledWith(POLICY_ENDPOINTS.DELETE('p-1'));
    });

    it('should remove policy from policies array', async () => {
      const initial = [
        { id: 'p-1', name: 'policy-a' },
        { id: 'p-2', name: 'policy-b' },
      ];
      mockGet.mockResolvedValue(initial);
      mockDelete.mockResolvedValue(undefined);
      const { result } = renderHook(() => usePolicies());

      await act(async () => {
        await result.current.list();
      });
      await act(async () => {
        await result.current.remove('p-1');
      });

      expect(result.current.policies).toEqual([initial[1]]);
    });

    // Break-glass credentials travel as the DELETE body.
    it('should pass break-glass credentials as the DELETE data option', async () => {
      mockDelete.mockResolvedValue(undefined);
      const { result } = renderHook(() => usePolicies());
      const creds = { password: 'pw', confirmationName: 'policy-a' };

      await act(async () => {
        await result.current.remove('p-1', creds);
      });

      expect(mockDelete).toHaveBeenCalledWith(POLICY_ENDPOINTS.DELETE('p-1'), { data: creds });
    });
  });

  describe('validate', () => {
    it('should POST to POLICY_ENDPOINTS.VALIDATE with input', async () => {
      const input = { name: 'test-policy', rules: [{ action: 'read', subject: 'User' }] };
      const validationResult = { valid: true, errors: [] };
      mockPost.mockResolvedValue(validationResult);
      const { result } = renderHook(() => usePolicies());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.validate(input);
      });

      expect(mockPost).toHaveBeenCalledWith(POLICY_ENDPOINTS.VALIDATE, input);
      expect(resp).toEqual(validationResult);
    });
  });

  describe('SDK not initialized', () => {
    it('should throw when list is called with null apiClient', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => usePolicies());

      await expect(
        act(async () => {
          await result.current.list();
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });

  describe('error clearing', () => {
    it('should clear previous error on success', async () => {
      mockGet.mockRejectedValueOnce(new Error('Fetch failed')).mockResolvedValueOnce([]);
      const { result } = renderHook(() => usePolicies());

      await act(async () => {
        try {
          await result.current.list();
        } catch {
          /* expected */
        }
      });
      expect(result.current.error?.message).toBe('Fetch failed');

      await act(async () => {
        await result.current.list();
      });
      expect(result.current.error).toBeNull();
    });
  });
});
