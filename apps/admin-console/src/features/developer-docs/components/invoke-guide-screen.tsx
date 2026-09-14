'use client';

import Link from 'next/link';
import { IconBook2, IconKey, IconPackage } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/components/shadcn/card';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';

import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { CodeBlock } from './code-block';

/**
 * `/developer/invoke` — "Call a published agent or workflow" (TASK-971 lane E).
 *
 * The direct-HTTP contract behind every published agent and workflow, for a
 * developer who is not reaching for `@arcaai/vox-node` or `@arcaai/vox`. It
 * exists because the single most expensive mistake calling these routes —
 * sending a workflow's enveloped body to an agent, or an agent's flat body to
 * a workflow — was undocumented anywhere a developer would look before this
 * page (TASK-971 F-C1): it produced a 400 on every call.
 *
 * No "Try it" button lives here on purpose: a generated Postman collection
 * (downloaded from a published agent's or workflow's Integration tab) is
 * the sanctioned way to fire a real request, under the developer's own key —
 * never as the signed-in console operator against real tenant data.
 *
 * TASK-975 D1/D2 — the stream ticket authenticates SSE *and* WebSocket, minted
 * by two routes that take different credentials: `POST auth/stream-ticket`
 * (user JWT only, caller-supplied scope) and
 * `POST workflows/{slug}/runs/{runId}/stream-ticket` (API key or service
 * account reachable, scope derived server-side). Documenting the ticket as an
 * SSE-only mechanism was worse than omitting the WebSocket half, because a
 * reader concluded the ticket WAS an SSE concept (F-3).
 */

const AGENT_BODY_EXAMPLE = `POST api/v1/agents/{slug}/invocations

{
  "text": "…",
  "variables": { /* optional */ },
  "context": { /* optional */ }
}`;

const WORKFLOW_BODY_EXAMPLE = `POST api/v1/workflows/{slug}/runs

{
  "input": {
    "…": "…"
  }
}`;

const WORKFLOW_ASYNC_RESPONSE = `HTTP/1.1 202 Accepted

{
  "runId": "…",
  "status": "…",
  "statusUrl": "…",
  "streamUrl": "…"
}`;

const STREAM_TICKET_EXAMPLE = `POST api/v1/auth/stream-ticket                             (user JWT only — caller supplies the scope)

HTTP/1.1 200 OK
{ "ticket": "…", "expiresAt": "…", "scope": "…" }

POST api/v1/workflows/{slug}/runs/{runId}/stream-ticket    (API key or service account — scope is derived)

HTTP/1.1 201 Created
{ "ticket": "…", "expiresAt": "…", "scope": "…", "url": "…" }

SSE  —  GET {sseUrl}                       (Authorization: Bearer …)
SSE  —  GET {sseUrl}?ticket={ticket}       (no Authorization header)
SSE  —  GET {sseUrl}                       (Last-Event-ID: <id>  — resumes)
WS   —  open {url}                         (ticket already in the query string — single-use, consumed on first open)`;

/** The two WebSocket surfaces a developer can reach directly (TASK-975 D2). */
const WEBSOCKET_SURFACES = [
  {
    route: '/ws/workflows',
    handshake: '?slug=&runId=&ticket=[&lastEventId=]',
    scope: 'workflow_run:<runId>',
    notes: 'Same frames as the SSE run stream, one JSON message per frame. Mint the ticket from the run-scoped route above.',
  },
  {
    route: '/ws/stt/stream',
    handshake: '?sessionId=&ticket=',
    scope: 'stt_session:<sessionId>',
    notes: 'Binary PCM16 LE mono up, typed transcript/status/error/resumed events down. Mint the ticket from auth/stream-ticket.',
  },
] as const;

const SSE_FRAME_EXAMPLE = `event: chunk
id: 3
data: {"delta":"…"}

: keepalive

event: workflow.run.completed
data: {"status":"succeeded"}`;

/** The three ways a request can authenticate, and what to know about each one here. */
const CREDENTIAL_CLASSES = [
  { name: 'User JWT', header: 'Authorization: Bearer <jwt>', note: 'A user session.' },
  {
    name: 'API key',
    header: 'X-API-Key: <key>',
    note: 'Minted on API keys — the credential you hand a developer. Can never reach /admin.',
  },
  {
    name: 'Service-account token',
    header: 'X-Service-Account-Token: <token>',
    note: 'Exchanged from client credentials, ~15 min.',
  },
] as const;

