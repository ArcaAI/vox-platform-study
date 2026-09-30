'use client';

import type { ReactNode } from 'react';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCloudDownload,
  IconCloudOff,
  IconCloudX,
  IconEyeOff,
  IconHourglass,
  IconInfoCircle,
  IconMinus,
  IconPackage,
  IconTrashX,
} from '@tabler/icons-react';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { formatBytes } from '@/shared/format';
import type { AiModel, ModelLifecycle, ModelLifecycleStatus } from '../api/types';

/**
 * ONE word per row (TASK-1019 D-9). Never colour alone (rule 11 §10): every
 * status carries its own icon AND its own label; the colour role only reinforces.
 */
export const LIFECYCLE_META: Record<ModelLifecycleStatus, { label: string; role: StatusColorRole; icon: ReactNode; hint: string }> = {
  UNREGISTERING: {
    label: 'Unregistering',
    role: 'warning',
    icon: <IconTrashX aria-hidden />,
    hint: 'The model is being removed; its weights are being cleaned up.',
  },
  UNREGISTER_FAILED: {
    label: 'Unregister failed',
    role: 'destructive',
    icon: <IconAlertTriangle aria-hidden />,
    hint: 'The removal did not finish. Retry the unregister to clean up the weights.',
  },
  DOWNLOADING: { label: 'Downloading', role: 'info', icon: <IconCloudDownload aria-hidden />, hint: 'The weights are being published to the bucket.' },
  DOWNLOAD_FAILED: { label: 'Download failed', role: 'destructive', icon: <IconAlertTriangle aria-hidden />, hint: 'The last publish did not finish.' },
  DOWNLOAD_CANCELLED: {
    label: 'Download cancelled',
    role: 'warning',
    icon: <IconCloudX aria-hidden />,
    hint: 'The download was cancelled. Retry it from the edit drawer to publish the weights again.',
  },
  NOT_DOWNLOADED: { label: 'Not downloaded', role: 'neutral', icon: <IconCloudOff aria-hidden />, hint: 'The weights are not in the bucket yet.' },
  LOAD_FAILED: { label: 'Load failed', role: 'destructive', icon: <IconAlertTriangle aria-hidden />, hint: 'A serving engine tried to load it and failed.' },
  LOADING: { label: 'Loading', role: 'info', icon: <IconHourglass aria-hidden />, hint: 'A serving engine is loading it.' },
  SERVING: { label: 'Serving', role: 'success', icon: <IconCircleCheck aria-hidden />, hint: 'Loaded on at least one serving engine.' },
  DOWNLOADED: { label: 'Downloaded', role: 'success', icon: <IconPackage aria-hidden />, hint: 'The weights are in the bucket; no engine holds it loaded.' },
  NOT_OBSERVED: {
    label: 'Not observed',
    role: 'neutral',
    icon: <IconEyeOff aria-hidden />,
    hint: 'Served by a workload whose load state is not reported to the registry.',
  },
  NOT_APPLICABLE: { label: 'Not applicable', role: 'neutral', icon: <IconMinus aria-hidden />, hint: 'A cloud model — there are no weights to host.' },
};

/** LM Studio reads new model files at start-up, so a fresh GGUF is invisible until its pod restarts (OD-6). */
export const LM_STUDIO_RESTART_HINT = 'LM Studio picks up new files after its pod restarts.';

/** A GGUF row that LM Studio serves and whose weights are in the bucket — the one case that needs a restart to go live. */
export function needsLmStudioRestart(model: Pick<AiModel, 'format' | 'servedBy' | 'provider' | 'lifecycle'>): boolean {
  const servedByLmStudio = [model.servedBy, model.provider].some((value) => value === 'lm-studio' || value === 'lmstudio');
  return model.format === 'GGUF' && servedByLmStudio && model.lifecycle?.status === 'DOWNLOADED';
}

export function LifecycleBadge({ status }: { status: ModelLifecycleStatus }) {
  const meta = LIFECYCLE_META[status];
  return <StatusBadge label={meta.label} colorRole={meta.role} icon={meta.icon} />;
}

/** Download progress in [0, 100], or `null` when the total is unknown (indeterminate). */
export function downloadPercent(download: ModelLifecycle['download']): number | null {
  if (!download || download.bytesDone == null || !download.bytesTotal) return null;
  return Math.min(100, Math.max(0, Math.round((download.bytesDone / download.bytesTotal) * 100)));
}

/** Byte counters for a download, e.g. "1.2 GB / 3.4 GB" (or just the done side while the total is unknown). */
export function downloadBytesLabel(download: NonNullable<ModelLifecycle['download']>): string {
  if (download.bytesDone == null) return '';
  return download.bytesTotal ? `${formatBytes(download.bytesDone)} / ${formatBytes(download.bytesTotal)}` : formatBytes(download.bytesDone);
}

/**
 * The grid cell: the badge, plus a progress bar while DOWNLOADING and the LM
 * Studio restart hint once a GGUF is in the bucket. Single line — the grid row
 * is fixed-height.
 */
export function LifecycleCell({ model }: { model: AiModel }) {
  const lifecycle = model.lifecycle;
  if (!lifecycle) return <span className="text-muted-foreground">—</span>;
  const percent = downloadPercent(lifecycle.download);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <LifecycleBadge status={lifecycle.status} />
      {lifecycle.status === 'DOWNLOADING' && lifecycle.download ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <Progress
            value={percent ?? undefined}
            aria-label={`Download progress for ${model.name}`}
            aria-valuetext={percent === null ? 'In progress' : `${percent}%`}
            className="w-16 shrink-0"
          />
          <span className="text-muted-foreground truncate font-mono text-xs">{percent === null ? downloadBytesLabel(lifecycle.download) : `${percent}%`}</span>
        </span>
      ) : null}
      {lifecycle.status === 'DOWNLOAD_FAILED' && lifecycle.download?.error ? (
        <span className="text-muted-foreground truncate text-xs" title={lifecycle.download.error}>
          {lifecycle.download.error}
        </span>
      ) : null}
      {needsLmStudioRestart(model) ? (
        <span className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs" title={LM_STUDIO_RESTART_HINT}>
          <IconInfoCircle aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{LM_STUDIO_RESTART_HINT}</span>
        </span>
      ) : null}
    </span>
  );
}
