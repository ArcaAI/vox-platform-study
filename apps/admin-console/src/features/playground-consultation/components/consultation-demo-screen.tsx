'use client';

/**
 * Frame 50 — Consultation Scribe workspace (matrix row 34;
 * redesign of the former two-tab demo). A single live 3-column clinical-scribe
 * view built on `@arcaai/vox`: a real consultation list (col 1), the live
 * session — level-driven waveform + `LiveTranscript` (col 2), and the
 * personalized case note with the harness assurance envelope folded in and
 * sign-off (col 3). Columns are user-resizable and persist per user through the
 * SDK settings plane ({@link useColumnLayout}); the footer surfaces the ASR +
 * note model selectors and real per-session metrics.
 *
 * Frame: `ScreenTemplate` with `contentMode="fill"` (rule 11 §1) — the column
 * group takes the remaining height and each column scrolls internally, and
 * `ScribeFooter` rides the pinned `footer` slot it was already shaped for.
 *

 * Transport split (unchanged): SDK/REST calls go through the BFF proxy
 * (`/api/hope`, auth injected server-side — no token in the browser); the STT
 * WebSocket and every SSE stream connect DIRECTLY to the gateway
 * (`publicEnv.apiHost`) — WS via the SDK `wsUrl` config, SSE via single-use
 * tickets minted through `/api/auth/stream-ticket`.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AgenticProvider, useArca, useArcaLiveSummary, useArcaSttLanguageModes, useStoreApi } from '@arcaai/vox';
import { toast } from 'sonner';
import type { ModelOption } from '@arcaai/ui/components/custom/model-selector';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@arcaai/ui/components/shadcn/resizable';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { publicEnv } from '@/config/public-env';
import { useSession } from '@/shared/auth';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import {
  getLatestSummary,
  playgroundConsultationKeys,
  useApproveSummary,
  useAudioPipelines,
  useCancelConsultationJob,
  useConsultationLoopStream,
  useDnaStyleOptions,
  useGenerateSummaryAsync,
  useHarnessAssuranceStream,
  useHarnessProgressStream,
  useLatestSummary,
  useScopingDepartments,
  useStartRecording,
  useSummaryJobProgress,
  useStopRecording,
  useSummaryProvenance,
  useTranscriptions,
  useUpdateSummary,
  type CitedSegment,
} from '../api';
import { useColumnLayout } from '../hooks/use-column-layout';
import { useLiveMetrics } from '../hooks/use-live-metrics';
import { useNoteEditor, type EditableDraft } from '../hooks/use-note-editor';
import { CaseNoteColumn } from './scribe/case-note-column';
import { ConsultationsColumn, type ConsultationListRow } from './scribe/consultations-column';
import { LiveSessionColumn, type SdkTranscriptSegment, type TranscriptReviewHighlight } from './scribe/live-session-column';
import { ScribeFooter } from './scribe/scribe-footer';

// ─── helpers ───

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The SDK's streaming sessionId (needed by `recording/start` so the live
 * summariser can attach to the STT session) lives on the transcription
 * pipeline's transport, reached imperatively through the provider store.
 * The chain is version-tolerant (`unknown`-typed navigation) and bounded —
 * when the id can't be read the body field is simply omitted; the
 * LiveDocumentationService then falls back to context-item ingestion.
 */
function readStreamingSessionId(state: unknown): string | null {
  const pipeline = (state as { pluginManager?: { getTranscriptionPipeline?: () => unknown } | null }).pluginManager?.getTranscriptionPipeline?.();
  const transport = (pipeline as { getConfig?: () => { stt?: { streamingTransport?: unknown } } } | null)?.getConfig?.()?.stt?.streamingTransport;
  const sessionId = (transport as { sessionManager?: { getSessionId?: () => string | null } } | undefined)?.sessionManager?.getSessionId?.();
  return sessionId ?? null;
}

