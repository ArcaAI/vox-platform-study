import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CodeEditor,
  Input,
  Label,
  SttLanguageModePicker,
  type SttLanguageModeOption,
} from '@arcaai/ui';
import { ProviderToggle } from './ProviderToggle';

interface ControllerColumnProps {
  // Session status
  sessionId: string | undefined;
  sessionStatus: string;
  sessionError: string | null;
  sttError: string | null;

  // Language
  modes: SttLanguageModeOption[];
  languageMode: string;
  onLanguageModeChange: (modeId: string) => void;
  catalogError: string | null;

  // Recording
  isRecording: boolean;
  isStarting: boolean;
  onStart: () => void;
  onStop: () => void;

  // Metadata simulation
  simSpeakerId: string;
  onSimSpeakerIdChange: (v: string) => void;
  simLanguage: string;
  onSimLanguageChange: (v: string) => void;
  simMetadataJson: string;
  onSimMetadataJsonChange: (v: string) => void;
  onSendMetadata: () => void;
  lastSentMetadata: Record<string, unknown> | null;
}

/**
 * Column 2 — the controller. Everything the operator drives during a session:
 * the STT language mode, the ON/OFF pipeline-vs-default engine toggle, the
 * start/stop recording controls, and the metadata simulator. Read-side output
 * lives in the transcript column (col 3).
 */
export function ControllerColumn({
  sessionId,
  sessionStatus,
  sessionError,
  sttError,
  modes,
  languageMode,
  onLanguageModeChange,
  catalogError,
  isRecording,
  isStarting,
  onStart,
  onStop,
  simSpeakerId,
  onSimSpeakerIdChange,
  simLanguage,
  onSimLanguageChange,
  simMetadataJson,
  onSimMetadataJsonChange,
  onSendMetadata,
  lastSentMetadata,
}: ControllerColumnProps) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            Session
            <Badge variant="outline">{sessionStatus}</Badge>
          </CardTitle>
          <CardDescription>
            <span className="font-mono text-xs">{sessionId ?? '—'}</span>
          </CardDescription>
        </CardHeader>
        {sessionError || sttError ? (
          <CardContent className="flex flex-col gap-1">
            {sessionError ? <p className="text-destructive text-sm">Session error: {sessionError}</p> : null}
            {sttError ? <p className="text-destructive text-sm">STT error: {sttError}</p> : null}
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Language</CardTitle>
          <CardDescription>
            From <code className="font-mono text-xs">useArcaSttLanguageModes()</code> (TASK-587) — falls back to a static list when the
            catalog is empty. Pick before you start.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SttLanguageModePicker
            label="STT language mode"
            modes={modes}
            value={languageMode}
            onValueChange={onLanguageModeChange}
            disabled={isRecording}
          />
          {catalogError ? (
            <p className="text-muted-foreground mt-2 text-xs">Catalog fetch failed ({catalogError}) — showing the static fallback list.</p>
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
        <CardContent className="flex gap-2">
          <Button onClick={onStart} disabled={isStarting || isRecording}>
            {isStarting ? 'Starting…' : 'Start consultation'}
          </Button>
          <Button variant="outline" onClick={onStop} disabled={isStarting || !isRecording}>
            Stop
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Simulate metadata</CardTitle>
          <CardDescription>
            TASK-564 client-side passthrough: <code className="font-mono text-xs">sendAudioData</code> tags the current turn; the same keys
            round-trip onto the next transcript line (see col 3).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="sim-speaker-id">speaker_id</Label>
              <Input id="sim-speaker-id" placeholder="doctor" value={simSpeakerId} onChange={(e) => onSimSpeakerIdChange(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="sim-language">language</Label>
              <Input id="sim-language" placeholder="en" value={simLanguage} onChange={(e) => onSimLanguageChange(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sim-metadata-json">Additional metadata (JSON object)</Label>
            <CodeEditor
              aria-label="Additional metadata JSON"
              value={simMetadataJson}
              onChange={onSimMetadataJsonChange}
              language="json"
              className="h-28"
            />
          </div>
          <Button onClick={onSendMetadata} disabled={isStarting || !isRecording} className="self-start">
            Send metadata
          </Button>
          {lastSentMetadata ? (
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs font-medium">Last sent</p>
              <pre className="bg-muted mt-1 overflow-x-auto rounded p-2 font-mono text-xs">{JSON.stringify(lastSentMetadata, null, 2)}</pre>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
