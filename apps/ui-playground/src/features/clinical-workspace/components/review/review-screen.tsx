import { cn } from '@/lib/utils';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent } from '@arcaai/ui/card';
import {
  buildTranscriptHighlights,
  confidencePercent,
  groupClaimsBySection,
  selectClaimsNeedingAttention,
  type ClinicalReviewData,
  type SensorScores,
  type SummaryApprovalResponse,
} from '@arcaai/vox';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { NeedsAttentionList } from './needs-attention-list';
import { SoapNotePanel } from './soap-note-panel';
import { TranscriptPane, type TranscriptHighlightPane } from './transcript-pane';

/**
 * TASK-355 Phase D Slice 6c — optimistic-delivery assurance state surfaced into
 * the review screen. Derived from the live per-claim assurance SSE feed; absent
 * (undefined) on the legacy synchronous path, so all branches stay dormant.
 */
export interface ReviewAssuranceState {
  /** Assurance pass still running — show the live counter + early-sign hint (Q5/Q2a). */
  pending: boolean;
  /** Claims resolved so far (N). */
  resolved: number;
  /** Total verifiable claims (M), when the harness reported it. */
  total?: number;
  /** Terminal safety FLAG landed — signing requires a one-click override (Q4). */
  safetyFlag: boolean;
}

interface ReviewScreenProps {
  data: ClinicalReviewData;
  /**
   * Approve + sign the draft note. Production wiring hits
   * `POST /consultations/:id/summary/:contextItemId/approve` (the SDK's
   * `useArca().summary.approveSummary`); the page injects it so the screen
   * stays presentational and testable. `options.overrideSafetyFlag` one-click
   * acknowledges + signs past a terminal safety FLAG (TASK-355 Q4).
   */
  onApprove: (noteContextItemId: string, options?: { overrideSafetyFlag?: boolean }) => Promise<SummaryApprovalResponse>;
  /** Live assurance state (TASK-355 Phase D); undefined on the legacy path. */
  assurance?: ReviewAssuranceState;
}

const SENSOR_LABELS: Record<keyof SensorScores, string> = {
  entityFaithfulness: 'Faithfulness',
  coverage: 'Coverage',
  schemaValid: 'Schema',
  citationPresence: 'Citations',
  numericDose: 'Dose',
};

function sensorTone(percent: number): string {
  if (percent >= 80) return 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400';
  if (percent >= 50) return 'border-amber-500/40 text-amber-700 dark:text-amber-400';
  return 'border-red-500/40 text-red-700 dark:text-red-400';
}

const SIGNED_STATUSES = new Set(['APPROVED', 'LOCKED', 'SIGNED']);

