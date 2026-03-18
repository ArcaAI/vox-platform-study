import { Badge } from '@arcaai/ui/badge';
import { Separator } from '@arcaai/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Link } from '@tanstack/react-router';
import { Callout } from '@/components/callout';
import { CodeBlock } from '@/components/code-block';
import { DocsLayout, type TocSection } from '@/components/layout/docs-layout';

const apiKeyExample = `import { AgenticProvider } from '@arcaai/vox';

function App() {
  return (
    <AgenticProvider
      config={{
        api: {
          baseUrl: 'https://api.arcaai.com',
          apiKey: 'your-api-key',
          tenantId: 'your-tenant-id',
        },
      }}
    >
      <YourApp />
    </AgenticProvider>
  );
}`;

const accessTokenExample = `import { AgenticProvider } from '@arcaai/vox';

function App() {
  const [token, setToken] = useState<string>();

  return (
    <AgenticProvider
      config={{
        api: {
          baseUrl: 'https://api.arcaai.com',
          accessToken: token,
          tenantId: 'your-tenant-id',
        },
      }}
    >
      <YourApp />
    </AgenticProvider>
  );
}`;

const hookExample = `import { useArca, useHealthCheck } from '@arcaai/vox';

function ConsultationRoom() {
  const { session, audio, context, summary } = useArca();
  const { status, services, check } = useHealthCheck();

  const handleStart = async () => {
    await session.open({
      patientId: 'patient-123',
      appointmentDate: new Date().toISOString(),
    });
    await audio.startRecording();
  };

  const handleStop = async () => {
    await audio.stopRecording();
    const result = await summary.generate();
    await session.close();
  };

  return (
    <div>
      <p>API Status: {status}</p>
      <button onClick={handleStart}>Start Consultation</button>
      <button onClick={handleStop}>End & Summarize</button>
    </div>
  );
}`;

const loginExample = `import { useAuth } from '@arcaai/vox';

function LoginPage() {
  const { login, isAuthenticated, user } = useAuth();

  const handleLogin = async () => {
    const response = await login('doctor@hospital.com', 'password', 'tenant-key');
    // SDK automatically stores the access token
    // All subsequent API calls are authenticated
    console.log('Logged in as:', response.user.username);
  };

  if (isAuthenticated) {
    return <p>Welcome, {user?.username}</p>;
  }

  return <button onClick={handleLogin}>Log In</button>;
}`;

const plugins = [
    {
        name: '@arcaai/room',
        description:
            'Audio track management with plugin architecture. Provides microphone access, audio context, and processor pipeline.',
        url: '/installation/room',
    },
    {
        name: '@arcaai/stt',
        description:
            'Speech-to-text with local Whisper engine. Runs in a WebWorker for non-blocking transcription.',
        url: '/installation/stt',
    },
    {
        name: '@arcaai/vad',
        description:
            'Voice Activity Detection using Silero VAD v5. Detects speech segments in real-time audio streams.',
        url: '/installation/vad',
    },
    {
        name: '@arcaai/noise-filter',
        description:
            'AI-powered noise cancellation via RNNoise WebAssembly. Removes background noise from microphone input.',
        url: '/installation/noise-filter',
    },
];

const sections: TocSection[] = [
    { id: 'prerequisites', title: 'Prerequisites' },
    { id: 'install-the-sdk', title: 'Install the SDK' },
    { id: 'entry-points', title: 'Entry Points' },
    { id: 'authentication', title: 'Authentication' },
    { id: 'api-key-authentication', title: 'API Key Authentication', level: 3 },
    { id: 'access-token-authentication', title: 'Access Token Authentication', level: 3 },
    { id: 'login-with-useauth', title: 'Login with useAuth', level: 3 },
    { id: 'basic-usage', title: 'Basic Usage' },
    { id: 'audio-plugins', title: 'Audio Plugins' },
];

function InlineCode({ children }: { children: React.ReactNode }) {
    return (
        <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[13px]">
            {children}
        </code>
    );
}

