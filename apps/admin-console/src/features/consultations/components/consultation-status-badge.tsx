'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';

import { CONSULTATION_PROCESSING, NOTE_READY_REASON, type ConsultationProcessing, type ConsultationStatus } from '@arcaai/types';
import { normalizeConsultationStatus } from '../api/types';

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

export function consultationStatusMeta(status: string | undefined, processing?: string, processingReason?: string | null) {
  const explicit = (CONSULTATION_PROCESSING as readonly string[]).includes(processing ?? '') ? (processing as ConsultationProcessing) : undefined;
  const normalized = normalizeConsultationStatus(status, explicit);
  if (!normalized) return { status: { label: status || 'Unknown', role: 'neutral' as StatusColorRole }, processing: null };
  const reason = processingReason ?? normalized.processingReason;
  const noteReady = normalized.status === 'STOPPED' && normalized.processing === 'IDLE' && reason === NOTE_READY_REASON;
  const chip = noteReady ? NOTE_READY_META : normalized.processing === 'IDLE' ? null : PROCESSING_META[normalized.processing];
  return { status: STATUS_META[normalized.status], processing: chip };
}

export function ConsultationStatusBadge({
  status,
  processing,
  processingReason,
}: {
  status: string | undefined;
  processing?: string;
  processingReason?: string | null;
}) {
  const meta = consultationStatusMeta(status, processing, processingReason);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge label={meta.status.label} colorRole={meta.status.role} icon={<StatusDot colorRole={meta.status.role} size="sm" />} />
      {meta.processing ? <StatusBadge label={meta.processing.label} colorRole={meta.processing.role} /> : null}
    </span>
  );
}
