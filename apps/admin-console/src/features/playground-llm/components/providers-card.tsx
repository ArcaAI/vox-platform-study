'use client';

import { IconRefresh } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { ErrorBanner } from '@/shared/state/error-state';
import type { TextProvider } from '../api/types';

interface CatalogListProps {
  title: string;
  endpoint: string;
  items: TextProvider[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}

function CatalogList({ title, endpoint, items, isLoading, error, onRetry }: CatalogListProps) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-muted-foreground/70 font-mono text-[11px]">{endpoint}</span>
      </div>
      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : error ? (
        <ErrorBanner error={error} onRetry={onRetry} />
      ) : !items || items.length === 0 ? (
        <p className="text-muted-foreground text-sm">No providers in this catalog.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((provider) => (
            <li key={provider.name} className="flex flex-col gap-1.5 rounded-lg border p-3 transition-colors hover:bg-accent/40">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium">{provider.name}</span>
                {provider.is_default ? <StatusBadge label="default" colorRole="primary" /> : null}
                <StatusBadge
                  label={provider.is_available ? 'Available' : 'Unavailable'}
                  colorRole={provider.is_available ? 'success' : 'neutral'}
                  className="ml-auto"
                />
              </div>
              <p className="text-muted-foreground text-xs">
                {provider.models.map((model) => `${model.name}${model.size ? ` (${model.size})` : ''}`).join(' · ') || 'No models advertised'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface ProvidersCardProps {
  providers: TextProvider[] | undefined;
  providersLoading: boolean;
  providersError: unknown;
  guardrails: TextProvider[] | undefined;
  guardrailsLoading: boolean;
  guardrailsError: unknown;
  onRefresh: () => void;
  /** Elevated sessions only — the endpoint 403s everyone else. */
  showGlobalSwitch: boolean;
  globalCatalog: boolean;
  onGlobalCatalogChange: (checked: boolean) => void;
  workingTenantName: string | null;
}

export function ProvidersCard({
  providers,
  providersLoading,
  providersError,
  guardrails,
  guardrailsLoading,
  guardrailsError,
  onRefresh,
  showGlobalSwitch,
  globalCatalog,
  onGlobalCatalogChange,
  workingTenantName,
}: ProvidersCardProps) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Providers &amp; guardrails</CardTitle>
        <CardDescription>
          {workingTenantName ? `Catalogs resolve against ${workingTenantName}` : 'Catalogs resolve against the working tenant'}
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon" aria-label="Refresh provider catalogs" onClick={onRefresh}>
            <IconRefresh aria-hidden />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {showGlobalSwitch ? (
          <div className="flex items-start justify-between gap-3 rounded-md border p-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label htmlFor="llm-global-catalog">Global catalog</Label>
              <p className="text-muted-foreground text-xs">
                Super Admins only — resolves against <code className="font-mono">__GLOBAL__</code> instead of the working tenant.
              </p>
            </div>
            <Switch id="llm-global-catalog" checked={globalCatalog} onCheckedChange={onGlobalCatalogChange} />
          </div>
        ) : null}
        <CatalogList
          title="Text providers"
          endpoint="GET /text-generations/providers"
          items={providers}
          isLoading={providersLoading}
          error={providersError}
          onRetry={onRefresh}
        />
        <CatalogList
          title="Guardrail providers"
          endpoint="GET /text-generations/guardrail-providers"
          items={guardrails}
          isLoading={guardrailsLoading}
          error={guardrailsError}
          onRetry={onRefresh}
        />
        <p className="text-muted-foreground/80 border-t pt-3 text-[11px] leading-relaxed">
          Provider/model omitted → HarnessPolicy cascade resolves them; unresolved fails closed with <code className="font-mono">422</code>.
        </p>
      </CardContent>
    </Card>
  );
}
