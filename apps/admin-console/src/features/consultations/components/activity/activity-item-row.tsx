import type { ActivityEntry, ActivityItemEntry, RunSummary } from '@arcaai/types';
import { formatNumber } from '@/shared/format';
import { formatDuration, formatRecordingOffset, formatRunCost, formatTokenPair, humanizeEventType } from './activity-format';
import { parseRecap, recapPlainText } from './recap-model';

function RunField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

/** The AI activity that produced an item: which workflow/agent/model, how long, tokens, context, cost. */
export function RunMeta({ run }: { run: RunSummary }) {
  const contextShare = run.contextWindow > 0 ? Math.min(100, Math.round((run.contextUsed / run.contextWindow) * 100)) : 0;
  return (
    <div role="group" aria-label="AI activity" className="mt-3 border-t border-dashed pt-2">
      <dl className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <RunField label="workflow">
          <span className="font-mono">{run.workflowSlug}</span>
        </RunField>
        <RunField label="agent">
          <span className="font-mono">{run.agentSlug}</span>
        </RunField>
        <RunField label="model">
          <span className="font-mono">{run.model}</span>
        </RunField>
        <RunField label="took">
          <span className="font-medium tabular-nums">{formatDuration(run.durationMs)}</span>
        </RunField>
        <RunField label="tokens in/out">
          <span className="tabular-nums">{formatTokenPair(run.tokensIn, run.tokensOut)}</span>
        </RunField>
        <RunField label="context">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="bg-muted inline-block h-1.5 w-16 overflow-hidden rounded-full">
              <span className="bg-primary block h-full" style={{ width: `${contextShare}%` }} />
            </span>
            <span className="tabular-nums">{`${formatNumber(run.contextUsed)} / ${formatNumber(run.contextWindow)}`}</span>
          </span>
        </RunField>
        <RunField label="cost">
          <span className="tabular-nums" title={run.costBasis ?? undefined}>
            {formatRunCost(run.costMicros)}
          </span>
        </RunField>
      </dl>
    </div>
  );
}

function itemText(entry: ActivityItemEntry): string | null {
  const content = entry.latestVersion.content;
  if (!content) return null;
  const recap = entry.kind === 'ENCOUNTER_RECAP' ? parseRecap(content) : null;
  return recap ? recapPlainText(recap) : content;
}

function ItemContent({ entry }: { entry: ActivityItemEntry }) {
  const text = itemText(entry);
  return (
    <>
      {text ? (
        <p className="line-clamp-4 text-sm whitespace-pre-line">{text}</p>
      ) : (
        <p className="text-muted-foreground text-sm">
          {entry.media?.durationMs !== undefined ? `Media · ${formatDuration(entry.media.durationMs)}` : 'No text content'}
        </p>
      )}
      {entry.segment ? (
        <p className="text-muted-foreground mt-1 text-xs tabular-nums">
          #{entry.segment.seq} {'·'} {formatRecordingOffset(entry.segment.t0Ms)}
          {entry.segment.speaker ? ` · ${entry.segment.speaker}` : ''}
        </p>
      ) : null}
      {entry.feedback ? (
        <p className="text-muted-foreground mt-1 text-xs">
          Feedback: {entry.feedback.up} up, {entry.feedback.down} down
        </p>
      ) : null}
      {entry.run ? <RunMeta run={entry.run} /> : null}
    </>
  );
}

/** Body of one timeline row, by entry type. */
export function ItemBody({ entry }: { entry: ActivityEntry }) {
  switch (entry.entryType) {
    case 'item':
      return <ItemContent entry={entry} />;
    case 'segment_run':
      return (
        <div>
          <p className="line-clamp-3 text-sm">{entry.preview}</p>
          <p className="text-muted-foreground mt-1 text-xs tabular-nums">
            {entry.count} segments {'·'} #{entry.firstSeq}
            {'–'}#{entry.lastSeq} {'·'} {formatRecordingOffset(entry.t0Ms)}
            {'–'}
            {formatRecordingOffset(entry.t1Ms)}
            {entry.speakers.length > 0 ? ` · ${entry.speakers.join(', ')}` : ''}
          </p>
        </div>
      );
    case 'feedback':
      return (
        <div className="flex flex-col gap-1 text-sm">
          <p>
            Rating: {entry.rating ?? 'none'}
            {entry.target ? ` · on ${entry.target.kind.toLowerCase()}` : ''}
          </p>
          {entry.reasonCodes.length > 0 ? <p className="text-muted-foreground text-xs">{entry.reasonCodes.join(', ')}</p> : null}
          {entry.comment ? <p className="whitespace-pre-line">{entry.comment}</p> : null}
        </div>
      );
    case 'lifecycle':
      return <p className="text-muted-foreground text-sm">{humanizeEventType(entry.type)}</p>;
  }
}
