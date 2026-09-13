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
 */
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconExternalLink, IconInfoCircle } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle, Badge, FieldDescription, Skeleton } from '@arcaai/ui';
import { GatewayError, getJson } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { agentVoxNodeSnippet, workflowVoxNodeSnippet, type SdkSnippetAgentTask } from '@/shared/docs/sdk-snippets';

const API_KEYS_HREF = '/api-keys';
const SOCKET_MODE = 'socket';
/** The ONLY palette the public invoke surface exposes (`EXPOSURE_ALLOWED_PALETTES` server-side). */
export const EXPOSABLE_PALETTE_KEY = 'core';

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

function Snippet({ snippet }: { snippet: string }) {
  return (
    <div>
      <FieldDescription>Invoke it from a backend with @arcaai/vox-node</FieldDescription>
      <div className="group/code relative mt-1" role="group" aria-label="Node.js (@arcaai/vox-node) snippet">
        <pre className="bg-muted text-foreground overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
          <code>{snippet}</code>
        </pre>
        <div className="absolute top-2 right-2">
          <CopyButton value={snippet} label="Copy the vox-node snippet" />
        </div>
      </div>
    </div>
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
}

function AgentIntegration({ slug, task, versionNumber, isActive = true }: AgentIntegrationProps) {
  const endpoint = AGENT_ENDPOINTS[task];
  const path = `${endpoint.method} ${endpoint.path.replace('{slug}', slug)}`;
  const snippet = agentVoxNodeSnippet(slug, snippetTaskOf(task));
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
      <Snippet snippet={snippet} />
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
      <Snippet snippet={workflowVoxNodeSnippet(slug)} />
      <ApiKeysLink />
    </div>
  );
}

export type IntegrationPanelProps = AgentIntegrationProps | WorkflowIntegrationProps;

export function IntegrationPanel(props: IntegrationPanelProps) {
  return props.kind === 'agent' ? <AgentIntegration {...props} /> : <WorkflowIntegration {...props} />;
}
