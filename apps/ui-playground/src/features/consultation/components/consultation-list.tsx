import { useArca, DEFAULT_PAGE_SIZE } from '@arcaai/vox';
import type { Consultation } from '@arcaai/vox';
import { Card, CardContent } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Skeleton } from '@arcaai/ui/skeleton';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, useCallback, useRef } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { FileText, ChevronRight, RefreshCw, Search, ChevronLeft, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

const statusVariant: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  OPEN: 'default',
  RECORDING: 'default',
  TRANSCRIBING: 'secondary',
  SUMMARIZING: 'secondary',
  REVIEW: 'outline',
  CLOSED: 'secondary',
  CANCELLED: 'destructive',
  active: 'default',
  completed: 'secondary',
  cancelled: 'destructive',
};

interface DoctorInfo {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
}

interface DepartmentInfo {
  id: string;
  code?: string;
  name?: string;
}

function getDoctorDisplayName(c: Consultation): string | undefined {
  if (c.doctorName) return c.doctorName;
  const doc = (c as unknown as Record<string, unknown>).doctor as DoctorInfo | undefined;
  if (!doc) return undefined;
  const parts = [doc.firstName, doc.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : doc.username;
}

function getDepartmentDisplayName(c: Consultation): string | undefined {
  if (typeof c.department === 'string') return c.department;
  const dept = (c as unknown as Record<string, unknown>).department as DepartmentInfo | undefined;
  if (!dept) return undefined;
  return dept.name || dept.code || undefined;
}

function getConsultationStatus(c: Consultation): string | undefined {
  if (c.status) return c.status;
  const meta = c.metadata as Record<string, unknown> | undefined;
  return (meta?.status as string) ?? undefined;
}

export function ConsultationList() {
  const { session } = useArca();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const navigate = useNavigate();
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const totalPages = Math.max(1, Math.ceil(totalCount / DEFAULT_PAGE_SIZE));

  const loadConsultations = useCallback(async (pageNum: number, patientId?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await sessionRef.current.listConsultations({
        page: pageNum,
        limit: DEFAULT_PAGE_SIZE,
        ...(patientId && { patientId }),
      });
      setConsultations(result?.data ?? []);
      setTotalCount(result?.total ?? 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load consultations';
      setError(message);
      setConsultations([]);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConsultations(page, searchQuery || undefined);
  }, [loadConsultations, page, searchQuery]);

  const handleSearch = (value: string) => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setPage(1);
      setSearchQuery(value);
    }, 400);
  };

  const handleRefresh = () => loadConsultations(page, searchQuery || undefined);

  if (isLoading && consultations.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-24" />
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex items-center gap-4 p-4">
              <Skeleton className="size-10 rounded-lg" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-6 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (error && consultations.length === 0) {
    return (
      <Card className="border-destructive/50">
        <CardContent className="flex flex-col items-center justify-center py-12">
          <AlertCircle className="text-destructive mb-4 size-12" aria-hidden />
          <h3 className="mb-1 text-lg font-medium">Failed to Load Consultations</h3>
          <p className="text-muted-foreground mb-4 max-w-md text-center text-sm">{error}</p>
          <Button onClick={handleRefresh} variant="outline">
            <RefreshCw data-icon="inline-start" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
          <Input
            placeholder="Search by patient ID..."
            className="pl-9"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleSearch(e.target.value)}
          />
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isLoading}>
          <RefreshCw data-icon="inline-start" className={isLoading ? 'animate-spin' : ''} />
          Refresh
        </Button>
      </div>

      {consultations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <FileText className="text-muted-foreground mb-4 size-12" />
            <h3 className="mb-1 text-lg font-medium">No consultations found</h3>
            <p className="text-muted-foreground text-sm">
              {searchQuery ? `No results for "${searchQuery}". Try a different search.` : 'Start a new consultation to get going.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {consultations.map((c) => {
            const doctorDisplay = getDoctorDisplayName(c);
            const deptDisplay = getDepartmentDisplayName(c);
            const status = getConsultationStatus(c);

            return (
              <Card
                key={c.id}
                className="cursor-pointer transition-colors hover:bg-accent/50"
                onClick={() =>
                  navigate({
                    to: '/consultation/$id',
                    params: { id: c.id },
                  })
                }
              >
                <CardContent className="flex items-center gap-4 p-4">
                  <div className="bg-primary/10 flex size-10 items-center justify-center rounded-lg">
                    <FileText className="text-primary size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{c.patientId || c.id}</span>
                      {status && (
                        <Badge variant={statusVariant[status] ?? 'outline'} className="shrink-0">
                          {status}
                        </Badge>
                      )}
                    </div>
                    <div className="text-muted-foreground flex items-center gap-3 text-sm">
                      <span>
                        {c.createdAt
                          ? formatDistanceToNow(new Date(c.createdAt), {
                              addSuffix: true,
                            })
                          : 'Unknown date'}
                      </span>
                      {doctorDisplay && <span className="truncate">Dr. {doctorDisplay}</span>}
                      {deptDisplay && <span className="text-muted-foreground/70 truncate">{deptDisplay}</span>}
                    </div>
                  </div>
                  <ChevronRight className="text-muted-foreground size-5 shrink-0" />
                </CardContent>
              </Card>
            );
          })}

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <p className="text-muted-foreground text-sm">
                Showing {(page - 1) * DEFAULT_PAGE_SIZE + 1}–{Math.min(page * DEFAULT_PAGE_SIZE, totalCount)} of {totalCount}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1 || isLoading}>
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="text-muted-foreground px-2 text-sm">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || isLoading}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
