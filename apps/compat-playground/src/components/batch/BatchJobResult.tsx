import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@arcaai/ui';
import { usePlaygroundSession } from '../../context/playground-session';

function formatSeconds(value: number | undefined): string {
  if (value === undefined) return '—';
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The selected job's transcript, streaming in live.
 *
 * The SEGMENTS are shown while the job runs (that is the live SSE feed); once
 * the job completes, the job's own `resultText` is what the hook stores in
 * `item.text` and what the summarization handoff sends — streamed chunks can be
 * partial, so the two are deliberately not the same value.
 */
export function BatchJobResult() {
  const { batch } = usePlaygroundSession();
  const item = batch.items.find((i) => i.id === batch.selectedId) ?? null;

  if (!item) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Transcript</CardTitle>
          <CardDescription>Select a queued file to read its result.</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground py-12 text-center text-sm">Nothing selected.</CardContent>
      </Card>
    );
  }

  const isWaiting = item.status === 'uploading' || (item.status === 'processing' && item.segments.length === 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span className="truncate">{item.fileName}</span>
          <Badge variant="outline" className="font-mono text-xs">
            {item.jobId ?? 'no job yet'}
          </Badge>
        </CardTitle>
        <CardDescription>
          {item.status === 'completed'
            ? 'Completed — showing the job’s authoritative result text.'
            : item.status === 'processing'
              ? 'Transcribing — segments stream in as the worker emits them.'
              : item.status === 'uploading'
                ? 'Uploading…'
                : `Status: ${item.status}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isWaiting ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : null}

        {item.segments.length > 0 ? (
          <ol className="flex flex-col gap-2">
            {item.segments.map((segment, index) => (
              <li key={`${item.id}-seg-${index}`} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2 text-sm">
                <span className="text-muted-foreground font-mono text-xs">
                  {formatSeconds(segment.startTime)}
                  {segment.speakerLabel || segment.speakerId ? ` · ${segment.speakerLabel ?? segment.speakerId}` : ''}
                </span>
                <span className={segment.isFinal ? '' : 'text-muted-foreground italic'}>{segment.text}</span>
              </li>
            ))}
          </ol>
        ) : null}

        {item.status === 'completed' ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Result text</p>
            <pre className="bg-muted max-h-72 overflow-auto rounded p-3 text-xs leading-relaxed whitespace-pre-wrap">{item.text || '(empty)'}</pre>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => batch.sendToSummarization(item.text)} disabled={!item.text}>
                Send to Summarization
              </Button>
            </div>
          </div>
        ) : null}

        {item.error ? <p className="text-destructive text-sm">{item.error}</p> : null}
      </CardContent>
    </Card>
  );
}