/** The six routes this page documents, in the order a developer reaches for them. */
const ROUTES = [
  {
    route: 'POST agents/{slug}/invocations',
    body: 'flat { text?, variables?, context? }',
    modes: 'blocking (default) or stream. NER shares this route and is one-shot: stream is a 400 MODE_UNSUPPORTED.',
    scope: 'agent:invocation:write',
  },
  {
    route: 'POST agents/{slug}/speech',
    body: '{ text } or { ssml }',
    modes: 'streams audio, not JSON.',
    scope: 'agent:invocation:write',
  },
  {
    route: 'POST agents/{slug}/transcriptions',
    body: '{ mediaId (required), consultationId?, language? }',
    modes: '201 with { id, status, sseUrl, … }.',
    scope: 'agent:invocation:write',
  },
  {
    route: 'GET agents?task=…',
    body: '—',
    modes: 'lists published agents.',
    scope: 'agent:definition:read',
  },
  {
    route: 'POST workflows/{slug}/runs',
    body: 'enveloped { input: {…} }',
    modes: 'async (default, 202), blocking (200 or 504 at ~60s), stream (SSE).',
    scope: 'workflow:run:write',
  },
  {
    route: 'GET workflows/{slug}/runs/{runId}',
    body: '—',
    modes: 'run status.',
    scope: 'workflow:run:read',
  },
  {
    route: 'POST workflows/{slug}/runs/{runId}/stream-ticket',
    body: '—',
    modes: '201 with { ticket, expiresAt, scope, url }.',
    scope: 'workflow:run:read',
  },
  {
    route: 'GET workflows/{slug}/schema',
    body: '—',
    modes: '{ slug, versionNumber, triggerKinds, protocols, modes, components, asyncapi }.',
    scope: 'workflow:definition:read',
  },
] as const;

const RESERVED_INPUT_KEYS = ['consultationId', 'externalPatientId', 'userId', 'jobId', 'sessionId'] as const;

