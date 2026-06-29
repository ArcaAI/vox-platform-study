import { AgenticProvider, type AgenticConfig } from '@arcaai/vox';
import { useMemo, type ReactNode } from 'react';
import { getApiBaseUrl } from '@/lib/api-config';
import { useAutoRefresh } from '@/hooks/use-auto-refresh';
import { useAuthStore } from '@/store/auth-store';

const API_BASE_URL = getApiBaseUrl();

/**
 * Runs the custom token-refresh wiring inside the provider tree so
 * `useArcaStore()` resolves. Renders nothing.
 */
function AutoRefreshInit() {
    useAutoRefresh();
    return null;
}

/**
 * Wires the admin auth store into the `@arcaai/vox` SDK. The bearer token +
 * tenant come from the persisted auth store.
 *
 * `autoWireTokenRefresh` is OFF: the SDK's built-in refresh keeps the refresh
 * token in-memory only (lost on hard reload). Instead `AutoRefreshInit` owns
 * the 401 interceptor + proactive refresh, reading the persisted refresh token
 * from `sessionStorage` (TASK-374).
 */
export function SDKProvider({ children }: { children: ReactNode }) {
    const accessToken = useAuthStore((s) => s.accessToken);
    const tenantId = useAuthStore((s) => s.tenantId);

    const config = useMemo<AgenticConfig>(
        () => ({
            api: {
                baseUrl: API_BASE_URL,
                accessToken: accessToken || undefined,
                tenantId: tenantId || undefined,
            },
            // Declares the capture pipeline for the Live Session surface; nothing
            // heavy initializes until `audio.start()` is called there.
            audio: {
                noiseFilter: true,
                vad: true,
                stt: true,
            },
            autoWireTokenRefresh: false,
        }),
        [accessToken, tenantId],
    );

    return (
        <AgenticProvider config={config}>
            <AutoRefreshInit />
            {children}
        </AgenticProvider>
    );
}
