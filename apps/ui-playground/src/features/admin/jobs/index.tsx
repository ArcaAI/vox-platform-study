import { useMemo, useState } from 'react';
import type { ColumnDef, PaginationState } from '@tanstack/react-table';
import { Main } from '@/components/layout/main';
import { useAuthStore } from '@/store/auth-store';
import { AdminApiError } from '../api/admin-client';
import { AdminDataTable } from '../components';
import {
  useAdminConsultations,
  useAdminTranscriptionJobs,
  useTranscriptionJobStats,
  type AdminConsultation,
  type AdminTranscriptionJob,
  type TranscriptionJobStats,
} from './api/jobs';
import { Badge } from '@arcaai/ui/badge';
import { Card, CardContent } from '@arcaai/ui/card';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { cn } from '@/lib/utils';
import { AlertCircle, Building2, MessageSquare, Mic } from 'lucide-react';

const STATUS_STYLES: Record<string, string> = {
  OPEN: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  CLOSED: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
  queued: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  processing: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-400',
  cancelled: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  dead: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
};

function StatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" className={cn('text-xs', STATUS_STYLES[status] ?? STATUS_STYLES[status.toUpperCase()] ?? '')}>
      {status}
    </Badge>
  );
}

function formatDate(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function shortId(id?: string | null) {
  if (!id) return '—';
  return `${id.slice(0, 8)}…`;
}

function doctorLabel(c: AdminConsultation): string {
  if (c.doctor) {
    const name = [c.doctor.firstName, c.doctor.lastName].filter(Boolean).join(' ').trim();
    return name || c.doctor.username || shortId(c.doctorId);
  }
  return shortId(c.doctorId);
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Failed to load data.';
}

function InlineError({ error }: { error: unknown }) {
  return (
    <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-md border p-3 text-sm">
      <AlertCircle className="size-4 shrink-0" />
      <span>{errorMessage(error)}</span>
    </div>
  );
}

const STAT_META: { key: keyof TranscriptionJobStats; label: string; tone: string }[] = [
  { key: 'queued', label: 'Queued', tone: 'text-blue-600 dark:text-blue-400' },
  { key: 'processing', label: 'Processing', tone: 'text-violet-600 dark:text-violet-400' },
  { key: 'completed', label: 'Completed', tone: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'failed', label: 'Failed', tone: 'text-red-600 dark:text-red-400' },
  { key: 'cancelled', label: 'Cancelled', tone: 'text-amber-600 dark:text-amber-400' },
  { key: 'dead', label: 'Dead', tone: 'text-zinc-600 dark:text-zinc-400' },
];

function TranscriptionStatsRow({ tenantId }: { tenantId: string }) {
  const { data, isLoading, isError } = useTranscriptionJobStats(tenantId);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {STAT_META.map(({ key, label, tone }) => (
        <Card key={key}>
          <CardContent className="p-4">
            <p className="text-muted-foreground text-xs">{label}</p>
            {isLoading ? (
              <Skeleton className="mt-1 h-7 w-10" />
            ) : (
              <p className={cn('text-2xl font-bold tabular-nums', tone)}>{isError ? '—' : (data?.[key] ?? 0)}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ConsultationsTab({ tenantId }: { tenantId: string }) {
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });

  const { data, isLoading, isFetching, isError, error } = useAdminConsultations(tenantId, {
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns = useMemo<ColumnDef<AdminConsultation, unknown>[]>(
    () => [
      {
        id: 'patientId',
        header: 'Patient',
        accessorKey: 'patientId',
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.patientId}</span>,
      },
      { id: 'doctor', header: 'Doctor', cell: ({ row }) => doctorLabel(row.original) },
      { id: 'department', header: 'Department', cell: ({ row }) => row.original.department?.name ?? row.original.department?.code ?? '—' },
      { id: 'appointmentDate', header: 'Appointment', cell: ({ row }) => row.original.appointmentDate || '—' },
      { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status ?? 'OPEN'} /> },
      {
        id: 'createdAt',
        header: 'Created',
        cell: ({ row }) => <span className="text-muted-foreground text-xs">{formatDate(row.original.createdAt)}</span>,
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      {isError && <InlineError error={error} />}
      <AdminDataTable
        data={data?.data ?? []}
        columns={columns}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.count ?? 0}
        isLoading={isLoading || isFetching}
        emptyMessage="No consultations in this tenant."
      />
    </div>
  );
}

function TranscriptionJobsTab({ tenantId }: { tenantId: string }) {
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 20 });

  const { data, isLoading, isFetching, isError, error } = useAdminTranscriptionJobs(tenantId, {
    page: pagination.pageIndex + 1,
    limit: pagination.pageSize,
  });

  const columns = useMemo<ColumnDef<AdminTranscriptionJob, unknown>[]>(
    () => [
      { id: 'id', header: 'Job', cell: ({ row }) => <span className="font-mono text-xs">{shortId(row.original.id)}</span> },
      { id: 'jobType', header: 'Type', cell: ({ row }) => <span className="text-xs">{row.original.jobType}</span> },
      { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge status={row.original.status} /> },
      { id: 'progress', header: 'Progress', cell: ({ row }) => <span className="tabular-nums">{row.original.progress}%</span> },
      {
        id: 'consultationId',
        header: 'Consultation',
        cell: ({ row }) => <span className="font-mono text-xs">{shortId(row.original.consultationId)}</span>,
      },
      {
        id: 'retries',
        header: 'Retries',
        cell: ({ row }) => <span className="tabular-nums">{`${row.original.retryCount}/${row.original.maxRetries}`}</span>,
      },
      {
        id: 'queuedAt',
        header: 'Queued',
        cell: ({ row }) => <span className="text-muted-foreground text-xs">{formatDate(row.original.queuedAt)}</span>,
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      {isError && <InlineError error={error} />}
      <AdminDataTable
        data={data?.data ?? []}
        columns={columns}
        pagination={pagination}
        onPaginationChange={setPagination}
        rowCount={data?.total ?? 0}
        isLoading={isLoading || isFetching}
        emptyMessage="No transcription jobs in this tenant."
      />
    </div>
  );
}

export default function AdminJobsPage() {
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());
  const tenantId = useAuthStore((s) => s.tenantId);
  const tenantName = useAuthStore((s) => s.tenantName);

  const needsTenant = isGlobalScope && !tenantId;
  const tenantLabel = tenantName || (tenantId ? `${tenantId.slice(0, 8)}\u2026` : '');

  return (
    <Main>
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight">Jobs</h2>
        <p className="text-muted-foreground mt-1">Tenant-wide consultations and transcription jobs{tenantLabel ? ` for ${tenantLabel}` : ''}.</p>
      </div>

      {needsTenant ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <Building2 className="text-muted-foreground size-8" />
            <p className="text-sm font-medium">Select a tenant</p>
            <p className="text-muted-foreground max-w-sm text-sm">
              Pick a tenant from the scope switcher in the header to view its consultations and transcription jobs.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          <div>
            <h3 className="mb-2 text-sm font-medium">Transcription job status</h3>
            <TranscriptionStatsRow tenantId={tenantId} />
          </div>

          <Tabs defaultValue="consultations" className="gap-4">
            <TabsList>
              <TabsTrigger value="consultations">
                <MessageSquare className="mr-1.5 size-4" />
                Consultations
              </TabsTrigger>
              <TabsTrigger value="transcription">
                <Mic className="mr-1.5 size-4" />
                Transcription Jobs
              </TabsTrigger>
            </TabsList>
            <TabsContent value="consultations">
              <ConsultationsTab tenantId={tenantId} />
            </TabsContent>
            <TabsContent value="transcription">
              <TranscriptionJobsTab tenantId={tenantId} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </Main>
  );
}