export function InvokeGuideScreen() {
  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="Call a published agent or workflow"
          meta={<span>The direct HTTP contract — for when you are not reaching for @arcaai/vox-node or @arcaai/vox.</span>}
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
      footer={<StatusFooter start="Business plane" end={<span>Agent and workflow invocation routes</span>} />}
    >
      <div className="flex flex-col gap-6 pb-2">
        <Card>
          <CardHeader>
            <CardTitle>Your first call</CardTitle>
            <CardDescription>Five steps from zero to a successful response.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>
                Mint an API key on the{' '}
                <Link href="/api-keys" className="underline underline-offset-4">
                  API keys
                </Link>{' '}
                screen — or use your own session JWT.
              </li>
              <li>
                Set your base URL to your gateway origin. Every route on this page sits under the{' '}
                <code className="font-mono text-xs">api/v1</code> prefix.
              </li>
              <li>Pick the route for what you want to do — invoke an agent, or start a workflow run (see “Routes at a glance” below).</li>
              <li>Send the request body in the shape that route expects — agent and workflow bodies are shaped differently (see below).</li>
              <li>Read the response. A 400 on this route family almost always means the two body shapes were swapped.</li>
            </ol>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Flat vs. enveloped bodies</CardTitle>
            <CardDescription>The single most common mistake calling these routes.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">Agent — flat</h2>
                <CodeBlock label="agent invocation body" code={AGENT_BODY_EXAMPLE} />
              </div>
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">Workflow — enveloped</h2>
                <CodeBlock label="workflow run body" code={WORKFLOW_BODY_EXAMPLE} />
              </div>
            </div>
            <Alert role="status">
              <AlertTitle>Mixing the two body shapes produced a 400 on every call.</AlertTitle>
              <AlertDescription>
                An agent invocation takes <code className="font-mono text-xs">{'{ text, variables, context }'}</code> directly. A workflow run
                wraps its payload in <code className="font-mono text-xs">{'{ input: { ... } }'}</code>. Sending one route&apos;s shape to the other
                fails validation immediately.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Routes at a glance</CardTitle>
            <CardDescription>All routes sit under the global <code className="font-mono text-xs">api/v1</code> prefix.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-left">
                    <th scope="col" className="py-2 pr-4 font-medium">Route</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Body</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Modes / response</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Scope</th>
                  </tr>
                </thead>
                <tbody>
                  {ROUTES.map((entry) => (
                    <tr key={entry.route} className="border-b align-top last:border-0">
                      <th scope="row" className="py-3 pr-4 text-left font-normal">
                        <code className="font-mono text-xs">{entry.route}</code>
                      </th>
                      <td className="py-3 pr-4">
                        <code className="font-mono text-xs">{entry.body}</code>
                      </td>
                      <td className="py-3 pr-4">{entry.modes}</td>
                      <td className="py-3 pr-4">
                        <code className="font-mono text-xs">{entry.scope}</code>
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
            <CardTitle>Credentials</CardTitle>
            <CardDescription>All three classes may call every route on this page.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-left">
                    <th scope="col" className="py-2 pr-4 font-medium">Class</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Header</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {CREDENTIAL_CLASSES.map((credential) => (
                    <tr key={credential.name} className="border-b align-top last:border-0">
                      <th scope="row" className="py-3 pr-4 text-left font-medium">{credential.name}</th>
                      <td className="py-3 pr-4">
                        <code className="font-mono text-xs">{credential.header}</code>
                      </td>
                      <td className="py-3 pr-4">{credential.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Alert role="status">
              <AlertTitle>Never send X-Tenant-Id with an API key or a service-account token.</AlertTitle>
              <AlertDescription>The tenant binds to the credential itself, not to a header sent alongside it.</AlertDescription>
            </Alert>
            <Alert role="status">
              <AlertTitle>Workflows carry one more gate than agents.</AlertTitle>
              <AlertDescription>
                Agent routes require authentication only. Workflow routes additionally require a CASL ability on the JWT path —{' '}
                <code className="font-mono text-xs">create:WorkflowRun</code> to start a run,{' '}
                <code className="font-mono text-xs">read:WorkflowRun</code> to read its status or mint a stream ticket. A tenant JWT user who can
                invoke an agent may still get a 403 starting a workflow. An API key carrying{' '}
                <code className="font-mono text-xs">workflow:run:write</code> is unaffected.
              </AlertDescription>
            </Alert>
            <p className="text-sm">
              Scopes:{' '}
              {['agent:invocation:write', 'agent:definition:read', 'workflow:run:write', 'workflow:run:read', 'workflow:definition:read'].map(
                (scope, index, all) => (
                  <span key={scope}>
                    <code className="font-mono text-xs">{scope}</code>
                    {index < all.length - 1 ? ', ' : '.'}
                  </span>
                ),
              )}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Running a workflow: async, then poll or stream</CardTitle>
            <CardDescription>A run does not have to finish before you get an answer back.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="list-disc space-y-2 pl-5 text-sm">
              <li>
                <code className="font-mono text-xs">async</code> (default) — a{' '}
                <code className="font-mono text-xs">202</code> with <code className="font-mono text-xs">runId, status, statusUrl, streamUrl</code>.
              </li>
              <li>
                <code className="font-mono text-xs">blocking</code> — a <code className="font-mono text-xs">200</code>, or a{' '}
                <strong>504 at a hard ~60s ceiling</strong> — the run is still going; switch to streaming.
              </li>
              <li>
                <code className="font-mono text-xs">stream</code> — <code className="font-mono text-xs">text/event-stream</code> directly.
              </li>
            </ul>
            <CodeBlock label="async start response" code={WORKFLOW_ASYNC_RESPONSE} />
            <p className="text-sm">
              Poll <code className="font-mono text-xs">GET workflows/{'{slug}'}/runs/{'{runId}'}</code> for status, or mint a stream ticket and
              connect directly — over SSE <em>or</em> a WebSocket. The ticket is single-use: it is consumed on the first open, so every
              reconnect mints a fresh one.
            </p>
            <CodeBlock label="stream ticket example" code={STREAM_TICKET_EXAMPLE} />
            <Alert role="status">
              <AlertTitle>Two routes mint this ticket, and they take different credentials.</AlertTitle>
              <AlertDescription>
                <code className="font-mono text-xs">POST auth/stream-ticket</code> takes a <strong>user JWT only</strong> — the caller supplies
                the scope string, and it is refused to API keys and service accounts.{' '}
                <code className="font-mono text-xs">POST workflows/{'{slug}'}/runs/{'{runId}'}/stream-ticket</code> is the counterpart for
                unattended callers — reachable by <strong>an API key or a service account</strong> — and derives the scope itself as{' '}
                <code className="font-mono text-xs">workflow_run:{'{runId}'}</code>, so nothing wider than that run can ever be minted.
              </AlertDescription>
            </Alert>
            <Alert role="status">
              <AlertTitle>The same ticket authenticates SSE and WebSocket alike.</AlertTitle>
              <AlertDescription>
                SSE is the default, and the only lane that resumes — pass{' '}
                <code className="font-mono text-xs">Last-Event-ID</code> to pick up where a connection dropped. WebSocket answers one symptom
                only: a proxy that buffers <code className="font-mono text-xs">text/event-stream</code>. See “WebSocket surfaces” below for
                the two endpoints this platform exposes directly.
              </AlertDescription>
            </Alert>
            <Alert role="status">
              <AlertTitle>Reserved input keys are refused with a 400.</AlertTitle>
              <AlertDescription>
                <code className="font-mono text-xs">input</code> must not contain{' '}
                {RESERVED_INPUT_KEYS.map((key, index) => (
                  <span key={key}>
                    <code className="font-mono text-xs">{key}</code>
                    {index < RESERVED_INPUT_KEYS.length - 1 ? ', ' : ''}
                  </span>
                ))}
                . These are stamped by the server itself, never supplied by a caller.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>WebSocket surfaces</CardTitle>
            <CardDescription>
              For a host that cannot hold an SSE connection. Both take the single-use ticket minted above.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b text-left">
                    <th scope="col" className="py-2 pr-4 font-medium">Route</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Handshake</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Scope</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {WEBSOCKET_SURFACES.map((entry) => (
                    <tr key={entry.route} className="border-b align-top last:border-0">
                      <th scope="row" className="py-3 pr-4 text-left font-normal">
                        <code className="font-mono text-xs">{entry.route}</code>
                      </th>
                      <td className="py-3 pr-4">
                        <code className="font-mono text-xs">{entry.handshake}</code>
                      </td>
                      <td className="py-3 pr-4">
                        <code className="font-mono text-xs">{entry.scope}</code>
                      </td>
                      <td className="py-3 pr-4">{entry.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>SSE framing</CardTitle>
            <CardDescription>Both streams speak real Server-Sent Events.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CodeBlock label="SSE frame example" code={SSE_FRAME_EXAMPLE} />
            <ul className="list-disc space-y-2 pl-5 text-sm">
              <li>
                Real <code className="font-mono text-xs">event:</code> / <code className="font-mono text-xs">data:</code> /{' '}
                <code className="font-mono text-xs">id:</code> lines, with a <code className="font-mono text-xs">:keepalive</code> comment every 15
                seconds.
              </li>
              <li>
                The workflow stream&apos;s first frame is a snapshot with no <code className="font-mono text-xs">id:</code> line; the stream ends
                on the <code className="font-mono text-xs">workflow.run.completed</code> event.
              </li>
              <li>
                Agent stream frames relay the text service verbatim — event types <code className="font-mono text-xs">chunk</code>,{' '}
                <code className="font-mono text-xs">reasoning</code>, <code className="font-mono text-xs">meta</code>,{' '}
                <code className="font-mono text-xs">done</code>, <code className="font-mono text-xs">error</code>,{' '}
                <code className="font-mono text-xs">usage</code> — the first frame is always <code className="font-mono text-xs">meta</code>.
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Import into Postman</CardTitle>
            <CardDescription>
              Every published agent and workflow generates its own ready-to-run collection from its <strong>Integration tab</strong> — this
              card only covers importing what you downloaded there.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>Open the agent&apos;s or workflow&apos;s Integration tab and download its collection.</li>
              <li>Open Postman.</li>
              <li>Import → drop the downloaded file.</li>
              <li>
                Set the <code className="font-mono text-xs">apiKey</code> collection variable — it ships empty and never contains a credential.
              </li>
              <li>Send.</li>
            </ol>
            <p className="text-muted-foreground text-sm">
              For a workflow, the run request captures its <code className="font-mono text-xs">runId</code> into a collection variable, so the
              status and stream-ticket requests chain without copy-paste.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>See also</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href="/developer">Developer overview</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/developer/reference">
                <IconBook2 aria-hidden className="size-4" />
                API reference
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/developer/sdk">
                <IconPackage aria-hidden className="size-4" />
                SDK guides
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/api-keys">
                <IconKey aria-hidden className="size-4" />
                API keys
              </Link>
            </Button>
            <Badge variant="outline" className="ml-auto self-center font-mono">
              NER: no ?mode=stream (400 MODE_UNSUPPORTED)
            </Badge>
          </CardContent>
        </Card>
      </div>
    </ScreenTemplate>
  );
}
