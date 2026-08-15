import { Badge, Button, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@arcaai/ui';

/**
 * Transcript source control for the Summarization tab.
 *
 * Requirement A3/R9 background: the live caption is produced on the
 * Live-transcription tab and read here from the console-wide session context
 * (`usePlaygroundSession().transcript.lineTexts`) — it is NOT a prop. What
 * changed in this lane is the SOURCE PRECEDENCE: previously a non-empty paste
 * silently won over the live transcript with no indication in the UI. This
 * component makes the choice an explicit selector instead, with three modes:
 *
 * - `live` — the live transcript, verbatim, read-only preview.
 * - `pasted` — a fully independent editable transcript; never
 * touches the live buffer. "Copy live transcript"
 * seeds it from a ONE-TIME snapshot (a COPY) so the
 * developer can edit without ever mutating the
 * growing live buffer.
 * - `live-plus-context` — the live transcript (read-only) plus a separate
 * editable "additional context" field appended
 * after it.
 */

export type TranscriptSourceMode = 'live' | 'pasted' | 'live-plus-context';

const MODE_OPTIONS: Array<{ value: TranscriptSourceMode; label: string }> = [
  { value: 'live', label: 'Live transcript' },
  { value: 'pasted', label: 'Pasted' },
  { value: 'live-plus-context', label: 'Live + additional context' },
];

/** Derive the text sent to `useSMR()` from the selected source mode. */
export function computeEffectiveTranscript(mode: TranscriptSourceMode, liveLines: string[], pastedText: string, additionalContext: string): string {
  if (mode === 'pasted') return pastedText;
  const live = liveLines.join('\n');
  if (mode === 'live-plus-context') {
    return [live, additionalContext.trim()].filter(Boolean).join('\n\n');
  }
  return live;
}

export interface TranscriptSourceProps {
  mode: TranscriptSourceMode;
  onModeChange: (mode: TranscriptSourceMode) => void;
  liveLines: string[];
  pastedText: string;
  onPastedTextChange: (value: string) => void;
  additionalContext: string;
  onAdditionalContextChange: (value: string) => void;
}

export function TranscriptSource({
  mode,
  onModeChange,
  liveLines,
  pastedText,
  onPastedTextChange,
  additionalContext,
  onAdditionalContextChange,
}: TranscriptSourceProps) {
  const liveText = liveLines.join('\n');
  const liveCountLabel = `${liveLines.length} live line${liveLines.length === 1 ? '' : 's'}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor="summary-transcript-source">Transcript source</Label>
        <Badge variant="secondary">{liveCountLabel}</Badge>
      </div>

      <Select value={mode} onValueChange={(v) => onModeChange(v as TranscriptSourceMode)}>
        <SelectTrigger id="summary-transcript-source" aria-label="Transcript source">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {mode === 'live' ? (
        <Textarea
          id="summary-transcript"
          aria-label="Live transcript (read-only)"
          readOnly
          value={liveText}
          placeholder="No live transcript yet — start recording on the Live-transcription tab."
          className="bg-muted min-h-24"
        />
      ) : null}

      {mode === 'pasted' ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">Independent of the live buffer — edits here never affect it.</span>
            <Button type="button" variant="outline" size="sm" disabled={liveLines.length === 0} onClick={() => onPastedTextChange(liveText)}>
              Copy live transcript
            </Button>
          </div>
          <Textarea
            id="summary-transcript"
            aria-label="Pasted transcript"
            placeholder="Paste or type a transcript here."
            value={pastedText}
            onChange={(e) => onPastedTextChange(e.target.value)}
            className="min-h-24"
          />
        </div>
      ) : null}

      {mode === 'live-plus-context' ? (
        <div className="flex flex-col gap-3">
          <Textarea
            id="summary-transcript"
            aria-label="Live transcript (read-only)"
            readOnly
            value={liveText}
            placeholder="No live transcript yet — start recording on the Live-transcription tab."
            className="bg-muted min-h-24"
          />
          <div className="flex flex-col gap-2">
            <Label htmlFor="summary-transcript-context">Additional context</Label>
            <Textarea
              id="summary-transcript-context"
              placeholder="Extra notes to append after the live transcript…"
              value={additionalContext}
              onChange={(e) => onAdditionalContextChange(e.target.value)}
              className="min-h-16"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
