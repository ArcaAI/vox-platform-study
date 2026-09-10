'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GatewayError, versionFromEtag } from '@/shared/api';
import { useEventStream, type StreamStatus } from '@/shared/streams';
import { foldLoopActivity, type LoopActivityEntry, type LoopEvent } from '../hooks/use-loop-activity';
import type { DocumentSectionRecord, DocumentSectionView, DocumentView, SectionPatch } from './document-sections';
import { liveAssistScopeFor, liveAssistStreamPath, type ClinicalSuggestion, type CorrectionProposal, type CorrectionsEnvelope, type LiveAssistEnvelope } from './live-assist';
import {
  approveSummary,
  cancelConsultationJob,
  confirmDocumentSection,
  consultationJobStreamPath,
  generateSummaryAsync,
  getConsultationJob,
  getDocumentSection,
  getLatestPreSummary,
  getLatestSummary,
  getNamedEntities,
  getSummaryProvenance,
  getTranscriptions,
  harnessAssuranceStreamPath,
  harnessProgressStreamPath,
  liveSummaryStreamPath,
  listDocumentSections,
  loopStreamPath,
  listScopingDepartments,
  startRecording,
  stopRecording,
  updateSummary,
} from './client';
import { playgroundConsultationKeys } from './keys';
import type {
  ApproveSummaryRequest,
  ConsultationJobStatus,
  GenerateSummaryRequest,
  HarnessAssuranceSnapshot,
  HarnessProgressSnapshot,
  SummaryResult,
  UpdateSummaryRequest,
} from './types';
import { isTerminalConsultationJob } from './types';

// ─── REST queries + mutations ───

/**
 * W2 scoping pickers, on the CLINICIAN plane ( / P-4).
 *
 * Best-effort by design: `retry: false`, and a failure degrades scoping to the
 * tenant tier rather than breaking the workspace. What changed is that the
 * degrade is no longer SILENT — `isLoading`/`isError` are handed to the
 * consuming control so it can render a skeleton or an explicit notice
 * (rule 11 §5, rule 10). `retry: false` is what makes `isError` trustworthy
 * enough to render on.
 */
export function useScopingDepartments() {
  return useQuery({
    queryKey: [...playgroundConsultationKeys.root, 'scoping-departments'],
    queryFn: listScopingDepartments,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/**
 * TASK-932 R-16a — how long after `recording/stop` the durable finalizer is given to land the
 * note before the draft pane stops asking, and how often it asks. Under a governing tenant
 * workflow the interpreter's `n_finalize` persists the note tens of seconds after the stop
 * call returns, through a gateway write that carries no summary-job id — so no SSE reaches this
 * screen and a plain query that 404'd at open would never be asked again.
 *
 * TASK-932 OD-5 — the harness-progress stream now pushes the same terminal signal
 * (`consultation-demo-screen.tsx`'s `harnessTerminalHandledRef` effect), so this poll is a
 * fallback for one release rather than the primary path; shortened from 180s accordingly.
 */
export const FINALIZE_SETTLE_WINDOW_MS = 60_000;
export const FINALIZE_POLL_MS = 5_000;

export interface UseLatestSummaryOptions {
  /** `Date.now()` of the stop being settled; `null`/absent = not settling, never poll. */
  awaitingFinalizeSince?: number | null;
  /** Poll cadence while settling (tests shrink it). */
  pollMs?: number;
}

/** Latest draft for the review pane. null = nothing generated yet (not an error). */
export function useLatestSummary(consultationId: string | null, enabled = true, options: UseLatestSummaryOptions = {}) {
  const { awaitingFinalizeSince = null, pollMs = FINALIZE_POLL_MS } = options;
  return useQuery({
    queryKey: playgroundConsultationKeys.latestSummary(consultationId ?? 'none'),
    queryFn: () => getLatestSummary(consultationId as string),
    enabled: enabled && !!consultationId,
    // Bounded, and only while there is nothing on screen: a draft already loaded is never
    // re-polled, and a consultation that never finalizes is not asked forever.
    refetchInterval: (query) => {
      if (awaitingFinalizeSince === null || query.state.data) return false;
      return Date.now() - awaitingFinalizeSince < FINALIZE_SETTLE_WINDOW_MS ? pollMs : false;
    },
  });
}

/**
 * W1 — persist a clinician edit to the SOAP note under If-Match.
 *
 * Deliberately does NOT invalidate on error: a 412 must leave the cached draft
 * alone so `useNoteEditor` can show the clinician's text beside the server's.
 */
export function useUpdateSummary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      consultationId,
      summaryId,
      body,
      expectedVersion,
    }: {
      consultationId: string;
      summaryId: string;
      body: UpdateSummaryRequest;
      expectedVersion: number;
    }): Promise<SummaryResult> => updateSummary(consultationId, summaryId, body, expectedVersion),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: playgroundConsultationKeys.root }),
  });
}

