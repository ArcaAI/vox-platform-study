import { useCallback } from 'react';
import { useAuth, useStoreApi } from '@arcaai/vox';
import { useAuthStore } from '@/store/auth-store';

/**
 * TASK-331 doc-05 — the single end-impersonation routine, shared by the overview
 * UserList "Stop Impersonation" button and the global header "Stop" affordance
 * so the exit logic lives in one place.
 *
 * Mirrors the start path in `user-list.tsx`: clears ConfigManager read-only (the
 * provider's identity-change rehydrate then reloads the admin's OWN namespace —
 * see F-2/F-7), revokes + restores the admin identity in the SDK, then clears the
 * playground auth store. Must be used inside `<AgenticProvider>`.
 */
export function useEndImpersonation(): () => Promise<void> {
  const { endImpersonation: sdkEndImpersonation } = useAuth();
  const storeApi = useStoreApi();

  return useCallback(async () => {
    storeApi.getState().configManager?.setReadOnly(false);
    await sdkEndImpersonation();
    useAuthStore.getState().endImpersonation();
  }, [sdkEndImpersonation, storeApi]);
}
