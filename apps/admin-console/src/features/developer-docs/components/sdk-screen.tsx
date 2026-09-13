'use client';

import Link from 'next/link';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';

import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { CodeBlock } from './code-block';

const VOX_NODE_INSTALL = `pnpm add @arcaai/vox-node`;

const VOX_NODE_API_KEY = `import { HopeClient } from '@arcaai/vox-node';

// Business plane. An API key can never reach /admin — that is a 403,
// checked before scopes, so a broader scope does not help.
const hope = new HopeClient({
  baseUrl: process.env.HOPE_API_URL,
  apiKey: process.env.HOPE_API_KEY,
});

await hope.summarization.presummary({ /* ... */ });`;

const VOX_NODE_SERVICE_ACCOUNT = `import { HopeClient } from '@arcaai/vox-node';

// Administration plane. The SDK exchanges these for a short-lived token and
// refreshes it for you. workingTenantId binds at EXCHANGE — do not also send
// X-Tenant-Id per request.
const hope = new HopeClient({
  baseUrl: process.env.HOPE_API_URL,
  serviceAccount: {
    clientId: process.env.HOPE_SA_CLIENT_ID,
    clientSecret: process.env.HOPE_SA_CLIENT_SECRET,
  },
  workingTenantId: process.env.HOPE_TENANT_ID,
});

await hope.admin.users.list();`;

const VOX_BROWSER = `pnpm add @arcaai/vox`;

/**
 * `baseUrl` MUST include the gateway's `/api/v1` prefix here — the one
 * detail that differs from the `@arcaai/vox-node` examples above, whose
 * `HopeClient` takes the bare origin instead.
 */
const VOX_BROWSER_JWT = `import { AgenticProvider, useAgentInvocation } from '@arcaai/vox/core';

function App({ sessionJwt }) {
  return (
    <AgenticProvider config={{ api: { baseUrl: 'https://api.example.com/api/v1', accessToken: sessionJwt } }}>
      <Triage />
    </AgenticProvider>
  );
}

function Triage() {
  const { invoke, result, isLoading } = useAgentInvocation();

  const onSubmit = () => invoke('triage-summariser', { text: note });
  // ...
}`;

const VOX_BROWSER_API_KEY = `<AgenticProvider config={{ api: { baseUrl: 'https://api.example.com/api/v1', apiKey: process.env.HOPE_API_KEY } }}>
  <Triage />
</AgenticProvider>`;

/** The browser always starts async and then watches — it never passes ?mode= on a run. */
const VOX_BROWSER_WORKFLOW = `import { useWorkflowRun } from '@arcaai/vox/core';

function StartRun() {
  const { workflows, start, status, events, isRunning } = useWorkflowRun();

  const onSubmit = () => start('triage-workflow', { note });
  // status/events update live as the run streams — the browser never passes ?mode=.
}`;

export function SdkScreen() {
  return (
    <ScreenTemplate
      header={<PageHeader title="SDKs" meta={<span>Two packages that share a brand and nothing else — pick by runtime, not by name.</span>} />}
      footer={<StatusFooter start="Server SDK: @arcaai/vox-node" end={<span>Browser SDK: @arcaai/vox</span>} />}
    >
      <div className="flex flex-col gap-6 pb-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <code className="font-mono">@arcaai/vox-node</code>
              <Badge variant="secondary">server</Badge>
            </CardTitle>
            <CardDescription>
              Node 22+, Bun, Deno, and edge runtimes. Zero runtime dependencies, no React. This is the package for a backend integration.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CodeBlock label="install command" code={VOX_NODE_INSTALL} />
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">With an API key — business plane</h2>
              <CodeBlock label="API key example" code={VOX_NODE_API_KEY} />
            </div>
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">With a service account — administration plane</h2>
              <CodeBlock label="service account example" code={VOX_NODE_SERVICE_ACCOUNT} />
            </div>
            <p className="text-muted-foreground text-sm">
              Supplying both credentials throws at construction: they are different planes with different rules, and guessing which one you meant
              would be the wrong thing to do silently. See the{' '}
              <Link href="/developer/reference" className="underline underline-offset-4">
                API reference
              </Link>{' '}
              for which credential each route accepts.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <code className="font-mono">@arcaai/vox</code>
              <Badge variant="secondary">browser</Badge>
            </CardTitle>
            <CardDescription>
              React 18/19 in the browser. Audio capture, VAD, streaming speech-to-text, and the consultation session hooks.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CodeBlock label="browser SDK install command" code={VOX_BROWSER} />
            <p className="text-muted-foreground text-sm">
              Browser-only — every entry point is a client module and React is a required peer. Do not import it from server code, and do not reach
              for it to make plain API calls: that is what <code className="font-mono text-xs">@arcaai/vox-node</code> is for.
            </p>

            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Calling a published agent — with a session JWT</h2>
              <p className="text-muted-foreground text-sm">
                <code className="font-mono text-xs">baseUrl</code> MUST include the gateway&apos;s{' '}
                <code className="font-mono text-xs">/api/v1</code> prefix here — the one detail that differs from the{' '}
                <code className="font-mono text-xs">@arcaai/vox-node</code> examples above, whose client takes the bare origin instead.
              </p>
              <CodeBlock label="AgenticProvider and useAgentInvocation example" code={VOX_BROWSER_JWT} />
            </div>

            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Or with an API key</h2>
              <p className="text-muted-foreground text-sm">
                Only when a session JWT is not available. An API key baked into a browser bundle is readable by anyone who opens it — mint one
                scoped to <code className="font-mono text-xs">agent:invocation:write</code> alone, which is mintable on its own, so a compromised
                key can invoke one agent family and do nothing else.
              </p>
              <CodeBlock label="API key AgenticProvider example" code={VOX_BROWSER_API_KEY} />
            </div>

            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Starting and watching a workflow run</h2>
              <CodeBlock label="useWorkflowRun example" code={VOX_BROWSER_WORKFLOW} />
              <p className="text-muted-foreground text-sm">
                The browser always starts a run async and then watches it — it never passes <code className="font-mono text-xs">?mode=</code> the
                way a direct HTTP call or the server SDK can.
              </p>
            </div>

            <p className="text-muted-foreground text-sm">
              No browser path by slug exists for TEXT_TO_SPEECH or batch SPEECH_TO_TEXT — those go through{' '}
              <code className="font-mono text-xs">useTtsPlayback</code>/<code className="font-mono text-xs">useTtsStream</code> and{' '}
              <code className="font-mono text-xs">FileTranscriptionService</code> respectively, not the invocation hooks above.
            </p>
          </CardContent>
        </Card>
      </div>
    </ScreenTemplate>
  );
}
