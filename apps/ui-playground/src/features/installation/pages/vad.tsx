import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Badge } from '@arcaai/ui/badge';
import { Separator } from '@arcaai/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Info } from 'lucide-react';
import { DocsLayout, type TocSection } from '@/components/layout/docs-layout';
import { CodeBlock } from '@/components/code-block';

const hookExample = `import { useVAD } from '@arcaai/vad';
import { useAudioTrack } from '@arcaai/room';

function SpeechDetector() {
  const track = useAudioTrack({ source: 'microphone' });
  const { isSpeaking, speechSegments, attach, detach } = useVAD({
    track,
    onSpeechStart: () => console.log('Speech started'),
    onSpeechEnd: (audio) => {
      console.log('Speech ended, duration:', audio.duration, 'ms');
    },
    onVADMisfire: () => console.log('False positive filtered'),
  });

  return (
    <div>
      <p>Speaking: {isSpeaking ? 'Yes' : 'No'}</p>
      <p>Segments detected: {speechSegments.length}</p>
      <button onClick={attach}>Start VAD</button>
      <button onClick={detach}>Stop VAD</button>
    </div>
  );
}`;

const configExample = `import { useVAD } from '@arcaai/vad';

const { isSpeaking } = useVAD({
  track,
  // Sensitivity: 0.0 (least sensitive) to 1.0 (most sensitive)
  sensitivity: 0.5,
  // Minimum speech duration to trigger (ms)
  minSpeechDuration: 250,
  // Minimum silence duration to end speech (ms)
  minSilenceDuration: 300,
  // Auto-attach when track is ready
  autoAttach: true,
});`;

const processorExample = `import { createVAD } from '@arcaai/vad';
import { useProcessors, useAudioTrack } from '@arcaai/room';

function CustomPipeline() {
  const track = useAudioTrack({ source: 'microphone' });
  const { attach } = useProcessors(track);

  const setup = async () => {
    const vad = createVAD({
      sensitivity: 0.6,
      minSpeechDuration: 200,
    });
    await attach(vad);
  };

  return <button onClick={setup}>Attach VAD Processor</button>;
}`;

const sections: TocSection[] = [
    { id: 'install', title: 'Install' },
    { id: 'requirements', title: 'Requirements' },
    { id: 'basic-usage', title: 'Basic Usage' },
    { id: 'configuration', title: 'Configuration' },
    { id: 'processor-api', title: 'Processor API' },
];

export default function VadInstallation() {
    return (
        <DocsLayout
            title="@arcaai/vad"
            description="Voice Activity Detection using Silero VAD v5."
            sections={sections}
            cta={{ title: 'Next: Noise Filter', description: 'Add AI noise cancellation to your pipeline.', buttonLabel: 'View Noise Filter Guide', href: '/installation/noise-filter' }}
        >
            <Alert>
                <Info />
                <AlertTitle>Peer Dependency</AlertTitle>
                <AlertDescription>
                    This package requires <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">@arcaai/room</code> as
                    a peer dependency. Install it first.
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
                            <CodeBlock code="pnpm add @arcaai/vad @arcaai/room" />
                        </TabsContent>
                        <TabsContent value="npm" className="mt-3">
                            <CodeBlock code="npm install @arcaai/vad @arcaai/room" />
                        </TabsContent>
                        <TabsContent value="yarn" className="mt-3">
                            <CodeBlock code="yarn add @arcaai/vad @arcaai/room" />
                        </TabsContent>
                    </Tabs>
                </div>
            </section>

            <section id="requirements">
                <h2 className="text-xl font-semibold tracking-tight">Requirements</h2>
                <ul className="text-muted-foreground mt-3 flex flex-col gap-2 leading-6 text-sm">
                    <li>React <Badge variant="outline" className="ml-1">^18.3.0 || ^19.0.4</Badge></li>
                    <li><code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">@arcaai/room</code> <Badge variant="outline" className="ml-1">^0.1.0</Badge></li>
                    <li>Browser with WebAssembly support</li>
                </ul>
            </section>

            <Separator className="my-6" />

            <section id="basic-usage">
                <h2 className="text-xl font-semibold tracking-tight">Basic Usage</h2>
                <p className="text-muted-foreground mt-1.5 leading-6 text-sm">
                    The <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">useVAD</code> hook
                    detects speech segments in real-time from an audio track.
                </p>
                <div className="mt-3">
                    <CodeBlock code={hookExample} />
                </div>
            </section>

            <section id="configuration">
                <h2 className="text-xl font-semibold tracking-tight">Configuration</h2>
                <p className="text-muted-foreground mt-1.5 leading-6 text-sm">
                    Tune sensitivity and timing thresholds for your use case.
                </p>
                <div className="mt-3">
                    <CodeBlock code={configExample} />
                </div>
                <div className="bg-muted/50 mt-3 overflow-hidden rounded-lg border">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b">
                                <th className="px-4 py-2 text-left font-medium">Option</th>
                                <th className="px-4 py-2 text-left font-medium">Default</th>
                                <th className="px-4 py-2 text-left font-medium">Description</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr className="border-b">
                                <td className="px-4 py-2"><code className="font-mono text-[13px]">sensitivity</code></td>
                                <td className="px-4 py-2">0.5</td>
                                <td className="text-muted-foreground px-4 py-2">0.0 (least) to 1.0 (most sensitive)</td>
                            </tr>
                            <tr className="border-b">
                                <td className="px-4 py-2"><code className="font-mono text-[13px]">minSpeechDuration</code></td>
                                <td className="px-4 py-2">250ms</td>
                                <td className="text-muted-foreground px-4 py-2">Minimum duration to trigger speech</td>
                            </tr>
                            <tr>
                                <td className="px-4 py-2"><code className="font-mono text-[13px]">minSilenceDuration</code></td>
                                <td className="px-4 py-2">300ms</td>
                                <td className="text-muted-foreground px-4 py-2">Silence needed to end a speech segment</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <section id="processor-api">
                <h2 className="text-xl font-semibold tracking-tight">Processor API</h2>
                <p className="text-muted-foreground mt-1.5 leading-6 text-sm">
                    For advanced use, create a VAD processor and attach it to a track's processor pipeline directly.
                </p>
                <div className="mt-3">
                    <CodeBlock code={processorExample} />
                </div>
            </section>
        </DocsLayout>
    );
}
