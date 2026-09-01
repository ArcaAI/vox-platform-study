'use client';

import { IconBuilding, IconWorldCog } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@arcaai/ui/components/shadcn/toggle-group';
import type { ResolvedAiPlatformScope } from './use-ai-platform-scope';

/**
 * The tenancy control — the whole point of TASK-845 step 2.
 *
 * It is a two-position tier switch, not a tenant picker: WHICH customer tenant
 * is chosen in the shell's working-tenant switcher, and this only chooses
 * between that tenant's own configuration and the platform default it inherits
 * from. Keeping the two questions apart is what stops "Global" (a customer
 * tenant, per `00-project-context.md`) from being mistaken for a third tier.
 *
 * A tenant-bound administrator sees no switch at all — they have exactly one
 * tier — rather than a disabled control implying a scope they could reach.
 */
export function ScopeControl({ scope }: { scope: ResolvedAiPlatformScope }) {
  if (scope.isLoading) {
    return (
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 w-64" />
      </div>
    );
  }

  if (!scope.canSelectSystem) {
    return (
      <Badge variant="secondary" className="gap-1.5">
        <IconBuilding aria-hidden className="size-3.5" />
        <span>Tenant configuration — {scope.label}</span>
      </Badge>
    );
  }

  const tenantDisabled = scope.tenantUnavailableReason !== null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={scope.scope}
        // Radix reports "" when the pressed item is toggled off. A tier switch
        // has no "neither" position, so an empty value keeps the current tier
        // rather than dropping the screen into an unscoped state.
        onValueChange={(next) => {
          if (next === 'system' || next === 'tenant') scope.setScope(next);
        }}
        aria-label="Configuration tier"
      >
        <ToggleGroupItem value="system" aria-label="Platform default, owned by the SYSTEM tenant">
          <IconWorldCog aria-hidden className="size-4" />
          Platform default
        </ToggleGroupItem>
        <ToggleGroupItem
          value="tenant"
          disabled={tenantDisabled}
          // Names the WORKING TENANT, never `scope.label`: the control has to
          // say which tier it switches TO, and reading the active scope made
          // this button announce "Tenant configuration — Platform default
          // (SYSTEM)" while the system tier was selected.
          aria-label={
            tenantDisabled
              ? `Tenant configuration — unavailable. ${scope.tenantUnavailableReason}`
              : `Tenant configuration — ${scope.workingTenantLabel ?? 'working tenant'}`
          }
        >
          <IconBuilding aria-hidden className="size-4" />
          {scope.workingTenantLabel ?? 'Working tenant'}
        </ToggleGroupItem>
      </ToggleGroup>
      {tenantDisabled ? <span className="text-muted-foreground text-xs">{scope.tenantUnavailableReason}</span> : null}
    </div>
  );
}
