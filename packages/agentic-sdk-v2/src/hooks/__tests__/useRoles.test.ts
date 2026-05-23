/**
 * useRoles Hook Tests (TASK-032 WS-G)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoles, USER_ROLES, type UserRole } from '../useRoles';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { ADMIN_USER_ROLES_ENDPOINTS, ROLE_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useRoles', () => {
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

    afterEach(() => { vi.clearAllMocks(); });

    describe('initial state', () => {
        it('should return empty roles array', () => {
            const { result } = renderHook(() => useRoles());
            expect(result.current.roles).toEqual([]);
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('listRoles', () => {
        it('should GET from ROLE_ENDPOINTS.LIST and update state', async () => {
            const roles = [
                { id: 'r-1', name: 'Admin', description: 'Administrator' },
                { id: 'r-2', name: 'Doctor', description: 'Medical doctor' },
            ];
            mockGet.mockResolvedValue(roles);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.listRoles(); });

            expect(mockGet).toHaveBeenCalledWith(ROLE_ENDPOINTS.LIST);
            expect(result.current.roles).toEqual(roles);
            expect(resp).toEqual(roles);
        });

        it('should set error on failure', async () => {
            mockGet.mockRejectedValue(new Error('Fetch failed'));
            const { result } = renderHook(() => useRoles());

            await act(async () => {
                try { await result.current.listRoles(); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Fetch failed');
        });

        it('should extract array from paginated wrapper response', async () => {
            const roles = [{ id: 'r-1', name: 'Admin', description: 'Administrator' }];
            mockGet.mockResolvedValue({ data: roles, total: 1, page: 1, pageSize: 10 });
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.listRoles(); });

            expect(result.current.roles).toEqual(roles);
            expect(Array.isArray(result.current.roles)).toBe(true);
        });

        it('should return empty array for unexpected listRoles response shape', async () => {
            mockGet.mockResolvedValue({ error: 'forbidden' });
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.listRoles(); });

            expect(result.current.roles).toEqual([]);
        });
    });

    describe('getRole', () => {
        it('should GET from ROLE_ENDPOINTS.GET(id)', async () => {
            const role = { id: 'r-1', name: 'Admin', description: 'Administrator' };
            mockGet.mockResolvedValue(role);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.getRole('r-1'); });

            expect(mockGet).toHaveBeenCalledWith(ROLE_ENDPOINTS.GET('r-1'));
            expect(resp).toEqual(role);
        });
    });

    // -----------------------------------------------------------------------
    // TASK-279 R-05: deprecated aliases now route to ADMIN_USER_ROLES_ENDPOINTS
    // -----------------------------------------------------------------------

    describe('getUserRoles (deprecated alias \u2192 listUserRoleAssignments)', () => {
        it('should GET from ADMIN_USER_ROLES_ENDPOINTS.LIST(userId)', async () => {
            const assignments = [
                { id: 'a-1', userId: 'u-1', roleId: 'r-1', roleName: 'Admin' },
            ];
            mockGet.mockResolvedValue(assignments);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.getUserRoles('u-1'); });

            expect(mockGet).toHaveBeenCalledWith(ADMIN_USER_ROLES_ENDPOINTS.LIST('u-1'));
            expect(mockGet).toHaveBeenCalledWith('/admin/users/u-1/roles');
            expect(resp).toEqual(assignments);
        });

        it('should extract array from paginated wrapper response', async () => {
            const assignments = [
                { id: 'a-1', userId: 'u-1', roleId: 'r-1', roleName: 'Admin' },
            ];
            mockGet.mockResolvedValue({ data: assignments, count: 1 });
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.getUserRoles('u-1'); });

            expect(resp).toEqual(assignments);
            expect(Array.isArray(resp)).toBe(true);
        });

        it('should return empty array for unexpected response shape', async () => {
            mockGet.mockResolvedValue({ error: 'not found' });
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.getUserRoles('u-1'); });

            expect(resp).toEqual([]);
        });
    });

    describe('assignRole (deprecated alias \u2192 assignRoleToUser)', () => {
        it('should POST to ADMIN_USER_ROLES_ENDPOINTS.ASSIGN(userId) with roleId', async () => {
            const assignment = { id: 'a-new', userId: 'u-1', roleId: 'r-1' };
            mockPost.mockResolvedValue(assignment);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.assignRole('u-1', 'r-1'); });

            expect(mockPost).toHaveBeenCalledWith(ADMIN_USER_ROLES_ENDPOINTS.ASSIGN('u-1'), { roleId: 'r-1' });
            expect(mockPost).toHaveBeenCalledWith('/admin/users/u-1/roles', { roleId: 'r-1' });
            expect(resp).toEqual(assignment);
        });

        it('should POST with tenantId when provided (Story #41)', async () => {
            const assignment = { id: 'a-new', userId: 'u-1', roleId: 'r-1', tenantId: 't-1' };
            mockPost.mockResolvedValue(assignment);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.assignRole('u-1', 'r-1', 't-1'); });

            expect(mockPost).toHaveBeenCalledWith(
                ADMIN_USER_ROLES_ENDPOINTS.ASSIGN('u-1'),
                { roleId: 'r-1', tenantId: 't-1' },
            );
            expect(resp).toEqual(assignment);
        });

        it('should POST without tenantId when not provided (Story #41)', async () => {
            mockPost.mockResolvedValue({ id: 'a-2', userId: 'u-1', roleId: 'r-1' });
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.assignRole('u-1', 'r-1'); });

            expect(mockPost).toHaveBeenCalledWith(
                ADMIN_USER_ROLES_ENDPOINTS.ASSIGN('u-1'),
                { roleId: 'r-1' },
            );
        });
    });

    describe('removeRole (deprecated alias \u2192 removeUserRoleAssignment)', () => {
        it('should DELETE from ADMIN_USER_ROLES_ENDPOINTS.REMOVE(userId, assignmentId)', async () => {
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.removeRole('u-1', 'a-9'); });

            expect(mockDelete).toHaveBeenCalledWith(ADMIN_USER_ROLES_ENDPOINTS.REMOVE('u-1', 'a-9'));
            expect(mockDelete).toHaveBeenCalledWith('/admin/users/u-1/roles/a-9');
        });
    });

    // -----------------------------------------------------------------------
    // TASK-279 R-05: new admin user-role assignment surface
    // -----------------------------------------------------------------------

    describe('listUserRoleAssignments (new admin surface)', () => {
        it('should GET from ADMIN_USER_ROLES_ENDPOINTS.LIST(userId)', async () => {
            const assignments = [
                { id: 'a-1', userId: 'u-1', roleId: 'r-1', roleName: 'Admin' },
            ];
            mockGet.mockResolvedValue(assignments);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.listUserRoleAssignments('u-1'); });

            expect(mockGet).toHaveBeenCalledWith('/admin/users/u-1/roles');
            expect(resp).toEqual(assignments);
        });

        it('should extract array from paginated wrapper', async () => {
            const assignments = [{ id: 'a-1', userId: 'u-1', roleId: 'r-1' }];
            mockGet.mockResolvedValue({ data: assignments, count: 1 });
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.listUserRoleAssignments('u-1'); });

            expect(resp).toEqual(assignments);
        });
    });

    describe('assignRoleToUser (new admin surface)', () => {
        it('should POST {roleId} to ADMIN_USER_ROLES_ENDPOINTS.ASSIGN(userId)', async () => {
            const assignment = { id: 'a-new', userId: 'u-1', roleId: 'r-1' };
            mockPost.mockResolvedValue(assignment);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.assignRoleToUser('u-1', 'r-1'); });

            expect(mockPost).toHaveBeenCalledWith('/admin/users/u-1/roles', { roleId: 'r-1' });
            expect(resp).toEqual(assignment);
        });

        it('should POST {roleId, tenantId} when tenantId is provided', async () => {
            mockPost.mockResolvedValue({ id: 'a-2', userId: 'u-1', roleId: 'r-1', tenantId: 't-1' });
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.assignRoleToUser('u-1', 'r-1', 't-1'); });

            expect(mockPost).toHaveBeenCalledWith('/admin/users/u-1/roles', { roleId: 'r-1', tenantId: 't-1' });
        });
    });

    describe('removeUserRoleAssignment (new admin surface)', () => {
        it('should DELETE from /admin/users/:id/roles/:assignmentId', async () => {
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.removeUserRoleAssignment('u-1', 'a-9'); });

            expect(mockDelete).toHaveBeenCalledWith('/admin/users/u-1/roles/a-9');
        });
    });

    describe('deprecation warnings (TASK-279)', () => {
        it('warns exactly once per hook instance for assignRole alias', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockPost.mockResolvedValue({ id: 'a-1', userId: 'u-1', roleId: 'r-1' });
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.assignRole('u-1', 'r-1'); });
            await act(async () => { await result.current.assignRole('u-2', 'r-2'); });
            await act(async () => { await result.current.assignRole('u-3', 'r-3'); });

            const deprecationCalls = warnSpy.mock.calls.filter((args) =>
                typeof args[0] === 'string' && args[0].includes('`assignRole` is deprecated'),
            );
            expect(deprecationCalls).toHaveLength(1);
            warnSpy.mockRestore();
        });

        it('warns exactly once per hook instance for removeRole alias', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.removeRole('u-1', 'a-1'); });
            await act(async () => { await result.current.removeRole('u-2', 'a-2'); });

            const deprecationCalls = warnSpy.mock.calls.filter((args) =>
                typeof args[0] === 'string' && args[0].includes('`removeRole` is deprecated'),
            );
            expect(deprecationCalls).toHaveLength(1);
            warnSpy.mockRestore();
        });

        it('warns exactly once per hook instance for getUserRoles alias', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.getUserRoles('u-1'); });
            await act(async () => { await result.current.getUserRoles('u-2'); });

            const deprecationCalls = warnSpy.mock.calls.filter((args) =>
                typeof args[0] === 'string' && args[0].includes('`getUserRoles` is deprecated'),
            );
            expect(deprecationCalls).toHaveLength(1);
            warnSpy.mockRestore();
        });

        it('does NOT warn when calling the new method names directly', async () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            mockGet.mockResolvedValue([]);
            mockPost.mockResolvedValue({ id: 'a-1', userId: 'u-1', roleId: 'r-1' });
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.listUserRoleAssignments('u-1'); });
            await act(async () => { await result.current.assignRoleToUser('u-1', 'r-1'); });
            await act(async () => { await result.current.removeUserRoleAssignment('u-1', 'a-1'); });

            const deprecationCalls = warnSpy.mock.calls.filter((args) =>
                typeof args[0] === 'string' && args[0].includes('deprecated'),
            );
            expect(deprecationCalls).toHaveLength(0);
            warnSpy.mockRestore();
        });
    });

    describe('createRole', () => {
        it('should POST to ROLE_ENDPOINTS.CREATE with role data', async () => {
            const input = { name: 'NewRole', description: 'A new role' };
            const created = { id: 'r-new', ...input };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.createRole(input); });

            expect(mockPost).toHaveBeenCalledWith(ROLE_ENDPOINTS.CREATE, input);
            expect(resp).toEqual(created);
        });

        it('should add created role to roles array', async () => {
            const existing = [{ id: 'r-1', name: 'Admin' }];
            const created = { id: 'r-new', name: 'NewRole' };
            mockGet.mockResolvedValue(existing);
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.listRoles(); });
            await act(async () => { await result.current.createRole({ name: 'NewRole' }); });

            expect(result.current.roles).toEqual([...existing, created]);
        });
    });

    describe('updateRole', () => {
        it('should PUT to ROLE_ENDPOINTS.UPDATE(id) with data', async () => {
            const updated = { id: 'r-1', name: 'UpdatedRole', description: 'Updated' };
            mockPut.mockResolvedValue(updated);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.updateRole('r-1', { name: 'UpdatedRole' });
            });

            expect(mockPut).toHaveBeenCalledWith(ROLE_ENDPOINTS.UPDATE('r-1'), { name: 'UpdatedRole' });
            expect(resp).toEqual(updated);
        });

        it('should replace matching role in roles array', async () => {
            const initial = [
                { id: 'r-1', name: 'Admin' },
                { id: 'r-2', name: 'Doctor' },
            ];
            const updated = { id: 'r-1', name: 'UpdatedAdmin' };
            mockGet.mockResolvedValue(initial);
            mockPut.mockResolvedValue(updated);
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.listRoles(); });
            await act(async () => { await result.current.updateRole('r-1', { name: 'UpdatedAdmin' }); });

            expect(result.current.roles).toEqual([updated, initial[1]]);
        });
    });

    describe('deleteRole', () => {
        it('should DELETE from ROLE_ENDPOINTS.DELETE(id)', async () => {
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.deleteRole('r-1'); });

            expect(mockDelete).toHaveBeenCalledWith(ROLE_ENDPOINTS.DELETE('r-1'));
        });

        it('should remove role from roles array', async () => {
            const initial = [
                { id: 'r-1', name: 'Admin' },
                { id: 'r-2', name: 'Doctor' },
            ];
            mockGet.mockResolvedValue(initial);
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.listRoles(); });
            await act(async () => { await result.current.deleteRole('r-1'); });

            expect(result.current.roles).toEqual([initial[1]]);
        });
    });

    describe('assignPolicy', () => {
        it('should POST to ROLE_ENDPOINTS.ASSIGN_POLICY(roleId, policyId) with empty body when no priority', async () => {
            const assignment = { roleId: 'r-1', policyId: 'p-1' };
            mockPost.mockResolvedValue(assignment);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.assignPolicy('r-1', 'p-1'); });

            expect(mockPost).toHaveBeenCalledWith(ROLE_ENDPOINTS.ASSIGN_POLICY('r-1', 'p-1'), {});
            expect(resp).toEqual(assignment);
        });

        it('should POST with priority when provided (Story #38)', async () => {
            const assignment = { roleId: 'r-1', policyId: 'p-1', priority: 5 };
            mockPost.mockResolvedValue(assignment);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.assignPolicy('r-1', 'p-1', 5); });

            expect(mockPost).toHaveBeenCalledWith(
                ROLE_ENDPOINTS.ASSIGN_POLICY('r-1', 'p-1'),
                { priority: 5 },
            );
            expect(resp).toEqual(assignment);
        });

        it('should POST with priority=0 when explicitly set to zero (Story #38)', async () => {
            mockPost.mockResolvedValue({ message: 'ok' });
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.assignPolicy('r-1', 'p-1', 0); });

            expect(mockPost).toHaveBeenCalledWith(
                ROLE_ENDPOINTS.ASSIGN_POLICY('r-1', 'p-1'),
                { priority: 0 },
            );
        });

        it('should POST empty body when priority is undefined (Story #38)', async () => {
            mockPost.mockResolvedValue({ message: 'ok' });
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.assignPolicy('r-1', 'p-1', undefined); });

            expect(mockPost).toHaveBeenCalledWith(
                ROLE_ENDPOINTS.ASSIGN_POLICY('r-1', 'p-1'),
                {},
            );
        });
    });

    describe('removePolicy', () => {
        it('should DELETE from ROLE_ENDPOINTS.REMOVE_POLICY(roleId, policyId)', async () => {
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.removePolicy('r-1', 'p-1'); });

            expect(mockDelete).toHaveBeenCalledWith(ROLE_ENDPOINTS.REMOVE_POLICY('r-1', 'p-1'));
        });
    });

    describe('SDK not initialized', () => {
        it('should throw when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useRoles());

            await expect(
                act(async () => { await result.current.listRoles(); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('error clearing', () => {
        it('should clear previous error on success', async () => {
            mockGet.mockRejectedValueOnce(new Error('Fetch failed')).mockResolvedValueOnce([]);
            const { result } = renderHook(() => useRoles());

            await act(async () => {
                try { await result.current.listRoles(); } catch { /* expected */ }
            });
            expect(result.current.error?.message).toBe('Fetch failed');

            await act(async () => { await result.current.listRoles(); });
            expect(result.current.error).toBeNull();
        });
    });

    describe('null logger', () => {
        it('should work correctly when store.logger is null', async () => {
            mockStore.logger = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const roles = [{ id: 'r-1', name: 'Admin' }];
            mockGet.mockResolvedValue(roles);
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.listRoles(); });
            expect(result.current.roles).toEqual(roles);
        });
    });

    describe('createRole with parentRoleId (Story #39)', () => {
        it('should POST parentRoleId when creating a child role', async () => {
            const input = { name: 'ChildRole', description: 'A child role', parentRoleId: 'r-parent' };
            const created = { id: 'r-child', ...input };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.createRole(input); });

            expect(mockPost).toHaveBeenCalledWith(ROLE_ENDPOINTS.CREATE, input);
            expect(resp).toEqual(created);
        });

        it('should POST without parentRoleId when not provided', async () => {
            const input = { name: 'TopLevelRole' };
            const created = { id: 'r-top', ...input };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useRoles());

            await act(async () => { await result.current.createRole(input); });

            expect(mockPost).toHaveBeenCalledWith(ROLE_ENDPOINTS.CREATE, input);
        });
    });

    describe('updateRole with parentRoleId (Story #39)', () => {
        it('should PUT parentRoleId when updating hierarchy', async () => {
            const input = { parentRoleId: 'r-new-parent' };
            const updated = { id: 'r-1', name: 'Admin', parentRoleId: 'r-new-parent' };
            mockPut.mockResolvedValue(updated);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.updateRole('r-1', input); });

            expect(mockPut).toHaveBeenCalledWith(ROLE_ENDPOINTS.UPDATE('r-1'), input);
            expect(resp).toEqual(updated);
        });

        it('should clear parentRoleId by passing null', async () => {
            const input = { parentRoleId: null };
            const updated = { id: 'r-1', name: 'Admin', parentRoleId: null };
            mockPut.mockResolvedValue(updated);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.updateRole('r-1', input as any); });

            expect(mockPut).toHaveBeenCalledWith(ROLE_ENDPOINTS.UPDATE('r-1'), input);
            expect(resp).toEqual(updated);
        });
    });

    describe('getRole returns hierarchy fields (Story #39)', () => {
        it('should return role with parentRoleId and childRoles', async () => {
            const role = {
                id: 'r-1', name: 'Admin', parentRoleId: 'r-parent',
                childRoles: [{ id: 'r-child', name: 'SubAdmin' }],
            };
            mockGet.mockResolvedValue(role);
            const { result } = renderHook(() => useRoles());

            let resp: unknown;
            await act(async () => { resp = await result.current.getRole('r-1'); });

            expect(resp).toEqual(role);
            expect((resp as any).parentRoleId).toBe('r-parent');
            expect((resp as any).childRoles).toHaveLength(1);
        });
    });

    // -----------------------------------------------------------------------
    // TASK-265 W0-10 / GAP-04 — typed USER_ROLES tuple re-export
    // -----------------------------------------------------------------------

    describe('USER_ROLES re-export (TASK-265 W0-10)', () => {
        it('re-exports the role_-prefixed tuple from useRoles module', () => {
            expect(USER_ROLES).toEqual(['role_admin', 'role_doctor', 'role_patient']);
        });

        it('every value is prefixed with role_', () => {
            for (const r of USER_ROLES) expect(r).toMatch(/^role_/);
        });

        it('UserRole type accepts each tuple value at compile-time', () => {
            const admin: UserRole = 'role_admin';
            const doctor: UserRole = 'role_doctor';
            const patient: UserRole = 'role_patient';
            expect([admin, doctor, patient]).toEqual([...USER_ROLES]);
        });
    });
});
