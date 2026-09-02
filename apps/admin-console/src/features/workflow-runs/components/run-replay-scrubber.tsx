'use client';

import { useEffect, useState } from 'react';
import { IconPlayerPause, IconPlayerPlay, IconPlayerSkipBack, IconPlayerSkipForward, IconPlayerTrackNext, IconPlayerTrackPrev } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Slider } from '@arcaai/ui/components/shadcn/slider';

/** Fixed pacing for auto-play. This is an ORDERED WALK-THROUGH of the durable step sequence,
 *  not a timestamp-accurate reproduction of the run's real wall-clock pacing — a fixed interval
 *  is the honest, simple choice; it never claims to replay real timing. */
const AUTO_ADVANCE_MS = 900;

/**
 * Replay/scrub for a COMPLETED run (TASK-849 lane C, step 7). "Free" per the ticket: it reads
 * only the durable REST trace (`RunNodeRollup[]`, already fetched by `useRunTrace`) already on
 * screen — no additional live connection, no new endpoint. `step` is the count of trace steps
 * REVEALED so far, in `order`; the caller slices its own node/rollup list to `step` and feeds
 * the truncated set through the same correlation + canvas-problem pipeline the live view uses,
 * so scrubbing back genuinely hides later nodes rather than merely dimming them.
 *
 * Every control is a real, individually-labelled `<button>`/`Slider` (Radix, native keyboard
 * support) — there is no drag-only affordance, so this satisfies WCAG 2.5.7's single-pointer
 * requirement for free.
 */
export function RunReplayScrubber({
  totalSteps,
  step,
  onStepChange,
  stepLabel,
}: {
  /** Total steps in the trace being replayed (the scrub range's upper bound). */
  totalSteps: number;
  /** Steps revealed so far, `0..totalSteps`. */
  step: number;
  onStepChange: (step: number) => void;
  /** Human label for the step at the current boundary (e.g. "Extract entities") — read by the
   *  `aria-live` position text so a screen-reader user knows WHAT stepping past means, never
   *  inferred from the canvas's colour alone (rule 11 §7). */
  stepLabel?: string | null;
}) {
  const [playing, setPlaying] = useState(false);
  const atStart = step <= 0;
  const atEnd = step >= totalSteps;

  useEffect(() => {
    if (!playing) return;
    if (atEnd) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => onStepChange(Math.min(step + 1, totalSteps)), AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [playing, step, totalSteps, atEnd, onStepChange]);

  function stepTo(next: number) {
    setPlaying(false);
    onStepChange(Math.max(0, Math.min(next, totalSteps)));
  }

  return (
    <div role="group" aria-label="Replay this run" className="flex flex-wrap items-center gap-2 rounded-md border p-2">
      <Button type="button" variant="outline" size="icon-sm" aria-label="Jump to start" disabled={atStart} onClick={() => stepTo(0)}>
        <IconPlayerTrackPrev aria-hidden />
      </Button>
      <Button type="button" variant="outline" size="icon-sm" aria-label="Previous step" disabled={atStart} onClick={() => stepTo(step - 1)}>
        <IconPlayerSkipBack aria-hidden />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={playing ? 'Pause replay' : 'Play replay'}
        aria-pressed={playing}
        disabled={atEnd && !playing}
        onClick={() => setPlaying((current) => !current)}
      >
        {playing ? <IconPlayerPause aria-hidden /> : <IconPlayerPlay aria-hidden />}
      </Button>
      <Button type="button" variant="outline" size="icon-sm" aria-label="Next step" disabled={atEnd} onClick={() => stepTo(step + 1)}>
        <IconPlayerSkipForward aria-hidden />
      </Button>
      <Button type="button" variant="outline" size="icon-sm" aria-label="Jump to end" disabled={atEnd} onClick={() => stepTo(totalSteps)}>
        <IconPlayerTrackNext aria-hidden />
      </Button>
      <div className="min-w-40 flex-1 px-1">
        <Slider aria-label="Replay position" min={0} max={totalSteps} step={1} value={[step]} onValueChange={([next]) => stepTo(next ?? step)} />
      </div>
      <span className="text-muted-foreground min-w-0 shrink-0 font-mono text-xs tabular-nums" aria-live="polite">
        Step {step} / {totalSteps}
        {stepLabel ? ` — ${stepLabel}` : ''}
      </span>
    </div>
  );
}
