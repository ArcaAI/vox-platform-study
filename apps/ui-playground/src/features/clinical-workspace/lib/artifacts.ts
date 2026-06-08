/**
 * Artifact selectors (TASK-330 P3, WS5).
 *
 * Pure helpers that derive review inputs and the artifacts/storage grouping from
 * a consultation's context items. No SDK runtime — unit-testable directly.
 */
import type { TranscriptSource } from '@arcaai/vox';
import { NOTE_CONTEXT_TYPES } from '../constants';
import type { WorkspaceContextItem } from '../types';

const NOTE_TYPES = new Set<string>(NOTE_CONTEXT_TYPES);
/** Signed > modified > raw, so review targets the most authoritative draft. */
const NOTE_PRIORITY: Record<string, number> = { SIGNED_NOTE: 3, MODIFIED_SUMMARY: 2, RAW_SUMMARY: 1 };

function createdAtMs(item: WorkspaceContextItem): number {
  const t = item.createdAt ? Date.parse(item.createdAt) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Pick the note to review: the highest-priority note type, breaking ties by
 * most recent `createdAt`. Returns `null` when no note has been drafted yet.
 */
export function selectLatestNote(items: WorkspaceContextItem[]): WorkspaceContextItem | null {
  const notes = items.filter((i) => NOTE_TYPES.has(i.type));
  if (notes.length === 0) return null;
  return notes.reduce((best, candidate) => {
    const bp = NOTE_PRIORITY[best.type] ?? 0;
    const cp = NOTE_PRIORITY[candidate.type] ?? 0;
    if (cp !== bp) return cp > bp ? candidate : best;
    return createdAtMs(candidate) >= createdAtMs(best) ? candidate : best;
  });
}

/** Map TRANSCRIPT context items into the transcript sources the review highlights. */
export function selectTranscriptSources(items: WorkspaceContextItem[]): TranscriptSource[] {
  return items
    .filter((i) => i.type === 'TRANSCRIPT' && typeof i.content === 'string' && i.content.length > 0)
    .map((i) => ({ contextItemId: i.id, text: i.content, label: 'Live transcription' }));
}

export type ArtifactGroupKey = 'audio' | 'transcript' | 'note' | 'summary' | 'attachment';

/** Bucket a context item into its artifacts-panel group. */
export function artifactGroupFor(type: string): ArtifactGroupKey {
  if (type === 'AUDIO_RECORDING') return 'audio';
  if (type === 'TRANSCRIPT') return 'transcript';
  if (type === 'SIGNED_NOTE' || type === 'CASE_NOTE' || type === 'WORKNOTE') return 'note';
  if (type === 'RAW_SUMMARY' || type === 'MODIFIED_SUMMARY' || type === 'PRE_SUMMARY') return 'summary';
  return 'attachment';
}
