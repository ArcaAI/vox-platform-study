'use client';

/**
 * `IntegrationPanel` — TASK-965 (O-2 / AG-8 / WF-24): how a developer reaches a PUBLISHED agent or
 * workflow, as a surface that lives on the lineage rather than in the one-shot publish dialog.
 *
 * Everything shown here derives from what is STABLE about the lineage — the slug, the task or
 * palette, and whether the version in front of the admin is the ACTIVE one — never from the
 * publish response, so it can be reopened at any time (LangSmith's `name:tag`, GitHub's release
 * page: the integration surface is the entity itself). The publish dialogs render this same
 * panel as their "published" step, so the two can never disagree.
 *
 * Workflow variant: the resolved run contract (`GET workflows/{slug}/schema`) answers 404 for
 * three legitimate outcomes, each explained on its own terms; the two the client already knows
 * (not activated; a palette that is not exposable) never fire the request.
 *
 * ## TASK-971 lanes B + C — four lanes, and a body that is real
 *
 * **Lane B.** The example body is DERIVED from the lineage's own declared input — `agent.inputSchema`
 * for the invocations route, `components["Workflow_<slug>_Input"]` from the schema response for a
 * run. Both were already in hand and discarded; the panel printed a placeholder instead, so the
 * one example a tenant admin was handed after publishing taught them nothing about their own
 * contract. When no schema is usable the derivation returns `null` and the lane falls back to the
 * documented minimum — an empty `{}` would read as "this route takes an empty body", which is
 * false everywhere here.
 *
 * **Lane C.** Four tabs — Node · Browser · HTTP · Postman — each of which shows a real example OR
 * explains its absence on its own terms. Two browser cells genuinely do not exist: `@arcaai/vox`
 * has no path by slug for `TEXT_TO_SPEECH` (its TTS hooks select by `voice` against the legacy
 * `speech/synthesize`) or for batch `SPEECH_TO_TEXT` (`FileTranscriptionService` posts a pipeline
 * id). Those render as named absences. Inventing a snippet for a route the SDK cannot reach is
 * the worst thing this panel could do, because it carries the authority of the product.
 *
 * The callouts above the tabs carry the two facts no snippet can state for itself: the agent
 * plane's body is FLAT and the workflow plane's is ENVELOPED (mixing them is a 400 on every
 * call), and a workflow run over a USER JWT additionally needs a CASL ability that the agent
 * routes do not require — so the same person who can invoke an agent may get a 403 here.
 *
 * ## TASK-975 lanes A, B, C — the socket lane, and being findable
 *
 * **Lane A.** The panel linked exactly ONE destination, `/api-keys`, so `/developer/invoke`,
 * `/developer/reference` and `/developer/sdk` — three good REST surfaces that already existed —
 * were reported as missing. They are now a footer row on EVERY state, the three workflow early
 * returns included: a developer told their workflow is not exposable is precisely the one who
 * needs an onward path, and used to be handed an alert and nothing else.
 *
 * **Lane B.** A fifth lane, **Socket**, for the two places a socket is a real transport: a
 * workflow run (`transport: 'socket'`, an OPTION on the methods the Node tab already shows) and
 * a realtime STT session (`hope.stt.*` + `RealtimeSttSocket`). Four WebSocket gateways and two
 * SDK socket clients shipped with zero mention anywhere in this console. Its two constants are
 * rendered from `shared/docs/socket-snippets` rather than restated here, so the SSE tab and the
 * Socket tab can never give a developer two different explanations of the same choice.
 *
 * The same ticket also closes the Browser lane's one honest-but-codeless cell: `SPEECH_TO_TEXT`
 * keeps its "no browser path by slug" framing — there genuinely is no `invoke()` for it — and
 * gains the capture snippet that framing names. `TEXT_TO_SPEECH` keeps prose ALONE, because
 * `@arcaai/vox` really has no agent-slug path for synthesis and inventing one would be the worst
 * failure this panel can have: it carries the authority of the product.
 *
 * **Lane C.** The Postman lane leads with a request MANIFEST derived from the same
 * `collection.item` array the file is serialized from (so the two cannot drift), and the raw JSON
 * moves behind a collapsed disclosure — present and complete, because reading it before importing
 * is the only way to see for yourself that no credential travels with it.
 */
