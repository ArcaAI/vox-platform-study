import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { STORAGE_KEYS } from '@/lib/constants';

type AuthMethod = 'apiKey' | 'credentials' | null;

interface AuthUser {
    id: string;
    email: string;
    username: string;
    roles: string[];
    permissions: string[];
}

interface AuthState {
    authMethod: AuthMethod;
    apiKey: string;
    tenantId: string;
    tenantKey: string;
    tenantName: string;
    accessToken: string;
    refreshToken: string;
    user: AuthUser | null;
    isAuthenticated: boolean;
    impersonatedUser: AuthUser | null;
    impersonationToken: string;
    isImpersonating: boolean;
    originalTenantId: string;
}

interface AuthActions {
    setApiKeyAuth: (apiKey: string, tenantId: string) => void;
    setCredentialsAuth: (token: string, user: AuthUser, tenantId: string, tenantKey?: string, refreshToken?: string) => void;
    updateToken: (token: string) => void;
    updateTokens: (accessToken: string, refreshToken?: string) => void;
    setTenant: (tenantId: string, tenantName?: string) => void;
    /** @deprecated Use setTenant instead — kept for backward compat */
    setTenantKey: (tenantKey: string, tenantName?: string) => void;
    startImpersonation: (user: AuthUser, token: string, tenantId?: string) => void;
    endImpersonation: () => void;
    logout: () => void;
    isSuperAdmin: () => boolean;
}

const initialState: AuthState = {
    authMethod: null,
    apiKey: '',
    tenantId: '',
    tenantKey: '',
    tenantName: '',
    accessToken: '',
    refreshToken: '',
    user: null,
    isAuthenticated: false,
    impersonatedUser: null,
    impersonationToken: '',
    isImpersonating: false,
    originalTenantId: '',
};

export const useAuthStore = create<AuthState & AuthActions>()(
    persist(
        (set) => ({
            ...initialState,

            setApiKeyAuth: (apiKey, tenantId) =>
                set({
                    authMethod: 'apiKey',
                    apiKey,
                    tenantId,
                    tenantKey: '',
                    tenantName: '',
                    accessToken: '',
                    refreshToken: '',
                    user: null,
                    isAuthenticated: true,
                }),

            setCredentialsAuth: (token, user, tenantId, tenantKey, refreshToken) =>
                set({
                    authMethod: 'credentials',
                    apiKey: '',
                    tenantId,
                    tenantKey: tenantKey ?? '',
                    tenantName: '',
                    accessToken: token,
                    refreshToken: refreshToken ?? '',
                    user,
                    isAuthenticated: true,
                }),

            updateToken: (token) => set({ accessToken: token }),

            updateTokens: (accessToken, refreshToken) =>
                set((state) => ({
                    accessToken,
                    refreshToken: refreshToken ?? state.refreshToken,
                })),

            setTenant: (tenantId, tenantName) =>
                set({ tenantId, tenantName: tenantName ?? '' }),

            setTenantKey: (tenantKey, tenantName) =>
                set({ tenantId: tenantKey, tenantKey, tenantName: tenantName ?? '' }),

            startImpersonation: (user, token, tenantId) =>
                set((state) => ({
                    impersonatedUser: user,
                    impersonationToken: token,
                    isImpersonating: true,
                    originalTenantId: state.tenantId,
                    ...(tenantId ? { tenantId } : {}),
                })),

            endImpersonation: () =>
                set((state) => ({
                    impersonatedUser: null,
                    impersonationToken: '',
                    isImpersonating: false,
                    tenantId: state.originalTenantId,
                    originalTenantId: '',
                })),

            logout: () => set(initialState),

            isSuperAdmin: () => {
                const state = useAuthStore.getState();
                return state.user?.roles?.includes('SUPER_ADMIN') ?? false;
            },
        }),
        {
            name: STORAGE_KEYS.AUTH,
            partialize: (state) => ({
                authMethod: state.authMethod,
                apiKey: state.apiKey,
                tenantId: state.tenantId,
                tenantKey: state.tenantKey,
                tenantName: state.tenantName,
                accessToken: state.accessToken,
                refreshToken: state.refreshToken,
                user: state.user,
                isAuthenticated: state.isAuthenticated,
                impersonatedUser: state.impersonatedUser,
                impersonationToken: state.impersonationToken,
                isImpersonating: state.isImpersonating,
                originalTenantId: state.originalTenantId,
            }),
        },
    ),
);
