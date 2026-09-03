'use client';

import { useEffect, useRef, useState } from 'react';
import { IconCloudDownload } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { formatBytes, formatRelativeTime } from '@/shared/format';
import { useInvalidateAiModels, useModelDownloadStatus, useStartModelDownload } from '../api/hooks';
import type { AiModel, AiModelDownloadStatus, ModelDownloadState as ModelDownloadDetail } from '../api/types';
import { DownloadStatusBadge } from './download-status-badge';

export interface UseModelDownloadResult {
  status: AiModelDownloadStatus;
  detail: ModelDownloadDetail | undefined;
  start: () => void;
  isStarting: boolean;
  /** Non-null when Download must be disabled — the reason to show next to it (rule 11 §5). */
  disabledReason: string | null;
}

/**
 * Orchestrates the Download action against the FROZEN contract:
 *   POST :id/download -> 202 { jobId, status: 'DOWNLOADING' }
 *   GET :id/download -> 200 { status, startedAt, finishedAt, fileSizeMb, sha256, localPath, error }
 * Polls while DOWNLOADING, stops on a terminal state, toasts the outcome
 * exactly once per transition, and refreshes the registry list so the grid's
 * `downloadStatus`/`localPath`/`fileSizeMb` pick up the finished row.
 */
export function useModelDownload(model: AiModel): UseModelDownloadResult {
  // A model already DOWNLOADING when the drawer opens (started elsewhere, or
  // from a prior visit) must resume polling immediately, not wait for a click.
  const [polling, setPolling] = useState(model.downloadStatus === 'DOWNLOADING');
  const poll = useModelDownloadStatus(model.id, { enabled: polling });
  const startMutation = useStartModelDownload();
  const invalidateModels = useInvalidateAiModels();
  const previousStatus = useRef<AiModelDownloadStatus | undefined>(undefined);

  const status = poll.data?.status ?? model.downloadStatus;

  useEffect(() => {
    if (previousStatus.current === 'DOWNLOADING' && status !== 'DOWNLOADING') {
      if (status === 'DOWNLOADED') toast.success(`${model.name} downloaded`);
      else if (status === 'DOWNLOAD_FAILED') toast.error(poll.data?.error || `${model.name} failed to download`);
      invalidateModels();
      setPolling(false);
    }
    previousStatus.current = status;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `invalidateModels` and `model.name` are stable for the drawer's lifetime; only the status transition should re-run this effect.
  }, [status]);

  const hasSource = Boolean(model.localPath?.trim() || model.sourceUri?.trim());

  function start() {
    startMutation.mutate(model.id, {
      onSuccess: () => setPolling(true),
      onError: (error) => {
        const alreadyInFlight = error instanceof GatewayError && error.status === 409;
        toast.error(alreadyInFlight ? 'A download is already in progress for this model.' : error.message);
        // A 409 means one really IS running elsewhere — start polling so this view catches up.
        if (alreadyInFlight) setPolling(true);
      },
    });
  }

  return {
    status,
    detail: poll.data,
    start,
    isStarting: startMutation.isPending,
    disabledReason: hasSource ? null : 'This model has no source URI or mounted path — add one above before downloading.',
  };
}

/**
 * The Download action + status readout, hosted in the edit drawer (a model
 * must already exist — `POST :id/download` has no create-time equivalent).
 * Grid rows stay read-only chips (`WeightSourceBadge`/`DownloadStatusBadge`);
 * this is where the action itself, its full detail, and a properly-labelled
 * disabled reason live (rule 11 §1 Detail Surface: actions belong on the
 * per-record DetailDrawer, not scattered across the grid).
 */
export function ModelDownloadPanel({ model }: { model: AiModel }) {
  const { status, detail, start, isStarting, disabledReason } = useModelDownload(model);
  const busy = status === 'DOWNLOADING' || isStarting;
  const label = status === 'DOWNLOADED' ? 'Re-download' : status === 'DOWNLOAD_FAILED' ? 'Retry download' : 'Download';
  const reasonId = 'model-download-disabled-reason';

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Weights</span>
        <DownloadStatusBadge status={status} />
      </div>
      {detail &&
      (detail.fileSizeMb != null || detail.sha256 || detail.localPath || detail.finishedAt || (status === 'DOWNLOAD_FAILED' && detail.error)) ? (
        <dl className="text-muted-foreground flex flex-col gap-1 text-xs">
          {detail.fileSizeMb != null ? (
            <div className="flex gap-1">
              <dt className="font-medium">Size:</dt>
              <dd>{formatBytes(detail.fileSizeMb * 1024 * 1024)}</dd>
            </div>
          ) : null}
          {detail.sha256 ? (
            <div className="flex gap-1">
              <dt className="shrink-0 font-medium">SHA256:</dt>
              <dd className="font-mono break-all">{detail.sha256}</dd>
            </div>
          ) : null}
          {detail.localPath ? (
            <div className="flex gap-1">
              <dt className="shrink-0 font-medium">Path:</dt>
              <dd className="font-mono break-all">{detail.localPath}</dd>
            </div>
          ) : null}
          {detail.finishedAt ? (
            <div className="flex gap-1">
              <dt className="font-medium">Finished:</dt>
              <dd>{formatRelativeTime(detail.finishedAt)}</dd>
            </div>
          ) : null}
          {status === 'DOWNLOAD_FAILED' && detail.error ? (
            <p role="alert" className="text-destructive">
              {detail.error}
            </p>
          ) : null}
        </dl>
      ) : null}
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={start}
          disabled={busy || Boolean(disabledReason)}
          aria-describedby={disabledReason ? reasonId : undefined}
          className="self-start"
        >
          {busy ? <Spinner /> : <IconCloudDownload aria-hidden />}
          {status === 'DOWNLOADING' ? 'Downloading…' : label}
        </Button>
        {/* Rule 11 : a disabled control must state its reason, visibly. */}
        {disabledReason ? (
          <p id={reasonId} className="text-muted-foreground text-xs">
            {disabledReason}
          </p>
        ) : null}
      </div>
    </div>
  );
}