export function useNamedEntities(consultationId: string | null, scope: 'single' | 'chain' = 'single', enabled = true) {
  return useQuery({
    queryKey: playgroundConsultationKeys.namedEntities(consultationId ?? 'none', scope),
    queryFn: () => getNamedEntities(consultationId as string, scope),
    enabled: enabled && !!consultationId,
  });
}

/**
 * Persisted transcripts for the consultation — the
 * evidence panel's snippet/highlight source. Distinct from the SDK's LIVE,
 * in-browser transcript segments (`audio.transcriptSegments`): this is the
 * decrypted, persisted TRANSCRIPT context item content, fetched once a draft
 * exists for review/sign-off.
 */
export function useTranscriptions(consultationId: string | null, enabled = true) {
  return useQuery({
    queryKey: playgroundConsultationKeys.transcriptions(consultationId ?? 'none'),
    queryFn: () => getTranscriptions(consultationId as string),
    enabled: enabled && !!consultationId,
  });
}

/** Citation + sensor provenance for a generated summary (evidence panel). */
export function useSummaryProvenance(consultationId: string | null, contextItemId: string | null, enabled = true) {
  return useQuery({
    queryKey: playgroundConsultationKeys.provenance(consultationId ?? 'none', contextItemId ?? 'none'),
    queryFn: () => getSummaryProvenance(consultationId as string, contextItemId as string),
    enabled: enabled && !!consultationId && !!contextItemId,
  });
}

export function useStartRecording() {
  return useMutation({
    mutationFn: ({ consultationId, sessionId }: { consultationId: string; sessionId?: string }) => startRecording(consultationId, sessionId),
  });
}

export function useStopRecording() {
  return useMutation({
    mutationFn: ({
      consultationId,
      persistSnapshot,
      acceptedProposals,
    }: {
      consultationId: string;
      persistSnapshot?: boolean;
      /** corrections the clinician accepted, to promote over the raw transcript. */
      acceptedProposals?: readonly CorrectionProposal[];
    }) => stopRecording(consultationId, persistSnapshot ?? true, acceptedProposals ?? []),
  });
}

export function useGenerateSummaryAsync() {
  return useMutation({
    mutationFn: ({ consultationId, body }: { consultationId: string; body?: GenerateSummaryRequest }) => generateSummaryAsync(consultationId, body),
  });
}

export function useCancelConsultationJob() {
  return useMutation({ mutationFn: (jobId: string) => cancelConsultationJob(jobId) });
}

export function useApproveSummary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ consultationId, contextItemId, body }: { consultationId: string; contextItemId: string; body?: ApproveSummaryRequest }) =>
      approveSummary(consultationId, contextItemId, body ?? {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: playgroundConsultationKeys.root }),
  });
}

// ─── SSE snapshot folds ───
//
// The gateway live streams publish FULL-STATE snapshots (LiveSummaryEventDto /
// HarnessProgressEventDto / HarnessAssuranceEventDto) so clients stay
// stateless: keep only the latest accepted event, close on `closed: true`
// (single-use tickets — never leave a zombie EventSource on a dead channel).

function parseJson<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export interface SnapshotStreamHandle<T> {
  /** Latest accepted full-state snapshot (null before the first event). */
  snapshot: T | null;
  status: StreamStatus;
  error: string | null;
  close: () => void;
  reopen: () => void;
}

interface UseSnapshotStreamOptions<T> {
  path: string | null;
  scope: string | null;
  enabled: boolean;
  /** Rejects non-snapshot payloads (heartbeats/keepalives) so they can't clobber state. */
  accept: (parsed: T) => boolean;
  /** Named SSE events that also carry snapshots (besides default `message`). */
  eventNames?: readonly string[];
}

