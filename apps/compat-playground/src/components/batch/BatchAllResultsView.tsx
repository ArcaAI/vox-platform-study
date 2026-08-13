import type { BatchQueueItem } from '@arcaai/vox/compat';
import { Badge, Button, Skeleton } from '@arcaai/ui';
import { toast } from 'sonner';
import { usePlaygroundSession } from '../../context/playground-session';
import { STATUS_LABEL, STATUS_VARIANT } from './BatchJobQueue';

/**
 * Plain-text export shared by "Copy all" and "Download all" — one section per
 * queued file, in queue order. Deliberately honest about mixed states: a
 * still-running or failed item gets its own section rather than being
 * dropped, so the export always accounts for every file that was dropped.
 */
export function buildBatchResultsText(items: BatchQueueItem[]): string {
  return items
    .map((item) => {
      const header = `=== ${item.fileName} (${STATUS_LABEL[item.status]}${item.jobId ? `, job ${item.jobId}` : ''}) ===`;
      const body =
        item.status === 'failed'
          ? `Error: ${item.error ?? 'Transcription failed.'}`
          : item.status === 'cancelled'
            ? 'Cancelled.'
            : item.text.trim() || '(no transcript text yet)';
      return `${header}\n${body}`;
    })
    .join('\n\n');
}

function downloadFileName(): string {
  return `batch-transcripts-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
}

/**
 * One queue item's transcript block. Mirrors `BatchJobResult`'s per-status
 * rules (skeleton while waiting, authoritative text once there is any,
 * error/cancelled messages) rather than inventing new ones — the difference
 * is that EVERY item gets a block here instead of only the selected one.
 */
function ResultBlock({
  item,
  onCopyItem,
  onSend,
}: {
  item: BatchQueueItem;
  onCopyItem: (item: BatchQueueItem) => void;
  onSend: (text: string) => void;
}) {
  const isWaiting = item.status === 'pending' || item.status === 'uploading' || (item.status === 'processing' && item.text.trim() === '');

  return (
    <li className="rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{item.fileName}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>
          <Badge variant="outline" className="font-mono text-xs">
            {item.jobId ?? 'no job yet'}
          </Badge>
        </div>
      </div>

      <div className="mt-2">
        {item.status === 'failed' ? (
          <p className="text-destructive text-sm">{item.error ?? 'Transcription failed.'}</p>
        ) : item.status === 'cancelled' ? (
          <p className="text-muted-foreground text-sm">Cancelled.</p>
        ) : isWaiting ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <pre className="bg-muted max-h-72 overflow-auto rounded p-3 text-xs leading-relaxed whitespace-pre-wrap">{item.text || '(empty)'}</pre>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => onCopyItem(item)} disabled={!item.text}>
                Copy
              </Button>
              {item.status === 'completed' && item.text ? (
                <Button variant="outline" size="sm" onClick={() => onSend(item.text)}>
                  Send to Summarization
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * "All results" — every queued file's transcript in one scrollable surface
 *, so dropping ten files doesn't force clicking through them one
 * at a time. Nothing is filtered out: pending/uploading/processing items show
 * what they have so far (or a skeleton), failed/cancelled items say so.
*/
export function BatchAllResultsView() {
  const { batch } = usePlaygroundSession();
  const total = batch.items.length;
  const completed = batch.items.filter((item) => item.status === 'completed').length;

  const handleCopyItem = async (item: BatchQueueItem) => {
    try {
      await navigator.clipboard.writeText(item.text);
      toast.success(`Copied ${item.fileName}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not copy to the clipboard.');
    }
  };

  const handleCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(buildBatchResultsText(batch.items));
      toast.success('Copied every transcript to the clipboard.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not copy to the clipboard.');
    }
  };

  const handleDownloadAll = () => {
    try {
      const blob = new Blob([buildBatchResultsText(batch.items)], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadFileName();
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success('Downloaded every transcript.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed.');
    }
  };

  if (total === 0) {
    return <p className="text-muted-foreground py-8 text-center text-sm">No files queued yet.</p>;
  }

  return (
    <div data-testid="batch-all-results" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {completed} of {total} completed
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={handleCopyAll}>
            Copy all
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownloadAll}>
            Download all
          </Button>
        </div>
      </div>

      <ol className="flex max-h-[36rem] flex-col gap-3 overflow-y-auto pr-1">
        {batch.items.map((item) => (
          <ResultBlock key={item.id} item={item} onCopyItem={handleCopyItem} onSend={batch.sendToSummarization} />
        ))}
      </ol>
    </div>
  );
}
