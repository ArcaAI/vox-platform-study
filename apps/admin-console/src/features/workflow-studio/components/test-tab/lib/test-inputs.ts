/**
 * Which test inputs a workflow can use (TASK-1036 §10.2, "Test input: only the controls the
 * workflow can use … each shows why it is there").
 *
 * - **Record** when a step is a speech-to-text agent (its slug opens the STT session), or when the
 *   Input shape takes live audio (`STREAM_AUDIO`).
 * - **Type a message** when the Input shape has a `message` kind (the default `default_io` shape).
 * - **Attach** for the shape's DOCUMENT / IMAGE kinds, with their allowed MIME types.
 * - Every other declared kind is offered as JSON (a STRUCTURED kind is an authored schema).
 *
 * The Input shape is the workflow's context schema definition (`{ kinds: [...] }`,
 * `ConsultationContextSchema`), as the composer resolves it.
 */
import { agentNamesOf, nodeDisplayName } from '../../../lib/node-identity';

interface PlanNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

interface PlanAgent {
  slug: string;
  task: string;
  name?: string | null;
}

interface ContextKind {
  key: string;
  label: string;
  primitive: string;
  constraints?: { mimeTypes?: unknown };
}

export interface TestInputPlan {
  record: { agentSlug: string | null; stepLabel: string | null; reason: string } | null;
  message: { label: string; reason: string } | null;
  attach: { mimeTypes: string[]; reason: string } | null;
  /** Declared kinds no dedicated control covers — offered as JSON. */
  extraKinds: Array<{ key: string; label: string; primitive: string }>;
  /** False when the workflow declares no Input shape (the run then takes `{}`). */
  schemaKnown: boolean;
}

const ASR_TASK = 'SPEECH_TO_TEXT';
const FILE_PRIMITIVES: ReadonlySet<string> = new Set(['DOCUMENT', 'IMAGE']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kindsOf(schema: unknown): ContextKind[] {
  if (!isRecord(schema) || !Array.isArray(schema.kinds)) return [];
  return schema.kinds.flatMap((kind) => {
    if (!isRecord(kind) || typeof kind.key !== 'string' || kind.key.length === 0) return [];
    return [
      {
        key: kind.key,
        label: typeof kind.label === 'string' && kind.label.length > 0 ? kind.label : kind.key,
        primitive: typeof kind.primitive === 'string' ? kind.primitive : 'STRUCTURED',
        ...(isRecord(kind.constraints) ? { constraints: kind.constraints as ContextKind['constraints'] } : {}),
      },
    ];
  });
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export function planTestInputs(input: { nodes: readonly PlanNode[]; agentOptions: readonly PlanAgent[]; contextSchema: unknown }): TestInputPlan {
  const taskBySlug = new Map(input.agentOptions.map((agent) => [agent.slug, agent.task]));
  const asrNode = input.nodes.find((node) => {
    if (node.type !== 'core.agent') return false;
    const ref = node.config.agentRef;
    const slug = isRecord(ref) && typeof ref.slug === 'string' ? ref.slug : null;
    return slug !== null && taskBySlug.get(slug) === ASR_TASK;
  });

  const kinds = kindsOf(input.contextSchema);
  const audioKind = kinds.find((kind) => kind.primitive === 'STREAM_AUDIO');

  let record: TestInputPlan['record'] = null;
  if (asrNode) {
    const label = nodeDisplayName(asrNode, input.nodes, agentNamesOf(input.agentOptions));
    record = { agentSlug: (asrNode.config.agentRef as { slug: string }).slug, stepLabel: label, reason: `Shown because “${label}” is a speech-to-text step.` };
  } else if (audioKind) {
    record = { agentSlug: null, stepLabel: null, reason: `Shown because the Input shape takes live audio (“${audioKind.label}”).` };
  }

  const messageKind = kinds.find((kind) => kind.key === 'message');
  const fileKinds = kinds.filter((kind) => FILE_PRIMITIVES.has(kind.primitive));
  const mimeTypes = [
    ...new Set(fileKinds.flatMap((kind) => (Array.isArray(kind.constraints?.mimeTypes) ? kind.constraints.mimeTypes.filter((type): type is string => typeof type === 'string') : []))),
  ];

  return {
    record,
    message: messageKind ? { label: messageKind.label, reason: 'Shown because the Input shape accepts a message.' } : null,
    attach: fileKinds.length > 0 ? { mimeTypes, reason: `Shown because the Input shape accepts ${joinLabels(fileKinds.map((kind) => kind.label))}.` } : null,
    extraKinds: kinds
      .filter((kind) => kind !== messageKind && !FILE_PRIMITIVES.has(kind.primitive) && kind.primitive !== 'STREAM_AUDIO')
      .map(({ key, label, primitive }) => ({ key, label, primitive })),
    schemaKnown: isRecord(input.contextSchema),
  };
}
