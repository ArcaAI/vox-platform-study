import { getApiBaseUrl } from '@/lib/api-config';
import { useAuthStore } from '@/store/auth-store';

const API_BASE_URL = getApiBaseUrl();

/**
 * Custom token auto-refresh (mirrors the ui-playground approach) — TASK-374.
 *
 * The SDK's built-in `autoWireTokenRefresh` keeps the refresh token in an
 * in-memory `WeakMap`, which is lost on a hard reload. The admin auth store
 * persists `refreshToken` in `sessionStorage`, so on a 401 (or proactively
 * before expiry) we refresh against `POST /auth/refresh` using the STORED
 * token and feed the new access token back into the SDK client. This keeps
 * SDK-backed screens alive across reloads without forcing a re-login.
 */

let inflightRefresh: Promise<boolean> | null = null;

type TokenRefreshedListener = (newAccessToken: string) => void;
const tokenRefreshedListeners = new Set<TokenRefreshedListener>();

export function registerOnTokenRefreshed(listener: TokenRefreshedListener): void {
    tokenRefreshedListeners.add(listener);
}

export function unregisterOnTokenRefreshed(listener: TokenRefreshedListener): void {
    tokenRefreshedListeners.delete(listener);
}

/**
 * Decode a JWT and return milliseconds until its `exp` claim.
 * Returns 0 for expired, malformed, or missing-exp tokens.
 */
export function getTokenExpiryMs(token: string): number {
    if (!token) return 0;
    try {
        const parts = token.split('.');
        if (parts.length < 2) return 0;
        const payload = JSON.parse(atob(parts[1]));
        if (typeof payload.exp !== 'number') return 0;
        return Math.max(0, payload.exp * 1000 - Date.now());
    } catch {
        return 0;
    }
}

/**
 * Returns `true` when the token is a structurally valid JWT whose `exp`
 * claim is in the past. Returns `false` for malformed tokens or tokens
 * that are still valid.
 */
export function isTokenExpired(token: string): boolean {
    if (!token) return false;
    try {
        const parts = token.split('.');
        if (parts.length < 2) return false;
        const payload = JSON.parse(atob(parts[1]));
        if (typeof payload.exp !== 'number') return false;
        return payload.exp * 1000 <= Date.now();
    } catch {
        return false;
    }
}

/**
 * Attempt to refresh the access token using the stored refresh token.
 *
 * - Reads the refresh token from the auth store (sessionStorage-backed).
 * - Calls `POST /auth/refresh` directly (no SDK dependency).
 * - Updates `accessToken`/`refreshToken` in the auth store + notifies listeners.
 * - Deduplicates concurrent calls via a single in-flight promise.
 *
 * Returns `true` if refreshed, `false` otherwise. On failure, logs out.
 */
export async function tryRefreshToken(): Promise<boolean> {
    if (inflightRefresh) return inflightRefresh;
    inflightRefresh = doRefresh();
    try {
        return await inflightRefresh;
    } finally {
        inflightRefresh = null;
    }
}

async function doRefresh(): Promise<boolean> {
    const { refreshToken } = useAuthStore.getState();
    if (!refreshToken) return false;

    try {
        const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
        });

        if (!res.ok) {
            useAuthStore.getState().logout();
            return false;
        }

        const data: { token?: string; accessToken?: string; refreshToken?: string } = await res.json();
        const newToken = data.token ?? data.accessToken;
        if (!newToken) {
            useAuthStore.getState().logout();
            return false;
        }
        useAuthStore.getState().updateTokens(newToken, data.refreshToken);
        for (const listener of tokenRefreshedListeners) listener(newToken);
        return true;
    } catch {
        useAuthStore.getState().logout();
        return false;
    }
}
