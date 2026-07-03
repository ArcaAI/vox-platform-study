/**
 * TASK-407 — Agent Jobs. NO drawn design exists for this surface (flagged in
 * the ticket README); it mirrors the TASK-379/380 tenant-detail patterns:
 * per-agent summary (PromptTemplate + last prompt-test outcome) and the
 * tenant's PromptUsageRecord run history (endpoint added in this task).
 */

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useDepartments, usePrompts, type PromptTemplate } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { Bot, ChevronLeft, ChevronRight, PlayCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { agentSummaryRows, resolveRunRows, scoreColorRole, type AgentRunRow } from '@/features/agent-jobs/run-model';
import { isSuperAdmin } from '@/features/tenants/permissions';
import { ActingOnBanner } from '@/features/tenants/tenant-context';
import { formatDateTime } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/agent-jobs')({
  component: AgentJobsPage,
});

const PAGE_SIZE = 20;

function shortId(v: string | null): string {
  if (!v) return '—';
  return v.length <= 8 ? v : `${v.slice(0, 8)}…`;
}

function AgentJobsPage() {
  const { tenantId } = Route.useParams();
  const tenant = useTenantDetailStore((s) => s.tenant);
  const roles = useAuthStore((s) => s.user?.roles);
  const superAdmin = isSuperAdmin(roles);

  const { list: listTemplates, listUsageRecords } = usePrompts();
  const { list: listDepartments } = useDepartments();

  const [templates, setTemplates] = useState<PromptTemplate[] | null>(null);
  const [deptNameById, setDeptNameById] = useState<ReadonlyMap<string, string>>(new Map());
  const [rows, setRows] = useState<AgentRunRow[] | null>(null);
  const [rawCount, setRawCount] = useState(0);
  const [page, setPage] = useState(1);
  const [templateFilter, setTemplateFilter] = useState<string>('ALL');

  useEffect(() => {
    void listTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]));
    void listDepartments()
      .then((ds) => setDeptNameById(new Map(ds.map((d) => [d.id, d.name]))))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => {
    if (templates == null) return;
    setRows(null);
    void listUsageRecords({ page, limit: PAGE_SIZE, promptTemplateId: templateFilter === 'ALL' ? undefined : templateFilter })
      .then((r) => {
        setRows(resolveRunRows(r.data, templates, deptNameById));
        setRawCount(r.count);
      })
      .catch(() => {
        setRows([]);
        setRawCount(0);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, page, templateFilter, templates, deptNameById]);

  const agents = useMemo(() => (templates ? agentSummaryRows(templates) : []), [templates]);
  const totalPages = Math.max(1, Math.ceil(rawCount / PAGE_SIZE));

  return (
    <div className="space-y-5">
      {/* Per-agent summary — templates with their last prompt-test outcome. */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Agents</h2>
          <Bot className="size-4 shrink-0 text-muted-foreground" />
        </div>
        {templates == null ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : agents.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">No agents (prompt templates) in this tenant.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground/70">
                <th className="px-5 py-2.5 font-medium">Agent</th>
                <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Category</th>
                <th className="hidden px-5 py-2.5 font-medium md:table-cell">Status</th>
                <th className="px-5 py-2.5 font-medium">Last test</th>
                <th className="hidden px-5 py-2.5 font-medium lg:table-cell">Tested</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {agents.map((a) => (
                <tr key={a.id}>
                  <td className="max-w-0 px-5 py-2.5">
                    <span className="block truncate font-medium">{a.name}</span>
                  </td>
                  <td className="hidden px-5 py-2.5 sm:table-cell">
                    {a.category ? <Badge variant="outline">{a.category}</Badge> : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="hidden px-5 py-2.5 md:table-cell">
                    {a.status ? (
                      <StatusBadge
                        label={a.status.charAt(0) + a.status.slice(1).toLowerCase()}
                        colorRole={a.status.toUpperCase() === 'PUBLISHED' ? 'success' : 'neutral'}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-5 py-2.5">
                    {a.lastTestScore != null ? (
                      <StatusBadge label={`${a.lastTestScore}/100`} colorRole={scoreColorRole(a.lastTestScore)} />
                    ) : (
                      <span className="text-muted-foreground">Never tested</span>
                    )}
                  </td>
                  <td className="hidden whitespace-nowrap px-5 py-2.5 text-muted-foreground lg:table-cell">{formatDateTime(a.lastTestAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Run history — PromptUsageRecord rows, newest first. */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Runs</h2>
          <Select
            value={templateFilter}
            onValueChange={(v) => {
              setTemplateFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-9 w-56" aria-label="Filter by agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All agents</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {rows == null ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlayCircle />
              </EmptyMedia>
              <EmptyTitle>No runs</EmptyTitle>
              <EmptyDescription>
                {templateFilter === 'ALL' ? 'No agent runs recorded for this tenant yet.' : 'No runs for this agent yet.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground/70">
                <th className="px-5 py-2.5 font-medium">Agent</th>
                <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Version</th>
                <th className="hidden px-5 py-2.5 font-medium md:table-cell">Consultation</th>
                <th className="hidden px-5 py-2.5 font-medium lg:table-cell">Department</th>
                <th className="px-5 py-2.5 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="max-w-0 px-5 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{r.templateName ?? 'Deleted agent'}</span>
                      {r.category ? (
                        <Badge variant="outline" className="hidden shrink-0 sm:inline-flex">
                          {r.category}
                        </Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="hidden px-5 py-2.5 tabular-nums text-muted-foreground sm:table-cell">{r.version != null ? `v${r.version}` : '—'}</td>
                  <td className="hidden px-5 py-2.5 font-mono text-xs text-muted-foreground md:table-cell" title={r.consultationId ?? undefined}>
                    {shortId(r.consultationId)}
                  </td>
                  <td className="hidden px-5 py-2.5 text-muted-foreground lg:table-cell">{r.departmentName ?? '—'}</td>
                  <td className="whitespace-nowrap px-5 py-2.5 text-muted-foreground">{formatDateTime(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
          <p className="text-xs text-muted-foreground">
            {rawCount} run{rawCount === 1 ? '' : 's'} · prompt-usage records are append-only.
          </p>
          {totalPages > 1 ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                <ChevronLeft className="size-4" />
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                <ChevronRight className="size-4" />
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      {superAdmin && tenant ? (
        <ActingOnBanner
          tenantName={tenant.name}
          description="Agent (prompt-template) run history for this tenant. Deeper prompt editing and test playgrounds live under Departments → Agents."
        />
      ) : null}
    </div>
  );
}
