'use client';

/**
 * Click-to-source evidence panel (TASK-552 Lane C; GAP-A2 UI half).
 *
 * The segment-citation chain is closed end-to-end server-side (F-032): a
 * signed-off draft's `citationsMap` names the transcript segments that
 * grounded it, and `GET :id/summary/:contextItemId/provenance` resolves those
 * ids into `CitedSegment` rows (speaker / t0–t1 / offsets) — see
 * `useSummaryProvenance`. Until now no console surface rendered any of it.
 *
 * This panel lists the cited segments (speaker, t0–t1, a snippet sliced from
 * the already-fetched persisted transcript text) and reports a click back to
 * the caller via `onSelectCitation` — the case-note column hosts this panel
 * and the workspace screen (`consultation-demo-screen.tsx`) wires the
 * selection to the live-session column's transcript-review highlight.
 *
 * Renders nothing when there is nothing cited — absence is itself truthful
 * (mirrors `AssuranceStrip`'s empty-path posture).
 */

import { cn } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import type { CitedSegment } from '../../api';

/** `t0Ms`/`t1Ms` as `mm:ss`; `--:--` when the timing is unknown. */
function formatTimestamp(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms)) return '--:--';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Slice `[charStart, charEnd)` out of the transcript text; null when unavailable (never fabricated). */
export function citationSnippet(segment: CitedSegment, transcriptText: string | null | undefined): string | null {
    if (!transcriptText || segment.charStart == null || segment.charEnd == null) return null;
    if (segment.charStart < 0 || segment.charEnd > transcriptText.length || segment.charStart >= segment.charEnd) return null;
    const slice = transcriptText.slice(segment.charStart, segment.charEnd).trim();
    return slice.length > 0 ? slice : null;
}

export interface CitationEvidencePanelProps {
    citedSegments: CitedSegment[];
    /** Persisted transcript text (from `useTranscriptions`) — sliced locally for the snippet, never re-sent by the backend. */
    transcriptText: string | null;
    /** The currently highlighted citation (drives the live-session column scroll target). */
    selectedSegmentId?: string | null;
    onSelectCitation?: (segment: CitedSegment) => void;
}

export function CitationEvidencePanel({ citedSegments, transcriptText, selectedSegmentId, onSelectCitation }: CitationEvidencePanelProps) {
    if (citedSegments.length === 0) return null;

    return (
        <div className="border-t pt-3" aria-label="Cited transcript evidence">
            <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-semibold">
                Evidence
                <span className="bg-ai/10 text-ai rounded px-1 text-[10px] font-bold">AI</span>
            </div>
            <ul className="flex list-none flex-col gap-1.5">
                {citedSegments.map((segment) => {
                    const snippet = citationSnippet(segment, transcriptText);
                    const isSelected = selectedSegmentId === segment.id;
                    return (
                        <li key={segment.id}>
                            <button
                                type="button"
                                onClick={() => onSelectCitation?.(segment)}
                                aria-pressed={isSelected}
                                className={cn(
                                    'bg-background hover:bg-muted/60 flex w-full flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors',
                                    isSelected && 'border-primary ring-primary/30 ring-1',
                                )}
                            >
                                <span className="text-muted-foreground flex items-center gap-2 font-medium">
                                    {segment.speaker ? (
                                        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                                            {segment.speaker}
                                        </Badge>
                                    ) : null}
                                    <span className="font-mono">
                                        {formatTimestamp(segment.t0Ms)}–{formatTimestamp(segment.t1Ms)}
                                    </span>
                                </span>
                                <span className="text-foreground truncate">{snippet ?? 'Transcript span unavailable'}</span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
