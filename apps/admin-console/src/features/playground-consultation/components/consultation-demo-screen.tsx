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
import {
  AgenticProvider,
  useArca,
  useArcaLiveSummary,
  useArcaSttLanguageModes,
  useConsultationWorkflow,
  useSelectableConsultationWorkflows,
  useStoreApi,
} from '@arcaai/vox';
import { toast } from 'sonner';
import { GatewayError } from '@/shared/api';
import { PURPOSE_META, grantLifecycle, isConsentDenied, usePatientConsentGrants } from '@/features/consent/api';
import { RecordConsentDialog } from '@/features/consent/components/record-consent-dialog';
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
  useDocumentSectionsStream,
  useLiveAssistStream,
  useLatestSummary,
  useNamedEntities,
  useScopingDepartments,
  useStartRecording,
  useSummaryJobProgress,
  useStopRecording,
  useSummaryProvenance,
  useTranscriptions,
  useUpdateSummary,
  type CitedSegment,
} from '../api';
import type { CorrectionProposal } from '../api/live-assist';
import { useColumnLayout } from '../hooks/use-column-layout';
import { useLiveMetrics } from '../hooks/use-live-metrics';
import { useNoteEditor, type EditableDraft } from '../hooks/use-note-editor';
import { CaseNoteColumn } from './scribe/case-note-column';
import { ConsultationsColumn, type ConsultationListRow } from './scribe/consultations-column';
import { GoverningWorkflowMeta } from './scribe/governing-workflow-meta';
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
  // D-17: `context` was never destructured, so `addCaseNote`/`addAttachment` had zero call
  // sites — a clinician had no way to hand the loop a supplementary detail mid-consultation.
  const { session: sdkSession, audio, context, isReady: sdkReady } = useArca();
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
  // W2 — the two scoping inputs found were never supplied.
  // `departmentId` is bound at OPEN (it is a property of the consultation and
  // feeds the workflow-assignment cascade); `dnaStyleId` is bound at GENERATE.
  const [departmentId, setDepartmentId] = useState('');
  const [dnaStyleId, setDnaStyleId] = useState('');
  // which PUBLISHED consultation workflow governs the session being opened.
  // Bound at OPEN like `departmentId` (it is a property of the consultation, not of the
  // capture). EMPTY IS THE DEFAULT and means "send no slug": the department → tenant
  // WorkflowAssignment cascade decides, which is what the tenant configured. Preselecting the
  // tenant default would have sent a slug on every open and silently overridden a DEPARTMENT
  // assignment — `isTenantDefault` describes the tenant tier, not this consultation.
  const [workflowChoice, setWorkflowChoice] = useState('');
  const languageModes = useArcaSttLanguageModes();
  // the citation currently highlighted in the live-session
  // column's transcript-review pane (click-to-source from the case-note
  // column's evidence panel).
  const [selectedCitationId, setSelectedCitationId] = useState<string | null>(null);

  const pipelines = useAudioPipelines();
  const departments = useScopingDepartments();
  /**
   * the selectable workflow set and the governing read-back, both from
   * and both previously uncalled anywhere in the console.
   *
   * `workflows.workflows` is deliberately tri-state (`null` could-not-ask vs `[]` none
   * published) and both hooks fail OPEN — a discovery read must never stop a consultation.
   * Nothing is preselected: the default is to send no slug and let the assignment cascade
   * decide. `tenantDefault` is surfaced in the picker as a HINT about the tenant tier.
 */
  const selectableWorkflows = useSelectableConsultationWorkflows();
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
  // Which engine ACTUALLY took the consultation — a selection at open is not a guarantee
  // (dispatch is best-effort so a harness outage never blocks an open).
  const governingWorkflow = useConsultationWorkflow(consultationId ?? undefined);
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
  // / — interpreter suggestions + PROPOSED corrections, live
  // while recording. The gateway route was; nothing in the console consumed it
  // until this hook.
  const liveAssist = useLiveAssistStream(consultationId, isRecording);
  // / — N documents from the section.patch plane. A SEPARATE
  // connection from `live` (useArcaLiveSummary) — that SDK hook only ever parses the legacy
  // undiscriminated payload on the same channel.
  const documentSections = useDocumentSectionsStream(consultationId, isRecording);
  // corrections the clinician ACCEPTED, accumulated for `feedback.capture` to
  // promote over the raw transcript when the endpoint sequence runs at recording-stop.
  // Reset per consultation, same as every other derived-state reset on this screen.
  const [acceptedProposals, setAcceptedProposals] = useState<CorrectionProposal[]>([]);

  // the evidence panel + its transcript-review highlight
  // only apply once a persisted draft exists (the reviewable artifact); both
  // reads are best-effort and never block the rest of the workspace.
  const draftId = draft.data?.id ?? null;
  const provenance = useSummaryProvenance(consultationId, draftId, !!draftId);
  const transcripts = useTranscriptions(consultationId, !!draftId);
  /**
   * W3 — the PERSISTED NER aggregate. `useNamedEntities` has existed since this feature
   * was written and had ZERO callers, so `GET :id/named-entities` was never read: once
   * recording stopped, the live snapshot's entities disappeared and nothing replaced them.
   * Enabled only once a draft exists — that is the review phase this read serves, and it
   * keeps the call off the recording path where the live stream is already authoritative.
   */
  const namedEntities = useNamedEntities(consultation?.id ?? null, 'single', !!draft.data);
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
    // Gated on SDK readiness. `listConsultations` throws `SDK not initialized`
    // until AgenticProvider has wired `apiClient` onto the store; firing before
    // that leaves the retry in TanStack's `paused` fetchStatus, where the query
    // is neither loading (`isFetching` false) nor errored — so the column
    // renders "No consultations yet" permanently and the clinician can never
    // re-open a prior consultation. Observed at runtime,
    enabled: sdkReady,
    queryKey: [...playgroundConsultationKeys.root, 'scribe-list'],
    queryFn: async (): Promise<ConsultationListRow[]> => {
      const page = await sdkSession.listConsultations({ limit: 50 });
      const items: Array<{ id: string; patientId: string; status?: unknown; createdAt?: string }> = page?.data ?? [];
      return items.map((item) => ({ id: item.id, patientId: item.patientId, status: String(item.status ?? 'OPEN'), createdAt: item.createdAt }));
    },
  });
  const rows = listQuery.data ?? [];
  const listError = listQuery.error ? errorMessage(listQuery.error, 'Could not load consultations') : null;

  // ─── Consent gate ───
  //
  // `recording/start` and `prime` both carry
  // `@RequiresConsent(AI_DOCUMENTATION)`, so without an active grant for this
  // patient the session cannot start at all. Reading it here turns a raw 403
  // at the end of a failed start (mic already open, audio already running)
  // into a pre-flight block with the fix attached.
  const patientId = consultation?.patientId ?? null;
  const consentQuery = usePatientConsentGrants(patientId);
  const [consentDialogOpen, setConsentDialogOpen] = useState(false);

  const hasDocumentationConsent = useMemo(
    () => (consentQuery.data ?? []).some((grant) => grant.purpose === 'AI_DOCUMENTATION' && grantLifecycle(grant) === 'ACTIVE'),
    [consentQuery.data],
  );

  /**
   * Null ⇒ do not block. Deliberately blocks ONLY on a settled, successful read
   * that found no active grant: while the read is in flight, or when it failed
   * (a role that cannot read the consent register still holds a valid session),
   * the server stays the authority and the clinician is not locked out of a
   * gate the console merely could not see.
   */
  const consentBlockedReason = useMemo(() => {
    if (!consultation || consentQuery.isPending || consentQuery.error) return null;
    if (hasDocumentationConsent) return null;
    return `Recording is blocked: patient ${consultation.patientId} has no active ${PURPOSE_META.AI_DOCUMENTATION.label} consent on record.`;
  }, [consultation, consentQuery.isPending, consentQuery.error, hasDocumentationConsent]);

  function selectConsultation(next: ConsultationListRow | null) {
    setConsultation(next);
    setApproved(false);
    setSelectedCitationId(null);
    setAcceptedProposals([]);
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

  async function handleOpenPatient(patientId: string, department?: string, workflowDefinitionSlug?: string) {
    try {
      // `departmentId` and `workflowDefinitionSlug` reach the gateway DTO verbatim; the SDK
      // forwards the input object as the request body. The slug is authorized by the same
      // predicate that produced the selectable list, so anything offered here is accepted.
      const opened = await sdkSession.open({
        patientId,
        ...(department ? { departmentId: department } : {}),
        ...(workflowDefinitionSlug ? { workflowDefinitionSlug } : {}),
      });
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
    // Pre-flight: never open the microphone for a session the gateway will
    // refuse. The button is already disabled in this state; this covers the
    // programmatic path.
    if (consentBlockedReason) {
      setConsentDialogOpen(true);
      return;
    }
    setCaptureBusy(true);
    try {
      await audio.start({ pipelineId: pipelineId || undefined, ...(languageMode ? { languageMode } : {}) });
      const sessionId = (await resolveStreamingSessionId(storeApi)) ?? undefined;
      const state = await recordingStart.mutateAsync({ consultationId: consultation.id, sessionId });
      setConsultation((previous) => (previous ? { ...previous, status: state.status } : previous));
      live.start(consultation.id);
      toast.success('Recording started');
    } catch (error) {
      // A consent denial is not a fault the clinician can debug from a raw
      // exception message — it is an action they can take. It can still land
      // here despite the pre-flight above: the grant may have been revoked
      // between the read and the start, or the read may have failed and been
      // (correctly) treated as "let the server decide".
      if (error instanceof GatewayError && isConsentDenied(error)) {
        void consentQuery.refetch();
        setConsentDialogOpen(true);
        toast.error('Recording needs patient consent for AI documentation.');
      } else {
        toast.error(errorMessage(error, 'Could not start recording'));
      }
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
      // every correction the clinician accepted this session rides the stop call, so
      // `feedback.capture` has something to promote over the raw transcript.
      const state = await recordingStop.mutateAsync({ consultationId: consultation.id, acceptedProposals });
      setConsultation((previous) => (previous ? { ...previous, status: state.status } : previous));
      live.stop();
      liveAssist.close();
      documentSections.close();
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

  // D-17 — the add-details-during-consultation affordance. Errors surface through the
  // control's own toast (AddDetailControl); rethrow so it can show pending state correctly.
  async function handleAddDetail(content: string) {
    await context.addCaseNote(content);
  }

  // records a clinician's acceptance for promotion over the raw transcript. Keyed by
  // proposalId ( rule 3) — the same envelope re-delivered after a retry must not
  // double the accumulator.
  function handleProposalAccepted(proposal: CorrectionProposal) {
    setAcceptedProposals((current) => (current.some((p) => p.proposalId === proposal.proposalId) ? current : [...current, proposal]));
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
      header={
        <PageHeader
          title="Consultation Scribe"
          meta={
            <>
              <span>Live capture → transcription → personalized note → sign-off, on @arcaai/vox.</span>
              {/* Which engine is actually writing this note. */}
              <GoverningWorkflowMeta workflow={governingWorkflow.workflow} isLoading={governingWorkflow.isLoading} hasConsultation={!!consultationId} />
            </>
          }
        />
      }
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
              // While the SDK is still initializing the query is disabled, so
              // TanStack reports isLoading=false — the column must still read as
              // LOADING, never as an (untrue) empty list.
              isLoading={!sdkReady || listQuery.isLoading}
              error={listError}
              selectedId={consultationId}
              onSelect={handleSelect}
              onOpenPatient={handleOpenPatient}
              activeIsRecording={isRecording}
              departments={departments.data ?? []}
              // P-4: the catalog's loading/failed states reach the column so
              // it can EXPLAIN them, instead of collapsing all three into the
              // same silent blank.
              departmentsLoading={departments.isLoading}
              departmentsError={departments.isError}
              selectedDepartmentId={departmentId}
              onDepartmentChange={setDepartmentId}
              // The workflow the clinician picks at open. Tri-state by design: `null` reaches
              // the column as "could not read", as "none published" (rule 11 §5).
              workflows={selectableWorkflows.workflows}
              workflowsLoading={selectableWorkflows.isLoading}
              selectedWorkflowSlug={workflowChoice}
              onWorkflowChange={setWorkflowChoice}
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
              consentBlockedReason={consentBlockedReason}
              onRecordConsent={() => setConsentDialogOpen(true)}
              onAddDetail={handleAddDetail}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="note" defaultSize={layout.sizes[2]} minSize={22} className="min-w-0">
            <CaseNoteColumn
              hasConsultation={!!consultation}
              isRecording={isRecording}
              live={live.snapshot}
              liveStatus={live.status}
              liveError={live.error?.message ?? null}
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
              namedEntities={namedEntities.data ?? null}
              correctionProposals={liveAssist.corrections}
              onProposalAccepted={handleProposalAccepted}
              onCorrectionsStale={liveAssist.reopen}
              suggestions={liveAssist.suggestions}
              suggestionsNodeType={liveAssist.suggestionsNodeType ?? undefined}
              documentSections={documentSections.documents}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="min-h-0 flex-1">
          <ConsultationDemoSkeleton />
        </div>
      )}

      {/*
 Point-of-care consent capture. The patient is fixed to the
          open consultation and the purpose to the one recording needs, so the
          clinician confirms an attestation rather than filling a form. 
*/}
      <RecordConsentDialog
        open={consentDialogOpen}
        onOpenChange={setConsentDialogOpen}
        patientId={consultation?.patientId}
        defaultPurpose="AI_DOCUMENTATION"
        onRecorded={() => void consentQuery.refetch()}
      />
    </ScreenTemplate>
  );
}
