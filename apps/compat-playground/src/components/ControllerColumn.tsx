import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, SttLanguageModePicker } from '@arcaai/ui';
import { ProviderToggle } from './ProviderToggle';
import { DrainSettings } from './DrainSettings';
import { MetadataSimulator } from './MetadataSimulator';
import { usePlaygroundSession } from '../context/playground-session';

/**
 * The controls column of the Live-transcription tab. Everything the operator
 * drives during a session: the STT language mode, the ON/OFF pipeline-vs-default
 * engine toggle, the start/stop recording controls, and the metadata simulator
 * (`MetadataSimulator`,). Read-side output lives in
 * `TranscriptColumn` next to it.
 *
 * Props-free by design: every value comes from `usePlaygroundSession()`, which
 * lives ABOVE the tabs so the session survives tab switches. Lane E takes
 * ownership of the engine/pipeline controls from here; the remaining card
 * contents are unchanged from the pre-tab-split version.
 */
export function ControllerColumn() {
  const { session, capture, transcript, language } = usePlaygroundSession();

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            Session
            <Badge variant="outline">{session.status}</Badge>
          </CardTitle>
          <CardDescription>
            <span className="font-mono text-xs">{session.id ?? '—'}</span>
          </CardDescription>
        </CardHeader>
        {session.error || transcript.error ? (
          <CardContent className="flex flex-col gap-1">
            {session.error ? <p className="text-destructive text-sm">Session error: {session.error}</p> : null}
            {transcript.error ? <p className="text-destructive text-sm">STT error: {transcript.error}</p> : null}
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Language</CardTitle>
          <CardDescription>
            From <code className="font-mono text-xs">useArcaSttLanguageModes()</code>  — falls back to a static list when the catalog is
            empty. Pick before you start.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SttLanguageModePicker
            label="STT language mode"
            modes={language.modes}
            value={language.mode}
            onValueChange={language.setMode}
            disabled={capture.isRecording}
          />
          {language.catalogError ? (
            <p className="text-muted-foreground mt-2 text-xs">Catalog fetch failed ({language.catalogError}) — showing the static fallback list.</p>
          ) : null}
        </CardContent>
      </Card>

      {/* ON = SDK-configured pipeline, OFF = tenant default provider — mid-session, no reconnect. */}
      <ProviderToggle />

      <Card>
        <CardHeader>
          <CardTitle>Recording</CardTitle>
          <CardDescription>
            Mic capture via <code className="font-mono text-xs">useAudioCapture</code>, session via{' '}
            <code className="font-mono text-xs">useArcaSessionManager</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            {/* Start stays disabled through `stopping` too: the mic is already
                released during the drain, so `isRecording` alone would re-arm
                Start on top of a half-closed session. */}
            <Button onClick={capture.start} disabled={capture.phase !== 'idle'}>
              {capture.isStarting ? 'Starting…' : 'Start consultation'}
            </Button>
            <Button variant="outline" onClick={capture.stop} disabled={capture.phase !== 'recording'}>
              {capture.phase === 'stopping' ? 'Finalizing…' : 'Stop'}
            </Button>
          </div>
          {capture.phase === 'stopping' ? (
            // Not colour-only and not a spinner-with-no-words: the mic really is
            // off already, and late final lines really are still arriving.
            <p className="text-muted-foreground text-xs" role="status">
              Microphone released. Finalizing the transcript — the last lines are still arriving.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* Per-capture stop-drain knobs — directly under Recording, because that
          is the button whose behaviour they change. */}
      <DrainSettings />

      <MetadataSimulator />
    </div>
  );
}
