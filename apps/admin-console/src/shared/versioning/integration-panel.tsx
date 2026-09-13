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
 */
import { useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconDownload, IconExternalLink, IconInfoCircle } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle, Badge, Button, FieldDescription, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui';
import { GatewayError, getJson } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { publicEnv } from '@/config/public-env';
import { agentContextExample, exampleBodyFromJsonSchema } from '@/shared/docs/example-body';
import { buildPostmanCollection, type PostmanCollection } from '@/shared/docs/postman-collection';
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

const API_KEYS_HREF = '/api-keys';
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

export type IntegrationAgentTask = 'TEXT_GENERATION' | 'SPEECH_TO_TEXT' | 'TEXT_TO_SPEECH' | 'NAMED_ENTITY_RECOGNITION';

interface EndpointDescriptor {
  method: 'POST';
  path: string;
  note?: string;
}

const AGENT_ENDPOINTS: Record<IntegrationAgentTask, EndpointDescriptor> = {
  TEXT_GENERATION: { method: 'POST', path: '/agents/{slug}/invocations', note: '?mode=blocking (default) or ?mode=stream for SSE' },
  SPEECH_TO_TEXT: { method: 'POST', path: '/agents/{slug}/transcriptions' },
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

function LaneTabs({ node, browser, http, postman }: { node: ReactNode; browser: ReactNode; http: ReactNode; postman: ReactNode }) {
  return (
    <Tabs defaultValue="node" className="gap-3">
      <TabsList variant="line">
        <TabsTrigger value="node">Node</TabsTrigger>
        <TabsTrigger value="browser">Browser</TabsTrigger>
        <TabsTrigger value="http">HTTP</TabsTrigger>
        <TabsTrigger value="postman">Postman</TabsTrigger>
      </TabsList>
      <TabsContent value="node" className="flex flex-col gap-3">
        {node}
      </TabsContent>
      <TabsContent value="browser" className="flex flex-col gap-3">
        {browser}
      </TabsContent>
      <TabsContent value="http" className="flex flex-col gap-3">
        {http}
      </TabsContent>
      <TabsContent value="postman" className="flex flex-col gap-3">
        {postman}
      </TabsContent>
    </Tabs>
  );
}

/**
 * Download the collection as a file the developer imports into their own Postman.
 *
 * The JSON is rendered in full beside the button on purpose: a downloadable file that a developer
 * is about to run against their own tenant should be readable BEFORE it is imported, and it is the
 * only way to see for yourself that no credential travels with it.
 */
function PostmanLane({ collection, slug }: { collection: PostmanCollection; slug: string }) {
  const json = useMemo(() => JSON.stringify(collection, null, 2), [collection]);
  const fileName = `hope-${slug}.postman_collection.json`;

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
      <p className="text-muted-foreground text-xs">
        Import this, then fill the <code className="font-mono">apiKey</code> collection variable in your own Postman environment. It ships EMPTY — the console
        never holds your key, and a downloaded file travels through chat threads and tickets.
      </p>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <IconDownload aria-hidden />
          Download the Postman collection
        </Button>
      </div>
      <CodeBlock label={POSTMAN_LABEL} code={json} />
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

/** The two agent tasks `@arcaai/vox` cannot reach BY SLUG, and what it does instead. */
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
  const options: AgentSnippetOptions = { exampleBody, streamable: task === 'TEXT_GENERATION' };

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
      <div>
        <FieldDescription>Endpoint</FieldDescription>
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
            <BrowserAbsence task={task} />
          )
        }
        http={
          <>
            <CodeBlock label={CURL_LABEL} caption="Any HTTP client — the same body, on the api/v1 prefix" code={agentCurlSnippet(slug, snippetTask, options)} />
          </>
        }
        postman={<PostmanLane collection={collection} slug={slug} />}
      />
      <ApiKeysLink />
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
      <Alert role="status">
        <IconInfoCircle aria-hidden />
        <AlertTitle>Published, not active</AlertTitle>
        <AlertDescription>
          This version is frozen, but the public endpoint keeps resolving the ACTIVE version of <code className="font-mono">{slug}</code>. Activate it from
          the version list when it should serve; the endpoint details appear here once it does.
        </AlertDescription>
      </Alert>
    );
  }

  if (!exposable) {
    return (
      <Alert role="status">
        <IconInfoCircle aria-hidden />
        <AlertTitle>Published — not exposable on the public invoke surface</AlertTitle>
        <AlertDescription>
          Only the <code className="font-mono">{EXPOSABLE_PALETTE_KEY}</code> palette is exposable; this workflow&apos;s palette is{' '}
          <code className="font-mono">{paletteKey ?? 'not core'}</code>, so there is no <code className="font-mono">POST /workflows/{slug}/runs</code> to offer. It
          runs through consultations and assignments instead.
        </AlertDescription>
      </Alert>
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
        <Alert role="status">
          <IconInfoCircle aria-hidden />
          <AlertTitle>Published, but not exposed to the public plane</AlertTitle>
          <AlertDescription>
            The gateway answers 404 for this slug on the public invoke surface. Either the tenant&apos;s <strong>Workflow exposure plane</strong> feature is off
            (Feature availability) or the published version is not visible there yet. Once it is on, the endpoint details appear here.
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <Alert variant="destructive">
        <IconAlertTriangle aria-hidden />
        <AlertTitle>Couldn&apos;t resolve this workflow&apos;s endpoints</AlertTitle>
        <AlertDescription>
          The run contract could not be read back{schema.error instanceof GatewayError ? `: ${schema.error.message}` : ''}. Reopen this panel to retry.
        </AlertDescription>
      </Alert>
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
        http={<CodeBlock label={CURL_LABEL} caption="Any HTTP client — start, read, follow" code={workflowCurlSnippet(slug, exampleBody, modes)} />}
        postman={<PostmanLane collection={collection} slug={slug} />}
      />
      <ApiKeysLink />
    </div>
  );
}

export type IntegrationPanelProps = AgentIntegrationProps | WorkflowIntegrationProps;

export function IntegrationPanel(props: IntegrationPanelProps) {
  return props.kind === 'agent' ? <AgentIntegration {...props} /> : <WorkflowIntegration {...props} />;
}
