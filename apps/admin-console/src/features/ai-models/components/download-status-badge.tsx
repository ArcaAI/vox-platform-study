'use client';

import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import type { AiModelDownloadStatus } from '../api/types';

/** Never color-only (rule 11 §10): each state carries its own label + role. */
const DOWNLOAD_STATUS_META: Record<AiModelDownloadStatus, { label: string; role: StatusColorRole; pulse?: boolean }> = {
  NOT_DOWNLOADED: { label: 'Not downloaded', role: 'neutral' },
  DOWNLOADING: { label: 'Downloading', role: 'info', pulse: true },
  DOWNLOADED: { label: 'Downloaded', role: 'success' },
  DOWNLOAD_FAILED: { label: 'Download failed', role: 'destructive' },
};

/** At-a-glance chip for "whether the weights are downloaded" + the download state. */
export function DownloadStatusBadge({ status }: { status: AiModelDownloadStatus }) {
  const meta = DOWNLOAD_STATUS_META[status];
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" pulse={meta.pulse} />} />;
}