function useSnapshotStream<T extends { closed?: boolean }>({
  path,
  scope,
  enabled,
  accept,
  eventNames,
}: UseSnapshotStreamOptions<T>): SnapshotStreamHandle<T> {
  const [snapshot, setSnapshot] = useState<T | null>(null);

  // Render-time derived-state reset: a new consultation must not inherit
  // the previous stream's folded snapshot.
  const [trackedScope, setTrackedScope] = useState(scope);
  if (scope !== trackedScope) {
    setTrackedScope(scope);
    setSnapshot(null);
  }

  const acceptRef = useRef(accept);
  useEffect(() => {
    acceptRef.current = accept;
  }, [accept]);

  // handleEvent needs stream.close, created before the handle exists —
  // bridge with a ref (close is identity-stable).
  const closeRef = useRef<(() => void) | null>(null);

  const handleEvent = useCallback((_type: string, data: string) => {
    const parsed = parseJson<T>(data);
    if (!parsed || !acceptRef.current(parsed)) return;
    setSnapshot(parsed);
    if (parsed.closed) closeRef.current?.();
  }, []);

  const stream = useEventStream({ path, scope, eventNames, onEvent: handleEvent, enabled });
  useEffect(() => {
    closeRef.current = stream.close;
  }, [stream.close]);

  return { snapshot, status: stream.status, error: stream.error, close: stream.close, reopen: stream.reopen };
}

/** Harness stage checklist — scope `consultation_harness_progress:<id>`. */
export function useHarnessProgressStream(consultationId: string | null, enabled = true): SnapshotStreamHandle<HarnessProgressSnapshot> {
  return useSnapshotStream<HarnessProgressSnapshot>({
    path: consultationId ? harnessProgressStreamPath(consultationId) : null,
    scope: consultationId ? `consultation_harness_progress:${consultationId}` : null,
    enabled: enabled && !!consultationId,
    accept: (parsed) => Array.isArray(parsed.stages),
  });
}

/**
 * Per-claim assurance verdicts — scope `consultation_harness_assurance:<id>`.
 * The terminal aggregate arrives as the NAMED `assurance_complete` event.
 */
export function useHarnessAssuranceStream(consultationId: string | null, enabled = true): SnapshotStreamHandle<HarnessAssuranceSnapshot> {
  return useSnapshotStream<HarnessAssuranceSnapshot>({
    path: consultationId ? harnessAssuranceStreamPath(consultationId) : null,
    scope: consultationId ? `consultation_harness_assurance:${consultationId}` : null,
    enabled: enabled && !!consultationId,
    accept: (parsed) => Array.isArray(parsed.claims),
    eventNames: ['assurance_complete'],
  });
}

/**
 * W4 — the agentic loop plane's live feed. APPEND-ONLY, unlike the snapshot
 * streams above: `LoopEventDto` messages are self-contained with no fold and
 * no late-join replay, so events are accumulated rather than replaced.
 */
export function useConsultationLoopStream(consultationId: string | null, enabled = true) {
  const [feed, setFeed] = useState<LoopActivityEntry[]>([]);

  // Render-time derived-state reset: a new consultation starts a new feed.
  const [trackedId, setTrackedId] = useState(consultationId);
  if (consultationId !== trackedId) {
    setTrackedId(consultationId);
    setFeed([]);
  }

  const handleEvent = useCallback((_type: string, data: string) => {
    const parsed = parseJson<LoopEvent>(data);
    if (!parsed?.kind) return;
    setFeed((current) => foldLoopActivity(current, parsed));
  }, []);

  const stream = useEventStream({
    path: consultationId ? loopStreamPath(consultationId) : null,
    scope: consultationId ? `consultation_loop:${consultationId}` : null,
    onEvent: handleEvent,
    enabled: enabled && !!consultationId,
  });

  return { feed, status: stream.status, error: stream.error };
}

/**
 * / — the `live-assist` plane: interpreter
 * suggestions and PROPOSED corrections, live while recording. One SSE
 * connection carries BOTH branches, discriminated by `kind` (a suggestions
 * publish never touches `corrections` and vice versa — see
 * `LiveAssistEnvelope`'s doc comment). Each publish is a full-state replace of
 * its own branch, same posture as the other snapshot streams on this
 * consultation. The feed has no terminal event (unlike live-summary /
 * harness-progress) — the caller closes it, typically when recording stops.
 */
