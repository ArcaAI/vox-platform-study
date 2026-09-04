/**
 * TASK-864 A7 — generated documentation for a PUBLISHED workflow, from its Trigger and Output
 * nodes: the OpenAPI component pair `Workflow_<slug>_Input` / `Workflow_<slug>_Output`, the
 * `?mode=` the Output's protocols admit, and an AsyncAPI fragment describing the stream/socket
 * frames. Pure functions over the graph — no I/O, no Nest — so the same code serves the
 * per-tenant `GET /workflows/{slug}/schema` route (the developer portal's source) and any future
 * offline emitter.
 *
 * Why not baked into the committed `openapi.json`: that artifact is emitted OFFLINE with no
 * database (`apps/api/src/scripts/emit-openapi.ts`), and a workflow's schema is TENANT data. The
 * static document keeps describing the generic route family; the per-definition components are
 * served live, per tenant, and the portal composes them. It lives here rather than in
 * `apps/api/src/openapi` because the gateway does not depend on `@arcaai/workflow-contract`
 * directly — this package does.
 */
import { declaredIoSchemas, declaredOutputProtocols, declaredTriggerKinds, type CoreOutputProtocol, type WorkflowGraph } from '@arcaai/workflow-contract';

export interface WorkflowSchemaDescription {
  slug: string;
  versionNumber: number;
  triggerKinds: string[];
  protocols: CoreOutputProtocol[];
  /** Which `?mode=` values `POST /workflows/{slug}/runs` accepts for this definition. */
  modes: Array<'async' | 'blocking' | 'stream'>;
  /** OpenAPI 3.1 `components.schemas` entries keyed `Workflow_<slug>_Input` / `_Output`. */
  components: Record<string, Record<string, unknown>>;
  /** An AsyncAPI 3 fragment for the SSE / WebSocket frames of a run. */
  asyncapi: Record<string, unknown>;
}

/** `discharge-summary` → `Workflow_discharge_summary_Input` (a component name must be `^[a-zA-Z0-9.\-_]+$`). */
export function componentName(slug: string, side: 'Input' | 'Output'): string {
  return `Workflow_${slug.replace(/[^A-Za-z0-9_]/g, '_')}_${side}`;
}

/** The `?mode=` values the declared protocols admit — `async` always; `http` → blocking; `http-sse` → stream. */
export function modesFor(protocols: readonly CoreOutputProtocol[]): Array<'async' | 'blocking' | 'stream'> {
  const modes: Array<'async' | 'blocking' | 'stream'> = ['async'];
  if (protocols.length === 0 || protocols.includes('http')) modes.push('blocking');
  if (protocols.length === 0 || protocols.includes('http-sse')) modes.push('stream');
  return modes;
}

const RUN_EVENT_ENVELOPE_SCHEMA = Object.freeze({
  type: 'object',
  description: 'One async-contract envelope. `type` is the event; `payload` its body; `idempotencyKey` is derived from intent.',
  required: ['schemaVersion', 'id', 'tenantId', 'type', 'occurredAt', 'idempotencyKey', 'payload'],
  properties: {
    schemaVersion: { type: 'integer' },
    id: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    type: {
      type: 'string',
      enum: ['workflow.run.progress', 'workflow.run.completed', 'workflow.node.started', 'workflow.node.completed', 'workflow.node.failed', 'workflow.loop.iteration', 'workflow.token.delta'],
    },
    occurredAt: { type: 'string', format: 'date-time' },
    correlationId: { type: 'string', description: 'The run id.' },
    causationId: { type: ['string', 'null'] },
    idempotencyKey: { type: 'string' },
    payload: { type: 'object', additionalProperties: true },
  },
});

/**
 * Describe one published definition. `graph` is the authored graph; a legacy (non-`core`) graph
 * yields open `object` schemas and every mode, exactly as the route family behaves for it today.
 */
export function describeWorkflow(slug: string, versionNumber: number, graph: Pick<WorkflowGraph, 'nodes'>): WorkflowSchemaDescription {
  const { input, output } = declaredIoSchemas(graph);
  const protocols = declaredOutputProtocols(graph);
  const triggerKinds = declaredTriggerKinds(graph);
  const inputName = componentName(slug, 'Input');
  const outputName = componentName(slug, 'Output');

  const components: Record<string, Record<string, unknown>> = {
    [inputName]: {
      title: inputName,
      description: `The trigger payload of workflow '${slug}' (version ${versionNumber}) — the body of POST /workflows/${slug}/runs (\`input\`) and of the inbound webhook.`,
      ...(input ?? { type: 'object', additionalProperties: true }),
    },
    [outputName]: {
      title: outputName,
      description: `The result of workflow '${slug}' (version ${versionNumber}) — what \`resultRef\` / the \`workflow.run.completed\` payload resolves to.`,
      ...(output ?? { type: 'object', additionalProperties: true }),
    },
  };

  const channels: Record<string, unknown> = {};
  if (protocols.length === 0 || protocols.includes('http-sse')) {
    channels[`workflows/${slug}/runs/{runId}/stream`] = {
      address: `/api/v1/workflows/${slug}/runs/{runId}/stream`,
      description: 'Server-Sent Events. Snapshot-then-delta; each frame `id` is an opaque resume token (echo it as `Last-Event-ID`).',
      bindings: { http: { method: 'GET' } },
      messages: { runEvent: { $ref: '#/components/messages/runEvent' } },
    };
  }
  if (protocols.includes('socket')) {
    channels[`ws/workflows`] = {
      address: `/ws/workflows?slug=${slug}&runId={runId}&ticket={ticket}`,
      description: 'WebSocket. The same frames as the SSE channel, one JSON text message `{ event, id?, data }` each; authenticate with a single-use stream ticket scoped `workflow_run:<runId>`.',
      bindings: { ws: { method: 'GET' } },
      messages: { runEvent: { $ref: '#/components/messages/runEvent' } },
    };
  }

  const asyncapi = {
    asyncapi: '3.0.0',
    info: { title: `Workflow ${slug} run events`, version: String(versionNumber) },
    channels,
    components: {
      messages: {
        runEvent: { name: 'runEvent', title: 'Workflow run event', contentType: 'application/json', payload: { $ref: '#/components/schemas/RunEventEnvelope' } },
      },
      schemas: { RunEventEnvelope: RUN_EVENT_ENVELOPE_SCHEMA, [outputName]: components[outputName] },
    },
  };

  return { slug, versionNumber, triggerKinds, protocols, modes: modesFor(protocols), components, asyncapi };
}
