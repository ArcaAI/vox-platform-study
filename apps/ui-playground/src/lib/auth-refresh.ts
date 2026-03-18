import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';

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
        const ms = payload.exp * 1000 - Date.now();
        return Math.max(0, ms);
    } catch {
        return 0;
    }
}

/**
 * Returns `true` when the token is a structurally valid JWT whose `exp`
 * claim is in the past. Returns `false` for malformed tokens, tokens
 * without an `exp` claim, or tokens that are still valid.
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
 * - Reads the refresh token from the auth store
 * - Calls POST /auth/refresh directly (no SDK dependency)
 * - Updates both accessToken and refreshToken in the auth store
 * - Deduplicates concurrent calls (only one network request at a time)
 *
 * Returns `true` if the token was refreshed, `false` otherwise.
 * On failure, logs the user out.
 */
export async function tryRefreshToken(): Promise<boolean> {
    if (inflightRefresh) {
        return inflightRefresh;
    }

    inflightRefresh = doRefresh();
    try {
        return await inflightRefresh;
    } finally {
        inflightRefresh = null;
    }
}

async function doRefresh(): Promise<boolean> {
    const { refreshToken, authMethod } = useAuthStore.getState();

    if (authMethod !== 'credentials' || !refreshToken) {
        return false;
    }

    try {
        const baseUrl = usePlaygroundStore.getState().apiBaseUrl;
        const res = await fetch(`${baseUrl}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
        });

        if (!res.ok) {
            useAuthStore.getState().logout();
            return false;
        }

        const data: { token: string; refreshToken: string } = await res.json();
        useAuthStore.getState().updateTokens(data.token, data.refreshToken);
        for (const listener of tokenRefreshedListeners) {
            listener(data.token);
        }
        return true;
    } catch {
        useAuthStore.getState().logout();
        return false;
    }
}
