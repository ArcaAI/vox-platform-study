import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Badge } from '@arcaai/ui/badge';
import { Separator } from '@arcaai/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Info } from 'lucide-react';
import { DocsLayout, type TocSection } from '@/components/layout/docs-layout';
import { CodeBlock } from '@/components/code-block';

const hookExample = `import { useSTT } from '@arcaai/stt';
import { useAudioTrack } from '@arcaai/room';

function Transcription() {
  const track = useAudioTrack({ source: 'microphone' });
  const { transcriptions, isProcessing, attach, detach } = useSTT({
    track,
    onTranscription: (result) => {
      console.log('Final:', result.text);
    },
    onPartialTranscription: (result) => {
      console.log('Partial:', result.text);
    },
  });

  return (
    <div>
      <p>Processing: {isProcessing ? 'Yes' : 'No'}</p>
      <button onClick={attach}>Start STT</button>
      <button onClick={detach}>Stop STT</button>
      <ul>
        {transcriptions.map((t, i) => (
          <li key={i}>{t.text}</li>
        ))}
      </ul>
    </div>
  );
}`;

const modelExample = `import { useSTT } from '@arcaai/stt';

// Use a specific Whisper model size
const { transcriptions } = useSTT({
  track,
  provider: 'local',
  modelId: 'whisper-tiny',    // tiny, base, small, medium
  language: 'en',
  onProgress: (progress) => {
    console.log(\`Model loading: \${progress.percent}%\`);
  },
});`;

const remoteExample = `import { useSTT } from '@arcaai/stt';

// Use backend STT instead of local Whisper
const { transcriptions } = useSTT({
  track,
  provider: 'remote',
  language: 'en',
  // Connects to the STT WebSocket endpoint
  // configured in your AgenticProvider
});`;

const sections: TocSection[] = [
    { id: 'install', title: 'Install' },
    { id: 'requirements', title: 'Requirements' },
    { id: 'available-models', title: 'Available Models' },
    { id: 'basic-usage', title: 'Basic Usage' },
    { id: 'model-configuration', title: 'Model Configuration' },
    { id: 'remote-stt', title: 'Remote STT' },
];

export default function SttInstallation() {
    return (
        <DocsLayout
            title="@arcaai/stt"
            description="Speech-to-text with local Whisper engine and backend fallback."
            sections={sections}
            cta={{ title: 'Next: @arcaai/vad', description: 'Add voice activity detection to your pipeline.', buttonLabel: 'View VAD Guide', href: '/installation/vad' }}
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
                            <CodeBlock code="pnpm add @arcaai/stt @arcaai/room" />
                        </TabsContent>
                        <TabsContent value="npm" className="mt-3">
                            <CodeBlock code="npm install @arcaai/stt @arcaai/room" />
                        </TabsContent>
                        <TabsContent value="yarn" className="mt-3">
                            <CodeBlock code="yarn add @arcaai/stt @arcaai/room" />
                        </TabsContent>
                    </Tabs>
                </div>
            </section>

            <section id="requirements">
                <h2 className="text-xl font-semibold tracking-tight">Requirements</h2>
                <ul className="text-muted-foreground mt-3 flex flex-col gap-2 leading-6 text-sm">
                    <li>React <Badge variant="outline" className="ml-1">^18.3.0 || ^19.0.4</Badge></li>
                    <li>Node.js <Badge variant="outline" className="ml-1">{'>'}= 18.0.0</Badge></li>
                    <li>WebGPU support recommended for local Whisper (falls back to WASM)</li>
                </ul>
            </section>

            <section id="available-models">
                <h2 className="text-xl font-semibold tracking-tight">Available Models</h2>
                <div className="bg-muted/50 mt-3 overflow-hidden rounded-lg border">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b">
                                <th className="px-4 py-2 text-left font-medium">Model</th>
                                <th className="px-4 py-2 text-left font-medium">Size</th>
                                <th className="px-4 py-2 text-left font-medium">Speed</th>
                                <th className="px-4 py-2 text-left font-medium">Accuracy</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr className="border-b">
                                <td className="px-4 py-2"><code className="font-mono text-[13px]">whisper-tiny</code></td>
                                <td className="px-4 py-2">~75 MB</td>
                                <td className="px-4 py-2">Fastest</td>
                                <td className="text-muted-foreground px-4 py-2">Good for real-time</td>
                            </tr>
                            <tr className="border-b">
                                <td className="px-4 py-2"><code className="font-mono text-[13px]">whisper-base</code></td>
                                <td className="px-4 py-2">~140 MB</td>
                                <td className="px-4 py-2">Fast</td>
                                <td className="text-muted-foreground px-4 py-2">Balanced</td>
                            </tr>
                            <tr className="border-b">
                                <td className="px-4 py-2"><code className="font-mono text-[13px]">whisper-small</code></td>
                                <td className="px-4 py-2">~460 MB</td>
                                <td className="px-4 py-2">Moderate</td>
                                <td className="text-muted-foreground px-4 py-2">High accuracy</td>
                            </tr>
                            <tr>
                                <td className="px-4 py-2"><code className="font-mono text-[13px]">whisper-medium</code></td>
                                <td className="px-4 py-2">~1.5 GB</td>
                                <td className="px-4 py-2">Slow</td>
                                <td className="text-muted-foreground px-4 py-2">Highest accuracy</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <Separator className="my-6" />

            <section id="basic-usage">
                <h2 className="text-xl font-semibold tracking-tight">Basic Usage</h2>
                <p className="text-muted-foreground mt-1.5 leading-6 text-sm">
                    Use the <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">useSTT</code> hook
                    with an audio track from <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">@arcaai/room</code>.
                </p>
                <div className="mt-3">
                    <CodeBlock code={hookExample} />
                </div>
            </section>

            <section id="model-configuration">
                <h2 className="text-xl font-semibold tracking-tight">Model Configuration</h2>
                <p className="text-muted-foreground mt-1.5 leading-6 text-sm">
                    Choose a model size based on your accuracy and performance needs.
                </p>
                <div className="mt-3">
                    <CodeBlock code={modelExample} />
                </div>
            </section>

            <section id="remote-stt">
                <h2 className="text-xl font-semibold tracking-tight">Remote STT</h2>
                <p className="text-muted-foreground mt-1.5 leading-6 text-sm">
                    For devices without WebGPU/WASM support, fall back to the backend STT service via WebSocket.
                </p>
                <div className="mt-3">
                    <CodeBlock code={remoteExample} />
                </div>
            </section>
        </DocsLayout>
    );
}
