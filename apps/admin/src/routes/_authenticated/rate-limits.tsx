import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Label } from '@arcaai/ui/label';
import { Switch } from '@arcaai/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useRateLimits } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Pencil, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { AUTH_CRITICAL_TIER, formatLimitPerWindow, formatWindow, sourceColorRole, tierDescription } from '@/features/rate-limits/rate-limit-format';
import { TierEditDialog } from '@/features/rate-limits/tier-edit-dialog';
import { requireSuperAdmin } from '@/lib/route-guards';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_authenticated/rate-limits')({
  beforeLoad: ({ context }) => requireSuperAdmin(context),
  component: RateLimitsPage,
});

/**
 * TASK-403 — Rate Limits (design §5.3, frame `14` v2): prominent global
 * kill-switch → 4 tier cards (strict = auth-critical) → read-only
 * route-overrides table with db/code/default provenance. Config is DB-backed
 * (TASK-316) and live — no redeploy.
 */
function RateLimitsPage() {
  const { policy, isLoading, error, refresh, setEnabled, setTier } = useRateLimits();
  const [editingTier, setEditingTier] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const onToggle = async (next: boolean) => {
    setToggling(true);
    try {
      await setEnabled(next);
      toast.success(next ? 'Rate limiting enabled platform-wide' : 'Rate limiting disabled platform-wide');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update the kill-switch');
    } finally {
      setToggling(false);
    }
  };

  const onSaveTier = async (tier: string, input: { limit?: number; ttl?: number }) => {
    try {
      await setTier(tier, input);
      toast.success(`Tier “${tier}” updated`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update tier');
      throw err;
    }
  };

  const editing = policy?.tiers.find((t) => t.tier === editingTier) ?? null;
  const disabled = policy ? !policy.enabled : false;

  return (
    <div>
      <PageHeader title="Rate Limits" description="Gateway throttling — live, DB-backed. Super-admin only." />

      {error ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn’t load the rate-limit policy</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      {/* Global kill-switch (design: a real Switch + state caption, leading the page). */}
      <Card className="mb-4 flex flex-row items-center justify-between gap-4 p-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="rate-limit-kill-switch" className="text-sm font-semibold">
            Rate limiting · {policy ? (policy.enabled ? 'On' : 'Off') : '…'}
          </Label>
          <p className="text-sm text-muted-foreground">
            Global kill-switch. Off disables throttling for every route.{' '}
            {policy ? (
              <span>
                Source: <span className="font-mono">{policy.enabledSource}</span>.
              </span>
            ) : null}
          </p>
        </div>
        <Switch
          id="rate-limit-kill-switch"
          checked={policy?.enabled ?? false}
          onCheckedChange={(v) => void onToggle(v)}
          disabled={!policy || toggling}
          aria-label="Rate limiting kill-switch"
        />
      </Card>

      {disabled ? (
        <Alert className="mb-4 border-warning/40 bg-warning/10 text-warning [&>svg]:text-warning">
          <ShieldAlert className="size-4" />
          <AlertTitle>Throttling disabled platform-wide</AlertTitle>
          <AlertDescription className="text-warning/90">
            Tier baselines and route overrides below are inert until the kill-switch is turned back on.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Kill-switch OFF dims the config surface (design "kill-switch off" state). */}
      <div className={cn('space-y-6', disabled && 'opacity-60')}>
        <section>
          <h3 className="mb-2 text-sm font-semibold">Tier baselines</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {isLoading && !policy
              ? Array.from({ length: 4 }).map((_, i) => <Card key={i} className="h-36 animate-pulse bg-muted/40 p-4" />)
              : policy?.tiers.map((tier) => (
                  <Card
                    key={tier.tier}
                    data-testid={`tier-card-${tier.tier}`}
                    className={cn('gap-2 p-4', tier.tier === AUTH_CRITICAL_TIER && 'border-hope/50 bg-hope/5')}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-sm font-semibold">{tier.tier}</span>
                      {tier.tier === AUTH_CRITICAL_TIER ? <StatusBadge label="Auth-critical" colorRole="hope" /> : null}
                    </div>
                    <div className="text-lg font-semibold tabular-nums">{formatLimitPerWindow(tier.limit, tier.ttl)}</div>
                    <p className="text-xs text-muted-foreground">{tierDescription(tier.tier)}</p>
                    <div className="flex items-center justify-between">
                      <div className="flex gap-1">
                        <StatusBadge label={`limit: ${tier.limitSource}`} colorRole={sourceColorRole(tier.limitSource)} />
                        <StatusBadge label={`ttl: ${tier.ttlSource}`} colorRole={sourceColorRole(tier.ttlSource)} />
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setEditingTier(tier.tier)} aria-label={`Edit tier ${tier.tier}`}>
                        <Pencil className="size-4" />
                        Edit
                      </Button>
                    </div>
                  </Card>
                ))}
          </div>
        </section>

        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Route overrides (effective state)</h3>
            {/* TARGET note required by the design: runtime hit-counts have no backend yet. */}
            <span className="text-xs text-muted-foreground">Live requests-in-window counters: TARGET — not yet exposed by the gateway.</span>
          </div>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Route</TableHead>
                  <TableHead className="max-md:hidden">Description</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Limit</TableHead>
                  <TableHead className="text-right">Window</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && !policy ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : !policy || policy.routes.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      All routes use their tier baseline.
                    </TableCell>
                  </TableRow>
                ) : (
                  policy.routes.map((route) => (
                    <TableRow key={route.routeId} data-testid={`route-row-${route.routeId}`}>
                      <TableCell>
                        <div className="font-mono text-xs font-medium">{route.routeId}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {route.controller}
                          {route.handler ? `.${route.handler}` : ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-md:hidden">{route.description}</TableCell>
                      <TableCell>
                        <StatusBadge label={route.tier} colorRole={route.tier === AUTH_CRITICAL_TIER ? 'hope' : 'neutral'} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{route.limit}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatWindow(route.ttl)}</TableCell>
                      <TableCell>
                        <StatusBadge label={route.enabled ? 'Enabled' : 'Disabled'} colorRole={route.enabled ? 'success' : 'neutral'} />
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <StatusBadge label={route.limitSource} colorRole={sourceColorRole(route.limitSource)} />
                          {route.ttlSource !== route.limitSource ? (
                            <StatusBadge label={route.ttlSource} colorRole={sourceColorRole(route.ttlSource)} />
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>

      {policy ? (
        <p className="mt-4 text-xs text-muted-foreground">
          <span className="tabular-nums">{policy.tiers.length}</span> tiers · <span className="tabular-nums">{policy.routes.length}</span> route
          overrides · Live (DB-backed). Tenant admins cannot retune gateway limits — this surface is super-admin only.
        </p>
      ) : null}

      <TierEditDialog tier={editing} open={editing !== null} onOpenChange={(o) => !o && setEditingTier(null)} onSave={onSaveTier} />
    </div>
  );
}
