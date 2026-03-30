import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Badge } from '@arcaai/ui/badge';
import { Separator } from '@arcaai/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Info } from 'lucide-react';
import { DocsLayout, type TocSection } from '@/components/layout/docs-layout';
import { CodeBlock } from '@/components/code-block';

const providerExample = `import { RoomProvider } from '@arcaai/room';

function App() {
  return (
    <RoomProvider>
      <YourAudioApp />
    </RoomProvider>
  );
}`;

const trackExample = `import { useRoom, useAudioTrack, useAudioLevel } from '@arcaai/room';

function MicrophoneCapture() {
  const { state, connect, disconnect } = useRoom();
  const track = useAudioTrack({ source: 'microphone' });
  const level = useAudioLevel(track);

  const handleStart = async () => {
    await connect();
    await track.start();
  };

  return (
    <div>
      <p>Room state: {state}</p>
      <p>Audio level: {Math.round(level * 100)}%</p>
      <button onClick={handleStart}>Start Microphone</button>
      <button onClick={() => track.stop()}>Stop</button>
    </div>
  );
}`;

const processorExample = `import { useProcessors, useAudioTrack } from '@arcaai/room';
import { createNoiseFilter } from '@arcaai/noise-filter';
import { createVAD } from '@arcaai/vad';

function AudioPipeline() {
  const track = useAudioTrack({ source: 'microphone' });
  const { attach, detach, processors } = useProcessors(track);

  const setupPipeline = async () => {
    const noiseFilter = createNoiseFilter({ level: 'medium' });
    const vad = createVAD({ sensitivity: 0.5 });
    await attach(noiseFilter);
    await attach(vad);
  };

  return (
    <div>
      <p>Active processors: {processors.length}</p>
      <button onClick={setupPipeline}>Setup Pipeline</button>
    </div>
  );
}`;

const devicesExample = `import { useDevices } from '@arcaai/room';

function DeviceSelector() {
  const { audioInputs, audioOutputs, selectedInput, selectInput } = useDevices();

  return (
    <select
      value={selectedInput?.deviceId}
      onChange={(e) => selectInput(e.target.value)}
    >
      {audioInputs.map((device) => (
        <option key={device.deviceId} value={device.deviceId}>
          {device.label}
        </option>
      ))}
    </select>
  );
}`;

const sections: TocSection[] = [
  { id: 'install', title: 'Install' },
  { id: 'requirements', title: 'Requirements' },
  { id: 'hooks', title: 'Hooks' },
  { id: 'provider-setup', title: 'Provider Setup' },
  { id: 'capture-audio', title: 'Capture Audio' },
  { id: 'processor-pipeline', title: 'Processor Pipeline' },
  { id: 'device-selection', title: 'Device Selection' },
];

export default function RoomInstallation() {
  return (
    <DocsLayout
      title="@arcaai/room"
      description="React-based audio processing with plugin architecture."
      sections={sections}
      cta={{
        title: 'Next: @arcaai/stt',
        description: 'Add speech-to-text to your audio pipeline.',
        buttonLabel: 'View STT Guide',
        href: '/installation/stt',
      }}
    >
      <Alert>
        <Info />
        <AlertTitle>Foundation Package</AlertTitle>
        <AlertDescription>
          <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">@arcaai/room</code> is the foundation for the audio pipeline. All
          audio plugins (STT, VAD, noise filter) depend on it.
        </AlertDescription>
      </Alert>

      <section id="install">
        <h2 className="text-xl font-semibold tracking-tight">Install</h2>
        <div className="mt-3">
          <Tabs defaultValue="pnpm">
            <TabsList>
              <TabsTrigger value="pnpm">pnpm</TabsTrigger>
              <TabsTrigger value="npm">npm</TabsTrigger>
              <TabsTrigger value="yarn">yarn</TabsTrigger>
            </TabsList>
            <TabsContent value="pnpm" className="mt-3">
              <CodeBlock code="pnpm add @arcaai/room" />
            </TabsContent>
            <TabsContent value="npm" className="mt-3">
              <CodeBlock code="npm install @arcaai/room" />
            </TabsContent>
            <TabsContent value="yarn" className="mt-3">
              <CodeBlock code="yarn add @arcaai/room" />
            </TabsContent>
          </Tabs>
        </div>
      </section>

      <section id="requirements">
        <h2 className="text-xl font-semibold tracking-tight">Requirements</h2>
        <ul className="text-muted-foreground mt-3 flex flex-col gap-2 leading-6 text-sm">
          <li>
            React{' '}
            <Badge variant="outline" className="ml-1">
              ^18.3.0 || ^19.0.4
            </Badge>
          </li>
          <li>Browser with WebAudio API support</li>
        </ul>
      </section>

      <section id="hooks">
        <h2 className="text-xl font-semibold tracking-tight">Hooks</h2>
        <div className="bg-muted/50 mt-3 overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="px-4 py-2 text-left font-medium">Hook</th>
                <th className="px-4 py-2 text-left font-medium">Purpose</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="px-4 py-2">
                  <code className="font-mono text-[13px]">useRoom</code>
                </td>
                <td className="text-muted-foreground px-4 py-2">Room state, connect/disconnect</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2">
                  <code className="font-mono text-[13px]">useAudioTrack</code>
                </td>
                <td className="text-muted-foreground px-4 py-2">Create and manage audio tracks</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2">
                  <code className="font-mono text-[13px]">useProcessors</code>
                </td>
                <td className="text-muted-foreground px-4 py-2">Attach/detach audio processors to a track</td>
              </tr>
              <tr className="border-b">
                <td className="px-4 py-2">
                  <code className="font-mono text-[13px]">useAudioLevel</code>
                </td>
                <td className="text-muted-foreground px-4 py-2">Real-time audio level metering</td>
              </tr>
              <tr>
                <td className="px-4 py-2">
                  <code className="font-mono text-[13px]">useDevices</code>
                </td>
                <td className="text-muted-foreground px-4 py-2">Enumerate and select audio devices</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <Separator className="my-6" />

      <section id="provider-setup">
        <h2 className="text-xl font-semibold tracking-tight">Provider Setup</h2>
        <p className="text-muted-foreground mt-1.5 leading-6 text-sm">
          Wrap your app (or the audio-enabled subtree) with <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">RoomProvider</code>
          .
        </p>
        <div className="mt-3">
          <CodeBlock code={providerExample} />
        </div>
      </section>

      <section id="capture-audio">
        <h2 className="text-xl font-semibold tracking-tight">Capture Audio</h2>
        <p className="text-muted-foreground mt-1.5 leading-6 text-sm">
          Use <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">useAudioTrack</code> to capture microphone input and{' '}
          <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">useAudioLevel</code> for real-time metering.
        </p>
        <div className="mt-3">
          <CodeBlock code={trackExample} />
        </div>
      </section>

      <section id="processor-pipeline">
        <h2 className="text-xl font-semibold tracking-tight">Processor Pipeline</h2>
        <p className="text-muted-foreground mt-1.5 leading-6 text-sm">
          Attach processors to a track to build an audio pipeline. Processors run in order.
        </p>
        <div className="mt-3">
          <CodeBlock code={processorExample} />
        </div>
      </section>

      <section id="device-selection">
        <h2 className="text-xl font-semibold tracking-tight">Device Selection</h2>
        <p className="text-muted-foreground mt-1.5 leading-6 text-sm">Enumerate available audio devices and let users pick their microphone.</p>
        <div className="mt-3">
          <CodeBlock code={devicesExample} />
        </div>
      </section>
    </DocsLayout>
  );
}
