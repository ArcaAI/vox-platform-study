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
          </CardContent>
        </Card>
      </div>
    </ScreenTemplate>
  );
}
