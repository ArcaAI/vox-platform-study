import { useState, type ChangeEvent } from 'react';
import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Input, Label } from '@arcaai/ui';
import { defaultConfig, type PlaygroundConfig } from '../lib/config-store';

interface ConfigColumnProps {
  /** The live-connected config, or `null` when disconnected. Drives read-only vs editable. */
  connectedConfig: PlaygroundConfig | null;
  onConnect: (config: PlaygroundConfig) => void;
  onDisconnect: () => void;
  onForget: () => void;
}

const FIELDS: Array<{ key: keyof PlaygroundConfig; label: string; placeholder: string; required?: boolean; secret?: boolean }> = [
  { key: 'apiEndpoint', label: 'API endpoint', placeholder: 'http://localhost:8868', required: true },
  { key: 'apiKey', label: 'API key', placeholder: 'tenant SDK API key', required: true, secret: true },
  { key: 'tenantId', label: 'Tenant ID', placeholder: '50000000-0000-0000-0000-000000000000' },
  { key: 'pipelineId', label: 'Pipeline ID', placeholder: 'streaming pipeline id — enables the ON/pipeline state' },
];

/**
 * Column 1 — configuration + Connect.
 *
 * Editable while disconnected; once `<ArcaCompatProvider>` is mounted (connected),
 * the fields switch to a read-only summary and the button becomes Disconnect —
 * editing credentials mid-session would require remounting the provider, so we
 * gate it behind an explicit disconnect.
 */
export function ConfigColumn({ connectedConfig, onConnect, onDisconnect, onForget }: ConfigColumnProps) {
  const [draft, setDraft] = useState<PlaygroundConfig>(() => defaultConfig());
  const connected = connectedConfig !== null;
  const view = connectedConfig ?? draft;
  const canConnect = draft.apiEndpoint.trim() !== '' && draft.apiKey.trim() !== '';

  const update = (field: keyof PlaygroundConfig) => (event: ChangeEvent<HTMLInputElement>) =>
    setDraft((prev) => ({ ...prev, [field]: event.target.value }));

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Configuration
          {connected ? <Badge variant="default">connected</Badge> : <Badge variant="outline">disconnected</Badge>}
        </CardTitle>
        <CardDescription>
          Tenant SDK credentials mapped into a <code className="font-mono text-xs">V1SdkConfig</code>. Persisted to localStorage only —
          never the URL.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {FIELDS.map((field) => (
          <div key={field.key} className="flex flex-col gap-2">
            <Label htmlFor={`config-${field.key}`}>
              {field.label}
              {field.required ? ' *' : ''}
            </Label>
            <Input
              id={`config-${field.key}`}
              type={field.secret && !connected ? 'password' : 'text'}
              placeholder={field.placeholder}
              value={connected && field.secret ? '••••••••' : view[field.key]}
              onChange={update(field.key)}
              disabled={connected}
              autoComplete="off"
            />
          </div>
        ))}
      </CardContent>
      <CardFooter className="flex flex-col gap-2">
        {connected ? (
          <Button className="w-full" variant="outline" onClick={onDisconnect}>
            Disconnect
          </Button>
        ) : (
          <>
            <Button className="w-full" disabled={!canConnect} onClick={() => onConnect(draft)}>
              Connect
            </Button>
            <Button
              className="w-full"
              variant="ghost"
              size="sm"
              onClick={() => {
                onForget();
                setDraft({ apiEndpoint: '', apiKey: '', tenantId: '', pipelineId: '', languageMode: '' });
              }}
            >
              Forget saved config
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}
