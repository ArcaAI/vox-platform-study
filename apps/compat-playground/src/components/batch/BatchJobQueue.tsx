import type { BatchItemStatus, BatchQueueItem } from '@arcaai/vox/compat';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress } from '@arcaai/ui';
import { usePlaygroundSession } from '../../context/playground-session';

/**
 * The queue: one row per file, with the job id the backend returned and what
 * that job is doing right now.
 *
 * Status is spelled out in TEXT inside the badge — the variant is decoration.
 * A colour-only status is a WCAG 1.4.1 failure, and this table is exactly the
 * place a developer scans for "which one failed".
 */

const STATUS_VARIANT: Record<BatchItemStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  pending: 'outline',
  uploading: 'secondary',
  processing: 'secondary',
  completed: 'default',
  failed: 'destructive',
  cancelled: 'outline',
};

const STATUS_LABEL: Record<BatchItemStatus, string> = {
  pending: 'Queued',
  uploading: 'Uploading',
  processing: 'Transcribing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function QueueRow({ item, isSelected }: { item: BatchQueueItem; isSelected: boolean }) {
  const { batch } = usePlaygroundSession();
  const canCancel = item.status === 'uploading' || item.status === 'processing' || item.status === 'pending';
  const canRetry = item.status === 'failed' || item.status === 'cancelled';

  return (
    <li className={`flex flex-col gap-2 rounded-md border p-3 ${isSelected ? 'border-primary' : 'border-border'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => batch.select(item.id)}
          className="cursor-pointer text-left text-sm font-medium hover:underline"
          aria-pressed={isSelected}
        >
          {item.fileName}
        </button>
        <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
        <span>{formatSize(item.size)}</span>
        <span className="font-mono">job: {item.jobId ?? '—'}</span>
        {item.segments.length > 0 ? <span>{item.segments.filter((s) => s.isFinal).length} segments</span> : null}
      </div>

      {item.status === 'uploading' ? (
        <div className="flex items-center gap-2">
          <Progress value={item.uploadProgress} className="h-2 flex-1" aria-label={`Upload progress for ${item.fileName}`} />
          <span className="text-muted-foreground w-10 text-right text-xs">{item.uploadProgress}%</span>
        </div>
      ) : null}

      {item.error ? <p className="text-destructive text-xs">{item.error}</p> : null}

      <div className="flex flex-wrap gap-2">
        {canCancel ? (
          <Button variant="outline" size="sm" onClick={() => batch.cancel(item.id)}>
            Cancel
          </Button>
        ) : null}
        {canRetry ? (
          <Button variant="outline" size="sm" onClick={() => batch.retry(item.id)}>
            Retry
          </Button>
        ) : null}
        {item.status === 'completed' && item.text ? (
          <Button variant="outline" size="sm" onClick={() => batch.sendToSummarization(item.text)}>
            Send to Summarization
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => batch.remove(item.id)}>
          Remove
        </Button>
      </div>
    </li>
  );
}

export function BatchJobQueue() {
  const { batch } = usePlaygroundSession();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Queue ({batch.items.length})</CardTitle>
        <CardDescription>One backend transcription job per file. Select a row to read its transcript.</CardDescription>
      </CardHeader>
      <CardContent>
        {batch.items.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">No files queued yet. Choose or drop audio files to start.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {batch.items.map((item) => (
              <QueueRow key={item.id} item={item} isSelected={item.id === batch.selectedId} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
