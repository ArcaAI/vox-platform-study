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
    };
  }, [authMethod, apiKey, tenantId, accessToken, persistedImpersonating, impersonationToken, apiBaseUrl, debugMode]);

  return (
    <AgenticProvider config={config}>
      <AutoRefreshInit />
      {children}
    </AgenticProvider>
  );
}
