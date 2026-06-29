import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { STORAGE_KEYS } from '@/lib/constants';

export interface AuthUser {
    id: string;
    email: string;
    username: string;
    roles: string[];
    permissions: string[];
}

interface AuthState {
    accessToken: string;
    refreshToken: string;
    tenantId: string;
    tenantKey: string;
    user: AuthUser | null;
    isAuthenticated: boolean;
}

interface AuthActions {
    setCredentialsAuth: (token: string, user: AuthUser, tenantId: string, tenantKey?: string, refreshToken?: string) => void;
    updateTokens: (accessToken: string, refreshToken?: string) => void;
    setTenant: (tenantId: string, tenantKey?: string) => void;
    logout: () => void;
}

const initialState: AuthState = {
    accessToken: '',
    refreshToken: '',
    tenantId: '',
    tenantKey: '',
    user: null,
    isAuthenticated: false,
};

export const useAuthStore = create<AuthState & AuthActions>()(
    persist(
        (set) => ({
            ...initialState,

            setCredentialsAuth: (token, user, tenantId, tenantKey, refreshToken) =>
                set({
                    accessToken: token,
                    refreshToken: refreshToken ?? '',
                    tenantId,
                    tenantKey: tenantKey ?? '',
                    user,
                    isAuthenticated: true,
                }),

            updateTokens: (accessToken, refreshToken) =>
                set((state) => ({ accessToken, refreshToken: refreshToken ?? state.refreshToken })),

            setTenant: (tenantId, tenantKey) => set({ tenantId, tenantKey: tenantKey ?? tenantId }),

            logout: () => set(initialState),
        }),
        {
            name: STORAGE_KEYS.AUTH,
            // PHI-adjacent surface on shared clinical workstations → sessionStorage
            // so a tab/window close evicts the bearer token (mirrors ui-playground).
            storage: createJSONStorage(() => sessionStorage),
        },
    ),
);
