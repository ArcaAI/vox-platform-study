/**
 * useUsers Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUsers } from '../useUsers';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { USER_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useUsers', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPost = vi.fn();
    const mockPatch = vi.fn();
    const mockDelete = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockPost.mockReset();
        mockPatch.mockReset();
        mockDelete.mockReset();

        mockStore = {
            apiClient: { get: mockGet, post: mockPost, patch: mockPatch, delete: mockDelete },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    describe('initial state', () => {
        it('should return empty users and null currentUser', () => {
            const { result } = renderHook(() => useUsers());
            expect(result.current.users).toEqual([]);
            expect(result.current.currentUser).toBeNull();
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('list', () => {
        it('should GET from USER_ENDPOINTS.LIST and update state', async () => {
            const users = [
                { id: 'u-1', username: 'john', email: 'john@test.com' },
                { id: 'u-2', username: 'jane', email: 'jane@test.com' },
            ];
            mockGet.mockResolvedValue(users);
            const { result } = renderHook(() => useUsers());

            let resp: unknown;
            await act(async () => { resp = await result.current.list(); });

            expect(mockGet).toHaveBeenCalledWith(USER_ENDPOINTS.LIST);
            expect(result.current.users).toEqual(users);
            expect(resp).toEqual(users);
        });

        it('should pass pagination params as query string', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                await result.current.list({ page: 2, limit: 10 });
            });

            expect(mockGet).toHaveBeenCalledWith(`${USER_ENDPOINTS.LIST}?page=2&limit=10`);
        });

        it('should set error on failure', async () => {
            mockGet.mockRejectedValue(new Error('Fetch failed'));
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Fetch failed');
        });

        it('should handle empty array response', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useUsers());

            let resp: unknown;
            await act(async () => { resp = await result.current.list(); });

            expect(result.current.users).toEqual([]);
            expect(resp).toEqual([]);
        });

        it('should replace users with latest response when called twice', async () => {
            const first = [{ id: 'u-1', username: 'first' }];
            const second = [{ id: 'u-2', username: 'second' }, { id: 'u-3', username: 'third' }];
            mockGet.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
            const { result } = renderHook(() => useUsers());

            await act(async () => { await result.current.list(); });
            expect(result.current.users).toEqual(first);

            await act(async () => { await result.current.list(); });
            expect(result.current.users).toEqual(second);
        });
    });

    describe('get', () => {
        it('should GET from USER_ENDPOINTS.GET(id) and set currentUser', async () => {
            const user = { id: 'u-1', username: 'john', email: 'john@test.com' };
            mockGet.mockResolvedValue(user);
            const { result } = renderHook(() => useUsers());

            let resp: unknown;
            await act(async () => { resp = await result.current.get('u-1'); });

            expect(mockGet).toHaveBeenCalledWith(USER_ENDPOINTS.GET('u-1'));
            expect(result.current.currentUser).toEqual(user);
            expect(resp).toEqual(user);
        });

        it('should update currentUser when called with different ids', async () => {
            const user1 = { id: 'u-1', username: 'john' };
            const user2 = { id: 'u-2', username: 'jane' };
            mockGet.mockResolvedValueOnce(user1).mockResolvedValueOnce(user2);
            const { result } = renderHook(() => useUsers());

            await act(async () => { await result.current.get('u-1'); });
            expect(result.current.currentUser).toEqual(user1);

            await act(async () => { await result.current.get('u-2'); });
            expect(result.current.currentUser).toEqual(user2);
        });

        it('should set error on failure and reset isLoading', async () => {
            mockGet.mockRejectedValue(new Error('Get failed'));
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                try { await result.current.get('u-1'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Get failed');
            expect(result.current.isLoading).toBe(false);
        });
    });

    describe('getByExternalId', () => {
        it('should GET from USER_ENDPOINTS.GET_BY_EXTERNAL(externalId)', async () => {
            const user = { id: 'u-1', username: 'john', externalId: 'ext-123' };
            mockGet.mockResolvedValue(user);
            const { result } = renderHook(() => useUsers());

            let resp: unknown;
            await act(async () => { resp = await result.current.getByExternalId('ext-123'); });

            expect(mockGet).toHaveBeenCalledWith(USER_ENDPOINTS.GET_BY_EXTERNAL('ext-123'));
            expect(resp).toEqual(user);
        });
    });

    describe('create', () => {
        it('should POST to USER_ENDPOINTS.CREATE with input data', async () => {
            const input = { username: 'newuser', email: 'new@test.com', password: 'pass123' };
            const created = { id: 'u-new', ...input };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useUsers());

            let resp: unknown;
            await act(async () => { resp = await result.current.create(input); });

            expect(mockPost).toHaveBeenCalledWith(USER_ENDPOINTS.CREATE, input);
            expect(resp).toEqual(created);
        });

        it('should add created user to users array', async () => {
            const existing = [{ id: 'u-1', username: 'existing' }];
            const created = { id: 'u-new', username: 'newuser' };
            mockGet.mockResolvedValue(existing);
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useUsers());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.create({ username: 'newuser' }); });

            expect(result.current.users).toEqual([...existing, created]);
        });

        it('should set error on failure', async () => {
            mockPost.mockRejectedValue(new Error('Create failed'));
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                try { await result.current.create({ username: 'test' }); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Create failed');
        });
    });

    describe('update', () => {
        it('should PATCH to USER_ENDPOINTS.UPDATE(id) with data', async () => {
            const updated = { id: 'u-1', username: 'john_updated', email: 'john@test.com' };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useUsers());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.update('u-1', { username: 'john_updated' });
            });

            expect(mockPatch).toHaveBeenCalledWith(USER_ENDPOINTS.UPDATE('u-1'), { username: 'john_updated' });
            expect(result.current.currentUser).toEqual(updated);
            expect(resp).toEqual(updated);
        });

        it('should replace matching user in users array', async () => {
            const initial = [
                { id: 'u-1', username: 'john' },
                { id: 'u-2', username: 'jane' },
            ];
            const updated = { id: 'u-1', username: 'john_updated' };
            mockGet.mockResolvedValue(initial);
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useUsers());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.update('u-1', { username: 'john_updated' }); });

            expect(result.current.users).toEqual([updated, initial[1]]);
        });

        it('should set error on failure', async () => {
            mockPatch.mockRejectedValue(new Error('Update failed'));
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                try { await result.current.update('u-1', { username: 'new' }); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Update failed');
        });
    });

    describe('remove', () => {
        it('should DELETE from USER_ENDPOINTS.DELETE(id)', async () => {
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useUsers());

            await act(async () => { await result.current.remove('u-1'); });

            expect(mockDelete).toHaveBeenCalledWith(USER_ENDPOINTS.DELETE('u-1'));
        });

        it('should remove user from users array', async () => {
            const initial = [
                { id: 'u-1', username: 'john' },
                { id: 'u-2', username: 'jane' },
            ];
            mockGet.mockResolvedValue(initial);
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useUsers());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.remove('u-1'); });

            expect(result.current.users).toEqual([initial[1]]);
        });

        it('should set error on failure', async () => {
            mockDelete.mockRejectedValue(new Error('Delete failed'));
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                try { await result.current.remove('u-1'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Delete failed');
        });
    });

    describe('SDK not initialized', () => {
        it('should throw when list is called with null apiClient', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useUsers());

            await expect(
                act(async () => { await result.current.list(); })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should throw when get is called with null apiClient', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useUsers());

            await expect(
                act(async () => { await result.current.get('u-1'); })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should throw when create is called with null apiClient', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useUsers());

            await expect(
                act(async () => { await result.current.create({ username: 'test' }); })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should throw when update is called with null apiClient', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useUsers());

            await expect(
                act(async () => { await result.current.update('u-1', { username: 'new' }); })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should throw when remove is called with null apiClient', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useUsers());

            await expect(
                act(async () => { await result.current.remove('u-1'); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('error clearing', () => {
        it('should clear previous error on success', async () => {
            mockGet.mockRejectedValueOnce(new Error('Fetch failed')).mockResolvedValueOnce([{ id: 'u-1', username: 'user' }]);
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });
            expect(result.current.error?.message).toBe('Fetch failed');

            await act(async () => { await result.current.list(); });
            expect(result.current.error).toBeNull();
        });
    });

    describe('null logger', () => {
        it('should work correctly when store.logger is null', async () => {
            mockStore.logger = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const users = [{ id: 'u-1', username: 'user' }];
            mockGet.mockResolvedValueOnce(users).mockResolvedValueOnce(users[0]);
            mockPatch.mockResolvedValue({ ...users[0], username: 'updated' });
            const { result } = renderHook(() => useUsers());

            await act(async () => { await result.current.list(); });
            expect(result.current.users).toEqual(users);

            await act(async () => { await result.current.get('u-1'); });
            expect(result.current.currentUser).toEqual(users[0]);

            await act(async () => { await result.current.update('u-1', { username: 'updated' }); });
            expect(result.current.currentUser?.username).toBe('updated');
        });
    });

    describe('isLoading resets on error', () => {
        it('should set isLoading to false after a failed call', async () => {
            mockGet.mockRejectedValue(new Error('Fetch failed'));
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });

            expect(result.current.isLoading).toBe(false);
        });
    });

    describe('paginated response handling', () => {
        it('should extract data array from paginated API response', async () => {
            const paginatedResponse = {
                count: 2,
                limit: 10,
                page: 1,
                data: [
                    { id: 'u-1', username: 'john', email: 'john@test.com' },
                    { id: 'u-2', username: 'jane', email: 'jane@test.com' },
                ],
            };
            mockGet.mockResolvedValue(paginatedResponse);
            const { result } = renderHook(() => useUsers());

            await act(async () => { await result.current.list(); });

            expect(Array.isArray(result.current.users)).toBe(true);
            expect(result.current.users).toHaveLength(2);
            expect(result.current.users[0].username).toBe('john');
        });

        it('should ensure users is always an array even with unexpected response', async () => {
            mockGet.mockResolvedValue(null);
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });

            expect(Array.isArray(result.current.users)).toBe(true);
        });

        it('should handle response that is already a plain array', async () => {
            const plainArray = [
                { id: 'u-1', username: 'john' },
                { id: 'u-2', username: 'jane' },
            ];
            mockGet.mockResolvedValue(plainArray);
            const { result } = renderHook(() => useUsers());

            await act(async () => { await result.current.list(); });

            expect(result.current.users).toEqual(plainArray);
        });

        it('should support .filter() on users after paginated list call with pagination params', async () => {
            const paginatedResponse = {
                count: 3,
                limit: 200,
                page: 1,
                data: [
                    { id: 'u-1', username: 'admin', roles: ['GLOBAL_ADMIN'] },
                    { id: 'u-2', username: 'doctor1' },
                    { id: 'u-3', username: 'doctor2' },
                ],
            };
            mockGet.mockResolvedValue(paginatedResponse);
            const { result } = renderHook(() => useUsers());

            await act(async () => { await result.current.list({ page: 1, limit: 200 }); });

            expect(typeof result.current.users.filter).toBe('function');
            const nonAdmin = result.current.users.filter(
                (u: any) => !u.roles?.some((r: string) => r === 'GLOBAL_ADMIN'),
            );
            expect(nonAdmin).toHaveLength(2);
        });
    });

    /* ------------------------------------------------------------------ */
    /*  enable/disable convenience methods            */
    /* ------------------------------------------------------------------ */

    describe('enable', () => {
        it('should PATCH user with resourceStatus ENABLED', async () => {
            const mockPatch = mockStore.apiClient.patch;
            const updated = { id: 'u-1', username: 'test', resourceStatus: 'ENABLED' };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useUsers());

            let resp: unknown;
            await act(async () => { resp = await result.current.enable('u-1'); });

            expect(mockPatch).toHaveBeenCalledWith(
                expect.stringContaining('u-1'),
                expect.objectContaining({ resourceStatus: 'ENABLED' }),
            );
            expect(resp).toEqual(updated);
        });

        it('should update user in array', async () => {
            const mockPatch = mockStore.apiClient.patch;
            const initial = [
                { id: 'u-1', username: 'test', resourceStatus: 'DISABLED' },
                { id: 'u-2', username: 'other', resourceStatus: 'ENABLED' },
            ];
            mockGet.mockResolvedValue(initial);
            mockPatch.mockResolvedValue({ ...initial[0], resourceStatus: 'ENABLED' });
            const { result } = renderHook(() => useUsers());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.enable('u-1'); });

            expect(result.current.users[0].resourceStatus).toBe('ENABLED');
        });
    });

    describe('disable', () => {
        it('should PATCH user with resourceStatus DISABLED', async () => {
            const mockPatch = mockStore.apiClient.patch;
            const updated = { id: 'u-1', username: 'test', resourceStatus: 'DISABLED' };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useUsers());

            let resp: unknown;
            await act(async () => { resp = await result.current.disable('u-1'); });

            expect(mockPatch).toHaveBeenCalledWith(
                expect.stringContaining('u-1'),
                expect.objectContaining({ resourceStatus: 'DISABLED' }),
            );
            expect(resp).toEqual(updated);
        });
    });

    describe('update with resourceStatus', () => {
        it('should accept resourceStatus in update input', async () => {
            const mockPatch = mockStore.apiClient.patch;
            const updated = { id: 'u-1', username: 'renamed', resourceStatus: 'DISABLED' };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                await result.current.update('u-1', {
                    username: 'renamed',
                    resourceStatus: 'DISABLED',
                });
            });

            expect(mockPatch).toHaveBeenCalledWith(
                expect.stringContaining('u-1'),
                { username: 'renamed', resourceStatus: 'DISABLED' },
            );
        });

        it('should accept isServiceAccount in update input', async () => {
            const mockPatch = mockStore.apiClient.patch;
            const updated = { id: 'u-1', username: 'test', isServiceAccount: true };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                await result.current.update('u-1', { isServiceAccount: true });
            });

            expect(mockPatch).toHaveBeenCalledWith(
                expect.stringContaining('u-1'),
                { isServiceAccount: true },
            );
        });
    });
});
