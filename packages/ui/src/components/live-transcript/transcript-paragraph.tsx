'use client';

import { Badge } from '@/components/shadcn/badge';
import { cn } from '@/lib/utils';

import { formatClock, SPEAKER_TONE } from './transcript-segment';
import { TranscriptWord } from './transcript-word';
import { joinTranscriptFragments, seamAdjustment, type TranscriptParagraph as TranscriptParagraphData } from './paragraph-grouping';
import type { LiveTranscriptSegment, SpeakerConfig } from './types';
import type { ActiveWord } from './use-live-transcript';

export interface TranscriptParagraphProps {
  paragraph: TranscriptParagraphData;
  showWords?: boolean;
  showTimestamps?: boolean;
  showSpeakers?: boolean;
  showConfidence?: boolean;
  hasAudio?: boolean;
  activeWord?: ActiveWord | null;
  speakers?: Record<string, SpeakerConfig>;
  onWordSelect?: (segment: LiveTranscriptSegment, wordIndex: number) => void;
}

/**
 * Renders a group of adjacent, same-speaker segments (`paragraph-grouping.ts`)
 * as ONE flowing block: a single header sourced from the lead (first)
 * segment, then each member's text/word-tokens inline, joined with the same
 * seam-aware separator that assembles `paragraph.text` (so the seam a reader
 * sees always matches the seam the tested pure function would produce — never
 * "right?. Yes").
 *
 * Only ever handed a paragraph with more than one member — `LiveTranscript`
 * renders a single-member paragraph through the standalone `TranscriptSegment`
 * unchanged (same DOM, same editing affordance). Editing is intentionally out
 * of scope HERE: `onEditSegment` is keyed to one segment id, and grouping is
 * disabled outright while `editable` (see `use-live-transcript.ts`), so this
 * component never needs to expose an edit control.
 */
export function TranscriptParagraphView({
  paragraph,
  showWords,
  showTimestamps,
  showSpeakers = true,
  showConfidence,
  hasAudio,
  activeWord,
  speakers,
  onWordSelect,
}: TranscriptParagraphProps) {
  const lead = paragraph.segments[0];
  const speakerConfig = lead.speakerLabel ? speakers?.[lead.speakerLabel] : undefined;
  const speakerLabel = speakerConfig?.label ?? lead.speakerLabel;
  const timestamp = formatClock(lead.startTime);

  const combinedGloss = paragraph.segments.reduce<string | undefined>((acc, member) => {
    if (!member.englishText) return acc;
    return acc ? joinTranscriptFragments(acc, member.englishText) : member.englishText;
  }, undefined);

  return (
    <div
      data-slot="transcript-paragraph"
      data-final={paragraph.isFinal ? 'true' : 'false'}
      // Mirrors the standalone segment's rule: don't spam the live region
      // with every tentative-tail update, only the settled paragraph.
      aria-live={paragraph.isFinal ? undefined : 'off'}
      className="space-y-1 py-1.5"
    >
      {(showSpeakers && speakerLabel) || (showTimestamps && timestamp) || (showConfidence && lead.confidence != null) ? (
        <div className="flex items-center gap-2">
          {showSpeakers && speakerLabel ? (
            <span className={cn('text-xs font-medium', SPEAKER_TONE[speakerConfig?.colorRole ?? 'primary'])}>{speakerLabel}</span>
          ) : null}
          {showTimestamps && timestamp ? (
            <time className="text-xs tabular-nums text-muted-foreground" dateTime={`PT${Math.floor(lead.startTime ?? 0)}S`}>
              {timestamp}
            </time>
          ) : null}
          {showConfidence && lead.confidence != null ? (
            <Badge variant="outline" className="text-xs">
              {Math.round(lead.confidence * 100)}%
            </Badge>
          ) : null}
        </div>
      ) : null}

      {showWords ? (
        <p className="flex flex-wrap items-baseline gap-x-1 text-sm leading-relaxed">
          {paragraph.segments.map((member) =>
            member.wordTimestamps?.length ? (
              member.wordTimestamps.map((word, i) => (
                <TranscriptWord
                  key={`${member.id}-${i}`}
                  word={word}
                  interactive={!!hasAudio}
                  active={activeWord?.segmentId === member.id && activeWord.index === i}
                  label={hasAudio ? `Jump to ${formatClock(word.start)} — ${word.word}` : undefined}
                  onSelect={hasAudio ? () => onWordSelect?.(member, i) : undefined}
                />
              ))
            ) : (
              <span key={member.id} className={member.isFinal ? 'text-foreground' : 'italic text-muted-foreground'}>
                {member.text}
              </span>
            ),
          )}
        </p>
      ) : (
        <p className="text-sm leading-relaxed">
          {paragraph.segments.map((member, index) => (
            <MemberFragment key={member.id} member={member} previous={index > 0 ? paragraph.segments[index - 1] : undefined} />
          ))}
        </p>
      )}

      {combinedGloss ? <p className="text-xs italic text-muted-foreground">{combinedGloss}</p> : null}
    </div>
  );
}

/**
 * One member's inline text, seam-adjusted against the PREVIOUS member so the
 * rendered seam matches `joinTranscriptFragments` exactly (dropping a stray
 * duplicate leading terminator, inserting the joining space). `stableChars`
 * is shifted by whatever the seam adjustment skipped, so the settled/
 * tentative split still lands on the right characters of the DISPLAYED text.
 */
function MemberFragment({ member, previous }: { member: LiveTranscriptSegment; previous?: LiveTranscriptSegment }) {
  const { separator, skip } = previous ? seamAdjustment(previous.text, member.text) : { separator: '', skip: 0 };
  const displayText = member.text.slice(skip);
  const toneClass = member.isFinal ? 'text-foreground' : 'italic text-muted-foreground';

  // `adjustedStableChars` shifts the settled/tentative boundary by whatever
  // the seam adjustment skipped, so it still lands on the right characters of
  // `displayText`. The full condition is inlined in the ternary below (not
  // hoisted into a separate boolean) so TypeScript narrows it to `number` in
  // the true branch — matching `SegmentBody`'s own inline-`if` pattern in
  // `transcript-segment.tsx`.
  const adjustedStableChars = member.stableChars != null ? Math.max(0, member.stableChars - skip) : null;

  return (
    <span className={toneClass}>
      {separator}
      {!member.isFinal && adjustedStableChars != null && adjustedStableChars > 0 && adjustedStableChars < displayText.length ? (
        <>
          <span className="not-italic text-foreground">{displayText.slice(0, adjustedStableChars)}</span>
          <span>{displayText.slice(adjustedStableChars)}</span>
        </>
      ) : (
        displayText
      )}
    </span>
  );
}
