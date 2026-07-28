/**
 * useAuth Hook Tests
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

describe('useAuth', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStore: any;
  const mockGet = vi.fn();
  const mockPost = vi.fn();

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
        getAccessToken: vi.fn(),
        updateApiKey: vi.fn(),
        clearApiKey: vi.fn(),
        getApiKey: vi.fn(),
        getBaseUrl: vi.fn().mockReturnValue('https://api.example.com'),
        postFormData: vi.fn(),
        // AgenticClient impersonation API
        startImpersonation: vi.fn(),
        stopImpersonation: vi.fn(),
        isImpersonating: vi.fn().mockReturnValue(false),
        // AgenticClient in-memory refresh-token API
        setRefreshToken: vi.fn(),
        getRefreshToken: vi.fn(),
        hasRefreshToken: vi.fn().mockReturnValue(false),
        clearRefreshToken: vi.fn(),
      },
      logger: mockLogger,
      authUser: null as unknown,
      authIsAuthenticated: false,
      authImpersonatedUser: null as unknown,
      // NOTE: `authOriginalToken` removed. Admin JWT lives in AgenticClient.
      authOriginalUser: null as unknown,
      setAuthUser: vi.fn((user: unknown) => {
        mockStore.authUser = user;
      }),
      setIsAuthenticated: vi.fn((val: boolean) => {
        mockStore.authIsAuthenticated = val;
      }),
      setImpersonatedUser: vi.fn(),
      setOriginalUser: vi.fn(),
    };
    (useAgenticStore as any).mockImplementation(() => mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should return null user and not authenticated', () => {
      const { result } = renderHook(() => useAuth());
      expect(result.current.user).toBeNull();
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  describe('login', () => {
    it('should POST to AUTH_ENDPOINTS.LOGIN and update state', async () => {
      const loginResponse = {
        user: { id: 'u-1', username: 'doctor1', email: 'doc@example.com', roles: ['doctor'], permissions: ['read'] },
        token: 'jwt-token-123',
        refreshToken: 'refresh-token-456',
      };
      mockPost.mockResolvedValue(loginResponse);
      const { result } = renderHook(() => useAuth());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.login('doctor1', 'password123');
      });

      expect(mockPost).toHaveBeenCalledWith(AUTH_ENDPOINTS.LOGIN, { username: 'doctor1', password: 'password123' });
      expect(mockStore.setAuthUser).toHaveBeenCalledWith(loginResponse.user);
      expect(mockStore.setIsAuthenticated).toHaveBeenCalledWith(true);
      expect(resp).toEqual(loginResponse);
    });

    it('should set error on login failure', async () => {
      mockPost.mockRejectedValue(new Error('Invalid credentials'));
      const { result } = renderHook(() => useAuth());

      await act(async () => {
        try {
          await result.current.login('bad', 'creds');
        } catch {
          /* expected */
        }
      });

      expect(result.current.error?.message).toBe('Invalid credentials');
      expect(result.current.isAuthenticated).toBe(false);
      expect(result.current.isLoading).toBe(false);
    });

    it('should throw when apiClient is null', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useAuth());

      await expect(
        act(async () => {
          await result.current.login('user', 'pass');
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });

  describe('logout', () => {
    it('should POST to AUTH_ENDPOINTS.LOGOUT and clear state', async () => {
      const loginResponse = {
        user: { id: 'u-1', username: 'doctor1', email: 'doc@example.com', roles: ['doctor'], permissions: [] },
        token: 'jwt-token-123',
        refreshToken: 'refresh-token-456',
      };
      mockPost.mockResolvedValueOnce(loginResponse).mockResolvedValueOnce({ success: true, message: 'Logged out' });
      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.login('doctor1', 'pass');
      });
      expect(mockStore.setIsAuthenticated).toHaveBeenCalledWith(true);

      await act(async () => {
        await result.current.logout();
      });

      expect(mockPost).toHaveBeenCalledWith(AUTH_ENDPOINTS.LOGOUT, {});
      expect(mockStore.setAuthUser).toHaveBeenCalledWith(null);
      expect(mockStore.setIsAuthenticated).toHaveBeenCalledWith(false);
    });

    it('should throw when apiClient is null', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useAuth());

      await expect(
        act(async () => {
          await result.current.logout();
        }),
      ).rejects.toThrow('SDK not initialized');
    });

    it('should set error on logout failure', async () => {
      mockPost.mockRejectedValue(new Error('Logout failed'));
      const { result } = renderHook(() => useAuth());

      await act(async () => {
        try {
          await result.current.logout();
        } catch {
          /* expected */
        }
      });

      expect(result.current.error?.message).toBe('Logout failed');
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('getMe', () => {
    it('should GET from AUTH_ENDPOINTS.ME and update user state', async () => {
      const meResponse = { id: 'u-1', username: 'doctor1', email: 'doc@example.com', roles: ['doctor'], permissions: ['read'] };
      mockGet.mockResolvedValue(meResponse);
      const { result } = renderHook(() => useAuth());

      let resp: unknown;
      await act(async () => {
        resp = await result.current.getMe();
      });

      expect(mockGet).toHaveBeenCalledWith(AUTH_ENDPOINTS.ME);
      expect(mockStore.setAuthUser).toHaveBeenCalledWith(meResponse);
      expect(mockStore.setIsAuthenticated).toHaveBeenCalledWith(true);
      expect(resp).toEqual(meResponse);
    });

    it('should set error on failure', async () => {
      mockGet.mockRejectedValue(new Error('Unauthorized'));
      const { result } = renderHook(() => useAuth());

      await act(async () => {
        try {
          await result.current.getMe();
        } catch {
          /* expected */
        }
      });

      expect(result.current.error?.message).toBe('Unauthorized');
      expect(result.current.isLoading).toBe(false);
    });

    it('should throw when apiClient is null', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);
      const { result } = renderHook(() => useAuth());

      await expect(
        act(async () => {
          await result.current.getMe();
        }),
      ).rejects.toThrow('SDK not initialized');
    });
  });

  describe('error clearing', () => {
    it('should clear error on subsequent success', async () => {
      const meResponse = { id: 'u-1', username: 'doctor1', email: 'doc@example.com', roles: ['doctor'], permissions: [] };
      mockGet.mockRejectedValueOnce(new Error('First failed')).mockResolvedValueOnce(meResponse);
      const { result } = renderHook(() => useAuth());

      await act(async () => {
        try {
          await result.current.getMe();
        } catch {
          /* expected */
        }
      });
      expect(result.current.error?.message).toBe('First failed');

      await act(async () => {
        await result.current.getMe();
      });
      expect(result.current.error).toBeNull();
      expect(result.current.user).toEqual(meResponse);
    });
  });

  describe('null logger', () => {
    it('should work when store.logger is null', async () => {
      mockStore.logger = null;
      const loginResponse = {
        user: { id: 'u-1', username: 'doc', email: 'doc@example.com', roles: [], permissions: [] },
        token: 'tok',
        refreshToken: 'ref',
      };
      mockPost.mockResolvedValue(loginResponse);
      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.login('doc', 'pass');
      });
      expect(mockStore.setAuthUser).toHaveBeenCalledWith(loginResponse.user);
    });
  });

  // =========================================================================
  // Login should store JWT token and configure apiClient
  // =========================================================================

  describe('login should configure apiClient with JWT token', () => {
    it('should call apiClient.updateAccessToken with the JWT token after successful login', async () => {
      const mockUpdateAccessToken = vi.fn();
      mockStore.apiClient.updateAccessToken = mockUpdateAccessToken;
      (useAgenticStore as any).mockReturnValue(mockStore);

      const loginResponse = {
        user: { id: 'u-1', username: 'doc', email: 'doc@example.com', roles: ['doctor'], permissions: [] },
        token: 'jwt-token-abc123',
        refreshToken: 'refresh-xyz',
      };
      mockPost.mockResolvedValue(loginResponse);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.login('doc', 'pass');
      });

      expect(mockUpdateAccessToken).toHaveBeenCalledWith('jwt-token-abc123');
    });

    it('should NOT call updateAccessToken when login fails', async () => {
      const mockUpdateAccessToken = vi.fn();
      mockStore.apiClient.updateAccessToken = mockUpdateAccessToken;
      (useAgenticStore as any).mockReturnValue(mockStore);

      mockPost.mockRejectedValue(new Error('Invalid credentials'));

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        try {
          await result.current.login('bad', 'creds');
        } catch {}
      });

      expect(mockUpdateAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('logout should clear access token', () => {
    it('should call apiClient.clearAccessToken on logout', async () => {
      const mockClearAccessToken = vi.fn();
      mockStore.apiClient.clearAccessToken = mockClearAccessToken;
      (useAgenticStore as any).mockReturnValue(mockStore);

      mockPost.mockResolvedValue({});

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.logout();
      });

      expect(mockClearAccessToken).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Login captures the refresh token in AgenticClient memory so
  // the auto-refresh handler can use it; logout clears it.
  // =========================================================================

  describe('in-memory refresh-token capture', () => {
    it('should stash the refresh token via apiClient.setRefreshToken after login', async () => {
      const loginResponse = {
        user: { id: 'u-1', username: 'doc', email: 'doc@e.com', roles: ['doctor'], permissions: [] },
        token: 'jwt-token-abc123',
        refreshToken: 'refresh-xyz-789',
      };
      mockPost.mockResolvedValue(loginResponse);

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.login('doc', 'pass');
      });

      expect(mockStore.apiClient.setRefreshToken).toHaveBeenCalledWith('refresh-xyz-789');
    });

    it('should NOT stash a refresh token when the login response omits it', async () => {
      const loginResponse = {
        user: { id: 'u-1', username: 'doc', email: 'doc@e.com', roles: ['doctor'], permissions: [] },
        token: 'jwt-token-abc123',
      };
      mockPost.mockResolvedValue(loginResponse);

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.login('doc', 'pass');
      });

      expect(mockStore.apiClient.setRefreshToken).not.toHaveBeenCalled();
    });

    it('should clear the in-memory refresh token on logout', async () => {
      mockPost.mockResolvedValue({ success: true, message: 'Logged out' });

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.logout();
      });

      expect(mockStore.apiClient.clearRefreshToken).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Token-absent edge cases
  // =========================================================================

  describe('login response without token', () => {
    it('should NOT call updateAccessToken when login response has no token field', async () => {
      const mockUpdateAccessToken = vi.fn();
      mockStore.apiClient.updateAccessToken = mockUpdateAccessToken;
      (useAgenticStore as any).mockReturnValue(mockStore);

      const loginResponse = {
        user: { id: 'u-1', username: 'doc', email: 'doc@e.com', roles: ['doctor'], permissions: [] },
      };
      mockPost.mockResolvedValue(loginResponse);

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.login('doc', 'pass');
      });

      expect(mockUpdateAccessToken).not.toHaveBeenCalled();
      expect(mockStore.setAuthUser).toHaveBeenCalledWith(loginResponse.user);
      expect(mockStore.setIsAuthenticated).toHaveBeenCalledWith(true);
    });

    it('should NOT call updateAccessToken when login response token is empty string', async () => {
      const mockUpdateAccessToken = vi.fn();
      mockStore.apiClient.updateAccessToken = mockUpdateAccessToken;
      (useAgenticStore as any).mockReturnValue(mockStore);

      mockPost.mockResolvedValue({
        user: { id: 'u-1', username: 'doc', email: 'doc@e.com', roles: [], permissions: [] },
        token: '',
      });

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.login('doc', 'pass');
      });

      expect(mockUpdateAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('impersonate response without token', () => {
    it('should NOT call updateAccessToken when impersonate response has no token', async () => {
      const mockUpdateAccessToken = vi.fn();
      mockStore.apiClient.getAccessToken = vi.fn().mockReturnValue('admin-jwt');
      mockStore.apiClient.updateAccessToken = mockUpdateAccessToken;
      (useAgenticStore as any).mockReturnValue(mockStore);

      mockPost.mockResolvedValue({
        user: { id: 'u-target', username: 'target', email: 't@e.com', roles: ['doctor'], permissions: [] },
      });

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.impersonate('u-target');
      });

      expect(mockUpdateAccessToken).not.toHaveBeenCalled();
      expect(mockStore.setImpersonatedUser).toHaveBeenCalled();
    });
  });

  describe('+ : endImpersonation with no stashed admin token', () => {
    it('should NOT call updateAccessToken when stopImpersonation returns undefined', async () => {
      const mockUpdateAccessToken = vi.fn();
      mockStore.apiClient.updateAccessToken = mockUpdateAccessToken;
      mockStore.apiClient.stopImpersonation = vi.fn().mockReturnValue(undefined);
      mockPost.mockResolvedValue({ success: true });
      (useAgenticStore as any).mockReturnValue(mockStore);

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.endImpersonation();
      });

      expect(mockUpdateAccessToken).not.toHaveBeenCalled();
      expect(mockStore.setImpersonatedUser).toHaveBeenCalledWith(null);
      expect(mockStore.setOriginalUser).toHaveBeenCalledWith(null);
      // Token removed from store, must come from client
      expect(mockStore.apiClient.stopImpersonation).toHaveBeenCalled();
    });

    it('should silently no-op when apiClient is null', async () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.endImpersonation();
      });
    });
  });

  // =========================================================================
  // Impersonation uses accessToken channel
  // =========================================================================

  describe('+ : impersonation uses AgenticClient internal stash', () => {
    it('should save current accessToken via apiClient.startImpersonation before impersonating', async () => {
      const mockGetAccessToken = vi.fn().mockReturnValue('original-admin-jwt');
      const mockStart = vi.fn();
      mockStore.apiClient.getAccessToken = mockGetAccessToken;
      mockStore.apiClient.startImpersonation = mockStart;
      (useAgenticStore as any).mockReturnValue(mockStore);

      mockPost.mockResolvedValue({
        user: { id: 'u-target', username: 'target', email: 't@e.com', roles: ['doctor'], permissions: [] },
        token: 'impersonated-jwt',
      });

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.impersonate('u-target');
      });

      expect(mockGetAccessToken).toHaveBeenCalled();
      expect(mockStart).toHaveBeenCalledWith('original-admin-jwt');
    });

    it('should update accessToken with impersonated token', async () => {
      const mockUpdateAccessToken = vi.fn();
      mockStore.apiClient.getAccessToken = vi.fn().mockReturnValue('admin-jwt');
      mockStore.apiClient.updateAccessToken = mockUpdateAccessToken;
      (useAgenticStore as any).mockReturnValue(mockStore);

      mockPost.mockResolvedValue({
        user: { id: 'u-target', username: 'target', email: 't@e.com', roles: ['doctor'], permissions: [] },
        token: 'impersonated-jwt',
      });

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.impersonate('u-target');
      });

      expect(mockUpdateAccessToken).toHaveBeenCalledWith('impersonated-jwt');
    });

    it('should restore original accessToken (from apiClient.stopImpersonation) when ending impersonation', async () => {
      const mockUpdateAccessToken = vi.fn();
      const mockStop = vi.fn().mockReturnValue('original-admin-jwt');
      mockStore.apiClient.updateAccessToken = mockUpdateAccessToken;
      mockStore.apiClient.stopImpersonation = mockStop;
      mockPost.mockResolvedValue({ success: true });
      (useAgenticStore as any).mockReturnValue(mockStore);

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.endImpersonation();
      });

      expect(mockStop).toHaveBeenCalled();
      expect(mockUpdateAccessToken).toHaveBeenCalledWith('original-admin-jwt');
    });

    it('should NOT call startImpersonation when getAccessToken returns undefined', async () => {
      const mockStart = vi.fn();
      mockStore.apiClient.getAccessToken = vi.fn().mockReturnValue(undefined);
      mockStore.apiClient.startImpersonation = mockStart;
      (useAgenticStore as any).mockReturnValue(mockStore);

      mockPost.mockResolvedValue({
        user: { id: 'u-target', username: 'target', email: 't@e.com', roles: ['doctor'], permissions: [] },
        token: 'impersonated-jwt',
      });

      const { result } = renderHook(() => useAuth());
      await act(async () => {
        await result.current.impersonate('u-target');
      });

      // No token to stash → no call.
      expect(mockStart).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Low-level startImpersonation / stopImpersonation helpers
  // =========================================================================

  describe('low-level impersonation helpers', () => {
    it('exposes startImpersonation that proxies to apiClient', () => {
      const mockStart = vi.fn();
      mockStore.apiClient.startImpersonation = mockStart;
      (useAgenticStore as any).mockReturnValue(mockStore);

      const { result } = renderHook(() => useAuth());
      result.current.startImpersonation('admin-jwt');

      expect(mockStart).toHaveBeenCalledWith('admin-jwt');
    });

    it('exposes stopImpersonation that proxies to apiClient', () => {
      const mockStop = vi.fn();
      mockStore.apiClient.stopImpersonation = mockStop;
      (useAgenticStore as any).mockReturnValue(mockStore);

      const { result } = renderHook(() => useAuth());
      result.current.stopImpersonation();

      expect(mockStop).toHaveBeenCalled();
    });

    it('startImpersonation throws when apiClient is null', () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);

      const { result } = renderHook(() => useAuth());
      expect(() => result.current.startImpersonation('jwt')).toThrow('SDK not initialized');
    });

    it('stopImpersonation is a silent no-op when apiClient is null', () => {
      mockStore.apiClient = null;
      (useAgenticStore as any).mockReturnValue(mockStore);

      const { result } = renderHook(() => useAuth());
      expect(() => result.current.stopImpersonation()).not.toThrow();
    });

    it('isImpersonating returns true when apiClient.isImpersonating() returns true', () => {
      mockStore.apiClient.isImpersonating = vi.fn().mockReturnValue(true);
      (useAgenticStore as any).mockReturnValue(mockStore);

      const { result } = renderHook(() => useAuth());
      expect(result.current.isImpersonating).toBe(true);
    });
  });

  // =========================================================================
  // REFACTOR-03: Auth state should be in Zustand store
  // =========================================================================

  describe('REFACTOR-03: auth state in store', () => {
    it('login should call store.setAuthUser and store.setIsAuthenticated', async () => {
      const setAuthUser = vi.fn();
      const setIsAuthenticated = vi.fn();
      mockStore.setAuthUser = setAuthUser;
      mockStore.setIsAuthenticated = setIsAuthenticated;
      (useAgenticStore as any).mockReturnValue(mockStore);

      mockPost.mockResolvedValue({ token: 'jwt-123', user: { id: 'u1', name: 'Test' } });

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.login('admin', 'pass');
      });

      expect(setAuthUser).toHaveBeenCalledWith({ id: 'u1', name: 'Test' });
      expect(setIsAuthenticated).toHaveBeenCalledWith(true);
    });

    it('logout should clear auth state in store', async () => {
      const setAuthUser = vi.fn();
      const setIsAuthenticated = vi.fn();
      mockStore.setAuthUser = setAuthUser;
      mockStore.setIsAuthenticated = setIsAuthenticated;
      (useAgenticStore as any).mockReturnValue(mockStore);

      mockPost.mockResolvedValue({});

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.logout();
      });

      expect(setAuthUser).toHaveBeenCalledWith(null);
      expect(setIsAuthenticated).toHaveBeenCalledWith(false);
    });

    it('should read user and isAuthenticated from store', () => {
      mockStore.authUser = { id: 'u1', name: 'Test' };
      mockStore.authIsAuthenticated = true;
      (useAgenticStore as any).mockReturnValue(mockStore);

      const { result } = renderHook(() => useAuth());

      expect(result.current.user).toEqual({ id: 'u1', name: 'Test' });
      expect(result.current.isAuthenticated).toBe(true);
    });
  });
});
