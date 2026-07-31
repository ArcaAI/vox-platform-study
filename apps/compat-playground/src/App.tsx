import { useState } from 'react';
import { ArcaCompatProvider, type V1SdkConfig } from '@arcaai/vox/compat';
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui';
import { Toaster } from 'sonner';
import { ConfigColumn } from './components/ConfigColumn';
import { SessionWorkspace } from './components/SessionWorkspace';
import { DisconnectedColumns } from './components/DisconnectedColumns';
import { ExampleCode } from './components/ExampleCode';
import { clearStoredConfig, saveStoredConfig, type PlaygroundConfig } from './lib/config-store';
import { useTheme } from './lib/use-theme';

function toCompatOptions(config: PlaygroundConfig): V1SdkConfig {
  const apiEndpoint = config.apiEndpoint.trim().replace(/\/+$/, '');
  return {
    apiEndpoint,
    websocketUrl: apiEndpoint.replace(/^http/, 'ws'),
    credentials: { apiKey: config.apiKey.trim() },
    tenantId: config.tenantId.trim() || undefined,
    sttPipelineId: config.pipelineId.trim() || undefined,
    // Enables the ON/OFF STT provider toggle (ProviderToggle.tsx).
    enableProviderSwitch: true,
  };
}

export function App() {
  const [connected, setConnected] = useState<PlaygroundConfig | null>(null);
  const [theme, toggleTheme] = useTheme();

  const handleConnect = (config: PlaygroundConfig) => {
    saveStoredConfig(config);
    setConnected(config);
  };

  return (
    <div className="flex min-h-svh flex-col">
      {/* `theme="system"` — sonner's own OS-theme detection, no next-themes dependency needed. */}
      <Toaster theme="system" richColors closeButton />

      <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">HOPE compat playground</h1>
          <p className="text-muted-foreground text-sm">
            A v1&rarr;v2 live-transcription demo on <code className="font-mono text-xs">@arcaai/vox/compat</code>.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={toggleTheme}>
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </Button>
      </header>

      <Tabs defaultValue="playground" className="flex flex-1 flex-col gap-4 px-6 py-4">
        <TabsList variant="line" className="self-start">
          <TabsTrigger value="playground">Playground</TabsTrigger>
          <TabsTrigger value="example">Example code</TabsTrigger>
        </TabsList>

        {/* forceMount keeps the live session alive when the user peeks at the code tab. */}
        <TabsContent value="playground" forceMount className="mx-auto w-full max-w-[110rem] data-[state=inactive]:hidden">
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,20rem)_minmax(0,26rem)_minmax(0,1fr)]">
            <ConfigColumn
              connectedConfig={connected}
              onConnect={handleConnect}
              onDisconnect={() => setConnected(null)}
              onForget={clearStoredConfig}
            />
            {connected ? (
              <ArcaCompatProvider options={toCompatOptions(connected)}>
                <SessionWorkspace config={connected} />
              </ArcaCompatProvider>
            ) : (
              <DisconnectedColumns />
            )}
          </div>
        </TabsContent>

        <TabsContent value="example" className="mx-auto w-full max-w-[80rem]">
          <ExampleCode />
        </TabsContent>
      </Tabs>
    </div>
  );
}
