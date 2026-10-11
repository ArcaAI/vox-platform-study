'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';

import { CONSULTATION_PROCESSING, NOTE_READY_REASON, type ConsultationProcessing, type ConsultationStatus } from '@arcaai/types';
import { normalizeConsultationStatus, type GoverningRun } from '../api/types';

/**
 * Seven-value lifecycle -> semantic roles (status is never color-only: the label always rides
 * along). Legacy twelve-value rows are normalised first; a non-idle processing marker renders as
 * a second chip beside the status. Values in neither vocabulary fall back to a neutral badge.
 */
export const STATUS_META: Record<ConsultationStatus, { label: string; role: StatusColorRole }> = {
  OPEN: { label: 'Open', role: 'info' },
  RECORDING: { label: 'Recording', role: 'primary' },
  PAUSED: { label: 'Paused', role: 'warning' },
  STOPPED: { label: 'Stopped', role: 'neutral' },
  APPROVED: { label: 'Approved', role: 'success' },
  CLOSED_COMPLETE: { label: 'Closed (approved)', role: 'success' },
  CLOSED_INCOMPLETE: { label: 'Closed (no approval)', role: 'neutral' },
};

export const PROCESSING_META: Record<Exclude<ConsultationProcessing, 'IDLE'>, { label: string; role: StatusColorRole }> = {
  FINALIZING_TRANSCRIPT: { label: 'Finalizing transcript', role: 'primary' },
  SUMMARIZING: { label: 'Summarizing', role: 'ai' },
  PROCESSING_ATTACHMENT: { label: 'Processing attachment', role: 'ai' },
  AWAITING_REVIEW: { label: 'Awaiting review', role: 'warning' },
  FAILED: { label: 'Processing failed', role: 'destructive' },
};

/** STOPPED + IDLE + NOTE_READY: the note is finished and waiting to be read. */
export const NOTE_READY_META: { label: string; role: StatusColorRole } = { label: 'Note ready', role: 'success' };

const REASON_LABEL: Record<string, { label: string; role: StatusColorRole }> = {
  GUARDRAIL_HOLD: { label: 'Guardrail hold', role: 'warning' },
  EGRESS_REDACTION_UNAVAILABLE: { label: 'Patient-detail protection unavailable', role: 'warning' },
  NOTE_GENERATION_FAILED: { label: 'Note generation failed', role: 'destructive' },
  NOTE_COVERAGE_GAPS: { label: 'Note coverage gaps', role: 'warning' },
};

/**
 * The human words for a `processingReason` (an open string column; some carry a `:n` count, e.g.
 * `NOTE_COVERAGE_GAPS:3`). Known reasons get a role; an unknown one is humanised, never hidden.
 * `NOTE_READY` is not a reason chip — it is the "Note ready" status chip.
 */
export function processingReasonMeta(reason: string | null | undefined): { label: string; role: StatusColorRole } | null {
  if (!reason || reason === NOTE_READY_REASON) return null;
  const [code, count] = reason.split(':', 2);
  const known = REASON_LABEL[code ?? ''];
  const words = known?.label ?? (code ?? reason).toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return { label: count ? `${words} (${count})` : words, role: known?.role ?? 'neutral' };
}

export function consultationStatusMeta(status: string | undefined, processing?: string, processingReason?: string | null) {
  const explicit = (CONSULTATION_PROCESSING as readonly string[]).includes(processing ?? '') ? (processing as ConsultationProcessing) : undefined;
  const normalized = normalizeConsultationStatus(status, explicit);
  if (!normalized) return { status: { label: status || 'Unknown', role: 'neutral' as StatusColorRole }, processing: null, reason: processingReasonMeta(processingReason) };
  const reason = processingReason ?? normalized.processingReason;
  const noteReady = normalized.status === 'STOPPED' && normalized.processing === 'IDLE' && reason === NOTE_READY_REASON;
  const chip = noteReady ? NOTE_READY_META : normalized.processing === 'IDLE' ? null : PROCESSING_META[normalized.processing];
  return { status: STATUS_META[normalized.status], processing: chip, reason: processingReasonMeta(reason) };
}

/**
 * BUG-041 — a governing run that failed while the consultation is not STOPPED leaves `processing`
 * untouched (a failed run is not a failed consultation), so without this chip a consultation that
 * keeps recording after its workflow died reads as perfectly healthy.
 */
const GOVERNING_RUN_CHIP: Partial<Record<GoverningRun['status'], { label: string; role: StatusColorRole }>> = {
  FAILED: { label: 'Workflow failed', role: 'destructive' },
  TIMED_OUT: { label: 'Workflow timed out', role: 'warning' },
};

export function ConsultationStatusBadge({
  status,
  processing,
  processingReason,
  governingRun,
}: {
  status: string | undefined;
  processing?: string;
  processingReason?: string | null;
  governingRun?: GoverningRun | null;
}) {
  const meta = consultationStatusMeta(status, processing, processingReason);
  const runChip = processing === 'FAILED' || !governingRun ? undefined : GOVERNING_RUN_CHIP[governingRun.status];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge label={meta.status.label} colorRole={meta.status.role} icon={<StatusDot colorRole={meta.status.role} size="sm" />} />
      {meta.processing ? <StatusBadge label={meta.processing.label} colorRole={meta.processing.role} /> : null}
      {meta.reason ? <StatusBadge label={meta.reason.label} colorRole={meta.reason.role} /> : null}
      {runChip ? <StatusBadge label={runChip.label} colorRole={runChip.role} /> : null}
    </span>
  );
}
