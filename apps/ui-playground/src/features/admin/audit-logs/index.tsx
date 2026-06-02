import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
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
import { useAuditLog, type AuditLogEntry, type AuditLogFilterParams } from '@arcaai/vox';
import { Download } from 'lucide-react';
import { Main } from '@/components/layout/main';

const PAGE_SIZE = 25;
const ALL = '__all__';

// Mirrors the AuditAction / ResourceType enums (packages/database/.../audit.prisma).
// A curated list keeps the selects usable; "All" clears the filter.
const ACTION_OPTIONS = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'ARCHIVE', 'LOGIN', 'LOGOUT', 'IMPERSONATED_ACTION'] as const;
const RESOURCE_OPTIONS = [
  'User',
  'Consultation',
  'AuditLog',
  'Role',
  'Permission',
  'Tag',
  'Tenant',
  'Department',
  'ApiKey',
  'Media',
  'Notification',
  'Session',
  'AiModel',
  'TranscriptionJob',
  'PromptTemplate',
  'Webhook',
  'GlobalSetting',
] as const;

const ACTION_COLOR: Record<string, string> = {
  CREATE: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  UPDATE: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  DELETE: 'bg-red-500/15 text-red-700 dark:text-red-400',
  LOGIN: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  LOGOUT: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
};

function formatDate(date?: string) {
  if (!date) return '—';
  return new Date(date).toLocaleString();
}

/** UTC start/end-of-day boundaries so the server `gte`/`lte` range is inclusive. */
function toIsoStart(date?: string) {
  return date ? new Date(`${date}T00:00:00.000Z`).toISOString() : undefined;
}
function toIsoEnd(date?: string) {
  return date ? new Date(`${date}T23:59:59.999Z`).toISOString() : undefined;
}

function responsibleUserLabel(entry: AuditLogEntry): string {
  const user = entry.responsibleUser;
  if (user) return user.displayName || user.email || user.id;
  return entry.responsibleUserId ?? '—';
}

