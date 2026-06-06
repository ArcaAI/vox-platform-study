import { useState } from 'react';
import { toast } from 'sonner';
import { Main } from '@/components/layout/main';
import { AdminApiError } from '../api/admin-client';
import { ConfirmDialog } from '../components';
import {
  useRateLimitPolicy,
  useSetRateLimitEnabled,
  useSetRateLimitRoute,
  useSetRateLimitTier,
  type RateLimitRoutePolicy,
  type RateLimitTierPolicy,
} from './api/rate-limit';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { cn } from '@/lib/utils';
import { AlertCircle, Gauge, Pencil } from 'lucide-react';

function SourceBadge({ source }: { source: string }) {
  const tone =
    source === 'db'
      ? 'bg-blue-500/15 text-blue-700 dark:text-blue-400'
      : source === 'code'
        ? 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400'
        : 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
  return (
    <Badge variant="outline" className={cn('text-[10px] uppercase', tone)}>
      {source}
    </Badge>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Failed to load rate-limit policy.';
}

type EditTarget = { kind: 'tier'; tier: RateLimitTierPolicy } | { kind: 'route'; route: RateLimitRoutePolicy };

export default function RateLimitsPage() {
  const { data: policy, isLoading, isError, error } = useRateLimitPolicy();
  const setEnabled = useSetRateLimitEnabled();
  const setTier = useSetRateLimitTier();
  const setRoute = useSetRateLimitRoute();

  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [limitDraft, setLimitDraft] = useState('');
  const [ttlDraft, setTtlDraft] = useState('');
  const [enabledDraft, setEnabledDraft] = useState(true);

  const openEdit = (target: EditTarget) => {
    setEditTarget(target);
    if (target.kind === 'tier') {
      setLimitDraft(String(target.tier.limit));
      setTtlDraft(String(target.tier.ttl));
    } else {
      setLimitDraft(String(target.route.limit));
      setTtlDraft(String(target.route.ttl));
      setEnabledDraft(target.route.enabled);
    }
  };

  const confirmToggle = () => {
    if (pendingEnabled === null) return;
    const next = pendingEnabled;
    setEnabled.mutate(next, {
      onSuccess: () => toast.success(next ? 'Rate limiting enabled' : 'Rate limiting disabled'),
      onError: (e) => toast.error(errorMessage(e)),
      onSettled: () => setPendingEnabled(null),
    });
  };

  const saveEdit = () => {
    if (!editTarget) return;
    const limit = limitDraft.trim() === '' ? undefined : Number(limitDraft);
    const ttl = ttlDraft.trim() === '' ? undefined : Number(ttlDraft);
    if ((limit != null && (!Number.isFinite(limit) || limit < 1)) || (ttl != null && (!Number.isFinite(ttl) || ttl < 1))) {
      toast.error('Limit and window must be positive integers.');
      return;
    }

    const onSuccess = () => {
      toast.success('Rate-limit configuration updated');
      setEditTarget(null);
    };
    const onError = (e: unknown) => toast.error(errorMessage(e));

    if (editTarget.kind === 'tier') {
      setTier.mutate({ tier: editTarget.tier.tier, limit, ttl }, { onSuccess, onError });
    } else {
      setRoute.mutate({ routeId: editTarget.route.routeId, limit, ttl, enabled: enabledDraft }, { onSuccess, onError });
    }
  };

  const isSaving = setTier.isPending || setRoute.isPending;

  return (
    <Main>
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight">Rate Limits</h2>
        <p className="text-muted-foreground mt-1">Tune the gateway throttler: the global kill-switch, tier baselines, and per-route overrides.</p>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <AlertCircle className="text-destructive size-6" />
            <p className="text-muted-foreground text-sm">{errorMessage(error)}</p>
          </CardContent>
        </Card>
      ) : policy ? (
        <div className="flex flex-col gap-6">
          {/* Global kill-switch */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <Gauge className="text-muted-foreground size-4" />
                  <CardTitle className="text-sm font-medium">Global rate limiting</CardTitle>
                  <SourceBadge source={policy.enabledSource} />
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'text-sm font-medium',
                      policy.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
                    )}
                  >
                    {policy.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <Switch checked={policy.enabled} disabled={setEnabled.isPending} onCheckedChange={(next: boolean) => setPendingEnabled(next)} />
                </div>
              </div>
              <CardDescription>
                When disabled, throttling is bypassed for every route. Changes take effect within the settings-cache window without a redeploy.
              </CardDescription>
            </CardHeader>
          </Card>

          {/* Tier baselines */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Tier baselines</CardTitle>
              <CardDescription>
                Default request limits per named throttler tier. A route inherits its tier unless it has its own override.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tier</TableHead>
                      <TableHead className="text-right">Limit</TableHead>
                      <TableHead className="text-right">Window (ms)</TableHead>
                      <TableHead className="w-20" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {policy.tiers.map((tier) => (
                      <TableRow key={tier.tier}>
                        <TableCell className="font-medium capitalize">{tier.tier}</TableCell>
                        <TableCell className="text-right">
                          <span className="tabular-nums">{tier.limit}</span> <SourceBadge source={tier.limitSource} />
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="tabular-nums">{tier.ttl}</span> <SourceBadge source={tier.ttlSource} />
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" className="h-7" onClick={() => openEdit({ kind: 'tier', tier })}>
                            <Pencil className="mr-1 size-3" />
                            Edit
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Per-route overrides */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Known throttled routes</CardTitle>
              <CardDescription>Per-endpoint overrides for security-sensitive routes (login, impersonation, …).</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Route</TableHead>
                      <TableHead>Tier</TableHead>
                      <TableHead className="text-right">Limit</TableHead>
                      <TableHead className="text-right">Window (ms)</TableHead>
                      <TableHead>Enabled</TableHead>
                      <TableHead className="w-20" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {policy.routes.map((route) => (
                      <TableRow key={route.routeId}>
                        <TableCell>
                          <div className="font-medium">{route.routeId}</div>
                          <div className="text-muted-foreground text-xs">{route.description}</div>
                        </TableCell>
                        <TableCell className="capitalize">{route.tier}</TableCell>
                        <TableCell className="text-right">
                          <span className="tabular-nums">{route.limit}</span> <SourceBadge source={route.limitSource} />
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="tabular-nums">{route.ttl}</span> <SourceBadge source={route.ttlSource} />
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-xs',
                              route.enabled
                                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                                : 'bg-red-500/15 text-red-700 dark:text-red-400',
                            )}
                          >
                            {route.enabled ? 'On' : 'Off'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="sm" className="h-7" onClick={() => openEdit({ kind: 'route', route })}>
                            <Pencil className="mr-1 size-3" />
                            Edit
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Confirm global toggle (platform-wide) */}
      <ConfirmDialog
        open={pendingEnabled !== null}
        onOpenChange={(open) => {
          if (!open) setPendingEnabled(null);
        }}
        title={pendingEnabled ? 'Enable rate limiting?' : 'Disable rate limiting?'}
        description={
          pendingEnabled
            ? 'Re-enable the gateway throttler for every route.'
            : 'This bypasses throttling for EVERY route platform-wide, removing brute-force protection. Continue?'
        }
        confirmLabel={pendingEnabled ? 'Enable' : 'Disable'}
        variant={pendingEnabled ? 'default' : 'destructive'}
        isLoading={setEnabled.isPending}
        onConfirm={confirmToggle}
      />

      {/* Edit tier / route */}
      <Dialog open={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editTarget?.kind === 'tier' ? `Edit "${editTarget.tier.tier}" tier` : editTarget ? `Edit "${editTarget.route.routeId}" route` : 'Edit'}
            </DialogTitle>
            <DialogDescription>Leave a field blank to clear the DB override and fall back to the code/default baseline.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="rl-limit">Max requests</Label>
              <Input id="rl-limit" type="number" min={1} value={limitDraft} onChange={(e) => setLimitDraft(e.target.value)} placeholder="e.g. 100" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rl-ttl">Window (milliseconds)</Label>
              <Input id="rl-ttl" type="number" min={1} value={ttlDraft} onChange={(e) => setTtlDraft(e.target.value)} placeholder="e.g. 60000" />
            </div>
            {editTarget?.kind === 'route' && (
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label htmlFor="rl-enabled">Throttle this route</Label>
                  <p className="text-muted-foreground text-xs">Turn off to bypass throttling for just this endpoint.</p>
                </div>
                <Switch id="rl-enabled" checked={enabledDraft} onCheckedChange={(v: boolean) => setEnabledDraft(v)} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={isSaving}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={isSaving}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Main>
  );
}
