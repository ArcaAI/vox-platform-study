import type { ReactNode } from 'react';
import type { ActivityEntry, ActivityItemEntry, ConsultationActivityPage, EncounterBlock } from '@arcaai/types';
import type { TimelineBadge, TimelineItemModel, TimelineRow } from '@arcaai/ui';
import { ItemBody } from './activity-item-row';
import { formatGap, humanizeEventType, kindLabel } from './activity-format';

export const segmentRunRowId = (runId: string) => `run:${runId}`;

function entryId(entry: ActivityEntry, index: number): string {
  switch (entry.entryType) {
    case 'item':
      return entry.id;
    case 'segment_run':
      return segmentRunRowId(entry.runId);
    case 'feedback':
      return `feedback:${entry.id ?? index}`;
    case 'lifecycle':
      return `lifecycle:${entry.at}:${entry.type}:${index}`;
  }
}

function entryTime(entry: ActivityEntry): string {
  switch (entry.entryType) {
    case 'lifecycle':
      return entry.at;
    case 'feedback':
      return entry.occurredAt ?? '';
    default:
      return entry.occurredAt;
  }
}

function entryTitle(entry: ActivityEntry): string {
  switch (entry.entryType) {
    case 'item':
      return kindLabel(entry.kind);
    case 'segment_run':
      return 'Transcript segments';
    case 'feedback':
      return 'Feedback';
    case 'lifecycle':
      return humanizeEventType(entry.type);
  }
}

function entryBadges(entry: ActivityEntry): TimelineBadge[] {
  if (entry.entryType === 'item') {
    const badges: TimelineBadge[] = [{ label: entry.edited ? `v${entry.latestVersion.number} · edited` : `v${entry.latestVersion.number}`, variant: entry.edited ? 'outline' : 'secondary' }];
    if (entry.source === 'ai') badges.push({ label: 'AI', variant: 'secondary' });
    return badges;
  }
  if (entry.entryType === 'segment_run') return entry.edited ? [{ label: 'edited', variant: 'outline' }] : [];
  return [];
}

/** Encounter bands carry the visit type exactly as the API reports it. */
function encounterBand(block: EncounterBlock): TimelineRow {
  return { kind: 'band', id: `encounter:${block.seq}`, label: `Encounter ${block.seq} · ${block.visitType}`, tone: 'section' };
}

function gapBand(block: EncounterBlock): TimelineRow | null {
  if (!block.gapAfter) return null;
  return { kind: 'band', id: `gap:${block.seq}`, label: `Away ${formatGap(block.gapAfter.durationMs)}`, tone: 'gap' };
}

export interface ActivityRows {
  rows: TimelineRow[];
  /** Every selectable row id -> its source entry. */
  entries: Map<string, ActivityEntry>;
}

/**
 * The feed arrives oldest-first. Each encounter opens with a section band, and the gap between two
 * encounters is a quiet band placed before the next encounter's heading.
 */
export function buildActivityRows(page: Pick<ConsultationActivityPage, 'items' | 'encounters'>, renderBody: (entry: ActivityEntry) => ReactNode = (entry) => <ItemBody entry={entry} />): ActivityRows {
  const bySeq = new Map(page.encounters.map((block) => [block.seq, block]));
  const rows: TimelineRow[] = [];
  const entries = new Map<string, ActivityEntry>();
  let currentSeq: number | null = null;

  page.items.forEach((entry, index) => {
    const seq = entry.entryType === 'item' || entry.entryType === 'segment_run' ? entry.encounterSeq : null;
    if (seq !== null && seq !== currentSeq) {
      const previous = currentSeq !== null ? bySeq.get(currentSeq) : undefined;
      const gap = previous ? gapBand(previous) : null;
      if (gap) rows.push(gap);
      const block = bySeq.get(seq);
      if (block) rows.push(encounterBand(block));
      currentSeq = seq;
    }
    const id = entryId(entry, index);
    entries.set(id, entry);
    const model: TimelineItemModel = {
      id,
      timestamp: entryTime(entry),
      title: entryTitle(entry),
      variant: 'custom',
      content: { type: 'custom', render: () => renderBody(entry) },
      badges: entryBadges(entry),
      defaultExpanded: true,
    };
    rows.push(model);
  });
  return { rows, entries };
}

export function isItemEntry(entry: ActivityEntry | undefined): entry is ActivityItemEntry {
  return entry?.entryType === 'item';
}