export function ReviewScreen({ data, onApprove, assurance }: ReviewScreenProps) {
  const claims = data.citationsMap.claims;
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);
  const [approval, setApproval] = useState<SummaryApprovalResponse | null>(null);

  const isSigned = approval !== null || (data.status ? SIGNED_STATUSES.has(data.status.toUpperCase()) : false);

  const needsAttention = useMemo(() => selectClaimsNeedingAttention(claims), [claims]);
  const sections = useMemo(() => groupClaimsBySection(claims), [claims]);
  const selectedClaim = useMemo(() => claims.find((claim) => claim.id === selectedClaimId) ?? null, [claims, selectedClaimId]);

  const panes = useMemo<TranscriptHighlightPane[]>(
    () =>
      data.transcripts.map((transcript) => {
        const spans = selectedClaim ? selectedClaim.evidence.filter((evidence) => evidence.transcriptContextItemId === transcript.contextItemId) : [];
        return {
          contextItemId: transcript.contextItemId,
          label: transcript.label,
          text: transcript.text,
          segments: buildTranscriptHighlights(transcript.text, spans),
          hasHighlight: spans.length > 0,
        };
      }),
    [data.transcripts, selectedClaim],
  );

  const sensorChips = useMemo(() => {
    if (!data.sensorScores) return [];
    return (Object.keys(SENSOR_LABELS) as Array<keyof SensorScores>).map((key) => ({
      key,
      label: SENSOR_LABELS[key],
      percent: confidencePercent(data.sensorScores![key]),
    }));
  }, [data.sensorScores]);

  // Q4 — a terminal safety FLAG makes signing a deliberate one-click override.
  const requiresOverride = assurance?.safetyFlag === true;

  const handleApprove = async () => {
    if (isApproving || isSigned) return;
    setIsApproving(true);
    try {
      const result = requiresOverride
        ? await onApprove(data.noteContextItemId, { overrideSafetyFlag: true })
        : await onApprove(data.noteContextItemId);
      setApproval(result);
      toast.success('Note approved and signed');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to approve the note';
      toast.error(message);
    } finally {
      setIsApproving(false);
    }
  };

  return (
    <div data-testid="clinical-review-screen" className="flex flex-col gap-4">
      {/* TASK-355 Phase D Slice 6c (Q5/Q2a) — assurance runs concurrently with
          review; show the live per-claim counter. Sign stays ENABLED below; this
          banner is the informational "you're signing early" hint. */}
      {assurance?.pending && (
        <div
          data-testid="assurance-pending-banner"
          role="status"
          aria-live="polite"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
        >
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          <span className="font-medium">
            Safety checks running — {assurance.resolved}
            {assurance.total != null ? ` of ${assurance.total}` : ''} claims verified
          </span>
          <span data-testid="assurance-early-sign-hint" className="text-amber-700/80 dark:text-amber-400/80">
            You can sign now, but you’re signing before the safety checks finish.
          </span>
        </div>
      )}
      {/* Q4 — a terminal safety FLAG: destructive alert; signing becomes a
          deliberate one-click acknowledge-and-override (recorded in audit). */}
      {requiresOverride && !isSigned && (
        <div
          data-testid="assurance-safety-flag"
          role="alert"
          className="flex items-center gap-2 rounded-md border border-red-500/50 bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-300"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <span>The safety screen flagged this note. Review carefully — signing records a one-click safety override.</span>
        </div>
      )}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="flex flex-col">
            <span className="text-muted-foreground text-xs">Draft note</span>
            <span className="font-mono text-xs">{data.noteContextItemId}</span>
          </div>
          {data.modelName && (
            <Badge variant="outline" className="text-[10px]">
              {data.modelName}
            </Badge>
          )}
          {sensorChips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {sensorChips.map((chip) => (
                <Badge key={chip.key} variant="outline" className={cn('tabular-nums text-[10px]', sensorTone(chip.percent))}>
                  {chip.label} {chip.percent}%
                </Badge>
              ))}
            </div>
          )}

          <div className="ml-auto flex items-center gap-3">
            {needsAttention.length > 0 && !isSigned && (
              <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-3.5" />
                {needsAttention.length} need{needsAttention.length === 1 ? 's' : ''} attention
              </span>
            )}
            {isSigned ? (
              <Badge data-testid="note-signed-badge" variant="outline" className="gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-400">
                <ShieldCheck className="size-3.5" />
                Signed
              </Badge>
            ) : (
              <Button
                data-testid="approve-note-button"
                onClick={handleApprove}
                disabled={isApproving}
                variant={requiresOverride ? 'destructive' : 'default'}
              >
                {isApproving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <ShieldCheck className="mr-1.5 size-4" />}
                {requiresOverride ? 'Acknowledge risk & sign' : 'Approve & sign note'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <NeedsAttentionList claims={needsAttention} selectedClaimId={selectedClaimId} onSelect={setSelectedClaimId} />
          <SoapNotePanel sections={sections} selectedClaimId={selectedClaimId} onSelect={setSelectedClaimId} />
        </div>
        <div className="lg:sticky lg:top-4 lg:self-start">
          <TranscriptPane panes={panes} selectedClaim={selectedClaim} consultationId={data.consultationId} />
        </div>
      </div>
    </div>
  );
}
