import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Badge } from '@arcaai/ui/badge';
import { Separator } from '@arcaai/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Info } from 'lucide-react';
import { DocsLayout, type TocSection } from '@/components/layout/docs-layout';
import { CodeBlock } from '@/components/code-block';

const hookExample = `import { useNoiseFilter } from '@arcaai/noise-filter';
import { useAudioTrack } from '@arcaai/room';

function NoiseCancellation() {
  const track = useAudioTrack({ source: 'microphone' });
  const { isEnabled, stats, attach, detach } = useNoiseFilter({
    track,
    autoAttach: true,
    onStatsUpdate: (stats) => {
      console.log('Noise reduction:', stats.noiseReduction, 'dB');
    },
  });

  return (
    <div>
      <p>Noise filter: {isEnabled ? 'Active' : 'Inactive'}</p>
      {stats && <p>Reduction: {stats.noiseReduction.toFixed(1)} dB</p>}
      <button onClick={isEnabled ? detach : attach}>
        {isEnabled ? 'Disable' : 'Enable'}
      </button>
    </div>
  );
}`;

const levelsExample = `import { useNoiseFilter } from '@arcaai/noise-filter';

// Low: minimal filtering, preserves more audio detail
const low = useNoiseFilter({ track, level: 'low' });

// Medium: balanced filtering (default)
const medium = useNoiseFilter({ track, level: 'medium' });

// High: aggressive filtering, best for noisy environments
const high = useNoiseFilter({ track, level: 'high' });`;

const processorExample = `import { createNoiseFilter } from '@arcaai/noise-filter';
import { useProcessors, useAudioTrack } from '@arcaai/room';

function CustomPipeline() {
  const track = useAudioTrack({ source: 'microphone' });
  const { attach } = useProcessors(track);

  const setup = async () => {
    const noiseFilter = createNoiseFilter({
      level: 'high',
    });
    await attach(noiseFilter);
  };

  return <button onClick={setup}>Attach Noise Filter</button>;
}`;

const supportExample = `import {
  isRNNoiseSupported,
  getNoiseFilterBrowserSupport,
} from '@arcaai/noise-filter';

function CompatibilityCheck() {
  const supported = isRNNoiseSupported();
  const details = getNoiseFilterBrowserSupport();

  return (
    <div>
      <p>RNNoise supported: {supported ? 'Yes' : 'No'}</p>
      <p>WebAssembly: {details.webAssembly ? 'Yes' : 'No'}</p>
      <p>AudioWorklet: {details.audioWorklet ? 'Yes' : 'No'}</p>
    </div>
  );
}`;

const sections: TocSection[] = [
    { id: 'install', title: 'Install' },
    { id: 'requirements', title: 'Requirements' },
    { id: 'cancellation-levels', title: 'Cancellation Levels' },
    { id: 'basic-usage', title: 'Basic Usage' },
    { id: 'cancellation-levels-example', title: 'Cancellation Levels Example' },
    { id: 'processor-api', title: 'Processor API' },
    { id: 'browser-compatibility', title: 'Browser Compatibility' },
];

export default function NoiseFilterInstallation() {
    return (
        <DocsLayout
            title="@arcaai/noise-filter"
            description="AI-powered noise cancellation via RNNoise WebAssembly."
            sections={sections}
            cta={{ title: 'Try the Playground', description: 'Test the full audio pipeline interactively.', buttonLabel: 'Open Audio Playground', href: '/audio/live-transcription' }}
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
                            <CodeBlock code="pnpm add @arcaai/noise-filter @arcaai/room" />
                        </TabsContent>
                        <TabsContent value="npm" className="mt-3">
                            <CodeBlock code="npm install @arcaai/noise-filter @arcaai/room" />
                        </TabsContent>
                        <TabsContent value="yarn" className="mt-3">
                            <CodeBlock code="yarn add @arcaai/noise-filter @arcaai/room" />
                        </TabsContent>
                    </Tabs>
                </div>
            </section>

            <section id="requirements">
                <h2 className="text-xl font-semibold tracking-tight">Requirements</h2>
                <ul className="text-muted-foreground mt-3 flex flex-col gap-2 leading-6 text-sm">
                    <li>React <Badge variant="outline" className="ml-1">^18.3.0 || ^19.0.4</Badge></li>
                    <li><code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">@arcaai/room</code> <Badge variant="outline" className="ml-1">^0.1.0</Badge></li>
                    <li>Browser with WebAssembly and AudioWorklet support</li>
                </ul>
            </section>

            <section id="cancellation-levels">
                <h2 className="text-xl font-semibold tracking-tight">Cancellation Levels</h2>
                <div className="bg-muted/50 mt-3 overflow-hidden rounded-lg border">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b">
                                <th className="px-4 py-2 text-left font-medium">Level</th>
                                <th className="px-4 py-2 text-left font-medium">Use Case</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr className="border-b">
                                <td className="px-4 py-2"><code className="font-mono text-[13px]">low</code></td>
                                <td className="text-muted-foreground px-4 py-2">Quiet environments — minimal filtering, preserves audio detail</td>
                            </tr>
                            <tr className="border-b">
                                <td className="px-4 py-2"><code className="font-mono text-[13px]">medium</code></td>
                                <td className="text-muted-foreground px-4 py-2">Office/clinic — balanced filtering (default)</td>
                            </tr>
                            <tr>
                                <td className="px-4 py-2"><code className="font-mono text-[13px]">high</code></td>
                                <td className="text-muted-foreground px-4 py-2">Noisy environments — aggressive filtering</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <Separator className="my-6" />

            <section id="basic-usage">
                <h2 className="text-xl font-semibold tracking-tight">Basic Usage</h2>
                <p className="text-muted-foreground mt-1.5 leading-6 text-sm">
                    The <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">useNoiseFilter</code> hook
                    attaches RNNoise processing to an audio track.
                </p>
                <div className="mt-3">
                    <CodeBlock code={hookExample} />
                </div>
            </section>

            <section id="cancellation-levels-example">
                <h2 className="text-xl font-semibold tracking-tight">Cancellation Levels Example</h2>
                <div className="mt-3">
                    <CodeBlock code={levelsExample} />
                </div>
            </section>

            <section id="processor-api">
                <h2 className="text-xl font-semibold tracking-tight">Processor API</h2>
                <p className="text-muted-foreground mt-1.5 leading-6 text-sm">
                    For advanced use, create a processor and attach it to a track's pipeline directly.
                </p>
                <div className="mt-3">
                    <CodeBlock code={processorExample} />
                </div>
            </section>

            <section id="browser-compatibility">
                <h2 className="text-xl font-semibold tracking-tight">Browser Compatibility</h2>
                <p className="text-muted-foreground mt-1.5 leading-6 text-sm">
                    Check browser support before enabling noise cancellation.
                </p>
                <div className="mt-3">
                    <CodeBlock code={supportExample} />
                </div>
            </section>
        </DocsLayout>
    );
}
