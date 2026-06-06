import { Building2 } from 'lucide-react';

import { useAuthStore } from '@/store/auth-store';

/**
 * TASK-335 #3 — anchors an impersonation gate to the header-selected working
 * tenant so the playground visibly reflects which tenant impersonation will act
 * in. Reads the single source of truth (the `ScopeSwitcher` store value); no
 * second tenant picker.
 *
 *  - working tenant selected → name it ("Impersonate a clinician in {tenant}…").
 *  - global-scope admin with none selected → point at the header switcher.
 *  - tenant-admin (locked) with no tenant → neutral prompt.
 */
export function WorkingTenantNotice() {
  const tenantName = useAuthStore((s) => s.tenantName);
  const tenantId = useAuthStore((s) => s.tenantId);
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());

  const tenantLabel = tenantName || (tenantId ? `${tenantId.slice(0, 8)}\u2026` : '');

  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
      <Building2 className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      {tenantId ? (
        <span data-testid="working-tenant-notice">
          Working tenant: <strong>{tenantLabel}</strong>. Impersonate a clinician in this tenant to continue.
        </span>
      ) : isGlobalScope ? (
        <span data-testid="working-tenant-notice">Select a tenant in the header switcher, then impersonate a clinician in it.</span>
      ) : (
        <span data-testid="working-tenant-notice">Impersonate a clinician to continue.</span>
      )}
    </div>
  );
}
