import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@arcaai/ui';
import { ScrollText, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { cn } from '@/lib/utils';
import { useHarnessAudit, type HarnessAuditEventResponse } from '../api/harness';
import { EmptyState } from '../components/empty-state';
import { formatDateTime, shortId } from '../lib/format';

const PAGE_SIZE = 25;
const ALL = '__all__';

// HarnessAuditAction enum (packages/domains/.../HarnessAuditAction.ts). The
// server filters only by consultationId + pagination, so action/date are
// applied client-side over the loaded page.
const ACTION_OPTIONS = [
  'GENERATE',
  'SENSOR_RUN',
  'GATE_DECISION',
  'ATTEST',
  'CONSENT_GIVEN',
  'CONSENT_WITHDRAWN',
  'BREACH_REPORTED',
  'REDUCED_ASSURANCE',
] as const;

const ACTION_COLOR: Record<string, string> = {
  GENERATE: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  SENSOR_RUN: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  GATE_DECISION: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  ATTEST: 'bg-teal-500/15 text-teal-700 dark:text-teal-400',
  BREACH_REPORTED: 'bg-red-500/15 text-red-700 dark:text-red-400',
  REDUCED_ASSURANCE: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
};

function ChainBadge({
  valid,
  brokenAtIndex,
  reason,
  loading,
}: {
  valid?: boolean;
  brokenAtIndex?: number | null;
  reason?: string | null;
  loading?: boolean;
}) {
  if (loading) return <Skeleton className="h-6 w-36 rounded-full" data-testid="audit-chain-skeleton" />;
  if (valid === undefined) return null;
  if (valid) {
    return (
      <Badge variant="outline" className="gap-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" data-testid="audit-chain-badge">
        <ShieldCheck className="size-3.5" aria-hidden />
        Chain verified
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="gap-1 bg-red-500/15 text-red-700 dark:text-red-400"
      title={reason ?? undefined}
      data-testid="audit-chain-badge"
    >
      <ShieldAlert className="size-3.5" aria-hidden />
      Chain broken{brokenAtIndex != null ? ` at #${brokenAtIndex}` : ''}
    </Badge>
  );
}

function startOfDay(date?: string) {
  return date ? new Date(`${date}T00:00:00.000`).getTime() : undefined;
}
function endOfDay(date?: string) {
  return date ? new Date(`${date}T23:59:59.999`).getTime() : undefined;
}

export default function HarnessAuditPage() {
  const tenantId = useAuthStore((s) => s.tenantId);

  // Draft filters (the consultationId is server-backed; action/date are client-side).
  const [consultationDraft, setConsultationDraft] = useState('');
  const [consultationId, setConsultationId] = useState('');
  const [action, setAction] = useState<string>(ALL);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);

  const { data, isLoading, isFetching } = useHarnessAudit({
    tenantId: tenantId || undefined,
    consultationId: consultationId.trim() || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const filtered = useMemo(() => {
    const fromMs = startOfDay(from);
    const toMs = endOfDay(to);
    return items.filter((event) => {
      if (action !== ALL && event.action !== action) return false;
      const ts = new Date(event.createdAt).getTime();
      if (fromMs !== undefined && ts < fromMs) return false;
      if (toMs !== undefined && ts > toMs) return false;
      return true;
    });
  }, [items, action, from, to]);

  const applyFilters = () => {
    setPage(0);
    setConsultationId(consultationDraft);
  };
  const resetFilters = () => {
    setConsultationDraft('');
    setConsultationId('');
    setAction(ALL);
    setFrom('');
    setTo('');
    setPage(0);
  };

  const [detail, setDetail] = useState<HarnessAuditEventResponse | null>(null);

  const showSkeleton = isLoading && items.length === 0;
  const showEmpty = !isLoading && filtered.length === 0;
  const nextDisabled = (page + 1) * PAGE_SIZE >= total;

  return (
    <section aria-label="Harness audit trail">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Audit trail</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Append-only, hash-chained WORM events. The integrity verdict covers the full tenant chain.
          </p>
        </div>
        <ChainBadge
          valid={data?.verification.valid}
          brokenAtIndex={data?.verification.brokenAtIndex}
          reason={data?.verification.reason}
          loading={isLoading && !data}
        />
      </div>

      {/* Filter bar */}
      <div className="mb-4 grid gap-3 rounded-md border p-3 md:grid-cols-2 lg:grid-cols-5" data-testid="audit-filter-bar">
        <div className="flex flex-col gap-1">
          <Label htmlFor="harness-audit-consultation">Consultation ID</Label>
          <Input
            id="harness-audit-consultation"
            value={consultationDraft}
            placeholder="consultation id"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConsultationDraft(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') applyFilters();
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Action</Label>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger data-testid="audit-action-select">
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All actions</SelectItem>
              {ACTION_OPTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="harness-audit-from">From</Label>
          <Input id="harness-audit-from" type="date" value={from} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFrom(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="harness-audit-to">To</Label>
          <Input id="harness-audit-to" type="date" value={to} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)} />
        </div>
        <div className="flex items-end gap-2">
          <Button onClick={applyFilters} className="flex-1" data-testid="audit-apply">
            Apply
          </Button>
          <Button variant="outline" onClick={resetFilters} data-testid="audit-reset">
            Reset
          </Button>
        </div>
      </div>

      {/* Results */}
      <div className="rounded-md border" data-testid="audit-results">
        {showSkeleton ? (
          <div className="space-y-2 p-3" data-testid="audit-skeleton">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : showEmpty ? (
          <EmptyState icon={ScrollText} title="No audit events" description="No WORM events match the current filters for this tenant." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Gate decision</TableHead>
                <TableHead>Consultation</TableHead>
                <TableHead>Hash</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((event) => (
                <TableRow key={event.id} className="cursor-pointer" data-testid="audit-row" onClick={() => setDetail(event)}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(event.createdAt)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn('text-xs', ACTION_COLOR[event.action] ?? 'bg-muted')}>
                      {event.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-40 truncate text-sm">
                    {event.modelName}
                    {event.modelVersion ? <span className="text-muted-foreground"> · {event.modelVersion}</span> : null}
                  </TableCell>
                  <TableCell>{event.gateDecision ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{shortId(event.consultationId)}</TableCell>
                  <TableCell className="font-mono text-xs">{event.hash.slice(0, 10)}…</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      <div className="mt-3 flex items-center justify-end gap-2">
        <span className="text-muted-foreground text-sm" data-testid="audit-pagination-info">
          {total > 0 ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}` : '0 events'}
        </span>
        <Button variant="outline" size="sm" disabled={page <= 0 || isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={nextDisabled || isFetching} onClick={() => setPage((p) => p + 1)}>
          Next
        </Button>
      </div>

      {/* Detail drawer */}
      <Sheet open={detail !== null} onOpenChange={(open: boolean) => !open && setDetail(null)}>
        <SheetContent className="w-full overflow-hidden sm:max-w-xl" data-testid="audit-detail-drawer">
          <SheetHeader>
            <SheetTitle>Audit event</SheetTitle>
            <SheetDescription>{detail ? `${detail.action} · ${formatDateTime(detail.createdAt)}` : '—'}</SheetDescription>
          </SheetHeader>
          {detail && (
            <ScrollArea className="h-[calc(100vh-8rem)] px-4 pb-6">
              <dl className="grid grid-cols-3 gap-2 text-sm">
                <DetailRow label="Event ID" value={detail.id} mono />
                <DetailRow label="Consultation" value={detail.consultationId} mono />
                <DetailRow label="Action" value={detail.action} />
                <DetailRow label="Model" value={`${detail.modelName} · ${detail.modelVersion}`} />
                <DetailRow label="Gate decision" value={detail.gateDecision ?? '—'} />
                <DetailRow label="Clinician" value={detail.clinicianId ?? '—'} mono />
                <DetailRow label="Prev hash" value={detail.prevHash} mono />
                <DetailRow label="Hash" value={detail.hash} mono />
                <DetailRow label="Attestation" value={detail.attestationHash ?? '—'} mono />
                <DetailRow label="Created" value={formatDateTime(detail.createdAt)} />
              </dl>
              <div className="mt-4 grid gap-4">
                <div>
                  <p className="mb-1 text-sm font-medium">Sensor scores</p>
                  <pre className="bg-muted max-h-[30vh] overflow-auto rounded-md p-3 text-xs" data-testid="audit-detail-sensors">
                    {JSON.stringify(detail.sensorScores ?? {}, null, 2)}
                  </pre>
                </div>
                <div>
                  <p className="mb-1 text-sm font-medium">Citations</p>
                  <pre className="bg-muted max-h-[30vh] overflow-auto rounded-md p-3 text-xs" data-testid="audit-detail-citations">
                    {JSON.stringify(detail.citations ?? {}, null, 2)}
                  </pre>
                </div>
              </div>
            </ScrollArea>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground col-span-1">{label}</dt>
      <dd className={cn('col-span-2 break-all', mono && 'font-mono text-xs')}>{value}</dd>
    </>
  );
}
