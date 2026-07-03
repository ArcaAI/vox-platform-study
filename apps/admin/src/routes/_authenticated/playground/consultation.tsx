import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useAdminConsultations, useArca } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, RotateCcw, Sparkles, Stethoscope } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import {
  canStartSandboxConsultation,
  consultationOptionLabel,
  consultationStatusRole,
  contextTypeLabel,
  formatProcessingTime,
  splitPlaygroundContext,
  type PlaygroundContextItem,
} from '@/features/playground/playground-format';
import { StartConsultationDialog } from '@/features/playground/start-consultation-dialog';
import { useAuthStore } from '@/store/auth-store';
import { cn, formatDateTime } from '@/lib/utils';

export const Route = createFileRoute('/_authenticated/playground/consultation')({
  component: ConsultationPlaygroundPage,
});

const PREVIEW_CHARS = 240;

function ContentPreview({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  if (content.length <= PREVIEW_CHARS) return <p className="whitespace-pre-wrap text-sm leading-relaxed">{content}</p>;
  return (
    <div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{expanded ? content : `${content.slice(0, PREVIEW_CHARS)}…`}</p>
      <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs" onClick={() => setExpanded((e) => !e)}>
        {expanded ? 'Show less' : 'Show more'}
      </Button>
    </div>
  );
}

/** Typed slices of the admin consultation GET relations (SDK models them via its index signature). */
interface DoctorSlice {
  username?: string;
  firstName?: string;
  lastName?: string;
}
interface DepartmentSlice {
  code?: string;
  name?: string;
}

function ContextItemCard({ item, showMeta = false }: { item: PlaygroundContextItem; showMeta?: boolean }) {
  return (
    <li className="rounded-md border p-3">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{contextTypeLabel(item.type)}</span>
        {item.isAiGenerated ? <StatusBadge label="AI" colorRole="ai" /> : null}
        {showMeta && item.summaryMeta?.aiModelId ? <span className="font-mono">{item.summaryMeta.aiModelId}</span> : null}
        {showMeta && item.summaryMeta?.processingTimeMs !== undefined ? (
          <span className="tabular-nums">{formatProcessingTime(item.summaryMeta.processingTimeMs)}</span>
        ) : null}
        <span className="tabular-nums">{formatDateTime(item.createdAt)}</span>
      </div>
      {item.content ? <ContentPreview content={item.content} /> : <p className="text-sm text-muted-foreground">No text content (media item).</p>}
    </li>
  );
}

/**
 * TASK-408 — screen 50 · Clinical Consultation (playground tier). The admin
 * view of the consultation lifecycle the clinical apps drive through the SDK:
 * tenant-wide list → detail (fields · context items · summaries), read through
 * the ADMIN surface (`/admin/consultations`, `@CanManage('Consultation')`) —
 * the end-user GET is doctor-scoped and rejects admin identities. Starting a
 * sandbox consultation is doctor-identity-gated (consultations are
 * doctor-owned records) — enabled under TASK-401 impersonation of a doctor.
 */
function ConsultationPlaygroundPage() {
  const consults = useAdminConsultations();
  const detailApi = useAdminConsultations();
  const { session } = useArca();
  const roles = useAuthStore((s) => s.user?.roles);

  const [selectedId, setSelectedId] = useState<string>('');
  const [filter, setFilter] = useState('');
  const [startOpen, setStartOpen] = useState(false);

  const canStart = canStartSandboxConsultation(roles);

  const refresh = () => void consults.list({ limit: 50 }).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  useEffect(refresh, []);

  useEffect(() => {
    if (selectedId) void detailApi.get(selectedId).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return consults.consultations;
    return consults.consultations.filter((c) => (c.patientId ?? '').toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  }, [consults.consultations, filter]);

  const onStart = async (patientId: string, appointmentDate: string) => {
    try {
      const opened = await session.open({ patientId, appointmentDate });
      toast.success(`Consultation #${opened.id.slice(0, 8)} ${opened.isNew ? 'created' : 'resumed'}.`);
      refresh();
      setSelectedId(opened.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the consultation.');
      throw err;
    }
  };

  const detail = detailApi.currentConsultation?.id === selectedId ? detailApi.currentConsultation : null;
  const doctor = (detail?.doctor ?? undefined) as DoctorSlice | undefined;
  const department = (detail?.department ?? undefined) as DepartmentSlice | undefined;
  const doctorName = doctor ? [doctor.firstName, doctor.lastName].filter(Boolean).join(' ') || doctor.username : undefined;
  const { items: contextItems, summaries } = useMemo(
    () => splitPlaygroundContext((detail?.contextItems ?? undefined) as PlaygroundContextItem[] | undefined),
    [detail],
  );

  return (
    <div>
      <PageHeader
        title="Clinical Consultation"
        description="Explore the consultation lifecycle the clinical apps drive through the @arcaai/vox SDK — context items, transcripts and summaries. Sandbox exploration only."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh} disabled={consults.isLoading}>
              <RotateCcw className="size-4" />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setStartOpen(true)} disabled={!canStart} data-testid="start-consultation">
              <Stethoscope className="size-4" />
              Start consultation
            </Button>
          </>
        }
      />

      {!canStart ? (
        <p className="mb-4 text-xs text-muted-foreground" data-testid="start-consultation-gate">
          Starting a consultation requires a doctor identity — consultations are doctor-owned records. Impersonate a doctor (Users → Impersonate) to
          exercise the create flow; browsing below stays fully available.
        </p>
      ) : null}

      {consults.error && consults.consultations.length === 0 ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn’t load consultations</AlertTitle>
          <AlertDescription>{consults.error.message} — tenant-wide consultation supervision requires an admin role.</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_1fr]">
        {/* Master — tenant-wide consultation list */}
        <section className="flex flex-col rounded-lg border bg-card" aria-label="Consultations">
          <header className="border-b p-3">
            <Input
              aria-label="Filter consultations"
              placeholder="Filter by patient or ID…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </header>
          <div className="max-h-[560px] overflow-y-auto p-2">
            {consults.isLoading && consults.consultations.length === 0 ? (
              <div className="space-y-2 p-1">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <Stethoscope className="size-8 text-muted-foreground" />
                <p className="text-sm font-medium">No consultations</p>
                <p className="max-w-[240px] text-xs text-muted-foreground">
                  {filter ? 'Nothing matches the filter.' : 'Nothing in this workspace yet — the list shows the 50 most recent.'}
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {filtered.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      data-testid={`consultation-item-${c.id}`}
                      className={cn(
                        'flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent',
                        selectedId === c.id ? 'border-primary bg-accent' : 'border-transparent',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-xs">{c.patientId ?? `#${c.id.slice(0, 8)}`}</span>
                        <StatusBadge label={c.status ?? 'unknown'} colorRole={consultationStatusRole(c.status)} />
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{consultationOptionLabel(c)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Detail — lifecycle fields · context items · summaries */}
        <section className="rounded-lg border bg-card" aria-label="Consultation detail">
          {!selectedId ? (
            <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-2 p-8 text-center">
              <Stethoscope className="size-9 text-muted-foreground" />
              <p className="font-medium">Select a consultation</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Pick one on the left to inspect its lifecycle — fields, context items and generated summaries.
              </p>
            </div>
          ) : detailApi.isLoading && !detail ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : detailApi.error && !detail ? (
            // Honest failure — notably the tenant-less super-admin session:
            // consultation reads are CLS-tenant-scoped server-side (TASK-331
            // platform gap), so cross-tenant super-admins get a 400 here.
            <div className="flex flex-col items-center gap-3 p-8 text-center" role="alert" data-testid="consultation-load-error">
              <AlertTriangle className="size-8 text-destructive" />
              <p className="font-medium">Couldn’t load the consultation</p>
              <p className="max-w-md text-sm text-muted-foreground">
                {detailApi.error.message} — consultation reads are tenant-scoped; a cross-tenant super-admin session has no working tenant (sign in
                with a workspace key, or impersonate).
              </p>
              <Button variant="outline" size="sm" onClick={() => void detailApi.get(selectedId).catch(() => undefined)}>
                Retry
              </Button>
            </div>
          ) : detail ? (
            <div className="space-y-5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-mono text-sm font-semibold">#{detail.id.slice(0, 8)}</h3>
                <StatusBadge label={detail.status ?? 'unknown'} colorRole={consultationStatusRole(detail.status)} />
              </div>
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2" data-testid="consultation-fields">
                <div className="flex justify-between gap-2 sm:flex-col sm:justify-start">
                  <dt className="text-muted-foreground">Patient</dt>
                  <dd className="font-mono text-xs">{detail.patientId ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-2 sm:flex-col sm:justify-start">
                  <dt className="text-muted-foreground">Doctor</dt>
                  <dd>{doctorName ?? <span className="font-mono text-xs">{detail.doctorId ?? '—'}</span>}</dd>
                </div>
                <div className="flex justify-between gap-2 sm:flex-col sm:justify-start">
                  <dt className="text-muted-foreground">Department</dt>
                  <dd>{department?.name ?? department?.code ?? <span className="font-mono text-xs">{detail.departmentId ?? '—'}</span>}</dd>
                </div>
                <div className="flex justify-between gap-2 sm:flex-col sm:justify-start">
                  <dt className="text-muted-foreground">Appointment</dt>
                  <dd className="tabular-nums">{detail.appointmentDate || formatDateTime(detail.createdAt)}</dd>
                </div>
              </dl>

              <div>
                <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Context items ({contextItems.length})
                </h4>
                {contextItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No context items — nothing captured for this consultation yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {contextItems.map((item) => (
                      <ContextItemCard key={item.id} item={item} />
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Summaries ({summaries.length})</h4>
                {summaries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No summaries yet — run one in the Summarization playground to see the SMR pipeline output here.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {summaries.map((item) => (
                      <ContextItemCard key={item.id} item={item} showMeta />
                    ))}
                  </ul>
                )}
              </div>

              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Sparkles className="size-3.5" />
                Read-focused exploration — nothing here mutates the record. Generation lives in the Summarization playground.
              </p>
            </div>
          ) : null}
        </section>
      </div>

      <StartConsultationDialog open={startOpen} onOpenChange={setStartOpen} onStart={onStart} />
    </div>
  );
}
