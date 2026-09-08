import { useState } from 'react';
import { ArcaCompatProvider } from '@arcaai/vox/compat';
import { ConnectionPanel } from './components/ConnectionPanel';
import { LiveTranscription } from './components/LiveTranscription';
import { BatchUpload } from './components/BatchUpload';
import { loadConfig, saveConfig, websocketUrlFor, type AppConfig } from './config';

export function App() {
  const [config, setConfig] = useState<AppConfig>(loadConfig);
  // The provider reads its options ONCE at mount, so "connected" is literally
  // "the provider is mounted with these values" — editing the form disconnects.
  const [connected, setConnected] = useState<AppConfig | null>(null);

  const connect = () => {
    saveConfig(config);
    setConnected(config);
  };

  return (
    <main>
      <header>
        <h1>Quick Compat App</h1>
        <p>
          A minimal <code>@arcaai/vox/compat</code> consumer: connect, transcribe live, and upload files for batch
          transcription.
        </p>
      </header>

      <ConnectionPanel
        config={config}
        connected={connected !== null}
        onChange={(next) => {
          setConfig(next);
          setConnected(null);
        }}
        onConnect={connect}
        onDisconnect={() => setConnected(null)}
      />

      {connected ? (
        <ArcaCompatProvider
          // Remount the whole SDK tree whenever the connection identity changes.
          key={`${connected.apiEndpoint}|${connected.apiKey}|${connected.pipelineId}`}
          options={{
            apiEndpoint: connected.apiEndpoint,
            websocketUrl: websocketUrlFor(connected.apiEndpoint),
            credentials: { apiKey: connected.apiKey },
            sttAgentSlug: connected.sttAgentSlug,
            environment: 'development',
            // Required for the BIDIRECTIONAL provider switch. Without it the
            // SDK can only switch one way (pipeline → tenant default), and
            // switching back rejects with SWITCH_FAILED — the native streaming
            // route has no primary-direction endpoint.
            enableProviderSwitch: true,
          }}
        >
          <div className="panels">
            <LiveTranscription pipelineId={connected.pipelineId} sttAgentSlug={connected.sttAgentSlug} language={connected.language} />
            <BatchUpload pipelineId={connected.pipelineId} language={connected.language} />
          </div>
        </ArcaCompatProvider>
      ) : (
        <section className="card muted">Connect to the gateway to enable transcription.</section>
      )}
    </main>
  );
}