import { useId, useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconChevronDown, IconDownload, IconExternalLink, IconInfoCircle } from '@tabler/icons-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FieldDescription,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@arcaai/ui';
import { GatewayError, getJson } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { publicEnv } from '@/config/public-env';
import { agentContextExample, exampleBodyFromJsonSchema } from '@/shared/docs/example-body';
import { buildPostmanCollection, type PostmanCollection, type PostmanItem } from '@/shared/docs/postman-collection';
import {
  agentCurlSnippet,
  agentVoxNodeSnippet,
  agentVoxSnippet,
  workflowCurlSnippet,
  workflowVoxNodeSnippet,
  workflowVoxSnippet,
  type AgentSnippetOptions,
  type SdkSnippetAgentTask,
} from '@/shared/docs/sdk-snippets';
import {
  SOCKET_LANE_RATIONALE,
  SOCKET_RUNTIME_FLOOR,
  sttBrowserCaptureSnippet,
  sttRealtimeVoxNodeSnippet,
  workflowSocketCurlSnippet,
  workflowSocketVoxNodeSnippet,
  workflowSocketVoxSnippet,
} from '@/shared/docs/socket-snippets';

const API_KEYS_HREF = '/api-keys';
const INVOKE_GUIDE_HREF = '/developer/invoke';
/**
 * TASK-975 B5 — `socket` is a LANE, not a `?mode=` value, and filtering it out of the badges and
 * the Postman requests below is CORRECT: `POST /workflows/{slug}/runs?mode=socket` is not a
 * route. A socket run starts exactly like any other (`?mode=async`) and is then FOLLOWED over a
 * run-scoped ticket, so the transport is chosen at the watch, never on the start.
 *
 * The defect this ticket fixed was never the filter — it was filtering the mode and then
 * documenting the lane nowhere. The lane now lives in the **Socket** tab of this panel and in
 * `shared/docs/socket-snippets.ts`; do not "fix" one by breaking the other.
 */
const SOCKET_MODE = 'socket';
/** The flat minimum the invocations route always accepts, when the schema yields nothing usable. */
const FLAT_MINIMUM_BODY: Record<string, unknown> = { text: '…' };
/** The ONLY palette the public invoke surface exposes (`EXPOSURE_ALLOWED_PALETTES` server-side). */
export const EXPOSABLE_PALETTE_KEY = 'core';

const NODE_LABEL = 'Node.js (@arcaai/vox-node) snippet';
const BROWSER_LABEL = 'Browser (@arcaai/vox) snippet';
const BROWSER_KEY_LABEL = 'Browser (@arcaai/vox) API-key variant';
const CURL_LABEL = 'curl snippet';
const POSTMAN_LABEL = 'Postman collection JSON';
const SOCKET_NODE_LABEL = 'Socket (@arcaai/vox-node) snippet';
const SOCKET_BROWSER_LABEL = 'Socket (@arcaai/vox) snippet';
const SOCKET_SHELL_LABEL = 'Socket handshake (websocat) snippet';
const STT_SOCKET_LABEL = 'Realtime STT (@arcaai/vox-node) snippet';

export type IntegrationAgentTask = 'TEXT_GENERATION' | 'SPEECH_TO_TEXT' | 'TEXT_TO_SPEECH' | 'NAMED_ENTITY_RECOGNITION';

interface EndpointDescriptor {
  method: 'POST';
  path: string;
  note?: string;
  /**
   * The realtime lane, where a task has one. A speech-to-text agent is FOR live audio, so its
   * header names the session route and the socket before the batch route — otherwise the first
   * thing a developer reads is the wrong endpoint for the thing they came to do.
   */
  realtime?: { session: string; socket: string; note: string };
}

const AGENT_ENDPOINTS: Record<IntegrationAgentTask, EndpointDescriptor> = {
  TEXT_GENERATION: { method: 'POST', path: '/agents/{slug}/invocations', note: '?mode=blocking (default) or ?mode=stream for SSE' },
  SPEECH_TO_TEXT: {
    method: 'POST',
    path: '/agents/{slug}/transcriptions',
    note: 'Batch: recorded audio in, an sseUrl for progress out. Live audio uses the realtime session above.',
    realtime: {
      session: '/audio/transcription-jobs/stream/session',
      socket: '/ws/stt/stream?sessionId={sessionId}&ticket={ticket}',
      note:
        'POST the session route with { "agentSlug": "{slug}" } on an API key. It answers the sessionId and a SINGLE-USE ticket; open the socket with both, send PCM16 LE mono frames, and read transcript / status / error / resumed events. The Socket lane has the code.',
    },
  },
  TEXT_TO_SPEECH: { method: 'POST', path: '/agents/{slug}/speech' },
  // The SAME route as text generation, deliberately without the `?mode=stream` note: token
  // classification is one-shot, and `mode=stream` on it is a 400, not a slower answer.
  NAMED_ENTITY_RECOGNITION: { method: 'POST', path: '/agents/{slug}/invocations' },
};

