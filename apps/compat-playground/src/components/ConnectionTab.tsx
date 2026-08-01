import { useState, type ChangeEvent } from 'react';
import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Input, Label } from '@arcaai/ui';
import { defaultConfig, type PlaygroundConfig } from '../lib/config-store';
import { PipelinePicker } from './PipelinePicker';
import { CONNECTION_EXAMPLE_FILES, TabExampleCode } from './TabExampleCode';

interface ConnectionTabProps {
  /** The live-connected config, or `null` when disconnected. Drives read-only vs editable. */
  connectedConfig: PlaygroundConfig | null;
  onConnect: (config: PlaygroundConfig) => void;
  onDisconnect: () => void;
  onForget: () => void;
}

const FIELDS: Array<{
  key: keyof PlaygroundConfig;
  label: string;
  placeholder: string;
  hint: string;
  required?: boolean;
  secret?: boolean;
}> = [
  {
    key: 'apiEndpoint',
    label: 'API endpoint',
    placeholder: 'http://localhost:8868',
    hint: 'REST origin of the v2 gateway. The WebSocket URL is derived from it (http → ws).',
    required: true,
  },
  {
    key: 'apiKey',
    label: 'API key',
    placeholder: 'tenant SDK API key',
    hint: 'Tenant SDK key, sent as `x-api-key`. Stored in localStorage only — never in the URL.',
    required: true,
    secret: true,
  },
  {
    key: 'tenantId',
    label: 'Tenant ID',
    placeholder: '50000000-0000-0000-0000-000000000000',
    hint: 'Optional. Only needed when the key is not already bound to a single tenant.',
  },
  {
    key: 'pipelineId',
    label: 'Pipeline ID',
    placeholder: 'streaming pipeline id — enables the ON/pipeline state',
    hint: 'Streaming STT pipeline to run. Leave empty to use the tenant default provider.',
  },
];

/**
 * Tab 1 — configuration + Connect.
 *
 * Editable while disconnected; once `<ArcaCompatProvider>` is mounted (connected),
 * the fields switch to a read-only summary and the button becomes Disconnect —
 * editing credentials mid-session would require remounting the provider, which
 * drops the SDK store and kills any live session, so we gate it behind an
 * explicit disconnect.
 *
 * Promoted from the old narrow `ConfigColumn` to a full-width page: the fields
 * flow in a responsive two-column grid with a per-field hint, and the actions
 * sit in the card footer.
 */
export function ConnectionTab({ connectedConfig, onConnect, onDisconnect, onForget }: ConnectionTabProps) {
  const [draft, setDraft] = useState<PlaygroundConfig>(() => defaultConfig());
  const connected = connectedConfig !== null;
  const view = connectedConfig ?? draft;
  const canConnect = draft.apiEndpoint.trim() !== '' && draft.apiKey.trim() !== '';

  const update = (field: keyof PlaygroundConfig) => (event: ChangeEvent<HTMLInputElement>) =>
    setDraft((prev) => ({ ...prev, [field]: event.target.value }));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Connection
            {connected ? <Badge variant="default">connected</Badge> : <Badge variant="outline">disconnected</Badge>}
          </CardTitle>
          <CardDescription>
            Tenant SDK credentials mapped into a <code className="font-mono text-xs">V1SdkConfig</code> and handed to{' '}
            <code className="font-mono text-xs">&lt;ArcaCompatProvider&gt;</code>. Persisted to localStorage only — never the URL.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {FIELDS.map((field) => (
            <div key={field.key} className="flex flex-col gap-2">
              <Label htmlFor={`config-${field.key}`}>
                {field.label}
                {field.required ? ' *' : ''}
              </Label>
              {field.key === 'pipelineId' ? (
                // Real tenant pipelines, not a hand-typed id — falls back to the
                // free-text input on 401/403/empty/network error (G1).
                <PipelinePicker
                  id={`config-${field.key}`}
                  apiEndpoint={view.apiEndpoint}
                  apiKey={view.apiKey}
                  value={view.pipelineId}
                  onChange={(v) => setDraft((prev) => ({ ...prev, pipelineId: v }))}
                  disabled={connected}
                  placeholder={field.placeholder}
                  aria-describedby={`config-${field.key}-hint`}
                />
              ) : (
                <Input
                  id={`config-${field.key}`}
                  type={field.secret && !connected ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  value={connected && field.secret ? '••••••••' : view[field.key]}
                  onChange={update(field.key)}
                  disabled={connected}
                  autoComplete="off"
                  aria-describedby={`config-${field.key}-hint`}
                />
              )}
              <p id={`config-${field.key}-hint`} className="text-muted-foreground text-xs">
                {field.hint}
              </p>
            </div>
          ))}
        </CardContent>

        <CardFooter className="flex flex-wrap items-center gap-2">
          {connected ? (
            <>
              <Button variant="outline" onClick={onDisconnect}>
                Disconnect
              </Button>
              <span className="text-muted-foreground text-xs">
                Disconnecting unmounts the SDK provider and ends any live session. Connect again to edit these fields.
              </span>
            </>
          ) : (
            <>
              <Button disabled={!canConnect} onClick={() => onConnect(draft)}>
                Connect
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onForget();
                  setDraft({ apiEndpoint: '', apiKey: '', tenantId: '', pipelineId: '', languageMode: '' });
                }}
              >
                Forget saved config
              </Button>
              {!canConnect ? <span className="text-muted-foreground text-xs">An API endpoint and an API key are required to connect.</span> : null}
            </>
          )}
        </CardFooter>
      </Card>

      {/* R2 — the tab ends with its own source, nothing from the other two tabs. */}
      <TabExampleCode
        files={CONNECTION_EXAMPLE_FILES}
        description="How the form's four values become a V1SdkConfig and reach <ArcaCompatProvider>, and how the pipeline list is fetched."
      />
    </div>
  );
}