export interface LiveAssistStreamHandle {
  suggestions: ClinicalSuggestion[];
  suggestionsNodeType: string | null;
  corrections: CorrectionsEnvelope | null;
  correctionsNodeType: string | null;
  status: StreamStatus;
  error: string | null;
  close: () => void;
  reopen: () => void;
}

export function useLiveAssistStream(consultationId: string | null, enabled = true): LiveAssistStreamHandle {
  const [suggestions, setSuggestions] = useState<ClinicalSuggestion[]>([]);
  const [suggestionsNodeType, setSuggestionsNodeType] = useState<string | null>(null);
  const [corrections, setCorrections] = useState<CorrectionsEnvelope | null>(null);
  const [correctionsNodeType, setCorrectionsNodeType] = useState<string | null>(null);

  // Render-time derived-state reset: a new consultation starts with no
  // suggestions/corrections carried over from the previous one.
  const [trackedId, setTrackedId] = useState(consultationId);
  if (consultationId !== trackedId) {
    setTrackedId(consultationId);
    setSuggestions([]);
    setSuggestionsNodeType(null);
    setCorrections(null);
    setCorrectionsNodeType(null);
  }

  const handleEvent = useCallback((_type: string, data: string) => {
    const parsed = parseJson<LiveAssistEnvelope>(data);
    if (!parsed?.kind) return;
    if (parsed.kind === 'suggestions') {
      setSuggestions(parsed.suggestions ?? []);
      setSuggestionsNodeType(parsed.nodeType ?? null);
    } else if (parsed.kind === 'corrections' && parsed.corrections) {
      setCorrections(parsed.corrections);
      setCorrectionsNodeType(parsed.nodeType ?? null);
    }
  }, []);

  const stream = useEventStream({
    path: consultationId ? liveAssistStreamPath(consultationId) : null,
    scope: consultationId ? liveAssistScopeFor(consultationId) : null,
    onEvent: handleEvent,
    enabled: enabled && !!consultationId,
  });

  return { suggestions, suggestionsNodeType, corrections, correctionsNodeType, status: stream.status, error: stream.error, close: stream.close, reopen: stream.reopen };
}

/**
 * / — N documents, folded from the `section.patch` plane on the
 * SAME `live-summary/stream` channel `useArcaLiveSummary` already opens for the legacy
 * whole-document view. That SDK hook only ever parses the undiscriminated legacy payload, so
 * this is a SEPARATE connection (Redis pub/sub — more than one subscriber is normal), filtered
 * to `event === 'section.patch'` and folded per `(documentKey, sectionKey)`.
 */
export interface DocumentSectionsStreamHandle {
  /** Documents in FIRST-SEEN order; each document's sections sorted by `idx`. */
  documents: DocumentView[];
  status: StreamStatus;
  error: string | null;
  close: () => void;
  reopen: () => void;
}

