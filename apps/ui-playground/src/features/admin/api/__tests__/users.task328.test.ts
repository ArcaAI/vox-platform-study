/**
 * TASK-328 A1–A3 — admin user-detail data layer.
 *
 * Exercises the new admin-api hooks that back the UserDetailDialog sections:
 *  - user profile GET / PATCH (incl. `preferredPromptTemplateId`)
 *  - enrolled voice profiles (read-only)
 *  - user ↔ department assignments (CRUD) with OCC `If-Match` on PATCH
 *
 * Mirrors the harness in `tenants.test.ts`: `adminClient` is mocked so we can
 * assert the exact URL / body / RequestOptions each hook forwards.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

import {
  useAdminUserProfile,
  useUpdateAdminUserProfile,
  useAdminUserVoiceProfiles,
  useAdminUserDepartments,
  useAssignUserDepartment,
  useUpdateUserDepartment,
  useUnassignUserDepartment,
} from '../users';

vi.mock('../admin-client', () => ({
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { adminClient } from '../admin-client';

const mockGet = adminClient.get as ReturnType<typeof vi.fn>;
const mockPost = adminClient.post as ReturnType<typeof vi.fn>;
const mockPatch = adminClient.patch as ReturnType<typeof vi.fn>;
const mockDelete = adminClient.delete as ReturnType<typeof vi.fn>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const USER_ID = 'user-42';

describe('Admin user-detail API hooks (TASK-328 A1–A3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('profile (preferredPromptTemplateId)', () => {
    it('GETs the user profile', async () => {
      mockGet.mockResolvedValueOnce({ id: 'p1', userId: USER_ID, preferredPromptTemplateId: 'tpl-1' });
      const { result } = renderHook(() => useAdminUserProfile(USER_ID), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(`/admin/users/${USER_ID}/profile`);
      expect(result.current.data?.preferredPromptTemplateId).toBe('tpl-1');
    });

    it('does not fetch when userId is empty', async () => {
      const { result } = renderHook(() => useAdminUserProfile(''), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('PATCHes preferredPromptTemplateId', async () => {
      mockPatch.mockResolvedValueOnce({ id: 'p1', userId: USER_ID, preferredPromptTemplateId: 'tpl-9' });
      const { result } = renderHook(() => useUpdateAdminUserProfile(), { wrapper: createWrapper() });

      result.current.mutate({ userId: USER_ID, preferredPromptTemplateId: 'tpl-9' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPatch).toHaveBeenCalledWith(`/admin/users/${USER_ID}/profile`, { preferredPromptTemplateId: 'tpl-9' });
    });
  });

  describe('enrolled voice profiles (read)', () => {
    it('GETs the voice profiles for a user', async () => {
      mockGet.mockResolvedValueOnce([{ id: 'vp1', userId: USER_ID, isActive: true, label: 'Clinic', modelId: null }]);
      const { result } = renderHook(() => useAdminUserVoiceProfiles(USER_ID), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(`/admin/users/${USER_ID}/voice-profiles`);
      expect(result.current.data?.[0].label).toBe('Clinic');
    });
  });

  describe('department assignments (CRUD + OCC)', () => {
    it('GETs the assignments', async () => {
      mockGet.mockResolvedValueOnce([{ id: 'ud1', userId: USER_ID, departmentId: 'd1', isPrimary: true, version: 1 }]);
      const { result } = renderHook(() => useAdminUserDepartments(USER_ID), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(`/admin/users/${USER_ID}/departments`);
      expect(result.current.data?.[0].departmentId).toBe('d1');
    });

    it('POSTs an assignment with isPrimary', async () => {
      mockPost.mockResolvedValueOnce({ id: 'ud2', userId: USER_ID, departmentId: 'd2', isPrimary: true, version: 1 });
      const { result } = renderHook(() => useAssignUserDepartment(USER_ID), { wrapper: createWrapper() });

      result.current.mutate({ departmentId: 'd2', isPrimary: true });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPost).toHaveBeenCalledWith(`/admin/users/${USER_ID}/departments`, { departmentId: 'd2', isPrimary: true });
    });

    it('PATCHes an assignment with an If-Match header (OCC)', async () => {
      mockPatch.mockResolvedValueOnce({ id: 'ud1', userId: USER_ID, departmentId: 'd1', isPrimary: true, version: 4 });
      const { result } = renderHook(() => useUpdateUserDepartment(USER_ID), { wrapper: createWrapper() });

      result.current.mutate({ assignmentId: 'ud1', isPrimary: true, expectedVersion: 3 });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPatch).toHaveBeenCalledWith(`/admin/users/${USER_ID}/departments/ud1`, { isPrimary: true, expectedVersion: 3 }, { ifMatch: '"3"' });
    });

    it('DELETEs an assignment', async () => {
      mockDelete.mockResolvedValueOnce(undefined);
      const { result } = renderHook(() => useUnassignUserDepartment(USER_ID), { wrapper: createWrapper() });

      result.current.mutate('ud1');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockDelete).toHaveBeenCalledWith(`/admin/users/${USER_ID}/departments/ud1`);
    });
  });
});
