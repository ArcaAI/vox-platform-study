/**
 * TASK-1036 §10.1 — the ONE picker every data-taking field opens (input bindings, `{{` / `/` in
 * prompt and template text, condition fields). Built on the contract's `bindingSourcePaths`, so
 * what the picker offers is what publish accepts; this module adds only what the UI needs on
 * top: group subtitles (the context schema's name and version), last-run SAMPLES, the
 * condition-specific blocks (CEL cannot read `consultation.*` or `run.*` this release), and the
 * filter-as-you-type with an empty reason per group.
 */
import {
  bindingSourcePaths,
  type AgentIOResolver,
  type BindingSourceGroupKey,
  type BindingSourceItem,
  type IoType,
  type WorkflowSettings,
} from '@arcaai/workflow-contract';
import type { GraphStoreEdge, GraphStoreNode } from '../store/types';
import { contractGraphOf } from './connection-plan';

export type PickerPurpose = 'binding' | 'template' | 'condition';

export interface PickerItem extends BindingSourceItem {
  scope: BindingSourceGroupKey;
  /** A short rendering of the value this path had in the last test run. */
  sample?: string;
}

export interface PickerGroup {
  key: BindingSourceGroupKey;
  label: string;
  subtitle?: string;
  items: PickerItem[];
  emptyReason?: string;
}

export interface PickerModelInput {
  nodes: readonly GraphStoreNode[];
  edges: readonly GraphStoreEdge[];
  settings?: WorkflowSettings;
  /** The node the field belongs to — only its ANCESTORS are offered. */
  nodeId: string;
  agents: AgentIOResolver;
  /** The bound context schema's definition (or inline schema). */
  contextSchema?: unknown;
  contextSchemaName?: string | null;
  contextSchemaVersion?: number | null;
  targetType?: IoType;
  purpose?: PickerPurpose;
  /** Last-run values by stored path (`samplesFromRunOutputs`). */
  samples?: Readonly<Record<string, unknown>>;
}

const SUBTITLES: Partial<Record<BindingSourceGroupKey, string>> = {
  steps: 'Outputs of steps that run before this one',
  consultation: 'Patient, visit, transcript and notes',
  run: 'Run identity and workflow variables',
};

const CONDITION_BLOCKS: Partial<Record<BindingSourceGroupKey, string>> = {
  consultation: 'A condition can’t read consultation data yet — bind it into an earlier step instead.',
};

/** `chest…` / `3 items` / `{ a, b }` — enough to recognise a value, never a dump. */
export function formatSample(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'string') return value.length > 60 ? `“${value.slice(0, 59)}…”` : `“${value}”`;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length > 4 ? `{ ${keys.slice(0, 4).join(', ')}, … }` : `{ ${keys.join(', ')} }`;
  }
  return String(value);
}

/** `{ nodeId: { field: value } }` (the last run's outputs) → `{ 'nodes.<id>.outputs.<field>': value }`, one level deep. */
export function samplesFromRunOutputs(outputsByNode: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [nodeId, outputs] of Object.entries(outputsByNode)) {
    for (const [field, value] of Object.entries(outputs ?? {})) {
      const raw = `nodes.${nodeId}.outputs.${field}`;
      out[raw] = value;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) out[`${raw}.${key}`] = nested;
      }
    }
  }
  return out;
}

function contextSubtitle(input: PickerModelInput): string | undefined {
  if (!input.contextSchemaName) return input.contextSchema ? 'This workflow’s Input shape' : undefined;
  return input.contextSchemaVersion ? `“${input.contextSchemaName}” v${input.contextSchemaVersion}` : `“${input.contextSchemaName}” · follows latest`;
}

export function pickerGroups(input: PickerModelInput): PickerGroup[] {
  const purpose = input.purpose ?? 'binding';
  const targetType = input.targetType ?? (purpose === 'template' ? 'text' : undefined);
  const groups = bindingSourcePaths(contractGraphOf(input.nodes, input.edges, input.settings), input.nodeId, {
    contextSchema: input.contextSchema,
    agentOutputs: input.agents,
    ...(targetType ? { targetType } : {}),
  });
  return groups.map((group) => {
    const block = purpose === 'condition' ? CONDITION_BLOCKS[group.key] : undefined;
    const items: PickerItem[] = group.items.map((item) => {
      const runBlock = purpose === 'condition' && item.raw.startsWith('run.') ? 'A condition can’t read run fields — only steps, the Input and variables.' : undefined;
      const disabledReason = item.disabledReason ?? block ?? runBlock;
      const sample = input.samples && item.raw in input.samples ? formatSample(input.samples[item.raw]) : undefined;
      return {
        ...item,
        scope: group.key,
        ...(disabledReason ? { disabledReason, bestMatch: undefined } : {}),
        ...(sample !== undefined ? { sample } : {}),
      };
    });
    const subtitle = group.key === 'context' ? contextSubtitle(input) : SUBTITLES[group.key];
    return {
      key: group.key,
      label: group.label,
      ...(subtitle ? { subtitle } : {}),
      items,
      ...(group.emptyReason ? { emptyReason: group.emptyReason } : {}),
    };
  });
}

/** Filter as you type: path, stored path and description. An emptied group says why. */
export function filterPickerGroups(groups: readonly PickerGroup[], query: string): PickerGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...groups];
  return groups.map((group) => {
    const items = group.items.filter((item) => [item.path, item.raw, item.description].some((text) => text.toLowerCase().includes(needle)));
    return items.length > 0 ? { ...group, items } : { ...group, items, emptyReason: `Nothing here matches “${query.trim()}”.` };
  });
}
