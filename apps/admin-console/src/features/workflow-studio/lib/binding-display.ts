/**
 * TASK-1036 §10.1 / OD-20 — how a binding READS: by step label, never by raw id (the stored id is
 * the tooltip), with its scope so chips, tokens and picker rows share one colour per scope.
 */
import type { BindingSourceGroupKey } from '@arcaai/workflow-contract';
import type { GraphStoreNode } from '../store/types';
import { nodeDisplayName, type NodeNaming } from './node-identity';

export type BindingScope = BindingSourceGroupKey | 'value' | 'template';

export function scopeOfPath(path: string): BindingSourceGroupKey {
  if (path.startsWith('nodes.')) return 'steps';
  if (path.startsWith('consultation.') || path === 'consultation') return 'consultation';
  if (path.startsWith('vars.') || path.startsWith('run.')) return 'run';
  return 'context';
}

/** `nodes.<id>.outputs.a.b` → `Label › a › b`; every other root reads as its path. */
export function pathLabel(path: string, nodes: ReadonlyArray<Pick<GraphStoreNode, 'id' | 'type' | 'config'>>, naming?: NodeNaming): string {
  const match = /^nodes\.([^.]+)\.outputs\.(.+)$/.exec(path);
  if (!match) return path;
  const producer = nodes.find((node) => node.id === match[1]);
  const name = producer ? nodeDisplayName(producer, nodes, naming) : 'A removed step';
  return [name, ...(match[2] as string).split('.')].join(' › ');
}

export interface BindingChip {
  kind: 'from' | 'value' | 'template' | 'firstOf';
  label: string;
  scope: BindingScope;
  /** What is stored — the tooltip. */
  title: string;
  paths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function literal(value: unknown): string {
  return typeof value === 'string' ? `“${value}”` : JSON.stringify(value) ?? String(value);
}

export function describeBinding(binding: unknown, nodes: ReadonlyArray<Pick<GraphStoreNode, 'id' | 'type' | 'config'>>, naming?: NodeNaming): BindingChip | null {
  if (!isRecord(binding)) return null;
  if (typeof binding.from === 'string') {
    return { kind: 'from', label: pathLabel(binding.from, nodes, naming), scope: scopeOfPath(binding.from), title: binding.from, paths: [binding.from] };
  }
  if (Array.isArray(binding.firstOf)) {
    const paths = binding.firstOf.filter((path): path is string => typeof path === 'string');
    const scopes = new Set(paths.map(scopeOfPath));
    return {
      kind: 'firstOf',
      label: `First of: ${paths.map((path) => pathLabel(path, nodes, naming)).join(', ')}`,
      scope: scopes.size === 1 ? [...scopes][0]! : 'steps',
      title: `firstOf: ${paths.join(' → ')}`,
      paths,
    };
  }
  if (typeof binding.template === 'string') {
    const text = binding.template.length > 40 ? `${binding.template.slice(0, 39)}…` : binding.template;
    return { kind: 'template', label: text, scope: 'template', title: binding.template, paths: [] };
  }
  if ('value' in binding) return { kind: 'value', label: literal(binding.value), scope: 'value', title: 'A fixed value', paths: [] };
  return null;
}