async function resolveStreamingSessionId(storeApi: { getState: () => unknown }, attempts = 8, delayMs = 250): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const sessionId = readStreamingSessionId(storeApi.getState());
    if (sessionId) return sessionId;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

// ─── screen shell ───

/** Route skeleton — mirrored by the route's loading.tsx; the full-height workspace. */
export function ConsultationDemoSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="bg-card grid min-h-0 flex-1 grid-cols-[1fr_2px_1.6fr_2px_1.6fr] overflow-hidden rounded-xl border">
        {[0, 1, 2].map((column) => (
          <div
            key={column}
            className={column === 0 ? 'flex flex-col gap-3 p-4' : 'flex flex-col gap-3 border-l p-4'}
            style={{ gridColumn: column * 2 + 1 }}
          >
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ))}
      </div>
      <Skeleton className="h-20 w-full rounded-lg" />
    </div>
  );
}

/** Frame 50 — tenant-gated `@arcaai/vox` consultation scribe workspace. */
export function ConsultationDemoScreen() {
  return (
    <WorkingTenantGate
      title="Consultation Scribe"
      meta={<span>@arcaai/vox — live capture, transcription, personalized SOAP and sign-off</span>}
      description="The workspace opens consultations and stores drafts in the working tenant. Pick one from the switcher in the top bar."
    >
      <SdkBoundary />
    </WorkingTenantGate>
  );
}

/**
 * Structural subset of the SDK's `AgenticConfig` this screen actually sets.
 * Kept as a local narrowing (the object is assignable to `AgenticConfig`); the
 * SDK validates the full config at runtime.
 */
interface VoxProviderConfig {
  api: { baseUrl: string; wsUrl?: string; tenantId?: string };
  audio?: {
    noiseFilter?: { enabled: boolean };
    vad?: { enabled: boolean };
    stt?: { enabled: boolean; provider: 'local' | 'backend' | 'auto' };
  };
  autoWireTokenRefresh?: boolean;
}

const emptySubscribe = () => () => {};

/** False during SSR + the hydration render, true afterwards. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

/**
 * Client-only SDK mount: the provider config needs `window.location.origin`,
 * so the interactive area renders after hydration (the skeleton covers SSR
 * and the first client frame).
 */
function SdkBoundary() {
  const session = useSession();
  const mounted = useHydrated();

  const tenantId = session.data ? (session.data.effectiveTenantId ?? session.data.user.tenantId) || undefined : undefined;

  const config = useMemo<VoxProviderConfig | null>(() => {
    if (!mounted) return null;
    return {
      // REST → BFF proxy (auth injected server-side; SDK carries no token).
      // WS → gateway directly (AgenticClient.getWsUrl).
      api: {
        baseUrl: `${window.location.origin}/api/hope`,
        wsUrl: publicEnv.apiHost,
        tenantId,
      },
      audio: {
        noiseFilter: { enabled: true },
        vad: { enabled: true },
        // Backend streaming STT; the pipeline is picked per capture
        // via audio.start({ pipelineId }).
        stt: { enabled: true, provider: 'backend' },
      },
      autoWireTokenRefresh: false,
    };
  }, [mounted, tenantId]);

  if (!config) return <ConsultationDemoSkeleton />;

  return (
    <AgenticProvider config={config}>
      <ScribeWorkspace />
    </AgenticProvider>
  );
}

// ─── the workspace (inside the provider) ───

