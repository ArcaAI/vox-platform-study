'use client';

/**
 * Column 3 of the Consultation Scribe workspace: the case
 * note. Shows the LIVE running SOAP (SSE snapshot) while recording, then the
 * PERSISTED personalized draft (`SummaryResult` — same artifact on both the
 * plain and harness paths) once one exists. The harness assurance envelope is
 * folded in as a compact status strip (stage progress → gate/safety outcome,
 * expandable to per-claim verdicts) so the Documentation-review tab's
 * safety-relevant signals survive the single-view redesign. Sign & save runs
 * the existing approve mutation; the server-enforced safety gate surfaces here
 * as the pre-emptive override affordance rather than a surprising 409.
 */

import { useId, useMemo, useState } from 'react';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconClipboardCheck,
  IconCopy,
  IconDeviceFloppy,
  IconLayoutList,
  IconFileText,
  IconPencil,
  IconShieldCheck,
  IconShieldExclamation,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Collapsible, CollapsibleTrigger } from '@arcaai/ui/components/shadcn/collapsible';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { cn } from '@arcaai/ui';
import { EmptyState } from '@/shared/state/empty-state';
import type { LoopActivityEntry } from '../../hooks/use-loop-activity';
import type { UseNoteEditorResult } from '../../hooks/use-note-editor';
import {
  claimVerdictBucket,
  type CitedSegment,
  type HarnessAssuranceSnapshot,
  type HarnessProgressSnapshot,
  type LiveSummaryEntity,
  type LiveSummarySnapshot,
  type LiveSummaryVitals,
  type NamedEntitiesAggregate,
  type SummaryResult,
} from '../../api';
import { CitationEvidencePanel } from './citation-evidence-panel';
import { HighlightedNoteText } from './highlighted-note-text';
import { ClinicalSuggestionsPanel } from './clinical-suggestions-panel';
import { CorrectionProposalsPanel } from './correction-proposals-panel';
import { composeAutofill, formatSoapSections } from '../../lib/soap-autofill';
import type { DocumentView, SectionState } from '../../api/document-sections';
import type { PreSummaryView } from '../../api/hooks';
import type { ClinicalSuggestion, CorrectionProposal, CorrectionsEnvelope } from '../../api/live-assist';