/** NER shares `hope.agents.invoke(slug, { text })` with text generation — same route, same call, only the `output` differs. */
function snippetTaskOf(task: IntegrationAgentTask): SdkSnippetAgentTask {
  return task === 'NAMED_ENTITY_RECOGNITION' ? 'TEXT_GENERATION' : task;
}

function ApiKeysLink() {
  return (
    <Link href={API_KEYS_HREF} className="text-foreground inline-flex w-fit items-center gap-1 text-sm hover:underline">
      <IconExternalLink aria-hidden className="size-3.5" />
      Mint an API key to call it (API Keys)
    </Link>
  );
}

/**
 * TASK-975 A1 — the other half of the integration story.
 *
 * The REST documentation was never missing; nothing pointed at it. Each label says what the
 * destination ANSWERS rather than naming the screen, because a developer standing on this panel
 * is choosing between questions, not between pages.
 */
const DEVELOPER_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: INVOKE_GUIDE_HREF, label: 'How to invoke (the direct HTTP contract)' },
  { href: '/developer/reference', label: 'API reference (every route)' },
  { href: '/developer/sdk', label: 'SDK guides (both SDKs)' },
];

/**
 * The footer of every panel state — including the three workflow early returns (A2), where an
 * alert used to be the entire answer.
 */
