'use client';

import { IconBuildingOff } from '@tabler/icons-react';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { isPlatformScopeForbidden } from './guardrail-control-logic';

/**
 * The block error for a guardrail-control read. A 403 there means "not a platform admin, or a customer
 * working tenant is selected" (the routes are tenant-LESS), which is an answer, not a fault: say what to do.
 */
export function ControlErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (isPlatformScopeForbidden(error)) {
    return (
      <EmptyState
        icon={IconBuildingOff}
        title="Platform scope required"
        description="Guardrail control is platform-wide. Clear the working tenant in the top bar to load it; only the per-tenant overrides on the Rules tab use a working tenant."
      />
    );
  }
  return <ErrorState error={error} onRetry={onRetry} />;
}
