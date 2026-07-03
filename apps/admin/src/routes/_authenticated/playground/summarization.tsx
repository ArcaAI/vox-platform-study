import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useAdminConsultations, useArca, useArcaSummary } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, FileText, Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import {
  consultationOptionLabel,
  contextTypeLabel,
  formatProcessingTime,
  splitPlaygroundContext,
  type PlaygroundContextItem,
} from '@/features/playground/playground-format';

export const Route = createFileRoute('/_authenticated/playground/summarization')({
  component: SummarizationPlaygroundPage,
});

const PREVIEW_CHARS = 320;

function SummaryContent({ content }: { content: string }) {
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

/**
 * TASK-408 — screen 54 · Summarization (playground tier). The SMR sandbox the
 * legacy playground's summary panel provides, in admin form. Reads go through
 * the ADMIN consultation surface (summaries are RAW/MODIFIED/PRE_SUMMARY
 * context items with `summaryMeta` — model · latency · tokens). Generation
 * calls the real doctor-scoped pipeline, so it unlocks only when the SDK
 * session can load the consultation (owner / impersonated doctor) — mirroring
 * the server's ownership rule instead of pretending admins can run it.
 */
function SummarizationPlaygroundPage() {
  const consults = useAdminConsultations();
  const detailApi = useAdminConsultations();
  const { session } = useArca();
  const summary = useArcaSummary();

  const [selectedId, setSelectedId] = useState<string>('');
  /** Whether the SDK session (doctor-scoped) accepted the consultation — the generation gate. */
  const [sdkSessionReady, setSdkSessionReady] = useState(false);

  useEffect(() => {
    void consults.list({ limit: 50 }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, []);

  // Auto-select the first consultation once the list loads (matches /history).
  useEffect(() => {
    if (!selectedId && consults.consultations.length > 0) {
      setSelectedId(consults.consultations[0].id);
    }
  }, [consults.consultations, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    setSdkSessionReady(false);
    // Admin read — tenant-wide detail incl. summary context items.
    void detailApi.get(selectedId).catch(() => undefined);
    // Doctor-scoped SDK load — succeeds only for the owner (or an
    // impersonated doctor identity); its success unlocks generation.
    void session
      .load(selectedId)
      .then(() => setSdkSessionReady(true))
      .catch(() => setSdkSessionReady(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const detail = detailApi.currentConsultation?.id === selectedId ? detailApi.currentConsultation : null;
  const { summaries } = splitPlaygroundContext((detail?.contextItems ?? undefined) as PlaygroundContextItem[] | undefined);

  const generate = async (kind: 'summary' | 'pre_summary') => {
    try {
      await (kind === 'summary' ? summary.generateSummary() : summary.generatePreSummary());
      toast.success(`${kind === 'summary' ? 'Summary' : 'Pre-summary'} generated.`);
      void detailApi.get(selectedId).catch(() => undefined);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Generation failed.');
    }
  };

  const hasConsultations = consults.consultations.length > 0;
  const canGenerate = sdkSessionReady && !summary.isGenerating;

  return (
    <div>
      <PageHeader
        title="Summarization"
        description="Inspect the SMR pipeline output for a consultation — pre-summaries and summaries with model, latency and token metadata — and run generation when you hold the doctor identity."
        actions={
          <Button variant="outline" size="sm" onClick={() => void consults.list({ limit: 50 }).catch(() => undefined)} disabled={consults.isLoading}>
            <RotateCcw className="size-4" />
            Refresh
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={selectedId} onValueChange={setSelectedId} disabled={!hasConsultations}>
          <SelectTrigger className="w-full max-w-md" aria-label="Select consultation">
            <SelectValue placeholder={consults.isLoading ? 'Loading consultations…' : 'Select a consultation'} />
          </SelectTrigger>
          <SelectContent>
            {consults.consultations.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {consultationOptionLabel(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void generate('pre_summary')} disabled={!canGenerate} data-testid="generate-pre-summary">
            {summary.isGenerating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Generate pre-summary
          </Button>
          <Button size="sm" onClick={() => void generate('summary')} disabled={!canGenerate} data-testid="generate-summary">
            {summary.isGenerating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Generate summary
          </Button>
        </div>
      </div>

      {selectedId && !sdkSessionReady ? (
        <p className="mb-4 text-xs text-muted-foreground" data-testid="generate-gate">
          Generation runs the real doctor-scoped pipeline and writes a new summary onto the consultation, so it unlocks only for the owning doctor
          (impersonate one via Users → Impersonate). Reading below stays available to admins.
        </p>
      ) : selectedId ? (
        <p className="mb-4 text-xs text-muted-foreground">
          Generation invokes the live SMR service and writes a new summary onto this consultation (additive, versioned — nothing is overwritten).
        </p>
      ) : null}

      {consults.error && !hasConsultations ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn’t load consultations</AlertTitle>
          <AlertDescription>{consults.error.message} — tenant-wide consultation access requires an admin role.</AlertDescription>
        </Alert>
      ) : null}

      {summary.error ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="size-4" />
          <AlertTitle>Summarization error</AlertTitle>
          <AlertDescription>{summary.error.message}</AlertDescription>
        </Alert>
      ) : null}

      <section className="rounded-lg border bg-card" aria-label="Summaries">
        <header className="flex items-center justify-between border-b px-4 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Summaries {detail ? `(${summaries.length})` : ''}
          </span>
          {summary.isGenerating ? <StatusBadge label="Generating" colorRole="info" /> : null}
        </header>
        <div className="p-4">
          {!selectedId ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <FileText className="size-9 text-muted-foreground" />
              <p className="font-medium">No consultation selected</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                {hasConsultations || consults.isLoading
                  ? 'Pick a consultation to inspect and generate its summaries.'
                  : 'This workspace has no consultations yet — start one in the Clinical Consultation playground first.'}
              </p>
            </div>
          ) : detailApi.error && !detail ? (
            // Honest failure — notably the tenant-less super-admin session:
            // consultation reads are CLS-tenant-scoped server-side (TASK-331
            // platform gap), so cross-tenant super-admins get a 400 here.
            <div className="flex flex-col items-center gap-2 py-10 text-center" role="alert" data-testid="summaries-load-error">
              <AlertTriangle className="size-8 text-destructive" />
              <p className="font-medium">Couldn’t load the consultation</p>
              <p className="max-w-md text-sm text-muted-foreground">
                {detailApi.error.message} — consultation reads are tenant-scoped; a cross-tenant super-admin session has no working tenant (sign in
                with a workspace key, or impersonate).
              </p>
            </div>
          ) : !detail ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          ) : summaries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center" data-testid="summaries-empty">
              <Sparkles className="size-9 text-muted-foreground" />
              <p className="font-medium">No summaries yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Nothing generated for this consultation — the SMR output lands here with its model and latency metadata.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {summaries.map((s) => (
                <li key={s.id} className="rounded-md border p-3" data-testid={`summary-item-${s.id}`}>
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <StatusBadge label={contextTypeLabel(s.type)} colorRole={(s.type ?? '').toUpperCase() === 'PRE_SUMMARY' ? 'info' : 'success'} />
                    {s.summaryMeta?.aiModelId ? (
                      <span className="font-mono">
                        {s.summaryMeta.aiModelId}
                        {s.summaryMeta.aiModelVersion ? ` · ${s.summaryMeta.aiModelVersion}` : ''}
                      </span>
                    ) : null}
                    {s.summaryMeta?.processingTimeMs !== undefined ? (
                      <span className="tabular-nums">{formatProcessingTime(s.summaryMeta.processingTimeMs)}</span>
                    ) : null}
                    {s.summaryMeta?.totalTokens !== undefined ? <span className="tabular-nums">{s.summaryMeta.totalTokens} tokens</span> : null}
                    {s.isAiGenerated ? <StatusBadge label="AI" colorRole="ai" /> : null}
                  </div>
                  {s.content ? <SummaryContent content={s.content} /> : <p className="text-sm text-muted-foreground">Empty content.</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <p className="mt-4 text-xs text-muted-foreground">
        Per-metric evaluation (faithfulness · coverage · conciseness) is a target — the backend returns latency/token metadata and a single quality
        proxy today (flagged in TASK-408, same gap as the agents test playground).
      </p>
    </div>
  );
}
