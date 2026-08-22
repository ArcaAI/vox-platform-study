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
import type { UseNoteEditorResult } from '../../hooks/use-note-editor';
import {
  claimVerdictBucket,
  type CitedSegment,
  type HarnessAssuranceSnapshot,
  type HarnessProgressSnapshot,
  type LiveSummaryEntity,
  type LiveSummarySnapshot,
  type LiveSummaryVitals,
  type SummaryResult,
} from '../../api';
import { CitationEvidencePanel } from './citation-evidence-panel';

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

export interface CaseNoteColumnProps {
  hasConsultation: boolean;
  isRecording: boolean;
  live: LiveSummarySnapshot | null;
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
}

export function CaseNoteColumn(props: CaseNoteColumnProps) {
  const {
    hasConsultation,
    isRecording,
    live,
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
                ? 'Running SOAP · auto-drafted live'
                : 'Drafts appear here after a session'}
          </p>
        </div>
        {showLive && live?.textFailed ? (
          <Badge variant="destructive" className="shrink-0 gap-1.5" aria-live="polite">
            <IconShieldExclamation aria-hidden className="size-3.5" />
            Note assistant unavailable — showing last update
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
                <p id={`${noteFieldId}-hint`} className="text-muted-foreground text-xs">
                  Transcription and drafting continue while you edit. A newer machine draft is offered, never applied on its own.
                </p>
              </div>
            ) : (
              <article aria-label="Personalized draft note" className="text-sm leading-relaxed whitespace-pre-wrap">
                {editor ? editor.value : draft.content}
              </article>
            )}
          </div>
        ) : showLive && liveSections.length > 0 ? (
          <div className="flex flex-col gap-4" aria-label="Live running summary">
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
          <p className="text-sm leading-relaxed whitespace-pre-wrap" aria-label="Live running summary">
            {live.runningSummary}
          </p>
        ) : isRecording ? (
          <div className="flex flex-col gap-3" aria-label="Waiting for the first live summary">
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

        {vitals.length > 0 ? (
          <div className="border-t pt-3" aria-label="Extracted vitals">
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
          <div className="flex flex-wrap items-center gap-1.5 border-t pt-3" aria-label="Detected entities">
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