export function useDocumentSectionsStream(consultationId: string | null, enabled = true): DocumentSectionsStreamHandle {
  // Keyed `${documentKey}::${sectionKey}` -> the folded section (revision-gated on write).
  const [sections, setSections] = useState<Record<string, DocumentSectionView & { documentKey: string }>>({});
  // First-seen document order, tracked separately — an object's key order is an implementation
  // detail this component should not lean on for something the UI renders positionally.
  const [documentOrder, setDocumentOrder] = useState<string[]>([]);

  const [trackedId, setTrackedId] = useState(consultationId);
  if (consultationId !== trackedId) {
    setTrackedId(consultationId);
    setSections({});
    setDocumentOrder([]);
  }

  const handleEvent = useCallback((_type: string, data: string) => {
    const patch = parseJson<SectionPatch>(data);
    if (!patch || patch.event !== 'section.patch') return; // the legacy full-snapshot payload — not ours
    const key = `${patch.documentKey}::${patch.sectionKey}`;
    setSections((current) => {
      const existing = current[key];
      // a patch whose revision is not greater than the one already held MUST be
      // discarded — the SSE plane makes no ordering guarantee.
      if (existing && patch.revision <= existing.revision) return current;
      return {
        ...current,
        [key]: {
          documentKey: patch.documentKey,
          sectionKey: patch.sectionKey,
          title: patch.title,
          idx: patch.idx,
          revision: patch.revision,
          state: patch.state,
          content: patch.content,
          annotations: patch.annotations ?? [],
          // The most recent accepted patch's value, whether or not it carries one — a patch
          // that replaced rather than appended (a correction, a confirm) must clear a highlight
          // an EARLIER patch set, never leave it pointing at now-stale content.
          appended: patch.appended,
        },
      };
    });
    setDocumentOrder((current) => (current.includes(patch.documentKey) ? current : [...current, patch.documentKey]));
  }, []);

  const stream = useEventStream({
    path: consultationId ? liveSummaryStreamPath(consultationId) : null,
    scope: consultationId ? `consultation_live_summary:${consultationId}` : null,
    // TASK-932 lane L relay: the gateway now tags this frame's SSE `type` from the payload's own
    // `event` instead of multiplexing it onto the default `message`. The `patch.event` check
    // above stays as defense-in-depth for an older gateway still on `message`.
    eventNames: ['section.patch'],
    onEvent: handleEvent,
    enabled: enabled && !!consultationId,
  });

  // R4 — hydrate documents already known to this fold from the DURABLE view, so a dropped SSE
  // frame or a reconnect (recording stopped and restarted without a remount — `documentOrder`
  // survives that, only a `consultationId` change resets it) is reconciled from the row the
  // gateway itself points to for exactly this: "the section.patch SSE lane only emits while a
  // flush is running, so a client that reloads mid-encounter reads its state here." Gated on
  // `documentOrder` rather than firing blind: nothing in the console plane can enumerate a
  // consultation's document keys ahead of a first section.patch (the list route itself REQUIRES
  // one), so a cold reload before anything has ever streamed still shows a skeleton until the
  // next flush — same as before this change, not a regression.
  const hydrate = useQuery({
    queryKey: [...playgroundConsultationKeys.documentSectionsHydrate(consultationId ?? 'none'), documentOrder],
    queryFn: async (): Promise<DocumentSectionRecord[]> => {
      const perDocument = await Promise.all(
        documentOrder.map(async (documentKey) => {
          try {
            return await listDocumentSections(consultationId as string, documentKey);
          } catch (error) {
            if (error instanceof GatewayError && error.isNotFound) return [];
            throw error;
          }
        }),
      );
      return perDocument.flat();
    },
    enabled: enabled && !!consultationId && documentOrder.length > 0,
  });

  if (hydrate.data) {
    const folded = foldHydratedDocumentSections(sections, hydrate.data);
    if (folded !== sections) setSections(folded);
  }

  const documents = useMemo<DocumentView[]>(() => {
    const bySections = Object.values(sections);
    return documentOrder.map((documentKey) => ({
      documentKey,
      sections: bySections
        .filter((section) => section.documentKey === documentKey)
        .sort((a, b) => a.idx - b.idx)
        .map(({ documentKey: _drop, ...section }) => section),
    }));
  }, [sections, documentOrder]);

  return { documents, status: stream.status, error: stream.error, close: stream.close, reopen: stream.reopen };
}

/**
 * Folds a `GET .../documents/:documentKey/sections` read into the SSE-derived state. Exported
 * for the reducer test, same rationale as `foldPreSummaryEvent`/`reconcilePreSummaryFromLatest`.
 *
 * Uses `revision` — NEVER `version` — as the ordering token, for the same reason the SSE fold
 * does: `version` is the section's OCC precondition, `revision` is what orders writes
 * (`DocumentSectionRecord`'s own docblock in `document-sections.ts`). A hydrated read therefore
 * never clobbers state a LATER SSE patch already produced, and never regresses an
 * already-accepted revision — same discard rule (`<=`), just fed from REST instead of SSE.
 */
export function foldHydratedDocumentSections(
  current: Record<string, DocumentSectionView & { documentKey: string }>,
  hydrated: readonly DocumentSectionRecord[],
): Record<string, DocumentSectionView & { documentKey: string }> {
  let next = current;
  for (const item of hydrated) {
    const key = `${item.documentKey}::${item.sectionKey}`;
    const existing = next[key];
    if (existing && item.revision <= existing.revision) continue;
    if (next === current) next = { ...current };
    next[key] = {
      documentKey: item.documentKey,
      sectionKey: item.sectionKey,
      title: item.title,
      idx: item.idx,
      revision: item.revision,
      state: item.state,
      content: item.content,
      annotations: item.annotations ?? [],
      // A durable REST read never carries `appended` — nothing "just arrived" from a page
      // load's perspective, so any highlight an earlier SSE patch set is cleared, never guessed.
    };
  }
  return next;
}

