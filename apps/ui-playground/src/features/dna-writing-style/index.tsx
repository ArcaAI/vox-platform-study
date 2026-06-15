import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@arcaai/ui/form';
import { Progress } from '@arcaai/ui/progress';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Textarea } from '@arcaai/ui/textarea';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Dna,
  FileText,
  Loader2,
  Pencil,
  RotateCw,
  Sparkles,
  Timer,
  User as UserIcon,
  Wand2,
} from 'lucide-react';

import { LiveCodePanel } from '@/components/live-code-panel';
import { Main } from '@/components/layout/main';
import { ImpersonationGuard } from '@/components/impersonation-guard';
import { zodResolver } from '@/lib/zod-resolver';
import { buildDnaSnippet } from '@/lib/playground-snippets';
import { useDoctorContext } from '@/features/summarization/hooks/use-doctor-context';
import {
  streamDnaJob,
  useDnaJobStatus,
  useDnaVersions,
  useGenerateDnaReport,
  useMyDnaReports,
  useMyDnaStyle,
  useSetDefaultDnaReport,
  type DnaReport,
} from './api/dna-writing-styles';
import { DnaSettingsCard } from './components/dna-settings-card';
import { EditDialog } from './components/edit-dialog';
import { GenerateFromHistoryPanel } from './components/generate-from-history-panel';
import { ReportsListPanel } from './components/reports-list-panel';
import { VersionDiffSection } from './components/version-diff-section';
import { VersionsPanel } from './components/versions-panel';
import { useEditDialogController } from './hooks/use-edit-dialog-controller';
import type { DnaStyleVersion } from './api/dna-writing-styles';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const generateSchema = z.object({
  textSamples: z.string().min(1, 'At least one text sample is required'),
});

type GenerateFormValues = z.infer<typeof generateSchema>;
type DeliveryMethod = 'sse' | 'polling';

