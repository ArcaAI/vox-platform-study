import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@arcaai/ui';
import { usePlaygroundSession } from '../context/playground-session';

/**
 * Stop-drain controls.
 *
 * WHY THESE LIVE HERE, and not on the Connection tab: they are
 * `AudioStartOptions` fields, read on every `startRecording()`. A developer can
 * change them between two runs of the same session without remounting
 * `<ArcaCompatProvider>`. Noise suppression and VAD are the opposite — they are
 * baked into the provider config at mount — so they stay on the Connection tab.
 *
 * WHAT THEY FIX: when Stop is clicked the SDK sends a finalize frame and keeps
 * the socket open so a tail final can still land. That wait ends on whichever
 * comes first — the server's terminal status, `quietWindowMs` of silence after
 * `finalizing`, or `drainTimeoutMs`. On a slow ASR pipeline the backend reports
 * `finalizing` within milliseconds but publishes the last transcript SECONDS
 * later, so the 250 ms default quiet window closes the socket first and the
 * tail final never reaches the browser. Raising the timeout alone does not help
 * — the quiet window fires before it.
 */
export function DrainSettings() {
  const { drain, capture } = usePlaygroundSession();

  const locked = capture.phase !== 'idle';
  const isDefault = drain.timeoutMs === undefined && drain.quietWindowMs === undefined;
  const waitsForTailFinal = drain.quietWindowMs === 0;

  /** Empty input ⇒ `undefined` ⇒ the SDK default. `0` is kept as a real value. */
  const parse = (raw: string): number | undefined => {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          Stop drain
          {isDefault ? <Badge variant="outline">SDK defaults</Badge> : <Badge variant="secondary">custom</Badge>}
        </CardTitle>
        <CardDescription>
          How long the STT socket stays open after Stop so a late final transcript can still land. Passed per capture via{' '}
          <code className="font-mono text-xs">useAudioCapture(&#123; drainTimeoutMs, quietWindowMs &#125;)</code>. Leave both empty for the SDK
          defaults (1500 ms / 250 ms).
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="drain-timeout">Drain timeout (ms)</Label>
            <Input
              id="drain-timeout"
              type="number"
              min={0}
              step={100}
              inputMode="numeric"
              placeholder="1500 (SDK default)"
              value={drain.timeoutMs ?? ''}
              onChange={(event) => drain.setTimeoutMs(parse(event.target.value))}
              disabled={locked}
              aria-describedby="drain-timeout-hint"
            />
            <p id="drain-timeout-hint" className="text-muted-foreground text-xs">
              Hard ceiling on the wait. Only reached when no terminal status arrives at all.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="drain-quiet-window">Quiet window (ms)</Label>
            <Input
              id="drain-quiet-window"
              type="number"
              min={0}
              step={50}
              inputMode="numeric"
              placeholder="250 (SDK default)"
              value={drain.quietWindowMs ?? ''}
              onChange={(event) => drain.setQuietWindowMs(parse(event.target.value))}
              disabled={locked}
              aria-describedby="drain-quiet-window-hint"
            />
            <p id="drain-quiet-window-hint" className="text-muted-foreground text-xs">
              Silence after <code className="font-mono text-xs">finalizing</code> that ends the drain early. Enter <strong>0</strong> to disable the
              early resolve and wait for the server&apos;s terminal status.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={drain.applyWaitForTailFinal} disabled={locked}>
            Wait for tail final
          </Button>
          <Button variant="ghost" size="sm" onClick={drain.resetToDefaults} disabled={locked || isDefault}>
            Reset to defaults
          </Button>
          {locked ? (
            <span className="text-muted-foreground text-xs">Applied on the next Start — stop the current capture to change them.</span>
          ) : null}
        </div>

        {waitsForTailFinal ? (
          // Text + a badge, never colour alone. `role="note"` (not `Alert`'s
          // default `role="alert"`): this describes a setting the user just
          // chose, so an assertive interruption would be wrong.
          <Alert role="note">
            <AlertTitle>Waiting for the tail final</AlertTitle>
            <AlertDescription>
              The early resolve is off, so Stop keeps the socket open until the backend publishes its terminal status (or the timeout above). The
              microphone is still released immediately — only the transcript keeps arriving. This is the setting an accuracy run needs; without it the
              last utterance of every clip is silently dropped.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
