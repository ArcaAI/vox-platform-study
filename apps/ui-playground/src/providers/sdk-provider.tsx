import { AgenticProvider } from '@arcaai/vox';
import type { AgenticConfig } from '@arcaai/vox';
import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';
import { useMemo } from 'react';
import { useAutoRefresh } from '@/hooks/use-auto-refresh';

function AutoRefreshInit() {
  useAutoRefresh();
  return null;
}

/**
 * SDKProvider — wires the playground's auth state into the @arcaai/vox SDK.
 *
 * TASK-295 H-1 / H-5 interaction (impersonation persistence):
 *   - Auth store now persists to `sessionStorage` instead of `localStorage`,
 *     and the `impersonationToken`, `impersonatedUser`, `isImpersonating`,
 *     `originalTenantId` keys are deliberately excluded from `partialize`.
 *   - On a fresh page load `isImpersonating === false` and
 *     `impersonationToken === ''`, so the `accessToken` fed to the SDK is the
 *     admin's own bearer token. The admin must explicitly re-click
 *     "Impersonate" to elevate again.
 *   - During an active in-tab impersonation, both fields live in memory and
 *     this provider correctly hands `impersonationToken` to the SDK. Nothing
 *     to rehydrate from storage — that's the point of H-1.
 *   - We keep the `persistedImpersonating && impersonationToken` guard so
 *     that if the team ever re-enables persistence (e.g. behind a feature
 *     flag for a developer-only build), this path still does the right
 *     thing.
 */
export function SDKProvider({ children }: { children: React.ReactNode }) {
  const { authMethod, apiKey, tenantId, accessToken, isImpersonating: persistedImpersonating, impersonationToken } = useAuthStore();
  const { apiBaseUrl, debugMode } = usePlaygroundStore();

  const config = useMemo((): AgenticConfig => {
    const api: AgenticConfig['api'] = {
      baseUrl: apiBaseUrl,
      tenantId: tenantId || undefined,
    };

    if (authMethod === 'apiKey' && apiKey) {
      api.apiKey = apiKey;
    }

    if (authMethod === 'credentials') {
      api.accessToken = persistedImpersonating && impersonationToken ? impersonationToken : accessToken || undefined;
    }

    return {
      api,
      debug: debugMode,
      // TASK-331 doc-05 F-5 — `useAutoRefresh` (mounted below) is the SOLE owner
      // of the single-slot `setOnUnauthorized`; its impersonation-aware handler
      // (refresh admin token → re-impersonate) must win. Opt out of the SDK's
      // default auto-wire so the two registrants no longer race.
      autoWireTokenRefresh: false,
    };
  }, [authMethod, apiKey, tenantId, accessToken, persistedImpersonating, impersonationToken, apiBaseUrl, debugMode]);

  return (
    <AgenticProvider config={config}>
      <AutoRefreshInit />
      {children}
    </AgenticProvider>
  );
}