interface StreamingState {
  status: 'idle' | 'connecting' | 'streaming' | 'done' | 'error';
  jobId?: string;
  progress: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(dateStr?: string | null): string {
  if (!dateStr) return '—';
  const ms = Date.now() - new Date(dateStr).getTime();
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (day > 30) {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  if (day >= 1) return rtf.format(-day, 'day');
  if (hr >= 1) return rtf.format(-hr, 'hour');
  if (min >= 1) return rtf.format(-min, 'minute');
  return rtf.format(-sec, 'second');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function fmtDate(dateStr?: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// StyleAttributeCard (used by MyStyleCard)
// ---------------------------------------------------------------------------

function StyleAttributeCard({ label, value, icon }: { label: string; value?: string | null; icon: React.ReactNode }) {
  return (
    <div className="bg-muted/30 rounded-lg border p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-sm font-medium">{value || '—'}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// JobPollingBanner — HTTP polling progress display
// ---------------------------------------------------------------------------

function StreamingJobBanner({ state, onCancel, onDismiss }: { state: StreamingState; onCancel: () => void; onDismiss: () => void }) {
  if (state.status === 'idle') return null;

  const isTerminal = state.status === 'done' || state.status === 'error';
  const isError = state.status === 'error';

  return (
    <div
      className={`rounded-lg border px-4 py-3 space-y-2 ${isError ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800' : 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800'}`}
    >
      <div className="flex items-center gap-3">
        <span className={isError ? 'text-red-600' : 'text-blue-600'}>
          {isTerminal ? (
            isError ? (
              <AlertCircle className="size-4" />
            ) : (
              <CheckCircle2 className="size-4" />
            )
          ) : (
            <Loader2 className="size-4 animate-spin" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <p className={`text-sm font-medium ${isError ? 'text-red-600' : 'text-blue-600'}`}>
              SSE Stream: {isError ? 'Failed' : state.status === 'done' ? 'Completed' : state.status === 'connecting' ? 'Connecting' : 'Streaming'}
            </p>
            {isTerminal ? (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onDismiss}>
                Dismiss
              </Button>
            ) : (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            {state.jobId && (
              <span>
                Job: <code className="font-mono">{state.jobId.slice(0, 12)}…</code>
              </span>
            )}
            {state.error && <span>{state.error}</span>}
          </div>
        </div>
      </div>
      <Progress value={state.progress} className="h-1.5" />
    </div>
  );
}

function JobPollingBanner({ jobId, onComplete, onDismiss }: { jobId: string; onComplete: () => void; onDismiss: () => void }) {
  const { data: jobStatus } = useDnaJobStatus(jobId);
  const [pollCount, setPollCount] = useState(0);
  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    if (!jobStatus) return;
    setPollCount((c) => c + 1);
  }, [jobStatus]);

  useEffect(() => {
    if (jobStatus?.status === 'completed') {
      toast.success('DNA writing style report generated successfully');
      onComplete();
    }
    if (jobStatus?.status === 'failed') {
      toast.error(`Generation failed: ${jobStatus.error ?? 'Unknown error'}`);
    }
  }, [jobStatus?.status, jobStatus?.error, onComplete]);

  if (!jobStatus) return null;

  const elapsed = Math.round((Date.now() - startTimeRef.current) / 1000);
  const isTerminal = jobStatus.status === 'completed' || jobStatus.status === 'failed';

  const statusConfig = {
    queued: {
      icon: <Timer className="size-4" />,
      color: 'text-yellow-600',
      bg: 'bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-800',
      label: 'Queued',
      progress: 10,
    },
    processing: {
      icon: <Loader2 className="size-4 animate-spin" />,
      color: 'text-blue-600',
      bg: 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800',
      label: 'Processing',
      progress: 50,
    },
    completed: {
      icon: <CheckCircle2 className="size-4" />,
      color: 'text-green-600',
      bg: 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800',
      label: 'Completed',
      progress: 100,
    },
    failed: {
      icon: <AlertCircle className="size-4" />,
      color: 'text-red-600',
      bg: 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800',
      label: 'Failed',
      progress: 100,
    },
  };

  const config = statusConfig[jobStatus.status] ?? statusConfig.queued;

  return (
    <div className={`rounded-lg border px-4 py-3 space-y-2 ${config.bg}`}>
      <div className="flex items-center gap-3">
        <span className={config.color}>{config.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <p className={`text-sm font-medium ${config.color}`}>HTTP Job Polling: {config.label}</p>
            {isTerminal && (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onDismiss}>
                Dismiss
              </Button>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            <span>
              Job: <code className="font-mono">{jobId.slice(0, 12)}…</code>
            </span>
            <span>Polls: {pollCount}</span>
            <span>Elapsed: {elapsed}s</span>
            <Badge variant="outline" className="text-[10px] gap-1">
              <RotateCw className="size-2.5" />
              2s interval
            </Badge>
          </div>
        </div>
      </div>
      <Progress value={config.progress} className="h-1.5" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// GenerateDialog — submits an async DNA generation job and returns a jobId
// the parent polls via GET /dna-writing-styles/jobs/:jobId.
// ---------------------------------------------------------------------------

function GenerateDialog({
  open,
  onOpenChange,
  onJobStarted,
  onStreamStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJobStarted: (jobId: string) => void;
  onStreamStarted: (jobId: string) => void;
}) {
  const generateMutation = useGenerateDnaReport();
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>('polling');

  const form = useForm<GenerateFormValues>({
    resolver: zodResolver(generateSchema),
    defaultValues: { textSamples: '' },
  });

  useEffect(() => {
    if (open) form.reset({ textSamples: '' });
  }, [open, form]);

  const handleSubmit = useCallback(
    (values: GenerateFormValues) => {
      const samples = values.textSamples
        .split('\n---\n')
        .map((s) => s.trim())
        .filter(Boolean);

      generateMutation.mutate(
        { textSamples: samples },
        {
          onSuccess: (data) => {
            if (deliveryMethod === 'sse') {
              toast.success('DNA report generation started — streaming status');
              onStreamStarted(data.jobId);
            } else {
              toast.success('DNA report generation started — polling for status');
              onJobStarted(data.jobId);
            }
            onOpenChange(false);
          },
          onError: (err) => toast.error(`Failed to start generation: ${err.message}`),
        },
      );
    },
    [deliveryMethod, generateMutation, onJobStarted, onOpenChange, onStreamStarted],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5" />
            Generate DNA Writing Style
          </DialogTitle>
          <DialogDescription>
            Provide writing samples (case notes, clinical documentation) to analyze and generate a DNA writing style profile. Separate multiple
            samples with
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">---</code>
            on its own line.
            <span className="mt-2 block text-xs">
              <strong>Note:</strong> Generating creates a brand-new style profile (starting at version 1). Your previous profile is kept in history
              but no longer marked as latest. Manual edits create new versions <em>within</em> the current profile.
            </span>
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="textSamples"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>Writing Samples</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={`Paste clinical notes or writing samples here…\n\nSeparate multiple samples with --- on its own line.\n\nExample:\nPatient presented with acute chest pain…\n---\nFollow-up visit for diabetes management…`}
                      className="min-h-48 font-mono text-sm"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormDescription>
                    More samples yield a more accurate writing style profile. Recommended: 3-5 samples of 200+ words each. The job typically completes
                    in 5–10 seconds.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant={deliveryMethod === 'polling' ? 'default' : 'outline'} onClick={() => setDeliveryMethod('polling')}>
                HTTP Polling
              </Button>
              <Button type="button" variant={deliveryMethod === 'sse' ? 'default' : 'outline'} onClick={() => setDeliveryMethod('sse')}>
                SSE Stream
              </Button>
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={generateMutation.isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={generateMutation.isPending}>
                {generateMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Wand2 className="mr-2 size-4" />}
                Generate
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// MyStyleCard — Quick view of current user's DNA style
// ---------------------------------------------------------------------------

function MyStyleCard({ onEdit }: { onEdit?: (report: DnaReport) => void }) {
  const { data: myStyle, isLoading, error } = useMyDnaStyle();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-60" />
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !myStyle) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-8">
          <Dna className="text-muted-foreground/50 mb-2 size-8" aria-hidden="true" />
          <p className="text-muted-foreground text-sm">No DNA writing style found. Generate one using the button above.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Dna className="size-4" aria-hidden="true" />
              My Writing Style
            </CardTitle>
            <CardDescription>
              Version {myStyle.currentVersionNumber} · Updated {relativeTime(myStyle.updatedAt)}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={myStyle.isLatest ? 'default' : 'secondary'}>{myStyle.isLatest ? 'Latest' : 'Outdated'}</Badge>
            {onEdit && (
              <Button variant="outline" size="sm" onClick={() => onEdit(myStyle)} data-testid="dna-edit-button">
                <Pencil className="mr-1.5 size-3.5" />
                Edit
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {myStyle.styleText && <p className="text-sm text-muted-foreground mb-3 line-clamp-2">{myStyle.styleText}</p>}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {myStyle.reportData?.tone && <StyleAttributeCard label="Tone" value={myStyle.reportData.tone} icon={<Sparkles className="size-3" />} />}
          {myStyle.reportData?.formality && (
            <StyleAttributeCard label="Formality" value={myStyle.reportData.formality} icon={<UserIcon className="size-3" />} />
          )}
          {myStyle.reportData?.vocabulary && (
            <StyleAttributeCard label="Vocabulary" value={myStyle.reportData.vocabulary} icon={<BookOpen className="size-3" />} />
          )}
          {myStyle.reportData?.structure && (
            <StyleAttributeCard label="Structure" value={myStyle.reportData.structure} icon={<FileText className="size-3" />} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function DnaWritingStylePage() {
  const [generateOpen, setGenerateOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  // TASK-329 P5 — impersonation gate + edit-dialog wiring (the bug fix lives in
  // the controller, which couples "select report" + "open" into `openFor`).
  const { requiresImpersonation } = useDoctorContext();
  const editCtrl = useEditDialogController();

  // Polling state
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamingState>({ status: 'idle', progress: 0 });
  const abortRef = useRef<AbortController | null>(null);

  // ---- Data (user-scoped; skipped until a doctor context is active) -------

  const { data: myStyle, refetch: refetchMyStyle } = useMyDnaStyle({ enabled: !requiresImpersonation });

  const reportId = myStyle?.id ?? '';

  const {
    data: versions = [],
    isLoading: isLoadingVersions,
    refetch: refetchVersions,
  } = useDnaVersions(reportId, {
    enabled: !!reportId && !requiresImpersonation,
  });

  // TASK-329 P5 — the doctor's report history (set-default picker) + the
  // generate-from-history mutation + the optimistic set-default mutation.
  const { data: myReports = [], isLoading: isLoadingReports, refetch: refetchReports } = useMyDnaReports({ enabled: !requiresImpersonation });
  const fromHistoryMutation = useGenerateDnaReport();
  const setDefaultMutation = useSetDefaultDnaReport();

  const dnaCode = useMemo(
    () =>
      buildDnaSnippet({
        reportId: myStyle?.id ?? null,
        version: myStyle?.currentVersionNumber ?? null,
        tone: myStyle?.reportData?.tone ?? null,
      }),
    [myStyle?.id, myStyle?.currentVersionNumber, myStyle?.reportData?.tone],
  );

  useEffect(() => {
    if (versions.length === 0) {
      setSelectedVersionId(null);
      return;
    }

    if (!selectedVersionId || !versions.some((v) => v.id === selectedVersionId)) {
      setSelectedVersionId(versions[0]?.id ?? null);
    }
  }, [selectedVersionId, versions]);

  // ---- Polling handlers ---------------------------------------------------

  const handleJobStarted = useCallback((jobId: string) => {
    setActiveJobId(jobId);
  }, []);

  const handleJobComplete = useCallback(() => {
    setActiveJobId(null);
    refetchMyStyle();
    refetchVersions();
    refetchReports();
  }, [refetchMyStyle, refetchVersions, refetchReports]);

  const handleJobDismiss = useCallback(() => {
    setActiveJobId(null);
  }, []);

  // ---- TASK-329 P5 handlers ----------------------------------------------

  const handleSetDefault = useCallback(
    (id: string) => {
      setDefaultMutation.mutate(id, {
        onSuccess: () => {
          toast.success('Default writing style updated');
          refetchMyStyle();
        },
        onError: (err) => toast.error(`Failed to set default: ${err.message}`),
      });
    },
    [setDefaultMutation, refetchMyStyle],
  );

  const handleGenerateFromHistory = useCallback(
    (selected: DnaStyleVersion[]) => {
      const textSamples = selected.map((v) => v.styleText ?? '').filter(Boolean);
      const sourceIds = selected.map((v) => v.id);
      fromHistoryMutation.mutate(
        { textSamples, sourceIds },
        {
          onSuccess: (data) => {
            toast.success('Generation started from selected history — polling for status');
            setActiveJobId(data.jobId);
          },
          onError: (err) => toast.error(`Failed to start generation: ${err.message}`),
        },
      );
    },
    [fromHistoryMutation],
  );

  const handleStreamStarted = useCallback(
    (jobId: string) => {
      abortRef.current?.abort();
      setStreamState({ status: 'connecting', jobId, progress: 0 });
      abortRef.current = streamDnaJob(jobId, {
        onStatus: (status) => {
          setStreamState((prev) => ({
            ...prev,
            status: status.status === 'completed' ? 'done' : status.status === 'failed' ? 'error' : 'streaming',
            progress: status.progress ?? prev.progress,
            error: status.error,
          }));
          if (status.status === 'completed') {
            toast.success('DNA writing style report generated successfully');
            refetchMyStyle();
            refetchVersions();
          }
          if (status.status === 'failed') {
            toast.error(`Generation failed: ${status.error ?? 'Unknown error'}`);
          }
        },
        onProgress: (progress) => setStreamState((prev) => ({ ...prev, status: prev.status === 'connecting' ? 'streaming' : prev.status, progress })),
        onError: (error) => {
          setStreamState((prev) => ({ ...prev, status: 'error', error: error.message }));
          toast.error(`Stream error: ${error.message}`);
        },
      });
    },
    [refetchMyStyle, refetchVersions],
  );

  const handleStreamCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreamState((prev) => ({ ...prev, status: 'error', error: 'Cancelled by user' }));
  }, []);

  const handleStreamDismiss = useCallback(() => {
    setStreamState({ status: 'idle', progress: 0 });
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ---- Render -------------------------------------------------------------

  return (
    <Main>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          {/* Header */}
          <div className="mb-6 flex items-start justify-between" data-doc="dna-header">
            <div>
              <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                <Dna className="size-6" />
                DNA Writing Style
              </h2>
              <p className="text-muted-foreground mt-1">View and manage your personal DNA writing style profile used for clinical documentation.</p>
            </div>
            {/* TASK-331 doc-07 F1 — the generate trigger is per-doctor; gate it
                behind the SAME impersonation signal as the body so a
                non-impersonating admin cannot self-generate a DNA style. */}
            {!requiresImpersonation && (
              <Button onClick={() => setGenerateOpen(true)}>
                <Sparkles className="mr-2 size-4" />
                Generate Style
              </Button>
            )}
          </div>

          {/* TASK-329 P5 — impersonation gate: this playground is per-doctor. */}
          <ImpersonationGuard featureName="DNA writing style">
            {/* Active generation banner */}
            {(activeJobId || streamState.status !== 'idle') && (
              <div className="mb-4 space-y-3">
                {activeJobId && <JobPollingBanner jobId={activeJobId} onComplete={handleJobComplete} onDismiss={handleJobDismiss} />}
                {streamState.status !== 'idle' && (
                  <StreamingJobBanner state={streamState} onCancel={handleStreamCancel} onDismiss={handleStreamDismiss} />
                )}
              </div>
            )}

            {/* TASK-356 Phase 6 (S3/S7) — per-doctor DNA on/off switch. */}
            <div className="mb-6">
              <DnaSettingsCard />
            </div>

            <div data-doc="dna-report-detail">
              <MyStyleCard onEdit={editCtrl.openFor} />
            </div>

            {/* TASK-329 P5 — generate-from-history + set-default report picker */}
            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              <GenerateFromHistoryPanel
                versions={versions}
                isLoading={isLoadingVersions}
                isGenerating={fromHistoryMutation.isPending}
                onGenerate={handleGenerateFromHistory}
              />
              <ReportsListPanel
                reports={myReports}
                isLoading={isLoadingReports}
                onSetDefault={handleSetDefault}
                settingDefaultId={setDefaultMutation.isPending ? (setDefaultMutation.variables ?? null) : null}
              />
            </div>

            {/* TASK-329 P5 — version diff */}
            {myStyle && (
              <div className="mt-6">
                <VersionDiffSection versions={versions} isLoading={isLoadingVersions} />
              </div>
            )}

            {myStyle && (
              <div className="mt-6" data-doc="dna-reports-list">
                <VersionsPanel
                  report={myStyle}
                  versions={versions}
                  isLoadingVersions={isLoadingVersions}
                  selectedVersionId={selectedVersionId}
                  onSelectVersion={setSelectedVersionId}
                  onRefreshVersions={() => void refetchVersions()}
                />
              </div>
            )}

            <div className="mt-6">
              <LiveCodePanel code={dnaCode} title="DNA Writing Style — SDK sample" filename="generate-style.ts" />
            </div>
          </ImpersonationGuard>

          {/* Dialogs */}
          {/* TASK-331 doc-07 F1 — keep the generate dialog behind the same gate
              as its trigger (defense-in-depth: it can't be opened when an admin
              isn't impersonating a doctor). */}
          {!requiresImpersonation && (
            <GenerateDialog
              open={generateOpen}
              onOpenChange={setGenerateOpen}
              onJobStarted={handleJobStarted}
              onStreamStarted={handleStreamStarted}
            />
          )}

          <EditDialog
            open={editCtrl.open}
            onOpenChange={(v) => {
              if (v) editCtrl.setOpen(true);
              else editCtrl.close();
            }}
            report={editCtrl.report}
          />
        </div>
      </div>
    </Main>
  );
}