function IntegrationLinks() {
  return (
    <div className="flex flex-col gap-1.5 border-t pt-3">
      <ApiKeysLink />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {DEVELOPER_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs hover:underline">
            <IconExternalLink aria-hidden className="size-3" />
            {link.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * A2 — a state the panel cannot offer lanes for is still an integration surface. Whatever the
 * explanation is, it is followed by the same way out.
 */
function PanelState({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      {children}
      <IntegrationLinks />
    </div>
  );
}

function CodeBlock({ label, caption, code }: { label: string; caption?: string; code: string }) {
  return (
    <div>
      {caption ? <FieldDescription>{caption}</FieldDescription> : null}
      <div className="group/code relative mt-1" role="group" aria-label={label}>
        <pre className="bg-muted text-foreground overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
        <div className="absolute top-2 right-2">
          <CopyButton value={code} label={`Copy the ${label}`} />
        </div>
      </div>
    </div>
  );
}

/** A static aside, not a live region: `role="note"` so it is not announced on every re-render. */
function Callout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Alert role="note">
      <IconInfoCircle aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/**
 * `socket` is OPTIONAL and sits between HTTP and Postman: a socket is a real transport for a
 * workflow run and for a realtime STT session, and for nothing else this panel describes. An
 * always-present tab would have had to explain its own emptiness on three tasks out of four.
 */
function LaneTabs({
  node,
  browser,
  http,
  socket,
  postman,
  leadWithSocket = false,
}: {
  node: ReactNode;
  browser: ReactNode;
  http: ReactNode;
  socket?: ReactNode;
  postman: ReactNode;
  /** The socket lane comes first and opens selected — for the task whose primary transport it is. */
  leadWithSocket?: boolean;
}) {
  const socketLeads = Boolean(socket) && leadWithSocket;
  const socketTrigger = socket ? <TabsTrigger value="socket">Socket</TabsTrigger> : null;
  const socketContent = socket ? (
    <TabsContent value="socket" className="flex flex-col gap-3">
      {socket}
    </TabsContent>
  ) : null;
  return (
    <Tabs defaultValue={socketLeads ? 'socket' : 'node'} className="gap-3">
      <TabsList variant="line">
        {socketLeads ? socketTrigger : null}
        <TabsTrigger value="node">Node</TabsTrigger>
        <TabsTrigger value="browser">Browser</TabsTrigger>
        <TabsTrigger value="http">HTTP</TabsTrigger>
        {socketLeads ? null : socketTrigger}
        <TabsTrigger value="postman">Postman</TabsTrigger>
      </TabsList>
      {socketLeads ? socketContent : null}
      <TabsContent value="node" className="flex flex-col gap-3">
        {node}
      </TabsContent>
      <TabsContent value="browser" className="flex flex-col gap-3">
        {browser}
      </TabsContent>
      <TabsContent value="http" className="flex flex-col gap-3">
        {http}
      </TabsContent>
      {socketLeads ? null : socketContent}
      <TabsContent value="postman" className="flex flex-col gap-3">
        {postman}
      </TabsContent>
    </Tabs>
  );
}

/**
 * TASK-975 B3 — the two facts no socket snippet can state for itself, rendered VERBATIM from the
 * shared constants rather than restated here. A developer comparing the HTTP tab with this one is
 * then comparing transports, not two different explanations of the same choice.
 */
function WorkflowSocketRationale() {
  return (
    <Callout title="SSE is still the default">
      <p>{SOCKET_LANE_RATIONALE}</p>
      <p>{SOCKET_RUNTIME_FLOOR}</p>
    </Callout>
  );
}

/**
 * The STT lane states the runtime FLOOR — which applies wherever a socket is offered — but not
 * the workflow rationale above, which would be false here: a live session has no SSE lane to
 * prefer. `/ws/stt/stream` is the transport, not an alternative to one.
 */
function SttSocketNote() {
  return (
    <Callout title="Here the socket IS the transport">
      <p>
        A live session has no SSE lane to fall back to — <code className="font-mono">/ws/stt/stream</code> is how realtime audio is carried, so the choice the
        workflow lane offers does not arise. Recorded audio goes to{' '}
        <code className="font-mono">{'POST /agents/{slug}/transcriptions'}</code> instead, which answers an <code className="font-mono">sseUrl</code> for
        progress.
      </p>
      <p>{SOCKET_RUNTIME_FLOOR}</p>
    </Callout>
  );
}

/**
 * One manifest row's path, rebuilt the way the collection's own `buildUrl` builds `raw` — from
 * `url.path` and `url.query`, never from a second copy of the route. C1's whole point is that the
 * manifest cannot drift from the file it sits above.
 */
function requestPathOf(item: PostmanItem): string {
  const query = item.request.url.query ?? [];
  const search = query.length > 0 ? `?${query.map((entry) => `${entry.key}=${entry.value}`).join('&')}` : '';
  return `/${item.request.url.path.join('/')}${search}`;
}

/**
 * Download the collection as a file the developer imports into their own Postman.
 *
 * TASK-975 lane C. The file was always correct and always unreadable: ~200 lines of raw JSON with
 * nothing saying what was inside it. It now leads with a MANIFEST — one row per request, derived
 * from the same `collection.item` array the JSON is serialized from — and the file itself moves
 * behind a disclosure.
 *
 * The JSON stays present and complete rather than being summarised away: a downloadable file a
 * developer is about to run against their own tenant should be readable BEFORE it is imported, and
 * it is the only way to see for yourself that no credential travels with it.
 */
function PostmanLane({ collection, slug }: { collection: PostmanCollection; slug: string }) {
  const json = useMemo(() => JSON.stringify(collection, null, 2), [collection]);
  const manifestId = useId();
  const fileName = `hope-${slug}.postman_collection.json`;
  // C3 — the origin the downloaded file will carry, read off the collection rather than re-derived,
  // so what this line promises is what the file does.
  const baseUrl = collection.variable.find((entry) => entry.key === 'baseUrl')?.value ?? '';

  function download() {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div>
        <FieldDescription id={manifestId}>Requests in this collection ({collection.item.length})</FieldDescription>
        <ul aria-labelledby={manifestId} className="mt-1 flex flex-col gap-1.5 rounded-md border p-2">
          {collection.item.map((item) => (
            <li key={item.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
              <Badge variant="outline" className="font-mono">
                {item.request.method}
              </Badge>
              <code className="text-muted-foreground font-mono break-all">{requestPathOf(item)}</code>
              <span className="text-foreground">{item.name}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-muted-foreground text-xs">
        Every request resolves against <code className="font-mono">{baseUrl}</code>, the gateway origin this console is configured for. Import the file, then
        fill the <code className="font-mono">apiKey</code> collection variable in your own Postman environment: it ships EMPTY, because the console never holds
        your key and a downloaded file travels through chat threads and tickets.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <IconDownload aria-hidden />
          Download the Postman collection
        </Button>
        <Link href={INVOKE_GUIDE_HREF} className="text-foreground inline-flex items-center gap-1 text-xs hover:underline">
          <IconExternalLink aria-hidden className="size-3.5" />
          Import walkthrough
        </Link>
      </div>

      <Collapsible className="rounded-md border">
        <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-xs font-medium outline-none focus-visible:ring-[3px]">
          Read the raw collection JSON
          <IconChevronDown aria-hidden className="size-3.5" />
        </CollapsibleTrigger>
        <CollapsibleContent className="px-2 pb-2">
          <CodeBlock label={POSTMAN_LABEL} code={json} />
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

function NotActiveNote({ slug }: { slug: string }) {
  return (
    <Alert role="status">
      <IconInfoCircle aria-hidden />
      <AlertTitle>Published, not active</AlertTitle>
      <AlertDescription>
        This version is frozen, but the endpoint keeps resolving the ACTIVE version of <code className="font-mono">{slug}</code>. Activate it from the
        version list when it should serve.
      </AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface AgentIntegrationProps {
  kind: 'agent';
  slug: string;
  task: IntegrationAgentTask;
  /** The version the admin is looking at; the endpoint always resolves the ACTIVE one. */
  versionNumber?: number;
  /** Whether that version is the active one. Default `true`. */
  isActive?: boolean;
  /**
   * The agent's own declared input (`Agent.inputSchema`). Every lane's example body derives from
   * it; `null`/absent falls back to the documented flat minimum rather than an empty object.
   */
  inputSchema?: Record<string, unknown> | null;
  /**
   * TASK-971 FU-1 — `Agent.compiledConfig`, stamped at publish. Carries the OTHER half of the
   * example: the instruction's `trigger.*` bindings (and a bound context schema when there is
   * one), which `inputSchema` never declares. Without it the rendered example is refused by
   * agents whose prompt binds clinical context.
   */
  compiledConfig?: Record<string, unknown> | null;
}

/**
 * The two agent tasks `@arcaai/vox` cannot reach BY SLUG, and what it does instead.
 *
 * TASK-975 B4 keeps this framing word for word and adds the snippet BENEATH it for
 * `SPEECH_TO_TEXT` (see `AgentIntegration`) — there is no `invoke()` for realtime speech because
 * it is a capture session, which is a fact about the shape of the integration, not a gap in the
 * docs. `TEXT_TO_SPEECH` gets no snippet at any point: `@arcaai/vox` genuinely has no agent-slug
 * path for synthesis.
 */
function BrowserAbsence({ task }: { task: IntegrationAgentTask }) {
  return (
    <Alert role="note">
      <IconInfoCircle aria-hidden />
      <AlertTitle>No browser path by slug</AlertTitle>
      <AlertDescription>
        {task === 'TEXT_TO_SPEECH' ? (
          <p>
            <code className="font-mono">@arcaai/vox</code> synthesizes through <code className="font-mono">useTtsPlayback</code> /{' '}
            <code className="font-mono">useTtsStream</code>, which select a <code className="font-mono">voice</code> against{' '}
            <code className="font-mono">speech/synthesize</code> — the legacy route — and never name a published agent.
          </p>
        ) : (
          <>
            <p>
              Realtime speech-to-text is a CAPTURE session, not an invocation:{' '}
              <code className="font-mono">{'audio.start({ agentSlug })'}</code> streams the microphone to the gateway, which resolves the agent there.
            </p>
            <p>
              A recorded file goes to <code className="font-mono">audio/transcription-jobs/transcribe</code>, which still selects a pipeline id rather than an
              agent slug.
            </p>
          </>
        )}
        <p>There is no browser call that names this agent, so this panel writes none. The Node and HTTP lanes reach it by slug from a server.</p>
      </AlertDescription>
    </Alert>
  );
}

function AgentIntegration({ slug, task, versionNumber, isActive = true, inputSchema, compiledConfig }: AgentIntegrationProps) {
  const endpoint = AGENT_ENDPOINTS[task];
  const path = `${endpoint.method} ${endpoint.path.replace('{slug}', slug)}`;
  const snippetTask = snippetTaskOf(task);
  // `inputSchema` governs the INVOCATIONS body. `/speech` and `/transcriptions` take a fixed
  // gateway shape (`{ text | ssml }`, `{ mediaId, … }`) the agent's own schema does not describe,
  // so deriving one for them would be a guess dressed as a contract.
  const invocable = snippetTask === 'TEXT_GENERATION';
  // TASK-971 FU-1 — `inputSchema` is only half the body. An agent's instruction binds
  // `trigger.context.*` paths that schema never declares (the gateway withholds `context` from its
  // `additionalProperties: false` check and validates it against the bound context schema instead),
  // so an example built from the schema alone is refused by every agent that binds clinical
  // context. `context` is a SIBLING of `text` — the body stays flat.
  const contextExample = invocable ? agentContextExample(compiledConfig) : null;
  const schemaExample = invocable ? exampleBodyFromJsonSchema(inputSchema) : null;
  const exampleBody = contextExample ? { ...(schemaExample ?? FLAT_MINIMUM_BODY), context: contextExample } : schemaExample;
  // NER shares the route but is one-shot: `?mode=stream` on it is a 400 `MODE_UNSUPPORTED`.
  // `baseUrl` (TASK-975 C4): the HTTP lane used to print `https://your-gateway.example.com`
  // while the Postman tab two clicks away injected the console's real origin — two answers to
  // one question, in one panel.
  const options: AgentSnippetOptions = { exampleBody, streamable: task === 'TEXT_GENERATION', baseUrl: publicEnv.apiHost };

  const collection = buildPostmanCollection({
    kind: 'agent',
    slug,
    task: snippetTask,
    // `snippetTask` has already folded NER into TEXT_GENERATION — they share the route — so the
    // builder cannot tell them apart on `task` alone and would emit the `?mode=stream` request
    // that NER answers with a 400. Say which one this is.
    isNamedEntityRecognition: task === 'NAMED_ENTITY_RECOGNITION',
    // The per-task routes (`/speech`, `/transcriptions`) are the builder's to select — lane D.
    exampleBody: invocable ? exampleBody : null,
    baseUrl: publicEnv.apiHost,
  });

  return (
    <div className="flex flex-col gap-4">
      {!isActive ? <NotActiveNote slug={slug} /> : null}
      {/* Captions, not headings: the panel is hosted under a drawer/dialog title and a heading
          here would skip a level (rule 11 §6). */}
      {endpoint.realtime ? (
        <div>
          <FieldDescription>Realtime session (WebSocket)</FieldDescription>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="bg-muted rounded-md border px-2 py-1 font-mono text-xs">{`POST ${endpoint.realtime.session}`}</code>
            <CopyButton value={`POST ${endpoint.realtime.session}`} label="Copy the realtime session route" />
            <span className="text-muted-foreground text-xs">then</span>
            <code className="bg-muted rounded-md border px-2 py-1 font-mono text-xs">{endpoint.realtime.socket}</code>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">{endpoint.realtime.note.replace('{slug}', slug)}</p>
        </div>
      ) : null}
      <div>
        <FieldDescription>{endpoint.realtime ? 'Batch endpoint' : 'Endpoint'}</FieldDescription>
        <div className="mt-1 flex items-center gap-2">
          <code className="bg-muted rounded-md border px-2 py-1 font-mono text-xs">{path}</code>
          <CopyButton value={path} label="Copy the endpoint" />
        </div>
        {endpoint.note ? <p className="text-muted-foreground mt-1 text-xs">{endpoint.note}</p> : null}
        <p className="text-muted-foreground mt-1 text-xs">
          Resolves the active version of <code className="font-mono">{slug}</code>
          {isActive && versionNumber ? ` (v${versionNumber}, this one)` : ''}. Reach it on an API key holding the business-plane scopes — never the admin plane.
        </p>
      </div>

      {/* Every agent route is flat, not only `invocations` — so the warning is not conditional,
          only the field list is. A developer holding both an agent slug and a workflow slug is
          exactly the person who will wrap this one by mistake. */}
      <Callout title="The body is flat">
        {invocable ? (
          <p>
            This route reads <code className="font-mono">text</code>, <code className="font-mono">variables</code> and <code className="font-mono">context</code>{' '}
            at the top level, plus whatever this agent&apos;s own input schema declares.
          </p>
        ) : task === 'TEXT_TO_SPEECH' ? (
          <p>
            This route reads <code className="font-mono">text</code> — or <code className="font-mono">ssml</code> instead — at the top level, and answers audio
            rather than JSON.
          </p>
        ) : (
          <p>
            This route reads <code className="font-mono">mediaId</code> at the top level, optionally with <code className="font-mono">consultationId</code> and{' '}
            <code className="font-mono">language</code>.
          </p>
        )}
        <p>
          The <code className="font-mono">{'{ "input": … }'}</code> envelope belongs to the workflow plane; sending it here is a 400 on every call.
        </p>
      </Callout>

      <LaneTabs
        leadWithSocket={task === 'SPEECH_TO_TEXT'}
        node={<CodeBlock label={NODE_LABEL} caption="Invoke it from a backend with @arcaai/vox-node" code={agentVoxNodeSnippet(slug, snippetTask, options)} />}
        browser={
          invocable ? (
            <>
              <CodeBlock label={BROWSER_LABEL} caption="Call it from a React app with @arcaai/vox" code={agentVoxSnippet(slug, 'accessToken', options)} />
              <CodeBlock label={BROWSER_KEY_LABEL} code={agentVoxSnippet(slug, 'apiKey', options)} />
              <p className="text-muted-foreground text-xs">
                Prefer the signed-in user&apos;s session. A key shipped in a browser bundle is readable by anyone who opens the page — if you need one anyway,
                mint it with <code className="font-mono">agent:invocation:write</code> alone, which bounds what a lifted key can do to invoking agents.
              </p>
            </>
          ) : (
            <>
              <BrowserAbsence task={task} />
              {/* The absence note NAMES this call; printing it is what turns an accurate sentence
                  into something a developer can run. TTS deliberately gets no equivalent. */}
              {task === 'SPEECH_TO_TEXT' ? (
                <CodeBlock label={BROWSER_LABEL} caption="The capture session that path names, with @arcaai/vox" code={sttBrowserCaptureSnippet(slug)} />
              ) : null}
            </>
          )
        }
        http={
          <>
            <CodeBlock label={CURL_LABEL} caption="Any HTTP client — the same body, on the api/v1 prefix" code={agentCurlSnippet(slug, snippetTask, options)} />
          </>
        }
        socket={
          task === 'SPEECH_TO_TEXT' ? (
            <>
              <SttSocketNote />
              <CodeBlock
                label={STT_SOCKET_LABEL}
                caption="Drive a live session from a server that ALREADY has audio — a telephony bridge, a recording relay"
                code={sttRealtimeVoxNodeSnippet(slug)}
              />
            </>
          ) : undefined
        }
        postman={<PostmanLane collection={collection} slug={slug} />}
      />
      <IntegrationLinks />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export interface WorkflowIntegrationProps {
  kind: 'workflow';
  slug: string;
  /** Whether the version in front of the admin is the ACTIVE one. Default `true`. */
  isActive?: boolean;
  /** Whether the palette is exposable on the public invoke surface (only `core` is). Default `true`. */
  exposable?: boolean;
  /** Named in the not-exposable explanation. */
  paletteKey?: string;
}

interface WorkflowRunSchemaLike {
  modes?: string[];
  /** OpenAPI 3.1 entries keyed `Workflow_<slug>_Input` / `_Output` — the run body's real shape. */
  components?: Record<string, Record<string, unknown>>;
}

/** `discharge-summary` → `Workflow_discharge_summary_Input` (component names are `^[a-zA-Z0-9.\-_]+$`). */
function inputComponentName(slug: string): string {
  return `Workflow_${slug.replace(/[^A-Za-z0-9_]/g, '_')}_Input`;
}

/** The resolved run contract of a published + active + exposable workflow. 404 = not exposed. */
function useWorkflowRunSchema(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: ['integration', 'workflow-run-schema', slug],
    queryFn: () => getJson<WorkflowRunSchemaLike>(`workflows/${encodeURIComponent(slug)}/schema`),
    enabled,
    retry: false,
  });
}

function WorkflowIntegration({ slug, isActive = true, exposable = true, paletteKey }: WorkflowIntegrationProps) {
  const schema = useWorkflowRunSchema(slug, isActive && exposable);

  if (!isActive) {
    return (
      <PanelState>
        <Alert role="status">
          <IconInfoCircle aria-hidden />
          <AlertTitle>Published, not active</AlertTitle>
          <AlertDescription>
            This version is frozen, but the public endpoint keeps resolving the ACTIVE version of <code className="font-mono">{slug}</code>. Activate it from
            the version list when it should serve; the endpoint details appear here once it does.
          </AlertDescription>
        </Alert>
      </PanelState>
    );
  }

  if (!exposable) {
    return (
      <PanelState>
        <Alert role="status">
          <IconInfoCircle aria-hidden />
          <AlertTitle>Published — not exposable on the public invoke surface</AlertTitle>
          <AlertDescription>
            Only the <code className="font-mono">{EXPOSABLE_PALETTE_KEY}</code> palette is exposable; this workflow&apos;s palette is{' '}
            <code className="font-mono">{paletteKey ?? 'not core'}</code>, so there is no <code className="font-mono">POST /workflows/{slug}/runs</code> to
            offer. It runs through consultations and assignments instead.
          </AlertDescription>
        </Alert>
      </PanelState>
    );
  }

  if (schema.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (schema.isError) {
    const notExposed = schema.error instanceof GatewayError && schema.error.isNotFound;
    if (notExposed) {
      return (
        <PanelState>
          <Alert role="status">
            <IconInfoCircle aria-hidden />
            <AlertTitle>Published, but not exposed to the public plane</AlertTitle>
            <AlertDescription>
              The gateway answers 404 for this slug on the public invoke surface. Either the tenant&apos;s <strong>Workflow exposure plane</strong> feature is
              off (Feature availability) or the published version is not visible there yet. Once it is on, the endpoint details appear here.
            </AlertDescription>
          </Alert>
        </PanelState>
      );
    }
    return (
      <PanelState>
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden />
          <AlertTitle>Couldn&apos;t resolve this workflow&apos;s endpoints</AlertTitle>
          <AlertDescription>
            The run contract could not be read back{schema.error instanceof GatewayError ? `: ${schema.error.message}` : ''}. Reopen this panel to retry.
          </AlertDescription>
        </Alert>
      </PanelState>
    );
  }

  const runPath = `POST /workflows/${slug}/runs`;
  const modes = (schema.data?.modes ?? []).filter((mode) => mode !== SOCKET_MODE);
  // The schema response carried the run body's real shape all along; the panel used to read
  // `modes` and drop the rest (TASK-971 F-B1).
  const exampleBody = exampleBodyFromJsonSchema(schema.data?.components?.[inputComponentName(slug)]);
  const collection = buildPostmanCollection({ kind: 'workflow', slug, modes, exampleBody, baseUrl: publicEnv.apiHost });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <code className="bg-muted rounded-md border px-2 py-1 font-mono text-xs">{runPath}</code>
        <CopyButton value={runPath} label="Copy the run endpoint" />
      </div>
      {modes.length > 0 ? (
        <div>
          <FieldDescription>
            Accepted <code className="font-mono">?mode=</code> values
          </FieldDescription>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {modes.map((mode) => (
              <Badge key={mode} variant="outline" className="font-mono">
                {mode}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <Callout title="The body is enveloped">
        A run takes <code className="font-mono">{'{ "input": { … } }'}</code>; the agent plane takes its input flat, and mixing the two is a 400 on every call.{' '}
        <code className="font-mono">input</code> may not carry <code className="font-mono">consultationId</code>,{' '}
        <code className="font-mono">externalPatientId</code>, <code className="font-mono">userId</code>, <code className="font-mono">jobId</code> or{' '}
        <code className="font-mono">sessionId</code> — the server stamps those itself.
      </Callout>
      <Callout title="A user session is not enough">
        Over a user JWT, starting a run needs the <code className="font-mono">create:WorkflowRun</code> ability (
        <code className="font-mono">read:WorkflowRun</code> for the status read and the stream ticket). An API key carrying{' '}
        <code className="font-mono">workflow:run:write</code> is unaffected — so someone who can invoke an agent may still get a 403 here.
      </Callout>

      <LaneTabs
        node={<CodeBlock label={NODE_LABEL} caption="Run it from a backend with @arcaai/vox-node" code={workflowVoxNodeSnippet(slug, exampleBody)} />}
        browser={
          <>
            <CodeBlock label={BROWSER_LABEL} caption="Start and follow a run from a React app with @arcaai/vox" code={workflowVoxSnippet(slug, exampleBody)} />
            <p className="text-muted-foreground text-xs">
              The browser starts a run asynchronously and watches it. Holding a blocking fetch open against the gateway&apos;s ~60s ceiling from a UI thread, or
              putting the whole event stream on a POST that cannot be resumed, are both worse than the 202-then-watch it does instead.
            </p>
          </>
        }
        http={
          <CodeBlock label={CURL_LABEL} caption="Any HTTP client — start, read, follow" code={workflowCurlSnippet(slug, exampleBody, modes, publicEnv.apiHost)} />
        }
        socket={
          <>
            <WorkflowSocketRationale />
            <CodeBlock
              label={SOCKET_NODE_LABEL}
              caption="One option on the methods the Node tab already shows — @arcaai/vox-node"
              code={workflowSocketVoxNodeSnippet(slug)}
            />
            <CodeBlock label={SOCKET_BROWSER_LABEL} caption="The same option in a React app — @arcaai/vox" code={workflowSocketVoxSnippet(slug)} />
            <CodeBlock
              label={SOCKET_SHELL_LABEL}
              caption="Without an SDK: mint the RUN-SCOPED ticket, then open the url it answers"
              code={workflowSocketCurlSnippet(slug, publicEnv.apiHost)}
            />
          </>
        }
        postman={<PostmanLane collection={collection} slug={slug} />}
      />
      <IntegrationLinks />
    </div>
  );
}

export type IntegrationPanelProps = AgentIntegrationProps | WorkflowIntegrationProps;

export function IntegrationPanel(props: IntegrationPanelProps) {
  return props.kind === 'agent' ? <AgentIntegration {...props} /> : <WorkflowIntegration {...props} />;
}
