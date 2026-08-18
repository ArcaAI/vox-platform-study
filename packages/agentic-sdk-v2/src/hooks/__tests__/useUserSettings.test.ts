/**
 * useUserSettings Hook Tests
 *
 * Reduced surface — only `list()` and
 * `updateByKey(namespace, key, value)`. The previous CRUD methods (get, create,
 * update by id, getMySettings) targeted routes that do not exist on the API
 * (`UserSettingsController`) and have been removed.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUserSettings } from '../useUserSettings';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { USER_SETTINGS_ENDPOINTS, ADMIN_USER_SETTINGS_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('useUserSettings (reduced surface)', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStore: any;
  const mockGet = vi.fn();
  const mockPatch = vi.fn();

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockGet.mockReset();
    mockPatch.mockReset();

    mockStore = {
      apiClient: { get: mockGet, post: vi.fn(), patch: mockPatch, delete: vi.fn() },
      logger: mockLogger,
    };
    (useAgenticStore as any).mockReturnValue(mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('returns empty settings array', () => {
      const { result } = renderHook(() => useUserSettings());
      expect(result.current.settings).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('list', () => {
    it('GETs from USER_SETTINGS_ENDPOINTS.list and updates state', async () => {
      const data = [{ id: 'us-1', key: 'theme', value: 'dark', userId: 'u-1' }];
      mockGet.mockResolvedValue(data);
      const { result } = renderHook(() => useUserSettings());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.list();
      });

      expect(mockGet).toHaveBeenCalledWith(USER_SETTINGS_ENDPOINTS.list);
      expect(mockGet).toHaveBeenCalledWith('/users/me/settings');
      expect(result.current.settings).toEqual(data);
      expect(resp).toEqual(data);
    });

    it('passes pagination params through the URL', async () => {
      mockGet.mockResolvedValue([]);
      const { result } = renderHook(() => useUserSettings());

      await act(async () => {
        await result.current.list({ page: 1, limit: 5 });
      });

      expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('page=1'));
    });

    it('sets error on failure', async () => {
      mockGet.mockRejectedValue(new Error('Forbidden'));
      const { result } = renderHook(() => useUserSettings());

      await act(async () => {
        try {
          await result.current.list();
        } catch {
          /* expected */
        }
      });

      expect(result.current.error?.message).toBe('Forbidden');
    });

    it('extracts array from paginated wrapper response', async () => {
      const items = [{ id: 'us-1', key: 'theme', value: 'dark', userId: 'u-1' }];
      mockGet.mockResolvedValue({ data: items, count: 1, page: 1, limit: 10 });
      const { result } = renderHook(() => useUserSettings());

      await act(async () => {
        await result.current.list();
      });

      expect(result.current.settings).toEqual(items);
    });

    it('returns empty array for unexpected list response shape', async () => {
      mockGet.mockResolvedValue({ message: 'none' });
      const { result } = renderHook(() => useUserSettings());

      await act(async () => {
        await result.current.list();
      });

      expect(result.current.settings).toEqual([]);
    });
  });

  describe('updateByKey', () => {
    it('PATCHes /users/me/settings/:namespace/:key with the value payload', async () => {
      const updated = { id: 'us-1', namespace: 'display', key: 'theme', value: 'dark' };
      mockPatch.mockResolvedValue(updated);
      const { result } = renderHook(() => useUserSettings());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.updateByKey('display', 'theme', 'dark');
      });

      expect(mockPatch).toHaveBeenCalledWith(USER_SETTINGS_ENDPOINTS.updateByKey('display', 'theme'), { value: 'dark' });
      expect(mockPatch).toHaveBeenCalledWith('/users/me/settings/display/theme', { value: 'dark' });
      expect(resp).toEqual(updated);
    });

    it('passes structured (non-string) values through unchanged', async () => {
      mockPatch.mockResolvedValue({ ok: true });
      const { result } = renderHook(() => useUserSettings());

      await act(async () => {
        await result.current.updateByKey('flags', 'features', { beta: true, level: 3 });
      });

      expect(mockPatch).toHaveBeenCalledWith('/users/me/settings/flags/features', { value: { beta: true, level: 3 } });
    });

    it('encodes special characters in namespace and key', async () => {
      mockPatch.mockResolvedValue({ ok: true });
      const { result } = renderHook(() => useUserSettings());

      await act(async () => {
        await result.current.updateByKey('a/ns', 'k=1', 'v');
      });

      const [endpoint] = mockPatch.mock.calls[0];
      expect(endpoint).toBe('/users/me/settings/a%2Fns/k%3D1');
    });

    it('sets error on failure', async () => {
      mockPatch.mockRejectedValue(new Error('Patch failed'));
      const { result } = renderHook(() => useUserSettings());

      await act(async () => {
        try {
          await result.current.updateByKey('ns', 'k', 'v');
        } catch {
          /* expected */
        }
      });

      expect(result.current.error?.message).toBe('Patch failed');
    });
  });

  // ─── Admin edit ANOTHER user's settings/preferences ───
  // The backend already exposes `GET /admin/users/:id/settings` and
  // `PATCH /admin/users/:id/settings/:namespace/:key` (assertUserInScope).
  // These SDK methods target a specific `userId` so a future admin
  // FE can view/edit another user's preferences.
  describe('admin target-user surface', () => {
    it('listForUser GETs the admin settings route for the target user', async () => {
      const data = [{ id: 'us-9', namespace: 'arcaai-sdk', key: 'theme', value: 'dark', userId: 'u-9' }];
      mockGet.mockResolvedValue(data);
      const { result } = renderHook(() => useUserSettings());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.listForUser('u-9');
      });

      expect(mockGet).toHaveBeenCalledWith(ADMIN_USER_SETTINGS_ENDPOINTS.list('u-9'));
      expect(mockGet).toHaveBeenCalledWith('/admin/users/u-9/settings');
      expect(result.current.settings).toEqual(data);
      expect(resp).toEqual(data);
    });

    it('updateForUser PATCHes the admin settings route with the value payload', async () => {
      const updated = { id: 'us-9', namespace: 'arcaai-sdk', key: 'theme', value: 'light', userId: 'u-9' };
      mockPatch.mockResolvedValue(updated);
      const { result } = renderHook(() => useUserSettings());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.updateForUser('u-9', 'arcaai-sdk', 'theme', 'light');
      });

      expect(mockPatch).toHaveBeenCalledWith(ADMIN_USER_SETTINGS_ENDPOINTS.updateByKey('u-9', 'arcaai-sdk', 'theme'), { value: 'light' });
      expect(mockPatch).toHaveBeenCalledWith('/admin/users/u-9/settings/arcaai-sdk/theme', { value: 'light' });
      expect(resp).toEqual(updated);
    });

    it('updateForUser encodes special characters in userId, namespace and key', async () => {
      mockPatch.mockResolvedValue({ ok: true });
      const { result } = renderHook(() => useUserSettings());

      await act(async () => {
        await result.current.updateForUser('u/9', 'a/ns', 'k=1', 'v');
      });

      const [endpoint] = mockPatch.mock.calls[0];
      expect(endpoint).toBe('/admin/users/u%2F9/settings/a%2Fns/k%3D1');
    });
  });

  describe('removed legacy surface', () => {
    it('does not expose get(id)/create()/update(id)/getMySettings()/mySettings', () => {
      const { result } = renderHook(() => useUserSettings());
      expect((result.current as any).get).toBeUndefined();
      expect((result.current as any).create).toBeUndefined();
      expect((result.current as any).update).toBeUndefined();
      expect((result.current as any).getMySettings).toBeUndefined();
      expect((result.current as any).mySettings).toBeUndefined();
    });

    it('return surface is exactly { settings, isLoading, error, list, updateByKey, listForUser, updateForUser }', () => {
      const { result } = renderHook(() => useUserSettings());
      expect(Object.keys(result.current).sort()).toEqual(
        ['error', 'isLoading', 'list', 'listForUser', 'settings', 'updateByKey', 'updateForUser'].sort(),
      );
    });
  });

  describe('SDK not initialized', () => {
    it('throws when apiClient is null', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useUserSettings());

      await expect(
        act(async () => {
          await result.current.list();
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });

  describe('null logger', () => {
    it('works when store.logger is null', async () => {
      mockStore.logger = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      mockGet.mockResolvedValue([]);
      const { result } = renderHook(() => useUserSettings());

      await act(async () => {
        await result.current.list();
      });
      expect(result.current.settings).toEqual([]);
    });
  });
});
