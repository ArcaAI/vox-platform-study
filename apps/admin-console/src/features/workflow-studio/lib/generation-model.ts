/**
 * TASK-1036 W2 / §8.6 — the ONLY generation knobs a tenant surface shows: temperature and max
 * output tokens, and only when the bound model supports them (`tenantEditableParams` — reasoning
 * models take no temperature). Everything else is platform-managed and never rendered here.
 *
 * The node writes them as per-node overrides (`overrides.generation.*`, the key the publish gate
 * range-checks against the agent's declared ranges).
 */
import { isAgentTask, tenantEditableParams, type ModelCapabilities } from '@arcaai/workflow-contract';

export interface GenerationField {
  key: 'temperature' | 'maxTokens';
  /** Dotted path in the node config. */
  path: 'overrides.generation.temperature' | 'overrides.generation.maxTokens';
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
}

const FIELDS: Readonly<Record<string, GenerationField>> = {
  'generation.temperature': {
    key: 'temperature',
    path: 'overrides.generation.temperature',
    label: 'Temperature',
    description: 'Lower is more predictable, higher more varied.',
    min: 0,
    max: 2,
    step: 0.1,
  },
  'generation.maxTokens': {
    key: 'maxTokens',
    path: 'overrides.generation.maxTokens',
    label: 'Max output tokens',
    description: 'The longest answer this step may write.',
    min: 1,
    max: 32768,
    step: 1,
  },
};

export function generationFields(task: string | null | undefined, capabilities: ModelCapabilities | null | undefined): GenerationField[] {
  if (!isAgentTask(task)) return [];
  return tenantEditableParams(task, capabilities ?? null)
    .map((path) => FIELDS[path])
    .filter((field): field is GenerationField => field !== undefined);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * `ModelCapabilities` off a model-catalogue row (`CatalogueModelResponse.capabilities`), read
 * defensively — the console's catalogue mirror does not name the field yet. `null` when the row
 * declares none, which hides every capability-gated knob (fail closed, like the gate itself).
 */
export function modelCapabilitiesOf(row: unknown): ModelCapabilities | null {
  if (row === null || typeof row !== 'object') return null;
  const raw = (row as { capabilities?: unknown }).capabilities;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const caps = raw as Record<string, unknown>;
  return {
    supportsTools: caps.supportsTools === true,
    supportsVision: caps.supportsVision === true,
    supportsAttachments: caps.supportsAttachments === true,
    voices: stringList(caps.voices),
    supportedGenerationParams: stringList(caps.supportedGenerationParams),
    ...(caps.reasoning === true ? { reasoning: true } : {}),
  };
}
