import { useState, type ChangeEvent } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Switch,
} from '@arcaai/ui';
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

/**
 * The text fields only. Narrowed away from `keyof PlaygroundConfig` because the
 * config now also carries booleans (the capture-stage switches below) and
 * numbers (the drain knobs, which live on the Live-transcription tab) — feeding
 * either to an `<Input value>` is a type error, and rendering `false` as text
 * would be a UI one.
 */
type TextFieldKey = 'apiEndpoint' | 'apiKey' | 'tenantId' | 'pipelineId';

const FIELDS: Array<{
  key: TextFieldKey;
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
 * The two browser capture-graph stages, as CONNECTION-level switches.
 *
 * They belong here — not next to Start/Stop — because they map onto
 * `V1SdkConfig.audioSettings`, which `<ArcaCompatProvider>` reads exactly once
 * at mount. Changing one after connecting would have no effect until the
 * provider remounts, so the form locks with the rest of the credentials and the
 * user changes them via Disconnect → edit → Connect. (The stop-drain knobs are
 * per-CAPTURE and therefore live on the Live-transcription tab instead.)
 */
const STAGE_SWITCHES: Array<{
  key: 'noiseSuppression' | 'voiceActivityDetection';
  label: string;
  hint: string;
}> = [
  {
    key: 'noiseSuppression',
    label: 'Noise suppression',
    hint: 'RNNoise (@arcaai/noise-filter) in the browser, before STT. Off ⇒ the stage is not built at all.',
  },
  {
    key: 'voiceActivityDetection',
    label: 'Voice activity detection (VAD)',
    hint: 'Silero VAD (@arcaai/vad) in the browser. Off ⇒ the stage is not built at all, so speech gating never trims the uplink.',
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

  const update = (field: TextFieldKey) => (event: ChangeEvent<HTMLInputElement>) => setDraft((prev) => ({ ...prev, [field]: event.target.value }));

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

        <CardContent className="flex flex-col gap-4 border-t pt-6">
          <div>
            <h2 className="text-sm font-medium">Browser audio processing</h2>
            <p className="text-muted-foreground text-xs">
              Client-side stages between the microphone and the STT uplink, mapped onto{' '}
              <code className="font-mono text-xs">V1SdkConfig.audioSettings</code>. Both are off by default, which is what the compat adapter has
              always produced.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {STAGE_SWITCHES.map((stage) => (
              <div key={stage.key} className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <Switch
                    id={`config-${stage.key}`}
                    checked={view[stage.key] ?? false}
                    onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, [stage.key]: checked }))}
                    disabled={connected}
                    aria-describedby={`config-${stage.key}-hint`}
                  />
                  <Label htmlFor={`config-${stage.key}`}>{stage.label}</Label>
                </div>
                <p id={`config-${stage.key}-hint`} className="text-muted-foreground text-xs">
                  {stage.hint}
                </p>
              </div>
            ))}
          </div>

          {/* Not colour-only, and not buried in a README: turning these off
              changes what the backend actually hears.

              `role="note"` overrides `Alert`'s built-in `role="alert"`. This is
              permanently-rendered advisory text, not an urgent live-region
              announcement — `alert` is assertive and reserved for messages that
              interrupt, and this panel is force-mounted, so it would also make
              every unrelated `getByRole('alert')` ambiguous. */}
          <Alert role="note">
            <AlertTitle>Both off sends unprocessed audio to the backend</AlertTitle>
            <AlertDescription>
              With noise suppression and VAD disabled, the raw captured signal reaches the ASR pipeline: no noise reduction, and no speech gating to
              trim silence or non-speech. That is what you want for an accuracy run against a labelled corpus — the model is then scored on the same
              audio you fed it — and usually not what you want for a noisy clinic room.
            </AlertDescription>
          </Alert>
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
                  setDraft({
                    apiEndpoint: '',
                    apiKey: '',
                    tenantId: '',
                    pipelineId: '',
                    languageMode: '',
                    noiseSuppression: false,
                    voiceActivityDetection: false,
                  });
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
