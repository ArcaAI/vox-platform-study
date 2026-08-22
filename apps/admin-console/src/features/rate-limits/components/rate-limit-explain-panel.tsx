'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconSearch } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useExplainRateLimit, useRouteCatalog } from '../api/hooks';
import { RATE_LIMIT_LEVEL_LABELS } from '../api/types';

/**
 * Explain tab (TASK-785 AC-8).
 *
 * With five levels and two match kinds, "why is this tenant getting 429s?" is
 * not answerable by reading the rules list — the winner depends on the tenant,
 * the route pattern and the plan together. This asks the gateway to resolve one
 * concrete request and show its whole trace, including how the counter is
 * bucketed, which is the part that explains why two callers share a budget.
 */
export function RateLimitExplainPanel() {
  const uid = useId();
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [submitted, setSubmitted] = useState<{ method: string; path: string; tenantId?: string } | null>(null);

  const catalogQuery = useRouteCatalog();
  const explainQuery = useExplainRateLimit(submitted ?? { method: 'GET', path: '' }, submitted !== null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim()) return;
    setSubmitted({ method: method.trim().toUpperCase(), path: path.trim(), tenantId: tenantId.trim() || undefined });
  };

  const result = explainQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={submit} className="bg-card flex flex-wrap items-end gap-4 rounded-md border p-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-method`}>Method</Label>
          <Input id={`${uid}-method`} value={method} onChange={(event) => setMethod(event.target.value)} className="w-28 font-mono" required />
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-2">
          <Label htmlFor={`${uid}-path`}>Path</Label>
          <Input
            id={`${uid}-path`}
            list={`${uid}-paths`}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/api/v1/auth/login"
            className="font-mono"
            required
          />
          <datalist id={`${uid}-paths`}>
            {(catalogQuery.data ?? []).map((route) => (
              <option key={route.routeId} value={route.path} />
            ))}
          </datalist>
        </div>
        <div className="flex min-w-56 flex-col gap-2">
          <Label htmlFor={`${uid}-tenant`}>Tenant ID</Label>
          <Input
            id={`${uid}-tenant`}
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            placeholder="Empty = anonymous traffic"
            className="font-mono"
          />
        </div>
        <Button type="submit" disabled={!path.trim()}>
          <IconSearch aria-hidden />
          Explain
        </Button>
      </form>

      {submitted === null ? (
        <EmptyState
          icon={IconSearch}
          title="Resolve a request"
          description="Pick a method, a route and (optionally) a tenant to see which of the five levels decides its limit — and what every other level offered."
        />
      ) : explainQuery.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : explainQuery.error ? (
        <ErrorState error={explainQuery.error} onRetry={() => void explainQuery.refetch()} />
      ) : result ? (
        <div className="flex flex-col gap-4">
          <section className="bg-card flex flex-wrap items-center gap-4 rounded-md border p-4">
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-sm">Effective limit</span>
              <span className="font-mono text-lg">
                {result.effective ? `${result.effective.limitValue} / ${Math.round(result.effective.windowMs / 1000)}s` : 'Exempt — not throttled'}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-sm">Decided by</span>
              <Badge>{RATE_LIMIT_LEVEL_LABELS[result.level]}</Badge>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-sm">Counted per</span>
              <Badge variant="secondary">{result.bucket === 'tenant' ? 'Tenant' : 'Source IP'}</Badge>
            </div>
            {result.ruleId ? (
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-sm">Rule</span>
                <span className="font-mono text-xs">{result.ruleId}</span>
              </div>
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-base font-semibold">Resolution trace</h3>
            <p className="text-muted-foreground text-sm">
              Levels are listed in precedence order. The first one with an opinion wins; the rest are what would apply if it were removed.
            </p>
            <ul className="flex flex-col gap-2">
              {result.trace.map((offer) => (
                <li
                  key={`${offer.level}-${offer.ruleId ?? 'none'}`}
                  className={`flex flex-wrap items-center gap-3 rounded-md border p-3 ${offer.winner ? 'border-primary bg-primary/5' : 'bg-card'}`}
                >
                  <Badge variant={offer.winner ? 'default' : 'outline'}>{RATE_LIMIT_LEVEL_LABELS[offer.level]}</Badge>
                  <span className="font-mono text-sm">
                    {offer.limitValue} / {Math.round(offer.windowMs / 1000)}s
                  </span>
                  {!offer.active ? <Badge variant="secondary">Exempts this scope</Badge> : null}
                  {offer.winner ? <span className="text-primary ms-auto text-sm font-medium">Applied</span> : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </div>
  );
}
