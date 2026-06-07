import { useState } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@arcaai/ui';
import { Ban, Octagon, RefreshCw, Workflow as WorkflowIcon, Zap } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { cn } from '@/lib/utils';
import { AdminApiError } from '../../api/admin-client';
import { ConfirmDialog } from '../../components';
import { useCancelWorkflow, useHarnessWorkflows, useSignalWorkflow, useTerminateWorkflow, type HarnessWorkflowSummary } from '../api/harness';
import { EmptyState } from '../components/empty-state';
import { formatDateTime, formatDuration, shortId } from '../lib/format';

const PAGE_SIZE = 50;
const POLL_MS = 15000;
const ALL = '__all__';
const STATUS_OPTIONS = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT', 'CONTINUED_AS_NEW'] as const;

function statusTone(status: string): string {
  switch (status.toUpperCase()) {
    case 'RUNNING':
      return 'bg-blue-500/15 text-blue-700 dark:text-blue-400';
    case 'COMPLETED':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400';
    case 'FAILED':
    case 'TERMINATED':
    case 'TIMED_OUT':
      return 'bg-red-500/15 text-red-700 dark:text-red-400';
    case 'CANCELED':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
    default:
      return 'bg-muted';
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

type ConfirmTarget = { kind: 'cancel' | 'terminate'; workflow: HarnessWorkflowSummary } | null;

export default function HarnessWorkflowsPage() {
  const tenantId = useAuthStore((s) => s.tenantId);

  const [status, setStatus] = useState<string>(ALL);
  const [consultationDraft, setConsultationDraft] = useState('');
  const [consultationId, setConsultationId] = useState('');
  // Cursor pagination: `pageToken` drives the request; `history` lets us page back.
  const [pageToken, setPageToken] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<string[]>([]);

  const { data, isLoading, isFetching, refetch } = useHarnessWorkflows(
    {
      tenantId: tenantId || undefined,
      status: status === ALL ? undefined : status,
      consultationId: consultationId.trim() || undefined,
      limit: PAGE_SIZE,
      pageToken,
    },
    { refetchInterval: POLL_MS },
  );

  const workflows = data?.items ?? [];

  const cancelMutation = useCancelWorkflow();
  const terminateMutation = useTerminateWorkflow();
  const signalMutation = useSignalWorkflow();

  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget>(null);
  const [signalTarget, setSignalTarget] = useState<HarnessWorkflowSummary | null>(null);
  const [signalName, setSignalName] = useState('approve');
  const [signalPayload, setSignalPayload] = useState('');

  const applyFilters = () => {
    setPageToken(undefined);
    setHistory([]);
    setConsultationId(consultationDraft);
  };
  const onStatusChange = (next: string) => {
    setStatus(next);
    setPageToken(undefined);
    setHistory([]);
  };

  const goNext = () => {
    if (!data?.nextPageToken) return;
    setHistory((h) => [...h, pageToken ?? '']);
    setPageToken(data.nextPageToken);
  };
  const goPrev = () => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const next = [...h];
      const prev = next.pop();
      setPageToken(prev || undefined);
      return next;
    });
  };

  const runConfirm = () => {
    if (!confirmTarget) return;
    const { kind, workflow } = confirmTarget;
    const vars = { workflowId: workflow.workflowId, tenantId: tenantId || undefined };
    const mutation = kind === 'cancel' ? cancelMutation : terminateMutation;
    mutation.mutate(vars, {
      onSuccess: () => {
        toast.success(kind === 'cancel' ? 'Workflow cancellation requested' : 'Workflow terminated');
        setConfirmTarget(null);
      },
      onError: (e) => toast.error(errorMessage(e, `Failed to ${kind} workflow`)),
    });
  };

  const runSignal = () => {
    if (!signalTarget) return;
    if (!signalName.trim()) {
      toast.error('Signal name is required.');
      return;
    }
    let payload: Record<string, unknown> | undefined;
    if (signalPayload.trim()) {
      try {
        payload = JSON.parse(signalPayload);
      } catch {
        toast.error('Payload must be valid JSON.');
        return;
      }
    }
    signalMutation.mutate(
      { workflowId: signalTarget.workflowId, signalName: signalName.trim(), payload, tenantId: tenantId || undefined },
      {
        onSuccess: () => {
          toast.success(`Signal "${signalName.trim()}" sent`);
          setSignalTarget(null);
          setSignalPayload('');
        },
        onError: (e) => toast.error(errorMessage(e, 'Failed to signal workflow')),
      },
    );
  };

  const showSkeleton = isLoading && workflows.length === 0;
  const showEmpty = !isLoading && workflows.length === 0;

  return (
    <section aria-label="Harness workflows">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Document workflows</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Live Temporal document-loop workflows. Cancel, terminate, or re-signal running workflows.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching} data-testid="workflows-refresh">
          <RefreshCw className={cn('mr-2 size-4', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-md border p-3" data-testid="workflows-filter-bar">
        <div className="flex flex-col gap-1">
          <Label>Status</Label>
          <Select value={status} onValueChange={onStatusChange}>
            <SelectTrigger className="w-44" data-testid="workflows-status-select">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <Label htmlFor="workflows-consultation">Consultation ID</Label>
          <Input
            id="workflows-consultation"
            value={consultationDraft}
            placeholder="filter by consultation"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConsultationDraft(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') applyFilters();
            }}
          />
        </div>
        <Button onClick={applyFilters} data-testid="workflows-apply">
          Apply
        </Button>
      </div>

      {/* Results */}
      <div className="rounded-md border" data-testid="workflows-results">
        {showSkeleton ? (
          <div className="space-y-2 p-3" data-testid="workflows-skeleton">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : showEmpty ? (
          <EmptyState icon={WorkflowIcon} title="No workflows" description="No harness document workflows match the current filters." />
        ) : (
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Consultation</TableHead>
                  <TableHead>Phase</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">SLA</TableHead>
                  <TableHead className="text-right">Regens</TableHead>
                  <TableHead className="text-right">Escalations</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.map((wf) => {
                  const isRunning = wf.status.toUpperCase() === 'RUNNING';
                  return (
                    <TableRow key={`${wf.workflowId}:${wf.runId ?? ''}`} data-testid="workflows-row">
                      <TableCell className="font-mono text-xs" title={wf.workflowId}>
                        {shortId(wf.workflowId)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{shortId(wf.consultationId)}</TableCell>
                      <TableCell>
                        {wf.phase ? (
                          <Badge variant="secondary" className="text-[10px]">
                            {wf.phase}
                          </Badge>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn('text-xs', statusTone(wf.status))}>
                          {wf.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatDuration(wf.slaSeconds)}</TableCell>
                      <TableCell className="text-right tabular-nums">{wf.regenCount ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{wf.escalations ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{formatDateTime(wf.startedAt)}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7"
                            disabled={!isRunning}
                            onClick={() => setSignalTarget(wf)}
                            data-testid="workflows-signal"
                          >
                            <Zap className="mr-1 size-3" />
                            Signal
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-amber-600 hover:text-amber-700 h-7 dark:text-amber-400"
                            disabled={!isRunning}
                            onClick={() => setConfirmTarget({ kind: 'cancel', workflow: wf })}
                            data-testid="workflows-cancel"
                          >
                            <Ban className="mr-1 size-3" />
                            Cancel
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive h-7"
                            disabled={!isRunning}
                            onClick={() => setConfirmTarget({ kind: 'terminate', workflow: wf })}
                            data-testid="workflows-terminate"
                          >
                            <Octagon className="mr-1 size-3" />
                            Terminate
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Pagination (cursor) */}
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" disabled={history.length === 0 || isFetching} onClick={goPrev}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={!data?.nextPageToken || isFetching} onClick={goNext}>
          Next
        </Button>
      </div>

      {/* Confirm cancel / terminate */}
      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
        title={confirmTarget?.kind === 'terminate' ? 'Terminate workflow?' : 'Cancel workflow?'}
        description={
          confirmTarget?.kind === 'terminate'
            ? `Forcefully terminate workflow ${shortId(confirmTarget?.workflow.workflowId)}. The clinical document loop stops immediately and cannot resume. This is recorded in the workflow history.`
            : `Gracefully cancel workflow ${shortId(confirmTarget?.workflow.workflowId)}. The current document loop will stop at its next checkpoint.`
        }
        confirmLabel={confirmTarget?.kind === 'terminate' ? 'Terminate' : 'Cancel workflow'}
        cancelLabel="Keep running"
        variant="destructive"
        isLoading={cancelMutation.isPending || terminateMutation.isPending}
        onConfirm={runConfirm}
      />

      {/* Signal dialog */}
      <Dialog open={signalTarget !== null} onOpenChange={(open: boolean) => !open && setSignalTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Signal workflow</DialogTitle>
            <DialogDescription>
              Deliver a Temporal signal to workflow <span className="font-mono">{shortId(signalTarget?.workflowId)}</span> (e.g. <code>approve</code>{' '}
              to release the clinician gate).
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="signal-name">
                Signal name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="signal-name"
                value={signalName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSignalName(e.target.value)}
                placeholder="approve"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="signal-payload">Payload (optional JSON)</Label>
              <Textarea
                id="signal-payload"
                value={signalPayload}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setSignalPayload(e.target.value)}
                placeholder='{ "clinicianId": "…" }'
                className="resize-none font-mono text-xs"
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSignalTarget(null)} disabled={signalMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={runSignal} disabled={signalMutation.isPending}>
              Send signal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