export interface ConfirmDocumentSectionInput {
  consultationId: string;
  documentKey: string;
  sectionKey: string;
}

/**
 * R4/OD-5 — the clinician's CHECKPOINT. Re-reads the section FIRST for a fresh `version` +
 * `content` pair: the SSE fold this console renders from carries `revision` only, never the OCC
 * token the confirm PATCH's `If-Match` requires (`document-sections.ts`'s own note on why the
 * two numbers differ), and re-sending the section's OWN current content is enough to transition
 * it `provisional` -> `confirmed` without editing it.
 */
export function useConfirmDocumentSection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ consultationId, documentKey, sectionKey }: ConfirmDocumentSectionInput): Promise<DocumentSectionRecord> => {
      const read = await getDocumentSection(consultationId, documentKey, sectionKey);
      if (!read.etag) throw new Error(`Section ${sectionKey} of ${documentKey} carried no ETag to confirm against.`);
      return confirmDocumentSection(consultationId, documentKey, sectionKey, read.data.content, versionFromEtag(read.etag));
    },
    onSuccess: (_result, variables) =>
      void queryClient.invalidateQueries({ queryKey: playgroundConsultationKeys.documentSectionsHydrate(variables.consultationId) }),
  });
}

/**
 * TASK-932 D-9 — the WARM-START panel's feed: the `presummary` events on the SAME
 * `live-summary/stream` channel the case note and the section patches already use.
 *
 * A separate connection for the same reason `useDocumentSectionsStream` is one: the SDK's
 * `useArcaLiveSummary` parses only the undiscriminated legacy payload, and Redis pub/sub is
 * happy with more than one subscriber. Filtered to `event === 'presummary'`; every other message
 * on the channel — the whole-document snapshot, a `section.patch` — is somebody else's.
 *
 * ## Why three states and a monotonic fold
 *
 * `running` arrives when the session opens and `ready`/`degraded` some seconds later, so the
 * panel must be able to say "working" rather than showing an empty box that a clinician reads as
 * "there is nothing". A TERMINAL state is never displaced by a `running` one: SSE makes no
 * ordering guarantee, and a stale `running` landing after `ready` would take a rendered
 * pre-summary off the screen.
 */
export type PreSummaryStatus = 'running' | 'ready' | 'degraded';

export interface PreSummaryView {
  status: PreSummaryStatus;
  content: string | null;
  /** PHI-safe reason CODE on `degraded` (e.g. `no_case_notes`) — never clinical text. */
  error: string | null;
  agentSlug: string | null;
  updatedAt: string | null;
}

export interface PreSummaryStreamHandle {
  /** `null` until the first event — which is not the same as "there is no warm start". */
  preSummary: PreSummaryView | null;
  status: StreamStatus;
  error: string | null;
  close: () => void;
  reopen: () => void;
}

interface PreSummaryEventPayload {
  event?: string;
  status?: PreSummaryStatus;
  content?: string;
  error?: string;
  agentSlug?: string;
  updatedAt?: string;
}

const TERMINAL_PRE_SUMMARY: ReadonlySet<PreSummaryStatus> = new Set<PreSummaryStatus>(['ready', 'degraded']);

/** Exported for the reducer test — the fold is the part with a rule in it. */
export function foldPreSummaryEvent(current: PreSummaryView | null, raw: string): PreSummaryView | null {
  const event = parseJson<PreSummaryEventPayload>(raw);
  if (!event || event.event !== 'presummary') return current;
  const status = event.status;
  if (status !== 'running' && status !== 'ready' && status !== 'degraded') return current;
  // A terminal state is never displaced by a `running` one (see the docblock).
  if (current && TERMINAL_PRE_SUMMARY.has(current.status) && status === 'running') return current;
  return {
    status,
    content: typeof event.content === 'string' ? event.content : null,
    error: typeof event.error === 'string' ? event.error : null,
    agentSlug: typeof event.agentSlug === 'string' ? event.agentSlug : (current?.agentSlug ?? null),
    updatedAt: typeof event.updatedAt === 'string' ? event.updatedAt : null,
  };
}