/** Humanizes a `DocumentTemplate.slug` (`soap_note` → "Soap Note") — no join to the template needed. */
function humanizeDocumentKey(documentKey: string): string {
  return documentKey
    .split(/[_-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const SECTION_STATE_META: Record<SectionState, { label: string; icon: typeof IconCheck; className: string }> = {
  empty: { label: 'Empty', icon: IconSparkles, className: 'text-muted-foreground' },
  provisional: { label: 'Provisional', icon: IconSparkles, className: 'bg-ai/10 text-ai border-ai/40' },
  confirmed: { label: 'Confirmed', icon: IconCheck, className: 'bg-success/10 text-success border-success/40' },
  locked: { label: 'Locked', icon: IconShieldCheck, className: 'bg-muted text-muted-foreground' },
};

/** state badge — never conveys the state by color alone (rule 11 §10: icon + text). */
function SectionStateBadge({ state }: { state: SectionState }) {
  const meta = SECTION_STATE_META[state];
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={cn('shrink-0 gap-1', meta.className)}>
      <Icon aria-hidden className="size-3" />
      {meta.label}
    </Badge>
  );
}

/**
 * / — N documents, each rendering its OWN sections in `idx` order
 * with a live per-section state (`empty` renders as a skeleton, never an error
 * Per-section CLINICIAN EDITING is not wired here: no console-facing mutation endpoint exists
 * yet for a single section (only the whole persisted draft is editable, via `editor` below), so
 * this view is read-only live state, not a second writer.
 */
function DocumentSectionsView({ documents }: { documents: DocumentView[] }) {
  return (
    <div className="flex flex-col gap-5" aria-label="Live documents">
      {documents.map((document) => (
        <div key={document.documentKey} className="flex flex-col gap-3">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">{humanizeDocumentKey(document.documentKey)}</h3>
          <div className="flex flex-col gap-4">
            {document.sections.map((section) => (
              <div key={section.sectionKey} className="flex gap-2.5">
                <span
                  aria-hidden
                  className={cn('flex size-5.5 shrink-0 items-center justify-center rounded-md text-xs font-medium', sectionAccent(section.title))}
                >
                  {section.title.trim().charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <h4 className="text-xs font-medium tracking-wide uppercase">{section.title}</h4>
                    <SectionStateBadge state={section.state} />
                  </div>
                  {section.state === 'empty' ? (
                    <div className="flex flex-col gap-1.5" role="status" aria-label={`Waiting for ${section.title}`}>
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-2/3" />
                    </div>
                  ) : (
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{section.content}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Ordered vitals for the Objective grid — only present values render. */
function vitalCells(vitals: LiveSummaryVitals): Array<{ label: string; value: string }> {
  const cells: Array<{ label: string; value: string }> = [];
  if (vitals.systolic != null && vitals.diastolic != null) cells.push({ label: 'BP', value: `${vitals.systolic}/${vitals.diastolic}` });
  if (vitals.heartRate != null) cells.push({ label: 'HR', value: String(vitals.heartRate) });
  if (vitals.spo2 != null) cells.push({ label: 'SpO₂', value: `${vitals.spo2}%` });
  if (vitals.temperatureC != null) cells.push({ label: 'Temp', value: `${vitals.temperatureC}°` });
  if (vitals.weightKg != null) cells.push({ label: 'Weight', value: `${vitals.weightKg} kg` });
  return cells;
}

/** SOAP-ish accent for a live section, keyed by title (design frame styling). */
function sectionAccent(title: string): string {
  switch (title.trim().toUpperCase().charAt(0)) {
    case 'S':
      return 'bg-primary text-primary-foreground';
    case 'O':
      return 'bg-ai text-ai-foreground';
    case 'A':
      return 'bg-warning text-warning-foreground';
    case 'P':
      return 'bg-success text-success-foreground';
    default:
      return 'bg-secondary text-secondary-foreground';
  }
}

// ─── assurance strip ───

export interface AssuranceStripProps {
  progress: HarnessProgressSnapshot | null;
  assurance: HarnessAssuranceSnapshot | null;
}

/**
 * Harness status fold: drafting stages while in flight; gate/safety outcome
 * once assurance lands. Renders nothing when the harness never ran (plain
 * path) — absence of the envelope is itself truthful.
 */
export function AssuranceStrip({ progress, assurance }: AssuranceStripProps) {
  const [open, setOpen] = useState(false);

  const stages = progress?.stages ?? [];
  const done = stages.filter((stage) => stage.status === 'completed').length;
  const activeStage = stages.find((stage) => stage.status === 'active');
  const failedStage = stages.find((stage) => stage.status === 'failed');
  const drafting = stages.length > 0 && !progress?.closed && !failedStage;

  const claims = assurance?.claims ?? [];
  const reviewCount = claims.filter((claim) => claimVerdictBucket(claim.verdict) === 'review').length;
  const hasAssurance = !!assurance && (claims.length > 0 || assurance.gateDecision !== undefined || assurance.safetyFlag !== undefined);

  if (stages.length === 0 && !hasAssurance) return null;

  return (
    <div className="bg-muted/40 shrink-0 rounded-lg border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {drafting ? (
          <span className="flex items-center gap-2">
            <Spinner aria-hidden className="size-3.5" />
            <span className="font-medium">{activeStage?.label ?? 'Drafting note'}…</span>
            <span className="text-muted-foreground text-xs">
              {done}/{stages.length} stages
            </span>
          </span>
        ) : failedStage ? (
          <span className="text-destructive flex items-center gap-1.5 font-medium">
            <IconShieldExclamation aria-hidden className="size-4" />
            {failedStage.label} failed
          </span>
        ) : null}
        {hasAssurance ? (
          <>
            {assurance?.safetyFlag ? (
              <Badge variant="destructive" className="gap-1">
                <IconShieldExclamation aria-hidden className="size-3" />
                Safety flag
              </Badge>
            ) : assurance?.gateDecision ? (
              <Badge variant={assurance.gateDecision.toLowerCase() === 'pass' ? 'default' : 'secondary'} className="gap-1">
                <IconShieldCheck aria-hidden className="size-3" />
                Gate: {assurance.gateDecision}
              </Badge>
            ) : null}
            {assurance?.reducedAssurance ? <Badge variant="outline">Reduced assurance</Badge> : null}
            {claims.length > 0 ? (
              <span className="text-muted-foreground text-xs">
                {claims.length - reviewCount}/{claims.length} claims pass
              </span>
            ) : null}
          </>
        ) : null}
        {drafting && stages.length > 0 ? (
          <Progress value={(done / stages.length) * 100} className="h-1.5 w-24" aria-label="Drafting progress" />
        ) : null}
        {claims.length > 0 ? (
          <Collapsible open={open} onOpenChange={setOpen} className="ms-auto">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                Claims
                <IconChevronDown aria-hidden className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
              </Button>
            </CollapsibleTrigger>
          </Collapsible>
        ) : null}
      </div>
      {open && claims.length > 0 ? (
        <ul className="mt-2 flex list-none flex-col gap-1 border-t pt-2">
          {claims.map((claim) => {
            const bucket = claimVerdictBucket(claim.verdict);
            return (
              <li key={`${claim.claimId}-${claim.sensor}`} className="flex items-center gap-2 text-xs">
                <Badge variant={bucket === 'pass' ? 'outline' : 'secondary'} className="w-16 justify-center">
                  {bucket === 'pass' ? 'PASS' : 'REVIEW'}
                </Badge>
                <span className="text-muted-foreground font-mono">{claim.sensor}</span>
                <span className="truncate">{claim.label ?? claim.claimId}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ─── the column ───

/**
 * D-18 — mirrors the SDK's `LiveSummaryStreamStatus` (`useArcaLiveSummary`), which is not
 * itself re-exported from `@arcaai/vox/core` (only the hook is). A narrow local copy of the
 * runtime values is simpler than widening the SDK's public surface for one prop type.
 */
export type LiveStreamStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

/**
 * TASK-932 D-9 — the WARM-START panel.
 *
 * The first thing the clinician sees, and the first thing that has to be honest. The pre-summary
 * is generated in parallel with the microphone opening, so the panel is on screen before it has
 * content — which is exactly the situation TASK-891 B5 fixed for the case note ("`state ===
 * 'empty'` renders a `<Skeleton />` … so 'still generating' and 'generation failed' were the same
 * pixels forever. The owner watched that skeleton for ten minutes"). So all three states are
 * DRAWN differently: a skeleton while running, the text when ready, and a plain sentence when
 * there is nothing to summarise.
 *
 * `no_case_notes` is not an error and is not styled as one: a first-ever visit has no prior
 * record, which is a fact about the patient. Every other reason IS a failure and says so, with
 * the PHI-safe code the lane published — never clinical text, because the code is what the
 * channel carries.
 *
 * Nothing renders until an event arrives: a lane that authors no warm start must not leave an
 * empty labelled box on the screen (rule 11 §4).
 */
const PRE_SUMMARY_REASONS: Record<string, string> = {
  no_case_notes: 'No previous case notes were available for this patient, so there is nothing to summarise.',
  warm_start_unwired: 'The pre-summary service is not available in this environment.',
  empty_pre_summary: 'The assistant returned an empty pre-summary.',
};

function PreSummaryPanel({ preSummary }: { preSummary: PreSummaryView | null }) {
  if (!preSummary) return null;

  const isBenign = preSummary.status === 'degraded' && preSummary.error === 'no_case_notes';

  return (
    <section aria-label="Pre-summary" data-testid="pre-summary-panel" data-status={preSummary.status} className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <IconClipboardCheck aria-hidden className="size-4" />
          Pre-summary
        </h3>
        {preSummary.status === 'running' ? (
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs" aria-live="polite">
            <Spinner aria-hidden className="size-3.5" />
            Reading the previous case notes
          </span>
        ) : preSummary.status === 'ready' ? (
          <Badge variant="secondary" className="gap-1.5">
            <IconSparkles aria-hidden className="size-3.5" />
            AI
          </Badge>
        ) : (
          <Badge variant={isBenign ? 'outline' : 'destructive'} className="gap-1.5" aria-live="polite">
            {isBenign ? null : <IconAlertTriangle aria-hidden className="size-3.5" />}
            {isBenign ? 'Nothing to summarise' : 'Unavailable'}
          </Badge>
        )}
      </div>

      {preSummary.status === 'running' ? (
        // A skeleton is correct HERE and only here: this is the one state where content is
        // genuinely on its way.
        <div className="flex flex-col gap-2" aria-hidden>
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      ) : preSummary.status === 'ready' && preSummary.content ? (
        <p className="text-muted-foreground text-sm whitespace-pre-wrap">{preSummary.content}</p>
      ) : (
        <p className="text-muted-foreground text-sm">
          {PRE_SUMMARY_REASONS[preSummary.error ?? ''] ?? 'The pre-summary could not be produced for this consultation.'}
        </p>
      )}
    </section>
  );
}

export interface CaseNoteColumnProps {
  hasConsultation: boolean;
  isRecording: boolean;
  live: LiveSummarySnapshot | null;
  /** D-18 — the live-summary SSE connection's own status (distinct from `live.textFailed`,
   *  which is a GENERATION failure over an otherwise-healthy connection). */
  liveStatus?: LiveStreamStatus;
  /** D-18 — the live-summary SSE connection's last error, when `liveStatus === 'error'`. */
  liveError?: string | null;
  /**
   * / — N documents from the `section.patch` plane
   * (`useDocumentSectionsStream`). Non-empty ⇒ takes priority over the legacy single-section
   * `live.sections` view below (richer: per-section state, multiple documents). Empty ⇒
   * nothing has arrived on that plane yet and the legacy view renders unchanged.
 */
  documentSections?: DocumentView[];
  /**
   * TASK-932 D-9 — the WARM START, from the `presummary` plane on the same live-summary stream.
   *
   * `null` = no event has arrived, which is NOT "there is no warm start": a graph that authors
   * one publishes `running` within a moment of the session opening, and a graph that authors none
   * publishes nothing ever. The panel renders only once something arrives, so a lane without a
   * warm start shows no empty box.
 */
  preSummary?: PreSummaryView | null;
  draft: SummaryResult | null;
  draftLoading: boolean;
  progress: HarnessProgressSnapshot | null;
  assurance: HarnessAssuranceSnapshot | null;
  /** Manual generate — hidden entirely when the harness owns drafting. */
  onGenerate: (() => void) | null;
  generatePending: boolean;
  /**
   * W5/M-7 — current step of the async generation job, when one is running.
   * The manual Generate path is now the queued job + its SSE progress stream
   * (previously dead code); this is that stream's `currentStep`.
   */
  generateStatus?: string | null;
  /** Cancels the running generation job. Rendered only while one is running. */
  onCancelGenerate?: (() => void) | null;
  onApprove: (options: { overrideSafetyFlag: boolean }) => void;
  approvePending: boolean;
  approved: boolean;
  /** Cited transcript segments for the delivered draft (evidence panel). Absent/empty renders no panel. */
  citedSegments?: CitedSegment[];
  /** Persisted transcript text — the evidence panel slices it locally for the snippet. */
  transcriptText?: string | null;
  /** The citation currently highlighted in the live-session column. */
  selectedCitationId?: string | null;
  onSelectCitation?: (segment: CitedSegment) => void;
  /**
   * W1/R5 — the clinician's editing buffer and its two-writer conflict state
   * ({@link useNoteEditor}). Absent ⇒ the note renders read-only, exactly as
   * before, so every other caller of this column is unaffected.
   */
  editor?: UseNoteEditorResult;
  /**
   * W4/R3 — the agentic loop's live activity (`consultation.realtimeSummary`
   * and friends). PROGRESS ONLY: `summary.interim` event carries
   * `{ kindKey, ordinal, total, chars }` and deliberately no text, so this
   * renders what the assistant is working on, never a synthesised body.
 */
  loopActivity?: readonly LoopActivityEntry[];
  /**
   * W3 — the PERSISTED NER aggregate (`GET :id/named-entities`). Live entities ride the
   * live-summary snapshot and vanish with it when recording stops, so without this a
   * reviewed draft showed no entities at all. `AggregateNerResponse` carries no offsets
   * into the draft content, so these are a grouped chip list and NOT inline marks —
   * anchoring them by searching the text is exactly what `lib/entity-highlights.ts` refuses
   * to do, and it would be worse here because the draft is a rewrite of the transcript.
   */
  namedEntities?: NamedEntitiesAggregate | null;
  /**
   * W2/R3 — spelling / medical-term / drug-name correction PROPOSALS, off the `live-assist`
   * stream ( brokered contract; shapes in `api/live-assist.ts`). Fed live by
   * `useLiveAssistStream` — the gateway route is up.
   *
   * An accepted proposal is written through `editor.change` — the clinician's OWN buffer — so
   * it is a clinician edit, never a machine write, and the R5 two-writer contract in
   * `use-note-editor.ts` is untouched. That edit corrects the NOTE; promoting the SAME
   * correction over the raw TRANSCRIPT (`feedback.capture`) is a separate,
   * explicit step — see `onAcceptCorrectionForPromotion`.
 */
  correctionProposals?: CorrectionsEnvelope | null;
  /**
   * fires alongside `onAccept` the moment the clinician accepts a proposal
   * (the SAME click — there is deliberately no second "promote" control; accepting a
   * correction already IS the clinician's judgement that it is right). The parent accumulates
   * these and threads them into `stopRecording` so `feedback.capture` has
   * something to promote over the raw transcript when the endpoint sequence runs.
 */
  onProposalAccepted?: (proposal: CorrectionProposal) => void;
  /** W2/R3 — intelligent suggestions, same stream. */
  suggestions?: readonly ClinicalSuggestion[] | null;
  /** The interpreter node that produced the suggestions, for provenance. */
  suggestionsNodeType?: string;
  /** Re-request corrections after a digest mismatch (796 rule 2). */
  onCorrectionsStale?: () => void;
}

export function CaseNoteColumn(props: CaseNoteColumnProps) {
  const {
    hasConsultation,
    isRecording,
    live,
    liveStatus = 'idle',
    liveError = null,
    documentSections = [],
    preSummary = null,
    draft,
    draftLoading,
    progress,
    assurance,
    onGenerate,
    generatePending,
    generateStatus = null,
    onCancelGenerate = null,
    onApprove,
    approvePending,
    approved,
    citedSegments = [],
    transcriptText = null,
    selectedCitationId = null,
    onSelectCitation,
    editor,
    loopActivity = [],
    namedEntities = null,
    correctionProposals = null,
    onProposalAccepted,
    suggestions = null,
    suggestionsNodeType,
    onCorrectionsStale,
  } = props;
  const [overrideSafety, setOverrideSafety] = useState(false);
  const noteFieldId = useId();
  // Editing is only offered on a persisted, unsigned draft: the server locks an
  // approved summary ("Summary is approved and locked", 400), so offering the
  // control after sign-off would promise a write that cannot succeed.
  const canEdit = !!editor && !!draft && !approved;
  const isEditing = !!editor?.isEditing;

  // The live snapshot is the mid-recording scratch preview; the persisted
  // draft takes over as soon as it exists (it is the reviewable artifact).
  const showLive = !draft && (isRecording || !!live);
  const liveSections = live?.sections ?? [];
  const liveEntities: LiveSummaryEntity[] = live?.entities ?? [];
  const vitals = live?.vitals ? vitalCells(live.vitals) : [];
  // D-18 — whether a live snapshot has ANY renderable content, so the failure copy never
  // claims a "last update" exists when the very first flush is what failed.
  const liveHasContent = !!live?.runningSummary || liveSections.length > 0;

  // Stable, non-empty groups only — an empty aggregate renders nothing rather than a
  // labelled empty box (rule 11 §4: never a blank area presented as content).
  const persistedEntityGroups = useMemo(
    () => Object.entries(namedEntities?.entities ?? {}).filter(([, items]) => Array.isArray(items) && items.length > 0),
    [namedEntities],
  );

  /**
   * an interpreter-produced INTERIM summary arrives on this same plane, marked
   * `source: 'interpreter'`. Say so, and say where it sits in its sequence: an interim summary
   * is a snapshot of work in progress, and a clinician reading it should know that.
 */
  const interimLabel = useMemo(() => {
    if (live?.source !== 'interpreter') return null;
    const position = typeof live.ordinal === 'number' && typeof live.total === 'number' ? ` · ${live.ordinal} of ${live.total}` : '';
    return `Interim summary${position}`;
  }, [live]);

  // W2 — the SOAP block an autofill would insert. Empty when the live stream has no
  // sections, which is what hides the affordance entirely rather than offering a no-op.
  const autofillBlock = useMemo(() => formatSoapSections(live?.sections ?? []), [live]);

  /**
   * Corrections rewrite text, so they are offered live ONLY while the clinician is editing —
   * that is the only moment a buffer exists to write into. Outside it they stay visible but
   * inert, with the reason stated (rule 11 §5: a disabled control needs a visible reason).
 */
  const correctionsDisabledReason = approved
    ? 'This note is signed — corrections can no longer be applied.'
    : isEditing
      ? null
      : 'Choose "Edit note" to accept or reject a correction.';

  const provenance = useMemo(() => {
    const meta = draft?.structuredData;
    if (!meta) return null;
    const bits = [meta.llmProvider, meta.modelName, typeof meta.processingTimeMs === 'number' ? `${meta.processingTimeMs} ms` : null].filter(Boolean);
    return bits.length > 0 ? bits.join(' · ') : null;
  }, [draft]);

  async function handleCopy() {
    const text = draft?.content ?? live?.runningSummary ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Note copied to clipboard');
    } catch {
      toast.error('Could not copy the note');
    }
  }

  return (
    <section aria-label="Case note" className="bg-card flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2.5 border-b p-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">Case note</h2>
          <p className="text-muted-foreground truncate text-xs">
            {draft
              ? provenance
                ? `Personalized draft · ${provenance}`
                : 'Personalized draft'
              : showLive
                ? interimLabel ?? 'Running SOAP · auto-drafted live'
                : 'Drafts appear here after a session'}
          </p>
        </div>
        {showLive && liveStatus === 'error' ? (
          // D-18 — a CONNECTION failure (the SSE stream itself dropped), distinct from a
          // generation failure below: the note assistant may be healthy, the transport is not.
          <Badge variant="destructive" className="shrink-0 gap-1.5" aria-live="polite">
            <IconAlertTriangle aria-hidden className="size-3.5" />
            Live update connection lost{liveError ? ` — ${liveError}` : ''}
          </Badge>
        ) : showLive && live?.textFailed ? (
          <Badge variant="destructive" className="shrink-0 gap-1.5" aria-live="polite">
            <IconShieldExclamation aria-hidden className="size-3.5" />
            {liveHasContent ? 'Note assistant unavailable — showing last update' : 'Note assistant unavailable — no update yet'}
          </Badge>
        ) : showLive && isRecording ? (
          <span className="border-ai/40 bg-ai/10 text-ai flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium" aria-live="polite">
            <Spinner aria-hidden className="size-3.5" />
            Note assistant drafting
          </span>
        ) : null}
      </div>

      {/* tabIndex: a scrollable region must be reachable by keyboard (axe scrollable-region-focusable).
          No role/aria-label here — the parent <section aria-label="Case note"> already names this area, and a
          nested region with the same name is screen-reader noise. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" tabIndex={0}>
        <AssuranceStrip progress={progress} assurance={assurance} />
        <PreSummaryPanel preSummary={preSummary} />

        {!hasConsultation ? (
          <EmptyState icon={IconFileText} title="No case note" description="Select a consultation to see its note." />
        ) : draftLoading ? (
          <div className="flex flex-col gap-3" aria-hidden>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : draft ? (
          <div className="flex flex-col gap-3">
            {/* A newer machine draft landed on top of unsaved text. Announced
                politely (role=status) — it is information, not an emergency —
                and NEVER applied without the clinician saying so. */}
            {editor?.supersededBy ? (
              <Alert role="status" className="[&>svg]:text-ai">
                <IconSparkles aria-hidden />
                <AlertTitle>The assistant produced a newer draft</AlertTitle>
                <AlertDescription className="flex flex-col gap-2">
                  <span>Your unsaved edits are untouched. Choose which version to continue from.</span>
                  <span className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={editor.keepMine}>
                      Keep my version
                    </Button>
                    <Button size="sm" variant="ghost" onClick={editor.acceptIncoming}>
                      Discard mine, use the new draft
                    </Button>
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}

            {/* 412 from the If-Match precondition: the row moved under us. The
                buffer below still holds every character the clinician typed. */}
            {editor?.conflict ? (
              <Alert variant="destructive">
                <IconAlertTriangle aria-hidden />
                <AlertTitle>This note changed while you were editing</AlertTitle>
                <AlertDescription className="flex flex-col gap-2">
                  <span>
                    Someone or something saved version {editor.conflict.serverVersion} of this note. Your text is still in the editor below —
                    nothing has been lost.
                  </span>
                  {editor.conflict.serverContent ? (
                    <details className="w-full">
                      <summary className="cursor-pointer text-xs font-medium underline underline-offset-2">Show the saved version</summary>
                      <p className="bg-background/60 mt-1.5 max-h-40 overflow-y-auto rounded-md border p-2 text-xs whitespace-pre-wrap" tabIndex={0}>
                        {editor.conflict.serverContent}
                      </p>
                    </details>
                  ) : null}
                  <span className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => void editor.overwriteConflict()} disabled={editor.saving}>
                      {editor.saving ? <Spinner aria-hidden /> : null}
                      Overwrite with my version
                    </Button>
                    <Button size="sm" variant="ghost" onClick={editor.cancel}>
                      Discard mine, keep the saved version
                    </Button>
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}

            {editor?.error ? (
              <Alert variant="destructive">
                <IconAlertTriangle aria-hidden />
                <AlertTitle>Could not save the note</AlertTitle>
                <AlertDescription>{editor.error}</AlertDescription>
              </Alert>
            ) : null}

            {isEditing && editor ? (
              <div className="flex min-h-0 flex-1 flex-col gap-1.5">
                <Label htmlFor={noteFieldId}>Case note</Label>
                <Textarea
                  id={noteFieldId}
                  value={editor.value}
                  onChange={(event) => editor.change(event.target.value)}
                  // rule 11 §1: the primary input grows with its container
                  // rather than carrying a fixed `rows`.
                  className="min-h-64 flex-1 resize-none text-sm leading-relaxed"
                  aria-describedby={`${noteFieldId}-hint`}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <p id={`${noteFieldId}-hint`} className="text-muted-foreground text-xs">
                    Transcription and drafting continue while you edit. A newer machine draft is offered, never applied on its own.
                  </p>
                  {/* W2/R3 — autofill the SOAP sections the live stream is already producing.
                      Explicitly clinician-initiated, and it APPENDS rather than replaces, so it
                      can never destroy typed text (see `lib/soap-autofill.ts`). */}
                  {autofillBlock ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="ms-auto"
                      onClick={() => editor.change(composeAutofill(editor.value, autofillBlock))}
                    >
                      <IconLayoutList aria-hidden />
                      Fill from live summary
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <article aria-label="Personalized draft note" className="text-sm leading-relaxed whitespace-pre-wrap">
                {editor ? editor.value : draft.content}
              </article>
            )}
          </div>
        ) : showLive && documentSections.length > 0 ? (
          // DD-3 — richer than the legacy single-section view below (per-section state,
          // multiple documents), so it takes priority the moment any section.patch has arrived.
          <DocumentSectionsView documents={documentSections} />
        ) : showLive && liveSections.length > 0 ? (
          <div className="flex flex-col gap-4" role="group" aria-label="Live running summary">
            {liveSections.map((section) => (
              <div key={section.title} className="flex gap-2.5">
                <span
                  aria-hidden
                  className={cn('flex size-5.5 shrink-0 items-center justify-center rounded-md text-xs font-medium', sectionAccent(section.title))}
                >
                  {section.title.trim().charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="mb-1 text-xs font-medium tracking-wide uppercase">{section.title}</h3>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{section.content}</p>
                </div>
              </div>
            ))}
          </div>
        ) : showLive && live?.runningSummary ? (
          // W3: entities are MARKED in the text, not only listed as chips below it. Only the
          // running summary is markable — `LiveSummaryEntityDto`'s offsets index
          // `runningSummary`, so the sections branch above deliberately stays plain rather
          // than splicing marks on offsets that do not belong to it.
          <HighlightedNoteText text={live.runningSummary} entities={liveEntities} label="Live running summary" />
        ) : showLive && live?.textFailed ? (
          // D-18 — the empty-first-flush case: the header ALREADY says the assistant is
          // unavailable, so a loading skeleton here would contradict it (implying "in
          // progress" when generation has failed). An honest empty state instead.
          <EmptyState
            icon={IconShieldExclamation}
            title="No update yet"
            description="The note assistant hasn't produced a running summary for this session yet."
          />
        ) : isRecording ? (
          <div className="flex flex-col gap-3" role="status" aria-label="Waiting for the first live summary">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <EmptyState
            icon={IconFileText}
            title="No draft yet"
            description={
              onGenerate
                ? 'Record a session, or generate a note from the captured transcript.'
                : 'Record a session — the documentation harness drafts the note automatically.'
            }
          />
        )}

        {loopActivity.length > 0 ? (
          <div className="border-t pt-3" role="group" aria-label="Assistant activity">
            <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
              Assistant activity
              <span className="bg-ai/10 text-ai rounded px-1 text-xs font-medium">AI</span>
            </div>
            <ul className="flex list-none flex-col gap-1" aria-live="polite">
              {loopActivity.slice(-5).map((entry, index) => (
                <li key={`${entry.publishedAt}-${index}`} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground font-mono">{entry.kindKey ?? entry.kind}</span>
                  {entry.label ? <span className="truncate">{entry.label}</span> : null}
                  {entry.ordinal != null && entry.total != null ? (
                    <span className="text-muted-foreground tabular-nums">
                      {entry.ordinal} of {entry.total}
                    </span>
                  ) : null}
                  {entry.chars != null ? <span className="text-muted-foreground tabular-nums">{entry.chars} chars</span> : null}
                </li>
              ))}
            </ul>
            {/*
 This FEED is progress-only by design: `EmitLoopEventInput` is `extra="forbid"`
                and carries "ids/keys/labels only, NEVER note or transcript text". Interim
                summary TEXT rides the live-summary plane above instead — say which
                is which rather than implying this list is what the assistant produced. 
*/}
            <p className="text-muted-foreground mt-1.5 text-xs">Progress only — interim summary text appears in the note above.</p>
          </div>
        ) : null}

        {vitals.length > 0 ? (
          <div className="border-t pt-3" role="group" aria-label="Extracted vitals">
            <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
              Vitals
              <span className="bg-ai/10 text-ai rounded px-1 text-xs font-medium">AI</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {vitals.map((cell) => (
                <div key={cell.label} className="bg-background rounded-lg border px-2.5 py-1.5">
                  <div className="text-muted-foreground text-xs font-medium">{cell.label}</div>
                  <div className="font-mono text-sm font-medium tabular-nums">{cell.value}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {showLive && liveEntities.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 border-t pt-3" role="group" aria-label="Detected entities">
            {liveEntities.map((entity, index) => (
              <Badge key={`${entity.text}-${index}`} variant="secondary" className="gap-1">
                {entity.text}
                {entity.icd10 ? (
                  <span className="bg-accent text-accent-foreground rounded px-1 font-mono text-xs font-medium">{entity.icd10}</span>
                ) : (
                  <span className="text-muted-foreground font-mono text-xs">{entity.type}</span>
                )}
              </Badge>
            ))}
          </div>
        ) : null}

        {persistedEntityGroups.length > 0 ? (
          <div className="border-t pt-3" role="group" aria-label="Detected entities in this consultation">
            <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
              Detected entities
              <span className="bg-ai/10 text-ai rounded px-1 text-xs font-medium">AI</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {persistedEntityGroups.map(([className, items]) => (
                <div key={className} className="flex flex-wrap items-center gap-1.5">
                  {/* The class is readable text, never a colour (rule 11 §7). */}
                  <span className="text-muted-foreground w-24 shrink-0 font-mono text-xs">{className}</span>
                  {items.map((item, index) => (
                    <Badge key={`${className}-${index}`} variant="secondary">
                      {item.displayText ?? item.text}
                    </Badge>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <CorrectionProposalsPanel
          corrections={correctionProposals}
          onStale={onCorrectionsStale}
          onProposalAccepted={onProposalAccepted}
          // Checked against what the clinician is actually looking at: the buffer while
          // editing, the persisted draft otherwise. A proposal whose offsets stop matching
          // simply stops being offered.
          text={editor ? editor.value : (draft?.content ?? '')}
          onAccept={(next) => editor?.change(next)}
          disabledReason={correctionsDisabledReason}
        />

        <ClinicalSuggestionsPanel suggestions={suggestions} nodeType={suggestionsNodeType} />

        {draft ? (
          <CitationEvidencePanel
            citedSegments={citedSegments}
            transcriptText={transcriptText}
            selectedSegmentId={selectedCitationId}
            onSelectCitation={onSelectCitation}
          />
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t p-3">
        <Button variant="outline" size="sm" onClick={handleCopy} disabled={!draft && !live?.runningSummary}>
          <IconCopy aria-hidden />
          Copy
        </Button>
        {onGenerate && !isEditing ? (
          <Button variant="outline" size="sm" onClick={onGenerate} disabled={generatePending || isRecording}>
            {generatePending ? <Spinner aria-hidden /> : <IconClipboardCheck aria-hidden />}
            Generate note
          </Button>
        ) : null}
        {/* W1/R5: the write path the backend has always had and the UI never
            called (`PATCH :id/summary/:summaryId`, If-Match enforced). */}
        {generatePending && onCancelGenerate ? (
          <>
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs" aria-live="polite">
              <Spinner aria-hidden className="size-3.5" />
              {generateStatus ?? 'Generating note'}…
            </span>
            <Button variant="ghost" size="sm" onClick={onCancelGenerate}>
              <IconX aria-hidden />
              Cancel generation
            </Button>
          </>
        ) : null}
        {canEdit && editor && !isEditing ? (
          <Button variant="outline" size="sm" onClick={editor.beginEdit}>
            <IconPencil aria-hidden />
            Edit note
          </Button>
        ) : null}
        {isEditing && editor ? (
          <>
            <Button size="sm" variant="outline" onClick={() => void editor.save()} disabled={editor.saving || !!editor.conflict}>
              {editor.saving ? <Spinner aria-hidden /> : <IconDeviceFloppy aria-hidden />}
              Save note
            </Button>
            <Button size="sm" variant="ghost" onClick={editor.cancel} disabled={editor.saving}>
              <IconX aria-hidden />
              Cancel
            </Button>
            {editor.isDirty ? (
              <span className="text-muted-foreground text-xs" aria-live="polite">
                Unsaved changes
              </span>
            ) : null}
          </>
        ) : null}
        <div className="ms-auto flex items-center gap-3">
          {assurance?.safetyFlag && draft && !approved ? (
            <label className="text-destructive flex items-center gap-1.5 text-xs font-medium">
              <Checkbox
                checked={overrideSafety}
                onCheckedChange={(checked) => setOverrideSafety(checked === true)}
                aria-label="Override safety flag"
              />
              Override safety flag
            </label>
          ) : null}
          <Button
            size="sm"
            onClick={() => onApprove({ overrideSafetyFlag: overrideSafety })}
            disabled={!draft || approvePending || approved || isEditing || (assurance?.safetyFlag === true && !overrideSafety)}
          >
            {approvePending ? <Spinner aria-hidden /> : <IconCheck aria-hidden />}
            {approved ? 'Signed' : 'Sign & save'}
          </Button>
        </div>
      </div>
    </section>
  );
}
