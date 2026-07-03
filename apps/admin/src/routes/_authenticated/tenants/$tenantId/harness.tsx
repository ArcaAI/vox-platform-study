/**
 * TASK-407 — Harness (design §5.9 `42 · Harness`, spec-only): sub-tabs
 * Policy · Eval runs · Audit trail · Gate queue. Policy is rendered read-only
 * (editing + HarnessPolicyChange history is flagged as not built). The
 * Temporal-backed workflows list lives on the Gate queue tab and degrades
 * honestly (unavailable card) when the harness service (`:8866`) is down.
 */

import { Badge } from '@arcaai/ui/badge';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@arcaai/ui/sheet';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { StatusBadge } from '@arcaai/ui/components/shared';
import {
  useHarnessAdmin,
  type HarnessAuditList,
  type HarnessEvalRun,
  type HarnessEvalRunDetail,
  type HarnessEvalRunList,
  type HarnessGateQueue,
  type HarnessPolicy,
  type HarnessWorkflowList,
} from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { CloudOff, FileCheck2, ListChecks } from 'lucide-react';
import { useEffect, useState } from 'react';
import { chainVerdict, formatSeconds, policySourceLabel, policySourceRole, workflowStatusRole } from '@/features/harness/harness-display';
import { isSuperAdmin } from '@/features/tenants/permissions';
import { ActingOnBanner } from '@/features/tenants/tenant-context';
import { formatDateTime } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/harness')({
  component: HarnessPage,
});

function shortHash(v?: string | null): string {
  if (!v) return '—';
  return v.length <= 10 ? v : `${v.slice(0, 10)}…`;
}

/** Known numeric sensor thresholds (pass through the policy index signature). */
const THRESHOLD_KEYS: Array<[string, string]> = [
  ['entityFaithfulnessThreshold', 'Entity faithfulness'],
  ['coverageThreshold', 'Coverage'],
  ['citationPresenceThreshold', 'Citation presence'],
  ['numericDoseThreshold', 'Numeric dose'],
  ['groundednessThreshold', 'Groundedness'],
];