function ScribeWorkspace() {
  const { session: sdkSession, audio } = useArca();
  const storeApi = useStoreApi();

  const layout = useColumnLayout();
  const metrics = useLiveMetrics();

  const [consultation, setConsultation] = useState<ConsultationListRow | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [pipelineChoice, setPipelineChoice] = useState('');
  // end-user STT language mode. Empty ⇒ pipeline default. The
  // backend guarantees the chosen mode fits the session's engines (422 otherwise).
  const [languageMode, setLanguageMode] = useState('');
  // W2 — the two scoping inputs TASK-789 H-4 found were never supplied.
  // `departmentId` is bound at OPEN (it is a property of the consultation and
  // feeds the workflow-assignment cascade); `dnaStyleId` is bound at GENERATE.
  const [departmentId, setDepartmentId] = useState('');
  const [dnaStyleId, setDnaStyleId] = useState('');
  const languageModes = useArcaSttLanguageModes();
  // the citation currently highlighted in the live-session
  // column's transcript-review pane (click-to-source from the case-note
  // column's evidence panel).
  const [selectedCitationId, setSelectedCitationId] = useState<string | null>(null);

  const pipelines = useAudioPipelines();
  const departments = useScopingDepartments();
  const dnaStyles = useDnaStyleOptions();
  const defaultPipelineId = pipelines.data ? ((pipelines.data.find((pipeline) => pipeline.isDefault) ?? pipelines.data[0])?.id ?? '') : '';
  const pipelineId = pipelineChoice || defaultPipelineId;

  const recordingStart = useStartRecording();
  const recordingStop = useStopRecording();
  // W5/M-7 — manual generation runs as a QUEUED JOB with an SSE progress
  // stream, not a blocking mutation. That path was fully built and had zero
  // call sites; the sync mutation it replaces held the button for the whole
  // LLM generation with no feedback and no way out.
  const summaryAsync = useGenerateSummaryAsync();
  const cancelSummaryJob = useCancelConsultationJob();
  const [summaryJobId, setSummaryJobId] = useState<string | null>(null);
  const approve = useApproveSummary();
  const summaryEdit = useUpdateSummary();

  const consultationId = consultation?.id ?? null;
  const isRecording = (consultation?.status ?? '').toUpperCase() === 'RECORDING';
  const isClosed = (consultation?.status ?? '').toUpperCase() === 'CLOSED';

  // SDK-native live running-SOAP preview (opens SSE direct to the gateway via
  // the SDK client). Driven imperatively from the record/select handlers.
  const live = useArcaLiveSummary();
  const draft = useLatestSummary(consultationId, !!consultationId);
  const progress = useHarnessProgressStream(consultationId, !!consultationId);
  const assurance = useHarnessAssuranceStream(consultationId, !!consultationId);
  // W4 — the agentic loop's live activity feed (realtime summaries etc).
  const loop = useConsultationLoopStream(consultationId, !!consultationId);

  // the evidence panel + its transcript-review highlight
  // only apply once a persisted draft exists (the reviewable artifact); both
  // reads are best-effort and never block the rest of the workspace.
  const draftId = draft.data?.id ?? null;
  const provenance = useSummaryProvenance(consultationId, draftId, !!draftId);
  const transcripts = useTranscriptions(consultationId, !!draftId);
  const transcriptText = transcripts.data?.length === 1 ? (transcripts.data[0].content ?? null) : null;
  const citedSegments: CitedSegment[] = provenance.data?.citedSegments ?? [];
  const selectedCitation = citedSegments.find((segment) => segment.id === selectedCitationId) ?? null;
  const highlightCharStart = selectedCitation?.charStart ?? null;
  const highlightCharEnd = selectedCitation?.charEnd ?? null;
  // Memoized so the reference is stable across unrelated re-renders (e.g. an
  // SSE tick) — LiveSessionColumn's auto-scroll effect keys off this object's
  // identity, and re-scrolling on every render (not just a genuine citation
  // change) would be janky.
  const reviewHighlight = useMemo<TranscriptReviewHighlight | null>(
    () => (highlightCharStart != null && highlightCharEnd != null ? { charStart: highlightCharStart, charEnd: highlightCharEnd } : null),
    [highlightCharStart, highlightCharEnd],
  );

  // Fold live-summary flushes into the real per-session metrics.
  useEffect(() => {
    if (live.snapshot) metrics.ingest(live.snapshot);
  }, [live.snapshot, metrics]);

  // Real consultation list — TanStack Query over the SDK method (rule 13: no
  // fetch-in-useEffect). The SDK is untyped at the app boundary (dts: false).
  const listQuery = useQuery({
    queryKey: [...playgroundConsultationKeys.root, 'scribe-list'],
    queryFn: async (): Promise<ConsultationListRow[]> => {
      const page = await sdkSession.listConsultations({ limit: 50 });
      const items: Array<{ id: string; patientId: string; status?: unknown; createdAt?: string }> = page?.data ?? [];
      return items.map((item) => ({ id: item.id, patientId: item.patientId, status: String(item.status ?? 'OPEN'), createdAt: item.createdAt }));
    },
  });
  const rows = listQuery.data ?? [];
  const listError = listQuery.error ? errorMessage(listQuery.error, 'Could not load consultations') : null;

  function selectConsultation(next: ConsultationListRow | null) {
    setConsultation(next);
    setApproved(false);
    setSelectedCitationId(null);
    metrics.reset();
    // Live SOAP only streams while recording; a terminal consultation shows
    // its persisted draft instead.
    if (next && next.status.toUpperCase() === 'RECORDING') live.start(next.id);
    else live.stop();
  }

  async function handleSelect(row: ConsultationListRow) {
    try {
      const loaded = await sdkSession.load(row.id);
      selectConsultation({
        id: loaded.id,
        patientId: loaded.patientId,
        status: String(loaded.status ?? row.status),
        createdAt: loaded.createdAt ?? row.createdAt,
      });
    } catch (error) {
      toast.error(errorMessage(error, 'Could not open the consultation'));
    }
  }

  async function handleOpenPatient(patientId: string, department?: string) {
    try {
      // `departmentId` reaches the gateway DTO verbatim; the SDK forwards the
      // input object as the request body.
      const opened = await sdkSession.open({ patientId, ...(department ? { departmentId: department } : {}) });
      const row: ConsultationListRow = {
        id: opened.id,
        patientId: opened.patientId,
        status: String(opened.status ?? 'OPEN'),
        createdAt: typeof opened.createdAt === 'string' ? opened.createdAt : new Date().toISOString(),
      };
      selectConsultation(row);
      void listQuery.refetch();
      toast.success('Consultation opened');
    } catch (error) {
      toast.error(errorMessage(error, 'Could not open the consultation'));
      throw error;
    }
  }

  async function handleStart() {
    if (!consultation) return;
    setCaptureBusy(true);
    try {
      await audio.start({ pipelineId: pipelineId || undefined, ...(languageMode ? { languageMode } : {}) });
      const sessionId = (await resolveStreamingSessionId(storeApi)) ?? undefined;
      const state = await recordingStart.mutateAsync({ consultationId: consultation.id, sessionId });
      setConsultation((previous) => (previous ? { ...previous, status: state.status } : previous));
      live.start(consultation.id);
      toast.success('Recording started');
    } catch (error) {
      toast.error(errorMessage(error, 'Could not start recording'));
      void audio.stop().catch(() => undefined);
    } finally {
      setCaptureBusy(false);
    }
  }

  async function handleStop() {
    if (!consultation) return;
    setCaptureBusy(true);
    try {
      await audio.stop();
      const state = await recordingStop.mutateAsync({ consultationId: consultation.id });
      setConsultation((previous) => (previous ? { ...previous, status: state.status } : previous));
      live.stop();
      toast.success('Recording stopped — final snapshot persisted');
    } catch (error) {
      toast.error(errorMessage(error, 'Could not stop recording'));
    } finally {
      setCaptureBusy(false);
    }
  }

  async function handleSwitchToFallback() {
    try {
      await audio.switchToFallback();
      toast.success('Switching to the fallback transcription provider');
    } catch (error) {
      toast.error(errorMessage(error, 'Could not switch to the fallback provider'));
    }
  }

  const summaryJob = useSummaryJobProgress(summaryJobId, {
    onTerminal: (job) => {
      setSummaryJobId(null);
      const status = job.status.toUpperCase();
      if (status === 'COMPLETED') toast.success('Note generated');
      else if (status === 'CANCELLED') toast.success('Note generation cancelled');
      else toast.error(job.errorMessage || 'Note generation failed');
    },
  });

  function handleGenerate() {
    if (!consultation) return;
    summaryAsync.mutate(
      { consultationId: consultation.id, body: dnaStyleId ? { dnaStyleId } : undefined },
      {
        onSuccess: (job) => setSummaryJobId(job.jobId),
        onError: (error) => toast.error(errorMessage(error, 'Note generation failed')),
      },
    );
  }

  function handleCancelGenerate() {
    if (!summaryJobId) return;
    cancelSummaryJob.mutate(summaryJobId, {
      onError: (error) => toast.error(errorMessage(error, 'Could not cancel the generation')),
    });
  }

  function handleApprove({ overrideSafetyFlag }: { overrideSafetyFlag: boolean }) {
    const draftId = draft.data?.id;
    if (!consultation || !draftId) return;
    approve.mutate(
      { consultationId: consultation.id, contextItemId: draftId, body: overrideSafetyFlag ? { overrideSafetyFlag: true } : undefined },
      {
        onSuccess: () => {
          setApproved(true);
          toast.success('Note signed');
        },
        onError: (error) => toast.error(errorMessage(error, 'Could not sign the note')),
      },
    );
  }

  // W1/R5 — the clinician's editing buffer over the persisted draft. The
  // two-writer policy lives in the hook (see its docblock); this only supplies
  // the transport: an If-Match PATCH, and a fresh read for the 412 comparison.
  const editableDraft = useMemo<EditableDraft | null>(
    () => (draft.data ? { id: draft.data.id, content: draft.data.content, version: draft.data.version } : null),
    [draft.data],
  );
  const noteEditor = useNoteEditor({
    draft: editableDraft,
    onSave: async ({ summaryId, content, expectedVersion }) => {
      const saved = await summaryEdit.mutateAsync({
        consultationId: consultationId as string,
        summaryId,
        body: { content, changeSource: 'doctor_edit', changeReason: 'Clinician edit' },
        expectedVersion,
      });
      toast.success('Note saved');
      return { id: saved.id, content: saved.content, version: saved.version };
    },
    // Deliberately NOT the cached query: a 412 means the cache is the stale
    // thing, so the comparison must come off the wire.
    onReload: async () => {
      if (!consultationId) return null;
      const latest = await getLatestSummary(consultationId);
      return latest ? { id: latest.id, content: latest.content, version: latest.version } : null;
    },
  });

  // Harness owns drafting once its progress stream reports stages — hide the
  // manual generate action then (avoids the generate-vs-auto-harness race).
  const harnessActive = !!progress.snapshot && (progress.snapshot.stages?.length ?? 0) > 0;

  const transcriptionModels: ModelOption[] = useMemo(
    () =>
      (pipelines.data ?? []).map((pipeline) => ({
        id: pipeline.id,
        name: pipeline.name ?? pipeline.id,
        source: 'backend' as const,
        description: pipeline.description ?? undefined,
      })),
    [pipelines.data],
  );

  // The note model isn't a picker endpoint yet — surface the model that
  // actually produced the current draft (real provenance) as the selection.
  const noteModelName = draft.data?.structuredData?.modelName;
  const noteModels: ModelOption[] = useMemo(
    () => (noteModelName ? [{ id: noteModelName, name: noteModelName, source: 'backend' as const }] : []),
    [noteModelName],
  );

  return (
    // `ScreenTemplate` in `fill` mode (rule 11 §1): the resizable 3-column
    // group owns the remaining height and each column scrolls internally, so
    // nothing is nested inside a second scroll area. `ScribeFooter` — already
    // an IDE-style bottom bar — rides the pinned `footer` slot; the `header`
    // gives the workspace the page-level h1 it previously lacked (rule 11 §6).
    <ScreenTemplate
      contentMode="fill"
      header={<PageHeader title="Consultation Scribe" meta="Live capture → transcription → personalized note → sign-off, on @arcaai/vox." />}
      footer={
        <ScribeFooter
          transcriptionModels={transcriptionModels}
          selectedTranscriptionId={pipelineId}
          onTranscriptionChange={setPipelineChoice}
          transcriptionLoading={pipelines.isLoading}
          languageModes={languageModes.modes}
          selectedLanguageMode={languageMode}
          onLanguageModeChange={setLanguageMode}
          languageModesLoading={languageModes.isLoading}
          noteModels={noteModels}
          selectedNoteId={noteModelName ?? ''}
          onNoteChange={() => undefined}
          dnaStyles={dnaStyles.data ?? []}
          selectedDnaStyleId={dnaStyleId}
          onDnaStyleChange={setDnaStyleId}
          metrics={{ tokensPerSecond: metrics.tokensPerSecond, latencyP95Ms: metrics.latencyP95Ms, uplinkBitsPerSecond: audio.uplinkBitrate || null }}
        />
      }
    >
      {layout.isReady ? (
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={{ consultations: layout.sizes[0], live: layout.sizes[1], note: layout.sizes[2] }}
          onLayoutChanged={(next, meta) => {
            if (!meta.isUserInteraction) return;
            const sizes = [next.consultations, next.live, next.note];
            if (sizes.every((size) => typeof size === 'number' && Number.isFinite(size))) layout.persist(sizes);
          }}
          className="bg-card min-h-0 flex-1 overflow-hidden rounded-xl border"
        >
          <ResizablePanel id="consultations" defaultSize={layout.sizes[0]} minSize={16} className="min-w-0">
            <ConsultationsColumn
              rows={rows}
              isLoading={listQuery.isLoading}
              error={listError}
              selectedId={consultationId}
              onSelect={handleSelect}
              onOpenPatient={handleOpenPatient}
              activeIsRecording={isRecording}
              departments={departments.data ?? []}
              selectedDepartmentId={departmentId}
              onDepartmentChange={setDepartmentId}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="live" defaultSize={layout.sizes[1]} minSize={22} className="min-w-0">
            <LiveSessionColumn
              hasConsultation={!!consultation}
              isRecording={isRecording}
              isCapturing={audio.isCapturing}
              captureBusy={captureBusy}
              canRecord={!!consultation && !isClosed}
              level={audio.level}
              segments={audio.transcriptSegments as SdkTranscriptSegment[]}
              interim={audio.currentTranscript}
              onStart={handleStart}
              onStop={handleStop}
              reviewTranscriptText={transcriptText}
              reviewHighlight={reviewHighlight}
              sttConnectionState={audio.sttConnectionState}
              onFallback={audio.activePipeline?.isFallback ?? false}
              onSwitchToFallback={handleSwitchToFallback}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="note" defaultSize={layout.sizes[2]} minSize={22} className="min-w-0">
            <CaseNoteColumn
              hasConsultation={!!consultation}
              isRecording={isRecording}
              live={live.snapshot}
              draft={draft.data ?? null}
              draftLoading={draft.isLoading}
              progress={progress.snapshot}
              assurance={assurance.snapshot}
              onGenerate={harnessActive ? null : handleGenerate}
              generatePending={summaryAsync.isPending || (!!summaryJobId && !summaryJob.isTerminal)}
              generateStatus={summaryJob.job?.currentStep ?? null}
              onCancelGenerate={summaryJobId ? handleCancelGenerate : null}
              onApprove={handleApprove}
              approvePending={approve.isPending}
              approved={approved}
              citedSegments={citedSegments}
              transcriptText={transcriptText}
              selectedCitationId={selectedCitationId}
              onSelectCitation={(segment) => setSelectedCitationId(segment.id)}
              editor={noteEditor}
              loopActivity={loop.feed}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="min-h-0 flex-1">
          <ConsultationDemoSkeleton />
        </div>
      )}
    </ScreenTemplate>
  );
}
