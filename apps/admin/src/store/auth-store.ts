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

/**
 * TASK-401 — snapshot of the ORIGINAL (super-admin) session captured when an
 * impersonation starts, restored verbatim on exit/expiry.
 */
interface ImpersonationOriginal {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  tenantKey: string;
  user: AuthUser;
  /** Route to land on after exit (the impersonated user's detail page). */
  returnTo: string;
}

export interface ImpersonationState {
  active: boolean;
  /** ISO expiry of the time-boxed impersonation token (drives the banner countdown). */
  expiresAt: string;
  /** Display name of the impersonated user ("Viewing as {name}"). */
  targetName: string;
  original: ImpersonationOriginal | null;
}

/** Payload for {@link AuthActions.startImpersonation} (the admin mint response + returnTo). */
export interface StartImpersonationInput {
  token: string;
  user: AuthUser & { tenantId?: string };
  expiresAt: string;
  returnTo: string;
}

interface AuthState {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  tenantKey: string;
  user: AuthUser | null;
  isAuthenticated: boolean;
  impersonation: ImpersonationState;
}

interface AuthActions {
  setCredentialsAuth: (token: string, user: AuthUser, tenantId: string, tenantKey?: string, refreshToken?: string) => void;
  updateTokens: (accessToken: string, refreshToken?: string) => void;
  setTenant: (tenantId: string, tenantKey?: string) => void;
  /**
   * TASK-401 — swap the active session to the impersonated one while
   * snapshotting the current (original) session for restore. The refresh
   * token is CLEARED during impersonation so the custom auto-refresh no-ops
   * (the impersonation token is non-refreshable by design). Ignored when an
   * impersonation is already active — the original snapshot is never
   * overwritten (the server rejects nesting too).
   */
  startImpersonation: (input: StartImpersonationInput) => void;
  /**
   * TASK-401 — restore the original session. Returns the `returnTo` path the
   * caller should navigate to, or `null` when no impersonation was active.
   */
  endImpersonation: () => string | null;
  logout: () => void;
}

const initialImpersonation: ImpersonationState = {
  active: false,
  expiresAt: '',
  targetName: '',
  original: null,
};

const initialState: AuthState = {
  accessToken: '',
  refreshToken: '',
  tenantId: '',
  tenantKey: '',
  user: null,
  isAuthenticated: false,
  impersonation: initialImpersonation,
};

export const useAuthStore = create<AuthState & AuthActions>()(
  persist(
    (set, get) => ({
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

      updateTokens: (accessToken, refreshToken) => set((state) => ({ accessToken, refreshToken: refreshToken ?? state.refreshToken })),

      setTenant: (tenantId, tenantKey) => set({ tenantId, tenantKey: tenantKey ?? tenantId }),

      startImpersonation: ({ token, user, expiresAt, returnTo }) => {
        const state = get();
        if (state.impersonation.active || !state.user) return;
        set({
          accessToken: token,
          refreshToken: '',
          tenantId: user.tenantId ?? '',
          tenantKey: '',
          user: { id: user.id, email: user.email, username: user.username, roles: user.roles, permissions: user.permissions },
          isAuthenticated: true,
          impersonation: {
            active: true,
            expiresAt,
            targetName: user.username || user.email || user.id,
            original: {
              accessToken: state.accessToken,
              refreshToken: state.refreshToken,
              tenantId: state.tenantId,
              tenantKey: state.tenantKey,
              user: state.user,
              returnTo,
            },
          },
        });
      },

      endImpersonation: () => {
        const { impersonation } = get();
        if (!impersonation.active || !impersonation.original) return null;
        const { returnTo, ...original } = impersonation.original;
        set({
          ...original,
          isAuthenticated: true,
          impersonation: initialImpersonation,
        });
        return returnTo;
      },

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
