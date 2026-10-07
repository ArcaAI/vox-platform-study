import type { ActivityEntry, ActivityItemEntry, RunSummary } from '@arcaai/types';
import { formatNumber } from '@/shared/format';
import { GuardrailItemBadge } from '@/shared/guardrail/guardrail-item-badge';
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

/** TASK-1050: an item's guardrail warn / block counts (from its notices and evaluations). */
export interface ItemGuardrailCounts {
  warn: number;
  block: number;
}

/**
 * The item's `guardrailStatus` marker (README §9.7.4; on the feed since W2e round 4), or `undefined`
 * when the feed predates it. The marker is per VERSION and outranks the derived counts: `clean` means
 * the current version is unmarked (e.g. edited and re-screened), so no badge at all.
 */
function guardrailStatusOf(entry: ActivityItemEntry): string | undefined {
  const status = (entry as ActivityItemEntry & { guardrailStatus?: unknown }).guardrailStatus;
  return typeof status === 'string' && status !== '' ? status.toLowerCase() : undefined;
}

function ItemContent({ entry, guardrail }: { entry: ActivityItemEntry; guardrail?: ItemGuardrailCounts }) {
  const text = itemText(entry);
  const guardrailStatus = guardrailStatusOf(entry);
  // The gateway's marker wins when present; the derived counts are detail (or the fallback without it).
  const showGuardrail = guardrailStatus !== undefined ? guardrailStatus !== 'clean' : !!guardrail && (guardrail.warn > 0 || guardrail.block > 0);
  return (
    <>
      {showGuardrail ? (
        <div className="mb-1.5">
          <GuardrailItemBadge status={guardrailStatus} warn={guardrail?.warn ?? 0} block={guardrail?.block ?? 0} />
        </div>
      ) : null}
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
export function ItemBody({ entry, guardrail }: { entry: ActivityEntry; guardrail?: ItemGuardrailCounts }) {
  switch (entry.entryType) {
    case 'item':
      return <ItemContent entry={entry} guardrail={guardrail} />;
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