function HarnessPage() {
  const { tenantId } = Route.useParams();
  const tenant = useTenantDetailStore((s) => s.tenant);
  const roles = useAuthStore((s) => s.user?.roles);
  const superAdmin = isSuperAdmin(roles);

  const { getPolicy, listAudit, listEvalRuns, getEvalRun, listGateQueue, listWorkflows } = useHarnessAdmin();

  const [policy, setPolicy] = useState<HarnessPolicy | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [evalRuns, setEvalRuns] = useState<HarnessEvalRunList | null>(null);
  const [audit, setAudit] = useState<HarnessAuditList | null>(null);
  const [gateQueue, setGateQueue] = useState<HarnessGateQueue | null>(null);
  const [workflows, setWorkflows] = useState<HarnessWorkflowList | null>(null);
  const [workflowsUnavailable, setWorkflowsUnavailable] = useState(false);
  const [selectedRun, setSelectedRun] = useState<HarnessEvalRunDetail | null>(null);

  useEffect(() => {
    setPolicy(null);
    setPolicyError(null);
    setEvalRuns(null);
    setAudit(null);
    setGateQueue(null);
    setWorkflows(null);
    setWorkflowsUnavailable(false);
    // Each section loads + degrades independently (DB-backed vs Temporal-backed).
    void getPolicy()
      .then(setPolicy)
      .catch((e) => setPolicyError(e instanceof Error ? e.message : 'Failed to load policy'));
    void listEvalRuns({ limit: 20 })
      .then(setEvalRuns)
      .catch(() => setEvalRuns({ items: [], total: 0 }));
    void listAudit({ limit: 50 })
      .then(setAudit)
      .catch(() => setAudit(null));
    void listGateQueue()
      .then(setGateQueue)
      .catch(() => setGateQueue(null));
    void listWorkflows({ limit: 20 })
      .then((w) => {
        setWorkflows(w);
        setWorkflowsUnavailable(false);
      })
      .catch(() => setWorkflowsUnavailable(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const openRun = (run: HarnessEvalRun) => {
    void getEvalRun(run.id)
      .then(setSelectedRun)
      .catch(() => setSelectedRun({ ...run, scores: [] }));
  };

  return (
    <div className="space-y-5">
      <Tabs defaultValue="policy">
        <TabsList>
          <TabsTrigger value="policy">Policy</TabsTrigger>
          <TabsTrigger value="eval-runs">Eval runs</TabsTrigger>
          <TabsTrigger value="audit">Audit trail</TabsTrigger>
          <TabsTrigger value="gate-queue">Gate queue</TabsTrigger>
        </TabsList>

        {/* ---------- Policy (read-only; editing flagged as not built) ---------- */}
        <TabsContent value="policy" className="mt-4 space-y-4">
          {policyError ? (
            <Card className="p-5">
              <p role="alert" className="text-sm text-muted-foreground">
                Couldn’t load the harness policy — {policyError}
              </p>
            </Card>
          ) : policy == null ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge label={policySourceLabel(policy.source)} colorRole={policySourceRole(policy.source)} />
                {policy.updatedAt ? <span className="text-xs text-muted-foreground">Updated {formatDateTime(policy.updatedAt)}</span> : null}
                <span className="text-xs text-muted-foreground">Read-only view — policy editing is not available in this console yet.</span>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="p-5">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Sensor thresholds</h3>
                  <dl className="mt-3 space-y-2 text-sm">
                    {THRESHOLD_KEYS.map(([key, label]) => {
                      const v = policy[key];
                      return (
                        <div key={key} className="flex items-baseline justify-between gap-4">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="tabular-nums font-medium">{typeof v === 'number' ? v : '—'}</dd>
                        </div>
                      );
                    })}
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">Regen budget</dt>
                      <dd className="tabular-nums font-medium">{policy.maxRegen ?? '—'}</dd>
                    </div>
                  </dl>
                </Card>
                <Card className="p-5">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Safety · PHI · Gate</h3>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">Safety checks</dt>
                      <dd>
                        <StatusBadge label={policy.safetyEnabled ? 'Enabled' : 'Disabled'} colorRole={policy.safetyEnabled ? 'success' : 'neutral'} />
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">PHI detection</dt>
                      <dd>
                        <StatusBadge label={policy.phiEnabled ? 'Enabled' : 'Disabled'} colorRole={policy.phiEnabled ? 'success' : 'neutral'} />
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">PHI fail-closed</dt>
                      <dd>
                        <StatusBadge
                          label={policy.phiFailClosed ? 'Fail closed' : 'Fail open'}
                          colorRole={policy.phiFailClosed ? 'success' : 'warning'}
                        />
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">Safety model</dt>
                      <dd className="truncate font-mono text-xs">
                        {policy.safetyProvider || policy.safetyModel ? [policy.safetyProvider, policy.safetyModel].filter(Boolean).join(' · ') : '—'}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">SMR model</dt>
                      <dd className="truncate font-mono text-xs">
                        {policy.smrProvider || policy.smrModel ? [policy.smrProvider, policy.smrModel].filter(Boolean).join(' · ') : '—'}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">Gate SLA</dt>
                      <dd className="tabular-nums font-medium">{formatSeconds(policy.gateSlaSeconds ?? null)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">Gate escalation</dt>
                      <dd className="tabular-nums font-medium">{formatSeconds(policy.gateEscalationSeconds ?? null)}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">Tool allowlist</dt>
                      <dd className="flex max-w-[60%] flex-wrap justify-end gap-1">
                        {policy.toolAllowlist && policy.toolAllowlist.length > 0 ? (
                          policy.toolAllowlist.map((t) => (
                            <Badge key={t} variant="secondary" className="font-mono text-xs font-normal">
                              {t}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                </Card>
              </div>
            </>
          )}
        </TabsContent>

        {/* ---------- Eval runs ---------- */}
        <TabsContent value="eval-runs" className="mt-4">
          <Card className="overflow-hidden">
            {evalRuns == null ? (
              <div className="space-y-2 p-5">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : evalRuns.items.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ListChecks />
                  </EmptyMedia>
                  <EmptyTitle>No eval runs</EmptyTitle>
                  <EmptyDescription>Golden-set evaluation runs for this tenant will appear here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground/70">
                    <th className="px-5 py-2.5 font-medium">Run</th>
                    <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Model</th>
                    <th className="px-5 py-2.5 font-medium">Status</th>
                    <th className="hidden px-5 py-2.5 font-medium md:table-cell">Started</th>
                    <th className="hidden px-5 py-2.5 font-medium lg:table-cell">Completed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {evalRuns.items.map((run) => (
                    <tr
                      key={run.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => openRun(run)}
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && openRun(run)}
                      aria-label={`Eval run ${run.id}`}
                    >
                      <td className="max-w-0 px-5 py-2.5">
                        <span className="block truncate font-mono text-xs">{run.id}</span>
                      </td>
                      <td className="hidden px-5 py-2.5 sm:table-cell">
                        <span className="font-mono text-xs">
                          {run.modelName}
                          {run.modelVersion ? ` · ${run.modelVersion}` : ''}
                        </span>
                      </td>
                      <td className="px-5 py-2.5">
                        <StatusBadge label={String(run.status ?? '—')} colorRole={workflowStatusRole(run.status)} />
                      </td>
                      <td className="hidden whitespace-nowrap px-5 py-2.5 text-muted-foreground md:table-cell">
                        {formatDateTime(run.startedAt ?? null)}
                      </td>
                      <td className="hidden whitespace-nowrap px-5 py-2.5 text-muted-foreground lg:table-cell">
                        {formatDateTime(run.completedAt ?? null)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
              {evalRuns?.total ?? 0} run{(evalRuns?.total ?? 0) === 1 ? '' : 's'} · aggregate eval dashboards remain a target surface.
            </p>
          </Card>
        </TabsContent>

        {/* ---------- Audit trail (WORM) ---------- */}
        <TabsContent value="audit" className="mt-4">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">WORM audit trail</h3>
              {audit ? <StatusBadge label={chainVerdict(audit.verification).label} colorRole={chainVerdict(audit.verification).colorRole} /> : null}
            </div>
            {audit == null ? (
              <div className="space-y-2 p-5">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : audit.items.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileCheck2 />
                  </EmptyMedia>
                  <EmptyTitle>No audit events</EmptyTitle>
                  <EmptyDescription>Hash-chained harness audit events will appear here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground/70">
                    <th className="px-5 py-2.5 font-medium">Action</th>
                    <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Model</th>
                    <th className="hidden px-5 py-2.5 font-medium md:table-cell">Gate decision</th>
                    <th className="hidden px-5 py-2.5 font-medium lg:table-cell">Hash</th>
                    <th className="px-5 py-2.5 font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {audit.items.map((e) => (
                    <tr key={e.id}>
                      <td className="px-5 py-2.5">
                        <Badge variant="outline" className="font-mono text-xs">
                          {e.action}
                        </Badge>
                      </td>
                      <td className="hidden max-w-0 px-5 py-2.5 sm:table-cell">
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {e.modelName}
                          {e.modelVersion ? ` · ${e.modelVersion}` : ''}
                        </span>
                      </td>
                      <td className="hidden px-5 py-2.5 md:table-cell">
                        {e.gateDecision ? <Badge variant="secondary">{e.gateDecision}</Badge> : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="hidden px-5 py-2.5 lg:table-cell">
                        <span className="font-mono text-xs text-muted-foreground" title={e.hash}>
                          {shortHash(e.hash)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-muted-foreground">{formatDateTime(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
              Append-only — events are hash-chained (WORM) and can never be edited or deleted.
            </p>
          </Card>
        </TabsContent>

        {/* ---------- Gate queue + Temporal workflows ---------- */}
        <TabsContent value="gate-queue" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Pending</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{gateQueue?.total ?? '—'}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">SLA breached</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{gateQueue?.slaBreachedCount ?? '—'}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Escalated</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{gateQueue?.escalatedCount ?? '—'}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Gate SLA</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{gateQueue ? formatSeconds(gateQueue.gateSlaSeconds) : '—'}</p>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <div className="border-b border-border px-5 py-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Awaiting clinician review</h3>
            </div>
            {gateQueue == null ? (
              <div className="space-y-2 p-5">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : gateQueue.items.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">No consultations are waiting at the clinician gate.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground/70">
                    <th className="px-5 py-2.5 font-medium">Consultation</th>
                    <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Pending since</th>
                    <th className="px-5 py-2.5 font-medium">Age</th>
                    <th className="px-5 py-2.5 font-medium">SLA</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {gateQueue.items.map((item) => (
                    <tr key={item.consultationId}>
                      <td className="max-w-0 px-5 py-2.5">
                        <span className="block truncate font-mono text-xs">{item.consultationId}</span>
                      </td>
                      <td className="hidden whitespace-nowrap px-5 py-2.5 text-muted-foreground sm:table-cell">
                        {formatDateTime(item.pendingSince)}
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 tabular-nums text-muted-foreground">{formatSeconds(item.ageSeconds)}</td>
                      <td className="px-5 py-2.5">
                        {item.escalated ? (
                          <StatusBadge label="Escalated" colorRole="warning" />
                        ) : item.slaBreached ? (
                          <StatusBadge label="SLA breached" colorRole="destructive" />
                        ) : (
                          <StatusBadge label="Within SLA" colorRole="success" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-border px-5 py-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Document workflows (Temporal)</h3>
            </div>
            {workflowsUnavailable ? (
              <div className="flex flex-col items-center gap-2 p-10 text-center">
                <CloudOff className="size-8 text-muted-foreground" />
                <p className="font-medium">Harness service unavailable</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  The harness Temporal worker (:8866) isn’t reachable, so live workflow state can’t be shown. Policy, eval runs, audit trail and the
                  gate queue above are database-backed and stay accurate.
                </p>
              </div>
            ) : workflows == null ? (
              <div className="space-y-2 p-5">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : workflows.items.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">No document workflows found for this tenant.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground/70">
                    <th className="px-5 py-2.5 font-medium">Workflow</th>
                    <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Consultation</th>
                    <th className="px-5 py-2.5 font-medium">Status</th>
                    <th className="hidden px-5 py-2.5 font-medium md:table-cell">Phase</th>
                    <th className="hidden px-5 py-2.5 font-medium lg:table-cell">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {workflows.items.map((w) => (
                    <tr key={`${w.workflowId}:${w.runId ?? ''}`}>
                      <td className="max-w-0 px-5 py-2.5">
                        <span className="block truncate font-mono text-xs">{w.workflowId}</span>
                      </td>
                      <td className="hidden max-w-0 px-5 py-2.5 sm:table-cell">
                        <span className="block truncate font-mono text-xs text-muted-foreground">{w.consultationId ?? '—'}</span>
                      </td>
                      <td className="px-5 py-2.5">
                        <StatusBadge label={w.status} colorRole={workflowStatusRole(w.status)} />
                      </td>
                      <td className="hidden px-5 py-2.5 text-muted-foreground md:table-cell">{w.phase ?? '—'}</td>
                      <td className="hidden whitespace-nowrap px-5 py-2.5 text-muted-foreground lg:table-cell">
                        {formatDateTime(w.startedAt ?? null)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      {superAdmin && tenant ? (
        <ActingOnBanner
          tenantName={tenant.name}
          description="Clinical Documentation Harness for this tenant. Policy shows the effective resolution (tenant override → platform default → code default); the audit trail is WORM hash-chained."
        />
      ) : null}

      <EvalRunSheet run={selectedRun} onClose={() => setSelectedRun(null)} />
    </div>
  );
}

function EvalRunSheet({ run, onClose }: { run: HarnessEvalRunDetail | null; onClose: () => void }) {
  return (
    <Sheet open={run != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {run ? (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono text-sm">{run.id}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <StatusBadge label={String(run.status ?? '—')} colorRole={workflowStatusRole(run.status)} />
                <span className="font-mono text-xs">
                  {run.modelName}
                  {run.modelVersion ? ` · ${run.modelVersion}` : ''}
                </span>
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4 pb-6">
              <dl className="space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">Golden set</dt>
                  <dd className="truncate font-mono text-xs">{run.goldenSetId}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">Started</dt>
                  <dd>{formatDateTime(run.startedAt ?? null)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">Completed</dt>
                  <dd>{formatDateTime(run.completedAt ?? null)}</dd>
                </div>
              </dl>
              <div>
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Scores</h4>
                {run.scores.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">No per-case scores recorded.</p>
                ) : (
                  <table className="mt-2 w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground/70">
                        <th className="py-1.5 pr-3 font-medium">Metric</th>
                        <th className="py-1.5 font-medium">Score</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {run.scores.map((s) => (
                        <tr key={s.id}>
                          <td className="py-1.5 pr-3 font-mono text-xs">{s.metric}</td>
                          <td className="py-1.5 tabular-nums">
                            {s.score}
                            {s.maxScore != null ? ` / ${s.maxScore}` : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