export default function AuditLogManagementPage() {
  const { entries, isLoading, error, list, getById, exportCsv } = useAuditLog();

  // Draft filter state (committed via "Apply" / select changes).
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [action, setAction] = useState<string>(ALL);
  const [resourceType, setResourceType] = useState<string>(ALL);
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState(1);

  // Committed params actually sent to the hook. Bumping `applyToken` re-commits.
  const [applyToken, setApplyToken] = useState(0);

  const params = useMemo<AuditLogFilterParams>(
    () => ({
      page,
      limit: PAGE_SIZE,
      from: toIsoStart(from),
      to: toIsoEnd(to),
      action: action === ALL ? undefined : action,
      resourceType: resourceType === ALL ? undefined : resourceType,
      userId: userId.trim() || undefined,
    }),
    // `applyToken` forces a re-fetch when the user clicks Apply without changing
    // the date inputs (they otherwise debounce poorly with text typing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, applyToken],
  );

  useEffect(() => {
    void list(params).catch(() => undefined); // error surfaced via `error` + toast below
  }, [list, params]);

  useEffect(() => {
    if (error) toast.error(error.message || 'Failed to load audit logs');
  }, [error]);

  const applyFilters = useCallback(() => {
    setPage(1);
    setApplyToken((token) => token + 1);
  }, []);

  const resetFilters = useCallback(() => {
    setFrom('');
    setTo('');
    setAction(ALL);
    setResourceType(ALL);
    setUserId('');
    setPage(1);
    setApplyToken((token) => token + 1);
  }, []);

  // Detail drawer ----------------------------------------------------------
  const [detail, setDetail] = useState<AuditLogEntry | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const openDetail = useCallback(
    async (entry: AuditLogEntry) => {
      setDetailOpen(true);
      setDetail(entry); // optimistic: show row data immediately
      setDetailLoading(true);
      try {
        const full = await getById(entry.id);
        setDetail(full);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to load audit entry');
      } finally {
        setDetailLoading(false);
      }
    },
    [getById],
  );

  // CSV export -------------------------------------------------------------
  const [exporting, setExporting] = useState(false);
  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const csv = await exportCsv(params);
      if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      }
      toast.success('Audit log CSV exported');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'CSV export failed');
    } finally {
      setExporting(false);
    }
  }, [exportCsv, params]);

  const showSkeleton = isLoading && entries.length === 0;
  const showEmpty = !isLoading && entries.length === 0;

  return (
    <Main>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Audit Log</h2>
          <p className="text-muted-foreground mt-1">
            Filter the tenant-scoped audit trail, inspect a single entry, and export the current view to CSV.
          </p>
        </div>
        <Button onClick={handleExport} disabled={exporting} data-testid="export-csv">
          <Download className="mr-2 size-4" />
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>

      {/* Filter bar */}
      <div className="mb-4 grid gap-3 rounded-md border p-3 md:grid-cols-2 lg:grid-cols-6" data-testid="audit-filter-bar">
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-from">From</Label>
          <Input id="audit-from" type="date" value={from} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFrom(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-to">To</Label>
          <Input id="audit-to" type="date" value={to} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)} />
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
          <Label>Resource</Label>
          <Select value={resourceType} onValueChange={setResourceType}>
            <SelectTrigger data-testid="audit-resource-select">
              <SelectValue placeholder="All resources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All resources</SelectItem>
              {RESOURCE_OPTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-user">User ID</Label>
          <Input
            id="audit-user"
            value={userId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUserId(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') applyFilters();
            }}
            placeholder="responsible user id"
          />
        </div>
        <div className="flex items-end gap-2">
          <Button onClick={applyFilters} data-testid="apply-filters" className="flex-1">
            Apply
          </Button>
          <Button variant="outline" onClick={resetFilters} data-testid="reset-filters">
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
          <div className="text-muted-foreground p-8 text-center text-sm" data-testid="audit-empty">
            No audit logs match the current filters.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Resource</TableHead>
                <TableHead>Resource ID</TableHead>
                <TableHead>Responsible user</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow
                  key={entry.id}
                  className="cursor-pointer"
                  data-testid="audit-row"
                  onClick={() => void openDetail(entry)}
                >
                  <TableCell className="whitespace-nowrap">{formatDate(entry.createdAt)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={ACTION_COLOR[entry.action ?? ''] ?? 'bg-muted'}>
                      {entry.action ?? '—'}
                    </Badge>
                  </TableCell>
                  <TableCell>{entry.resourceType ?? '—'}</TableCell>
                  <TableCell>
                    <span className="block max-w-48 truncate font-mono text-xs">{String(entry.resourceId ?? '—')}</span>
                  </TableCell>
                  <TableCell data-testid="audit-responsible-user">{responsibleUserLabel(entry)}</TableCell>
                  <TableCell>{String(entry.responsibleIp ?? '—')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      <div className="mt-3 flex items-center justify-end gap-2">
        <span className="text-muted-foreground text-sm">Page {page}</span>
        <Button variant="outline" size="sm" disabled={page <= 1 || isLoading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={entries.length < PAGE_SIZE || isLoading}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>

      {/* Detail drawer */}
      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent className="w-full overflow-hidden sm:max-w-xl" data-testid="audit-detail-drawer">
          <SheetHeader>
            <SheetTitle>Audit entry</SheetTitle>
            <SheetDescription>{detail ? `${detail.action} · ${detail.resourceType}` : 'Loading…'}</SheetDescription>
          </SheetHeader>
          {detail && (
            <ScrollArea className="h-[calc(100vh-8rem)] px-4 pb-6">
              <dl className="grid grid-cols-3 gap-2 text-sm">
                <DetailRow label="ID" value={detail.id} mono />
                <DetailRow label="Timestamp" value={formatDate(detail.createdAt)} />
                <DetailRow label="Action" value={detail.action ?? '—'} />
                <DetailRow label="Resource" value={detail.resourceType ?? '—'} />
                <DetailRow label="Resource ID" value={String(detail.resourceId ?? '—')} mono />
                <DetailRow label="Responsible" value={responsibleUserLabel(detail)} />
                <DetailRow label="IP" value={String(detail.responsibleIp ?? '—')} />
                <DetailRow label="Success" value={detail.success == null ? '—' : String(detail.success)} />
              </dl>
              <div className="mt-4">
                <p className="mb-1 text-sm font-medium">Payload</p>
                <pre
                  className="bg-muted max-h-[40vh] overflow-auto rounded-md p-3 text-xs"
                  data-testid="audit-detail-data"
                >
                  {detailLoading ? 'Loading…' : JSON.stringify(detail.data ?? {}, null, 2)}
                </pre>
              </div>
            </ScrollArea>
          )}
        </SheetContent>
      </Sheet>
    </Main>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground col-span-1">{label}</dt>
      <dd className={`col-span-2 break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </>
  );
}
