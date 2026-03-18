/**
 * TASK-224: Auth Security Enhancement Tests
 *
 * Tests for:
 * 1. endImpersonation restores admin user identity
 * 2. Impersonation stores original user in store
 * 3. Token refresh mechanism
 * 4. Token revocation on impersonation end
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuth } from '../useAuth';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { AUTH_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('TASK-224: Auth Security Enhancement', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPost = vi.fn();

    const adminUser = {
        id: 'admin-001',
        username: 'super_admin',
        email: 'admin@arcaai.com',
        roles: ['SUPER_ADMIN'],
        permissions: ['manage:all'],
    };

    const targetUser = {
        id: 'doctor-001',
        username: 'dr_smith',
        email: 'smith@hospital.com',
        roles: ['doctor'],
        permissions: ['read:consultation'],
    };

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockPost.mockReset();

        mockStore = {
            apiClient: {
                get: mockGet,
                post: mockPost,
                patch: vi.fn(),
                delete: vi.fn(),
                updateAccessToken: vi.fn(),
                clearAccessToken: vi.fn(),
                getAccessToken: vi.fn().mockReturnValue('admin-jwt-token'),
                updateApiKey: vi.fn(),
                clearApiKey: vi.fn(),
                getApiKey: vi.fn(),
                getBaseUrl: vi.fn().mockReturnValue('https://api.arcaai.com'),
                postFormData: vi.fn(),
            },
            logger: mockLogger,
            authUser: adminUser,
            authIsAuthenticated: true,
            authImpersonatedUser: null as unknown,
            authOriginalToken: null as string | null,
            authOriginalUser: null as unknown,
            setAuthUser: vi.fn((user: unknown) => { mockStore.authUser = user; }),
            setIsAuthenticated: vi.fn((val: boolean) => { mockStore.authIsAuthenticated = val; }),
            setImpersonatedUser: vi.fn((user: unknown) => { mockStore.authImpersonatedUser = user; }),
            setOriginalToken: vi.fn((token: string | null) => { mockStore.authOriginalToken = token; }),
            setOriginalUser: vi.fn((user: unknown) => { mockStore.authOriginalUser = user; }),
        };
        (useAgenticStore as any).mockImplementation(() => mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    // =========================================================================
    // FIX 1: endImpersonation must restore admin user identity in store
    // =========================================================================

    describe('Fix 1: endImpersonation restores admin user identity', () => {
        it('should call setAuthUser with the original admin user when ending impersonation', async () => {
            mockStore.authOriginalToken = 'admin-jwt-token';
            mockStore.authOriginalUser = adminUser;
            mockPost.mockResolvedValue({ success: true });
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useAuth());
            await act(async () => { await result.current.endImpersonation(); });

            expect(mockStore.setAuthUser).toHaveBeenCalledWith(adminUser);
        });

        it('should NOT call setAuthUser when originalUser is null', async () => {
            mockStore.authOriginalToken = 'admin-jwt-token';
            mockStore.authOriginalUser = null;
            mockPost.mockResolvedValue({ success: true });
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useAuth());
            await act(async () => { await result.current.endImpersonation(); });

            expect(mockStore.setAuthUser).not.toHaveBeenCalled();
        });

        it('should restore both token AND user in correct order', async () => {
            const callOrder: string[] = [];
            mockStore.apiClient.updateAccessToken = vi.fn(() => callOrder.push('updateToken'));
            mockStore.setAuthUser = vi.fn(() => callOrder.push('setUser'));
            mockStore.setImpersonatedUser = vi.fn(() => callOrder.push('clearImpersonated'));
            mockStore.setOriginalToken = vi.fn(() => callOrder.push('clearOriginalToken'));
            mockStore.setOriginalUser = vi.fn(() => callOrder.push('clearOriginalUser'));

            mockStore.authOriginalToken = 'admin-jwt-token';
            mockStore.authOriginalUser = adminUser;
            mockPost.mockResolvedValue({ success: true });
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useAuth());
            await act(async () => { await result.current.endImpersonation(); });

            expect(callOrder).toEqual([
                'updateToken',
                'setUser',
                'clearImpersonated',
                'clearOriginalToken',
                'clearOriginalUser',
            ]);
        });

        it('should log when impersonation session ends', async () => {
            mockStore.authOriginalToken = 'admin-jwt-token';
            mockStore.authOriginalUser = adminUser;
            mockPost.mockResolvedValue({ success: true });
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useAuth());
            await act(async () => { await result.current.endImpersonation(); });

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Impersonation session ended'),
            );
        });
    });

    // =========================================================================
    // FIX 2: impersonate should preserve original user
    // =========================================================================

    describe('Fix 2: impersonate preserves original user', () => {
        it('should save current authUser as originalUser before impersonating', async () => {
            mockPost.mockResolvedValue({
                user: targetUser,
                token: 'impersonated-jwt',
                impersonatedBy: 'admin-001',
            });

            const { result } = renderHook(() => useAuth());
            await act(async () => { await result.current.impersonate('doctor-001'); });

            expect(mockStore.setOriginalUser).toHaveBeenCalledWith(adminUser);
        });

        it('should set impersonatedUser with the target user data', async () => {
            mockPost.mockResolvedValue({
                user: targetUser,
                token: 'impersonated-jwt',
                impersonatedBy: 'admin-001',
            });

            const { result } = renderHook(() => useAuth());
            await act(async () => { await result.current.impersonate('doctor-001'); });

            expect(mockStore.setImpersonatedUser).toHaveBeenCalledWith(targetUser);
        });

        it('should report isImpersonating as true after impersonation starts', async () => {
            mockPost.mockResolvedValue({
                user: targetUser,
                token: 'impersonated-jwt',
                impersonatedBy: 'admin-001',
            });

            mockStore.authImpersonatedUser = targetUser;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useAuth());
            expect(result.current.isImpersonating).toBe(true);
            expect(result.current.impersonatedUser).toEqual(targetUser);
        });
    });

    // =========================================================================
    // FIX 3 test: login should update apiClient accessToken
    // (already tested in useAuth.test.ts BUG-10, repeated here for TASK-224 regression)
    // =========================================================================

    describe('Fix 3: login sets access token on apiClient', () => {
        it('should call updateAccessToken with token from login response', async () => {
            const loginResponse = {
                user: adminUser,
                token: 'fresh-jwt-token',
                refreshToken: 'refresh-abc',
            };
            mockPost.mockResolvedValue(loginResponse);

            const { result } = renderHook(() => useAuth());
            await act(async () => { await result.current.login('super_admin', 'pass'); });

            expect(mockStore.apiClient.updateAccessToken).toHaveBeenCalledWith('fresh-jwt-token');
        });
    });

    // =========================================================================
    // RECOMMENDATION: Token Refresh Mechanism
    // =========================================================================

    describe('Recommendation 1: refreshToken method', () => {
        it('should expose a refreshToken method on the hook return', () => {
            const { result } = renderHook(() => useAuth());
            expect(result.current).toHaveProperty('refreshToken');
            expect(typeof result.current.refreshToken).toBe('function');
        });

        it('should POST to /auth/refresh with the current refresh token', async () => {
            const refreshResponse = {
                token: 'new-access-jwt',
                refreshToken: 'new-refresh-token',
            };
            mockPost.mockResolvedValue(refreshResponse);

            const { result } = renderHook(() => useAuth());
            await act(async () => {
                await result.current.refreshToken('old-refresh-token');
            });

            expect(mockPost).toHaveBeenCalledWith(
                AUTH_ENDPOINTS.REFRESH,
                { refreshToken: 'old-refresh-token' },
            );
        });

        it('should update apiClient accessToken with new token from refresh', async () => {
            mockPost.mockResolvedValue({
                token: 'refreshed-access-jwt',
                refreshToken: 'new-refresh-token',
            });

            const { result } = renderHook(() => useAuth());
            await act(async () => {
                await result.current.refreshToken('old-refresh');
            });

            expect(mockStore.apiClient.updateAccessToken).toHaveBeenCalledWith('refreshed-access-jwt');
        });

        it('should return the new token pair', async () => {
            const refreshResponse = {
                token: 'refreshed-jwt',
                refreshToken: 'new-refresh',
            };
            mockPost.mockResolvedValue(refreshResponse);

            const { result } = renderHook(() => useAuth());
            let response: any;
            await act(async () => {
                response = await result.current.refreshToken('old-refresh');
            });

            expect(response).toEqual(refreshResponse);
        });

        it('should set error on refresh failure', async () => {
            mockPost.mockRejectedValue(new Error('Refresh token expired'));

            const { result } = renderHook(() => useAuth());
            await act(async () => {
                try { await result.current.refreshToken('expired-refresh'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Refresh token expired');
        });

        it('should throw when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useAuth());
            await expect(
                act(async () => { await result.current.refreshToken('some-token'); }),
            ).rejects.toThrow('SDK not initialized');
        });
    });

    // =========================================================================
    // RECOMMENDATION: Token Revocation on Impersonation End
    // =========================================================================

    describe('Recommendation 4: endImpersonation calls revoke endpoint', () => {
        it('should POST to /auth/revoke-impersonation when ending impersonation', async () => {
            mockStore.authOriginalToken = 'admin-jwt-token';
            mockStore.authOriginalUser = adminUser;
            mockPost.mockResolvedValue({ success: true });
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useAuth());
            await act(async () => { await result.current.endImpersonation(); });

            expect(mockPost).toHaveBeenCalledWith(AUTH_ENDPOINTS.REVOKE_IMPERSONATION, {});
        });

        it('should still restore admin state even if revocation fails', async () => {
            mockStore.authOriginalToken = 'admin-jwt-token';
            mockStore.authOriginalUser = adminUser;
            mockPost.mockRejectedValue(new Error('Network error'));
            (useAgenticStore as any).mockReturnValue(mockStore);

            const { result } = renderHook(() => useAuth());
            await act(async () => { await result.current.endImpersonation(); });

            expect(mockStore.apiClient.updateAccessToken).toHaveBeenCalledWith('admin-jwt-token');
            expect(mockStore.setAuthUser).toHaveBeenCalledWith(adminUser);
            expect(mockStore.setImpersonatedUser).toHaveBeenCalledWith(null);
        });
    });
});