export default function Installation() {
    return (
        <DocsLayout
            title="Installation"
            description="How to install dependencies and structure your app."
            sections={sections}
            cta={{
                title: 'Try it Live',
                description: 'Test the SDK in the Audio Playground.',
                buttonLabel: 'Open Playground',
                href: '/audio/live-transcription',
            }}
        >
            <Callout className="border-emerald-600/30 bg-emerald-50 dark:border-emerald-400/30 dark:bg-emerald-950/40">
                <p>
                    <strong>Quick Start.</strong> Run{' '}
                    <InlineCode>pnpm add @arcaai/vox</InlineCode>, wrap your app
                    in <InlineCode>{'<AgenticProvider>'}</InlineCode>, and call{' '}
                    <InlineCode>useArca()</InlineCode>. That's it.
                </p>
            </Callout>

            <section id="prerequisites">
                <h2 className="text-xl font-semibold tracking-tight">
                    Prerequisites
                </h2>
                <ul className="text-muted-foreground mt-3 flex flex-col gap-2 text-sm">
                    <li className="flex items-baseline gap-2">
                        <Badge variant="outline" className="shrink-0 text-xs">
                            React
                        </Badge>
                        <span>
                            18.3+ or 19.x — the SDK uses hooks and concurrent
                            features.
                        </span>
                    </li>
                    <li className="flex items-baseline gap-2">
                        <Badge variant="outline" className="shrink-0 text-xs">
                            Node.js
                        </Badge>
                        <span>
                            18+ — required for the build toolchain. LTS
                            recommended.
                        </span>
                    </li>
                    <li className="flex items-baseline gap-2">
                        <Badge variant="outline" className="shrink-0 text-xs">
                            API
                        </Badge>
                        <span>
                            A running ArcaVox API instance with base URL, API
                            key or access token, and tenant ID.
                        </span>
                    </li>
                    <li className="flex items-baseline gap-2">
                        <Badge variant="outline" className="shrink-0 text-xs">
                            Browser
                        </Badge>
                        <span>
                            Audio features require WebAudio API and
                            WebAssembly. Chrome, Edge, Firefox, Safari 15.4+.
                        </span>
                    </li>
                </ul>
            </section>

            <section id="install-the-sdk">
                <h2 className="text-xl font-semibold tracking-tight">
                    Install the SDK
                </h2>
                <p className="text-muted-foreground mt-1.5 text-sm leading-6">
                    Add <InlineCode>@arcaai/vox</InlineCode> to your project.
                    The package is tree-shakeable — import only what you need.
                </p>
                <div className="mt-3">
                    <Tabs defaultValue="pnpm">
                        <TabsList>
                            <TabsTrigger value="pnpm">pnpm</TabsTrigger>
                            <TabsTrigger value="npm">npm</TabsTrigger>
                            <TabsTrigger value="yarn">yarn</TabsTrigger>
                        </TabsList>
                        <TabsContent value="pnpm" className="mt-2">
                            <CodeBlock code="pnpm add @arcaai/vox" />
                        </TabsContent>
                        <TabsContent value="npm" className="mt-2">
                            <CodeBlock code="npm install @arcaai/vox" />
                        </TabsContent>
                        <TabsContent value="yarn" className="mt-2">
                            <CodeBlock code="yarn add @arcaai/vox" />
                        </TabsContent>
                    </Tabs>
                </div>
            </section>

            <section id="entry-points">
                <h2 className="text-xl font-semibold tracking-tight">
                    Entry Points
                </h2>
                <p className="text-muted-foreground mt-1.5 text-sm leading-6">
                    The SDK ships three entry points so you can control bundle
                    size.
                </p>
                <div className="bg-muted/50 mt-3 overflow-hidden rounded-lg border">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b">
                                <th className="px-4 py-2 text-left font-medium">
                                    Import
                                </th>
                                <th className="px-4 py-2 text-left font-medium">
                                    Size
                                </th>
                                <th className="px-4 py-2 text-left font-medium">
                                    Description
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr className="border-b">
                                <td className="px-4 py-2">
                                    <code className="font-mono text-xs">
                                        @arcaai/vox
                                    </code>
                                </td>
                                <td className="px-4 py-2">
                                    <Badge variant="secondary">~5.5 MB</Badge>
                                </td>
                                <td className="text-muted-foreground px-4 py-2">
                                    Full SDK with audio plugins
                                </td>
                            </tr>
                            <tr className="border-b">
                                <td className="px-4 py-2">
                                    <code className="font-mono text-xs">
                                        @arcaai/vox/core
                                    </code>
                                </td>
                                <td className="px-4 py-2">
                                    <Badge variant="secondary">~200 KB</Badge>
                                </td>
                                <td className="text-muted-foreground px-4 py-2">
                                    Core only — sessions, context, summaries
                                </td>
                            </tr>
                            <tr>
                                <td className="px-4 py-2">
                                    <code className="font-mono text-xs">
                                        @arcaai/vox/plugins
                                    </code>
                                </td>
                                <td className="px-4 py-2">
                                    <Badge variant="secondary">~5.3 MB</Badge>
                                </td>
                                <td className="text-muted-foreground px-4 py-2">
                                    Audio plugins only — noise filter, VAD, STT
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <Separator />

            <section id="authentication">
                <h2 className="text-xl font-semibold tracking-tight">
                    Authentication
                </h2>
                <p className="text-muted-foreground mt-1.5 text-sm leading-6">
                    The SDK supports two authentication methods. You can use
                    either or both simultaneously.
                </p>

                <div id="api-key-authentication" className="mt-4 flex flex-col gap-1.5">
                    <h3 className="font-medium">API Key Authentication</h3>
                    <p className="text-muted-foreground text-sm leading-6">
                        Best for server-to-server or system-level access. The
                        API key is sent as{' '}
                        <InlineCode>X-API-Key</InlineCode> header on every
                        request.
                    </p>
                    <div className="mt-2">
                        <CodeBlock code={apiKeyExample} />
                    </div>
                </div>

                <Separator className="my-6" />

                <div id="access-token-authentication" className="flex flex-col gap-1.5">
                    <h3 className="font-medium">
                        Access Token Authentication
                    </h3>
                    <p className="text-muted-foreground text-sm leading-6">
                        Best for user-facing apps where each user logs in. The
                        token is sent as{' '}
                        <InlineCode>Authorization: Bearer</InlineCode> header.
                        Use the <InlineCode>useAuth</InlineCode> hook to handle
                        login/logout flows.
                    </p>
                    <div className="mt-2">
                        <CodeBlock code={accessTokenExample} />
                    </div>
                </div>

                <Separator className="my-6" />

                <div id="login-with-useauth" className="flex flex-col gap-1.5">
                    <h3 className="font-medium">Login with useAuth</h3>
                    <p className="text-muted-foreground text-sm leading-6">
                        For apps that need a login flow, the{' '}
                        <InlineCode>useAuth</InlineCode> hook provides{' '}
                        <InlineCode>login</InlineCode>,{' '}
                        <InlineCode>logout</InlineCode>,{' '}
                        <InlineCode>refreshToken</InlineCode>, and{' '}
                        <InlineCode>impersonate</InlineCode> methods. The SDK
                        automatically manages the access token after login.
                    </p>
                    <div className="mt-2">
                        <CodeBlock code={loginExample} />
                    </div>
                </div>
            </section>

            <Separator />

            <section id="basic-usage">
                <h2 className="text-xl font-semibold tracking-tight">
                    Basic Usage
                </h2>
                <p className="text-muted-foreground mt-1.5 text-sm leading-6">
                    Once the provider is set up, use{' '}
                    <InlineCode>useArca()</InlineCode> for the unified API, or
                    individual hooks like{' '}
                    <InlineCode>useArcaSession</InlineCode>,{' '}
                    <InlineCode>useArcaAudio</InlineCode>,{' '}
                    <InlineCode>useArcaContext</InlineCode>, and{' '}
                    <InlineCode>useArcaSummary</InlineCode> for finer control.
                </p>
                <div className="mt-3">
                    <CodeBlock code={hookExample} />
                </div>
            </section>

            <Separator />

            <section id="audio-plugins">
                <h2 className="text-xl font-semibold tracking-tight">
                    Audio Plugins
                </h2>
                <p className="text-muted-foreground mt-1.5 text-sm leading-6">
                    The audio pipeline is built from independent packages. Each
                    can be installed and configured separately. Select a plugin
                    below for detailed installation and usage instructions.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {plugins.map((plugin) => (
                        <Link
                            key={plugin.url}
                            to={plugin.url}
                            className="border-border hover:bg-accent/50 group flex flex-col gap-1.5 rounded-lg border p-4 transition-colors"
                        >
                            <code className="text-foreground font-mono text-sm font-semibold group-hover:underline">
                                {plugin.name}
                            </code>
                            <p className="text-muted-foreground text-xs leading-relaxed">
                                {plugin.description}
                            </p>
                        </Link>
                    ))}
                </div>
            </section>
        </DocsLayout>
    );
}