/**
 * TASK-932 C1-2 — folds a `getLatestPreSummary` REST read into the SSE-derived state.
 *
 * The REST route reads the SAME persisted row a `ready` SSE event describes, so this is never a
 * competing source of truth — only a way to recover it when the terminal SSE frame never arrived
 * (the 30ms lost-event window in the docblock above). A REST read therefore never regresses
 * anything the fold has already produced: it never overrides an already-terminal state unless the
 * REST answer is PROVABLY newer (a rare re-generation), and it never replaces a `running` state
 * with an equal-or-older `updatedAt`.
 *
 * Exported for the reconciler test — same rationale as `foldPreSummaryEvent`.
 */
export function reconcilePreSummaryFromLatest(current: PreSummaryView | null, latest: SummaryResult): PreSummaryView | null {
  const restView: PreSummaryView = {
    status: 'ready',
    content: latest.content,
    error: null,
    agentSlug: current?.agentSlug ?? null,
    updatedAt: latest.updatedAt ?? null,
  };
  if (!current) return restView;

  const currentTime = current.updatedAt ? Date.parse(current.updatedAt) : null;
  const restTime = restView.updatedAt ? Date.parse(restView.updatedAt) : null;
  const restIsStrictlyNewer = currentTime !== null && restTime !== null && restTime > currentTime;

  if (TERMINAL_PRE_SUMMARY.has(current.status)) return restIsStrictlyNewer ? restView : current;
  if (currentTime !== null && restTime !== null && restTime <= currentTime) return current;
  return restView;
}

export function usePreSummaryStream(consultationId: string | null, enabled = true): PreSummaryStreamHandle {
  const [preSummary, setPreSummary] = useState<PreSummaryView | null>(null);

  const [trackedId, setTrackedId] = useState(consultationId);
  if (consultationId !== trackedId) {
    setTrackedId(consultationId);
    setPreSummary(null);
  }

  const handleEvent = useCallback((_type: string, data: string) => {
    setPreSummary((current) => foldPreSummaryEvent(current, data));
  }, []);

  const stream = useEventStream({
    path: consultationId ? liveSummaryStreamPath(consultationId) : null,
    scope: consultationId ? `consultation_live_summary:${consultationId}` : null,
    // TASK-932 lane L relay: the gateway now tags this frame's SSE `type` from the payload's own
    // `event` instead of multiplexing it onto the default `message`. The `event.event` check in
    // `foldPreSummaryEvent` stays as defense-in-depth for an older gateway still on `message`.
    eventNames: ['presummary'],
    onEvent: handleEvent,
    enabled: enabled && !!consultationId,
  });

  // REST catch-up: recovers a `ready` pre-summary whose terminal SSE event was published before
  // this stream subscribed (lost outright — no replay). Fires once per consultation; reconciled
  // in during render (not an effect) so it can never regress state the fold already produced.
  const catchUp = useQuery({
    queryKey: playgroundConsultationKeys.latestPreSummary(consultationId ?? 'none'),
    queryFn: () => getLatestPreSummary(consultationId as string),
    enabled: enabled && !!consultationId,
  });

  if (catchUp.data) {
    const reconciled = reconcilePreSummaryFromLatest(preSummary, catchUp.data);
    if (reconciled !== preSummary) setPreSummary(reconciled);
  }

  return { preSummary, status: stream.status, error: stream.error, close: stream.close, reopen: stream.reopen };
}

// ─── Async summary job progress (the useDnaJobProgress pattern) ───

/** Fallback poll cadence while the SSE stream is down and the job is non-terminal. */
const JOB_POLL_MS = 2_000;

/** A job snapshot plus its client receipt time (comparable across transports). */
interface JobSnapshot {
  job: ConsultationJobStatus | null;
  at: number;
}

const EMPTY_SNAPSHOT: JobSnapshot = { job: null, at: 0 };

/**
 * Latest-wins merge of the SSE and fallback-poll snapshots — EXCEPT a
 * terminal snapshot is never displaced by a non-terminal one (a stale
 * in-flight poll response landing after the terminal SSE message must not
 * regress the UI back to "running").
 */
function mergeSnapshots(sse: JobSnapshot, polled: JobSnapshot | null): ConsultationJobStatus | null {
  if (!sse.job) return polled?.job ?? null;
  if (!polled?.job) return sse.job;
  const sseTerminal = isTerminalConsultationJob(sse.job.status);
  const pollTerminal = isTerminalConsultationJob(polled.job.status);
  if (sseTerminal !== pollTerminal) return sseTerminal ? sse.job : polled.job;
  return polled.at > sse.at ? polled.job : sse.job;
}

