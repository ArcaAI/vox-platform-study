import { LANGUAGES, type AppConfig } from '../config';

interface ConnectionPanelProps {
  config: AppConfig;
  connected: boolean;
  onChange: (config: AppConfig) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function ConnectionPanel({ config, connected, onChange, onConnect, onDisconnect }: ConnectionPanelProps) {
  const canConnect = config.apiEndpoint.trim() !== '' && config.apiKey.trim() !== '' && config.pipelineId.trim() !== '';

  const set = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => onChange({ ...config, [key]: value });

  return (
    <section className="card">
      <h2>
        Connection <span className={connected ? 'badge on' : 'badge off'}>{connected ? 'connected' : 'disconnected'}</span>
      </h2>

      <div className="grid">
        <label>
          Gateway URL
          <input
            value={config.apiEndpoint}
            onChange={(e) => set('apiEndpoint', e.target.value)}
            placeholder="http://localhost:8868"
          />
        </label>

        <label>
          API key
          <input type="password" value={config.apiKey} onChange={(e) => set('apiKey', e.target.value)} placeholder="tenant SDK API key" />
        </label>

        <label>
          Pipeline ID
          <input value={config.pipelineId} onChange={(e) => set('pipelineId', e.target.value)} placeholder="ASR pipeline id (deprecated)" />
        </label>

        <label>
          ASR Agent slug
          <input
            value={config.sttAgentSlug}
            onChange={(e) => set('sttAgentSlug', e.target.value)}
            placeholder="published SPEECH_TO_TEXT agent — empty uses the tenant assignment"
          />
        </label>

        <label>
          Language
          <select value={config.language} onChange={(e) => set('language', e.target.value)}>
            {LANGUAGES.map((lang) => (
              <option key={lang.id} value={lang.id}>
                {lang.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="row">
        {connected ? (
          <button onClick={onDisconnect}>Disconnect</button>
        ) : (
          <button className="primary" onClick={onConnect} disabled={!canConnect}>
            Connect
          </button>
        )}
        {!connected && !canConnect ? <span className="muted">Gateway URL, API key and pipeline ID are required.</span> : null}
      </div>
    </section>
  );
}
