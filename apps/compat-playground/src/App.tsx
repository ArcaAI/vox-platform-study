import { useMemo, useState } from 'react';
import { ArcaCompatProvider, type V1SdkConfig } from '@arcaai/vox/compat';
import { Alert, AlertDescription, AlertTitle, Button, Card, CardContent, Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui';
import { Toaster } from 'sonner';
import { BatchUploadTab } from './components/BatchUploadTab';
import { ConnectionTab } from './components/ConnectionTab';
import { LiveTranscriptionTab } from './components/LiveTranscriptionTab';
import { SummarizationTab } from './components/SummarizationTab';
import { PlaygroundSessionProvider } from './context/playground-session';
import { clearStoredConfig, saveStoredConfig, type PlaygroundConfig } from './lib/config-store';
import { useTheme } from './lib/use-theme';

type ConsoleTab = 'connection' | 'live-transcription' | 'batch-upload' | 'summarization';

/** The reason the session tabs are disabled before connecting — shown, never implied. */
const GATE_REASON = 'Connect on the Connection tab to enable Live transcription, Batch upload and Summarization.';

function toCompatOptions(config: PlaygroundConfig): V1SdkConfig {
  const apiEndpoint = config.apiEndpoint.trim().replace(/\/+$/, '');
  return {
    apiEndpoint,
    websocketUrl: apiEndpoint.replace(/^http/, 'ws'),
    credentials: { apiKey: config.apiKey.trim() },
    tenantId: config.tenantId.trim() || undefined,
    sttPipelineId: config.pipelineId.trim() || undefined,
    // Browser capture-graph stages. Stated EXPLICITLY in both
    // directions rather than omitted: the adapter's output replaces
    // `DEFAULT_AUDIO_CONFIG` outright, so an omitted key silently means "off"
    // and there would be no way to turn either stage back on. `false/false`
    // reproduces the pre-597 effective behaviour exactly.
    audioSettings: {
      noiseSuppression: config.noiseSuppression ?? false,
      voiceActivityDetection: config.voiceActivityDetection ?? false,
    },
    // Enables the ON/OFF STT provider toggle (ProviderToggle.tsx).
    enableProviderSwitch: true,
  };
}

/** Placeholder body for a session tab that is rendered (forceMount) but not usable yet. */
function NotConnectedPanel({ what }: { what: string }) {
  return (
    <Card>
      <CardContent className="text-muted-foreground py-12 text-center text-sm">{what} becomes available once the console is connected.</CardContent>
    </Card>
  );
}

export function App() {
  const [connected, setConnected] = useState<PlaygroundConfig | null>(null);
  const [tab, setTab] = useState<ConsoleTab>('connection');
  const [theme, toggleTheme] = useTheme();

  const handleConnect = (config: PlaygroundConfig) => {
    saveStoredConfig(config);
    setConnected(config);
  };

  const handleDisconnect = () => {
    setConnected(null);
    // The session tabs are about to become disabled — never strand the user
    // on a tab they can no longer interact with.
    setTab('connection');
  };

  // `<ArcaCompatProvider>` reads its config once on mount, but a fresh options
  // object on every keystroke/tab switch is still needless churn — and the
  // provider is the one thing in this tree that must not be disturbed.
  const compatOptions = useMemo(() => (connected ? toCompatOptions(connected) : null), [connected]);

  // ---------------------------------------------------------------------------
  // The four-tab console.
  //
  // Two invariants hold this together and are easy to break by accident:
  //
  //  1. EVERY `<TabsContent>` is `forceMount` + `data-[state=inactive]:hidden`.
  //     Radix unmounts inactive panels by default; the Live-transcription panel
  //     owns nothing stateful itself, but unmounting it would tear down the
  //     transcript view mid-stream and any child a later lane adds there.
  //  2. Session state does NOT live in a tab. It lives in
  //     `<PlaygroundSessionProvider>`, mounted below — inside the SDK provider
  //     and outside `<Tabs>` — so switching tabs cannot touch it.
  // ---------------------------------------------------------------------------
  const consoleTabs = (
    <Tabs value={tab} onValueChange={(next) => setTab(next as ConsoleTab)} className="flex flex-1 flex-col gap-4 px-6 py-4">
      <div className="flex flex-col gap-2">
        <TabsList variant="line" className="self-start">
          <TabsTrigger value="connection">Connection</TabsTrigger>
          {/* `disabled` + a visible reason below — a silently dead control is a
              WCAG/UX failure, so the gate is always spelled out on screen. */}
          <TabsTrigger value="live-transcription" disabled={!connected}>
            Live transcription
          </TabsTrigger>
          <TabsTrigger value="batch-upload" disabled={!connected}>
            Batch upload
          </TabsTrigger>
          <TabsTrigger value="summarization" disabled={!connected}>
            Summarization
          </TabsTrigger>
        </TabsList>

        {!connected ? (
          <Alert>
            <AlertTitle>Three tabs are locked</AlertTitle>
            <AlertDescription>{GATE_REASON}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <TabsContent value="connection" forceMount data-testid="connection-panel" className="mx-auto w-full max-w-[72rem] data-[state=inactive]:hidden">
        <ConnectionTab connectedConfig={connected} onConnect={handleConnect} onDisconnect={handleDisconnect} onForget={clearStoredConfig} />
      </TabsContent>

      <TabsContent
        value="live-transcription"
        forceMount
        data-testid="live-transcription-panel"
        className="mx-auto w-full max-w-[110rem] data-[state=inactive]:hidden"
      >
        {connected ? <LiveTranscriptionTab /> : <NotConnectedPanel what="Live transcription" />}
      </TabsContent>

      {/* `forceMount` is load-bearing here beyond the shared invariant: a batch
          upload runs for minutes and its SSE result stream must not be torn
          down by switching to another tab. (The queue itself lives in
          `<PlaygroundSessionProvider>` for the same reason.) */}
      <TabsContent
        value="batch-upload"
        forceMount
        data-testid="batch-upload-panel"
        className="mx-auto w-full max-w-[110rem] data-[state=inactive]:hidden"
      >
        {connected ? <BatchUploadTab /> : <NotConnectedPanel what="Batch upload" />}
      </TabsContent>

      <TabsContent
        value="summarization"
        forceMount
        data-testid="summarization-panel"
        className="mx-auto w-full max-w-[110rem] data-[state=inactive]:hidden"
      >
        {connected ? <SummarizationTab /> : <NotConnectedPanel what="Summarization" />}
      </TabsContent>
    </Tabs>
  );

  return (
    <div className="flex min-h-svh flex-col">
      {/* `theme="system"` — sonner's own OS-theme detection, no next-themes dependency needed. */}
      <Toaster theme="system" richColors closeButton />

      <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">HOPE compat playground</h1>
          <p className="text-muted-foreground text-sm">
            A v1&rarr;v2 developer console on <code className="font-mono text-xs">@arcaai/vox/compat</code>.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={toggleTheme}>
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </Button>
      </header>

      {/* The ONE mount point for the SDK provider. Remounting it creates a new
          Zustand store and kills the live session, so it is deliberately not
          nested inside anything that re-keys — and the session provider sits
          directly under it, above the tabs. */}
      {connected && compatOptions ? (
        <ArcaCompatProvider options={compatOptions}>
          <PlaygroundSessionProvider config={connected}>{consoleTabs}</PlaygroundSessionProvider>
        </ArcaCompatProvider>
      ) : (
        consoleTabs
      )}
    </div>
  );
}