export interface UseSummaryJobProgressOptions {
  /** Fired exactly once per job when it reaches COMPLETED/FAILED/CANCELLED. */
  onTerminal?: (job: ConsultationJobStatus) => void;
}

export interface UseSummaryJobProgressResult {
  /** Best-known job status (SSE primary, fallback poll merged in on stream error). */
  job: ConsultationJobStatus | null;
  isTerminal: boolean;
  /** SSE transport state — drives the Connecting/Live/Polling badge. */
  streamStatus: StreamStatus;
}

/**
 * Progress tracker for an async summary job. The ticket-authenticated SSE
 * stream (`@StreamScope consultation_job` on `GET /consultations/jobs/:jobId/
 * stream`) is the PRIMARY transport — unlike the DNA stream it publishes
 * DEFAULT (unnamed) `message` events whose data is a JobStatusResponse JSON
 * with UPPERCASE states. A 2s status poll is the documented error fallback,
 * spun up only after the stream exhausts its retry budget.
 */
export function useSummaryJobProgress(jobId: string | null, { onTerminal }: UseSummaryJobProgressOptions = {}): UseSummaryJobProgressResult {
  const queryClient = useQueryClient();

  const [sse, setSse] = useState<JobSnapshot>(EMPTY_SNAPSHOT);
  // Render-time derived-state reset: a new job must not inherit the
  // previous job's folded events.
  const [trackedJobId, setTrackedJobId] = useState(jobId);
  if (jobId !== trackedJobId) {
    setTrackedJobId(jobId);
    setSse(EMPTY_SNAPSHOT);
  }

  const onTerminalRef = useRef(onTerminal);
  useEffect(() => {
    onTerminalRef.current = onTerminal;
  }, [onTerminal]);

  const closeRef = useRef<(() => void) | null>(null);

  const handleEvent = useCallback((_type: string, data: string) => {
    const status = parseJson<ConsultationJobStatus>(data);
    if (!status?.jobId || !status.status) return;
    setSse({ job: status, at: Date.now() });
    // Terminal messages stop the stream eagerly (single-use tickets, no zombies).
    if (isTerminalConsultationJob(status.status)) closeRef.current?.();
  }, []);

  const stream = useEventStream({
    path: jobId ? consultationJobStreamPath(jobId) : null,
    scope: jobId ? `consultation_job:${jobId}` : null,
    onEvent: handleEvent,
    enabled: !!jobId,
  });
  const { close: closeStream, status: streamStatus } = stream;
  useEffect(() => {
    closeRef.current = closeStream;
  }, [closeStream]);

  const sseTerminal = isTerminalConsultationJob(sse.job?.status);
  const poll = useQuery({
    queryKey: playgroundConsultationKeys.job(jobId ?? 'idle'),
    queryFn: () => getConsultationJob(jobId as string),
    // Error fallback only: the SSE stream is the primary transport.
    enabled: !!jobId && !sseTerminal && streamStatus === 'error',
    // Stop once EITHER transport reported a terminal state.
    refetchInterval: (query) => (sseTerminal || isTerminalConsultationJob(query.state.data?.status) ? false : JOB_POLL_MS),
  });

  const polled: JobSnapshot | null = poll.data ? { job: poll.data, at: poll.dataUpdatedAt } : null;
  const job = jobId ? mergeSnapshots(sse, polled) : null;
  const isTerminal = isTerminalConsultationJob(job?.status);

  // Once-per-job terminal side effects: stop the stream (safety net for the
  // poll-detected end), refresh the latest-summary/NER reads, then hand off
  // to the caller for user feedback.
  const notifiedJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jobId || !job || !isTerminalConsultationJob(job.status)) return;
    if (notifiedJobRef.current === jobId) return;
    notifiedJobRef.current = jobId;
    closeStream();
    if (job.status.toUpperCase() === 'COMPLETED') {
      void queryClient.invalidateQueries({ queryKey: playgroundConsultationKeys.root });
    }
    onTerminalRef.current?.(job);
  }, [jobId, job, closeStream, queryClient]);

  return { job, isTerminal, streamStatus: jobId ? streamStatus : 'idle' };
}
