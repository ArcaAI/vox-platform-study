import { useEffect, useRef } from 'react';

import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@arcaai/ui';

export interface TranscriptLine {
  text: string;
  meta?: Record<string, unknown>;
  /** mm:ss.mmm — from `meta.startTime` when present, else capture-relative arrival time. */
  timestamp: string;
}

interface TranscriptColumnProps {
  lines: TranscriptLine[];
  interim: string;
  /** Session is loading and nothing has streamed yet — show skeletons. */
  isPreSession: boolean;
}

function MetadataCell({ meta }: { meta?: Record<string, unknown> }) {
  if (!meta || Object.keys(meta).length === 0) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {/* `mic` / `speaker` are the literal keys the per-mic metadata rows send
            (MetadataSimulator → sendAudioData). Mic attribution is the whole
            point of the multi-mic timeline, so they get first-class badges
            instead of being buried in the raw-JSON block below (carried from lane C). The label is spelled out in text — the
            badge variant is decoration, never the only signal. */}
        {meta.mic !== undefined ? <Badge variant="default">mic: {String(meta.mic)}</Badge> : null}
        {meta.speaker !== undefined ? <Badge variant="secondary">speaker: {String(meta.speaker)}</Badge> : null}
        {meta.speaker_id !== undefined ? <Badge variant="secondary">speaker_id: {String(meta.speaker_id)}</Badge> : null}
        {meta.detected_language !== undefined ? <Badge variant="secondary">lang: {String(meta.detected_language)}</Badge> : null}
        {meta.chunk_id !== undefined ? <Badge variant="outline">chunk: {String(meta.chunk_id)}</Badge> : null}
        {meta.startTime !== undefined || meta.endTime !== undefined ? (
          <Badge variant="outline">
            t: {String(meta.startTime ?? '—')}–{String(meta.endTime ?? '—')}
          </Badge>
        ) : null}
      </div>
      <details>
        <summary className="text-muted-foreground cursor-pointer text-xs">raw</summary>
        <pre className="bg-muted mt-1 overflow-x-auto rounded p-2 font-mono text-[11px] leading-tight">{JSON.stringify(meta, null, 2)}</pre>
      </details>
    </div>
  );
}

/**
 * Column 3 — the live results, as ONE timeline split into two aligned tracks:
 * the transcription (left, with timestamp) and the metadata that round-tripped
 * with it (right). Both cells share a grid row per turn, so a line and its
 * metadata always sit on the same horizontal timeline.
 */
export function TranscriptColumn({ lines, interim, isPreSession }: TranscriptColumnProps) {
  const hasContent = lines.length > 0 || interim !== '';

  // Keep the newest transcript in view — scroll the results body to the bottom
  // whenever a new line arrives or the interim text grows.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, interim]);

  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader>
        <CardTitle>Live results</CardTitle>
        <CardDescription>
          One timeline — the transcription (with timestamp) and the metadata returned alongside it (passthrough), aligned row by row.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        {/* Sticky two-track header so the columns stay labeled while the body scrolls. */}
        <div className="bg-background sticky top-0 z-10 grid grid-cols-2 gap-3 border-b pb-2">
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Transcription</span>
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Returned metadata</span>
        </div>

        <div ref={scrollRef} className="max-h-[62vh] overflow-y-auto">
          {isPreSession ? (
            <div className="flex flex-col gap-2 pt-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : !hasContent ? (
            <p className="text-muted-foreground pt-3 text-sm">No transcript yet — start a consultation to begin.</p>
          ) : (
            <ul className="flex flex-col">
              {lines.map((line, i) => (
                <li key={i} className="border-border grid grid-cols-2 gap-3 border-b py-2 text-sm last:border-b-0">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-muted-foreground font-mono text-xs">{line.timestamp}</span>
                    <span className="break-words">{line.text}</span>
                  </div>
                  <div className="min-w-0">
                    <MetadataCell meta={line.meta} />
                  </div>
                </li>
              ))}
              {interim ? (
                <li className="grid grid-cols-2 gap-3 py-2 text-sm">
                  <span className="text-muted-foreground italic">{interim}</span>
                  <span className="text-muted-foreground text-xs">—</span>
                </li>
              ) : null}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
