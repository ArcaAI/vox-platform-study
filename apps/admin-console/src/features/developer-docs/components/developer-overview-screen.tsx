'use client';

import Link from 'next/link';
import { IconBook2, IconKey, IconPackage } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';

import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { useGatewayVersion } from '../api/hooks';
import { CodeBlock } from './code-block';

const CURL_EXAMPLE = `curl -X GET "$HOPE_API_URL/api/v1/consultations" \\
  -H "X-API-Key: $HOPE_API_KEY"`;

const SDK_EXAMPLE = `import { HopeClient } from '@arcaai/vox-node';

const hope = new HopeClient({
  baseUrl: process.env.HOPE_API_URL,
  apiKey: process.env.HOPE_API_KEY,
});

const consultations = await hope.consultations.list();`;

/** The four ways a request can authenticate, and what each one can reach. */
const CREDENTIAL_CLASSES = [
  {
    name: 'User JWT',
    header: 'Authorization: Bearer <token>',
    reaches: 'Both planes, bounded by the user’s own abilities.',
    note: 'Issued by the login flow. Short-lived; refreshed by the console.',
  },
  {
    name: 'API key',
    header: 'X-API-Key: <key>',
    reaches: 'Business plane only.',
    note: 'Rejected with 403 on every /admin route, before scopes are even considered.',
  },
  {
    name: 'Service-account token',
    header: 'X-Service-Account-Token: <token>',
    reaches: 'Both planes, bounded by its scopes.',
    note: 'Exchanged from client credentials; ~15 min. Its tenant binds at exchange, so do not also send X-Tenant-Id.',
  },
] as const;

/** The status codes whose meaning here differs from the obvious reading. */
const ERROR_CONTRACT = [
  { code: '401', meaning: 'No credential, or it is expired, revoked, or malformed.' },
  { code: '403', meaning: 'A privilege boundary — the credential class, scope, or ability is insufficient.' },
  { code: '404', meaning: 'Not found — or it belongs to another tenant. The gateway hides existence across tenants, so read this as “not yours”.' },
  { code: '409', meaning: 'A conflict, commonly a quota ceiling from your plan entitlements.' },
  { code: '412', meaning: 'Your If-Match no longer matches the current ETag. Re-read the resource before retrying.' },
  { code: '428', meaning: 'This route requires If-Match and none was sent. Read the resource, take its ETag, resend.' },
  { code: '429', meaning: 'Rate limited.' },
] as const;

export function DeveloperOverviewScreen({ canReadAdminPlane }: { canReadAdminPlane: boolean }) {
  const { data: version, isPending } = useGatewayVersion();

  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="Developer"
          meta={<span>Integrate against the HOPE API — authentication, the error contract, and the full reference.</span>}
          actions={
            <>
              <Button asChild variant="outline">
                <Link href="/api-keys">
                  <IconKey aria-hidden className="size-4" />
                  API keys
                </Link>
              </Button>
              <Button asChild>
                <Link href="/developer/reference">
                  <IconBook2 aria-hidden className="size-4" />
                  API reference
                </Link>
              </Button>
            </>
          }
        />
      }
      footer={
        <StatusFooter
          start={
            isPending ? (
              <Skeleton className="h-3 w-40" />
            ) : (
              <span>Gateway build {version ?? 'unavailable'}</span>
            )
          }
          end={<span>{canReadAdminPlane ? 'Business + administration planes' : 'Business plane'}</span>}
        />
      }
    >
      <div className="flex flex-col gap-6 pb-2">
        <Card>
          <CardHeader>
            <CardTitle>Your first call</CardTitle>
            <CardDescription>
              Mint a key on the <Link href="/api-keys" className="underline underline-offset-4">API keys</Link> screen, then send a request. Set{' '}
              <code className="font-mono text-xs">HOPE_API_URL</code> to your gateway origin.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">curl</h2>
              <CodeBlock label="curl example" code={CURL_EXAMPLE} />
            </div>
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Node SDK</h2>
              <CodeBlock label="SDK example" code={SDK_EXAMPLE} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Credential classes</CardTitle>
            <CardDescription>
              Scopes bind the credential; abilities bind the user it acts for. They compose as AND — a credential can never exceed its user.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem] text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-left">
                    <th scope="col" className="py-2 pr-4 font-medium">Class</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Header</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Reaches</th>
                  </tr>
                </thead>
                <tbody>
                  {CREDENTIAL_CLASSES.map((credential) => (
                    <tr key={credential.name} className="border-b align-top last:border-0">
                      <th scope="row" className="py-3 pr-4 text-left font-medium">{credential.name}</th>
                      <td className="py-3 pr-4">
                        <code className="font-mono text-xs">{credential.header}</code>
                      </td>
                      <td className="py-3 pr-4">
                        <span className="block">{credential.reaches}</span>
                        <span className="text-muted-foreground block text-xs">{credential.note}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Error contract</CardTitle>
            <CardDescription>Two of these do not mean what they usually mean. Read 404 and 428 carefully.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-3">
              {ERROR_CONTRACT.map((entry) => (
                <div key={entry.code} className="flex flex-col gap-1 sm:flex-row sm:gap-4">
                  <dt className="shrink-0">
                    <Badge variant="outline" className="font-mono">{entry.code}</Badge>
                  </dt>
                  <dd className="text-sm">{entry.meaning}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Optimistic concurrency</CardTitle>
            <CardDescription>Versioned resources are edited with a compare-and-set, not a blind write.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p>
              A versioned resource returns a strong <code className="font-mono text-xs">ETag</code>. To modify it, send that value back as{' '}
              <code className="font-mono text-xs">If-Match</code>. Omitting the header is a <Badge variant="outline" className="font-mono">428</Badge>;
              sending a stale one is a <Badge variant="outline" className="font-mono">412</Badge>.
            </p>
            <p className="text-muted-foreground">
              Never retry a 412 blindly — it means someone else changed the resource, so re-read it and decide whether your change still applies. The
              reference marks every route that requires <code className="font-mono text-xs">If-Match</code>.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>SDKs</CardTitle>
            <CardDescription>Two published packages, for two very different runtimes.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/developer/sdk">
                <IconPackage aria-hidden className="size-4" />
                Browse the SDKs
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </ScreenTemplate>
  );
}
