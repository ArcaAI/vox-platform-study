/**
 * TASK-1036 §3.5 (OD-4, WF-SET-001..004) — the settings dialog's model. `graph.settings` is read
 * through the contract's `effectiveSettings` (settings first, the legacy trigger kinds / output
 * protocols for one release) and the implications are the contract's `settingsImplications`, so
 * a checkbox the dialog locks is exactly what publish would refuse without.
 *
 * An implied connection is shown CHECKED and LOCKED with its reason, and `withImpliedConnections`
 * (the closure) is what is written — the author can never save a set publish refuses.
 */
import {
  WORKFLOW_CONNECTIONS,
  WORKFLOW_SOURCES,
  effectiveSettings,
  settingsImplications,
  type SettingsImplicationContext,
  type WorkflowConnection,
  type WorkflowContextSchemaSetting,
  type WorkflowSettings,
  type WorkflowSource,
} from '@arcaai/workflow-contract';
import type { GraphStoreNode } from '../store/types';
import { contractGraphOf } from './connection-plan';

export interface SettingsDraft {
  connections: WorkflowConnection[];
  sources: WorkflowSource[];
  contextSchema?: WorkflowContextSchemaSetting;
}

export const CONNECTION_COPY: Readonly<Record<WorkflowConnection, { label: string; description: string }>> = {
  api: { label: 'API', description: 'Start runs with a POST and read the result.' },
  webhook: { label: 'Webhook', description: 'Deliver the result to a URL you register.' },
  sse: { label: 'Live stream (SSE)', description: 'Stream a run’s events and text as it happens.' },
  socket: { label: 'Socket', description: 'Two-way socket: live audio in, run frames out.' },
};

export const SOURCE_COPY: Readonly<Record<WorkflowSource, { label: string; description: string }>> = {
  consultation: { label: 'Consultation', description: 'Runs when a consultation session opens; can read consultation data.' },
  schedule: { label: 'Schedule', description: 'Runs on a schedule the platform keeps.' },
};

/** The dialog's starting point: `graph.settings`, else what the legacy trigger/output config implies. */
export function settingsDraftOf(nodes: readonly GraphStoreNode[], settings: WorkflowSettings | undefined): SettingsDraft {
  const effective = effectiveSettings(contractGraphOf(nodes, [], settings));
  return {
    connections: effective.connections,
    sources: effective.sources,
    ...(effective.contextSchema ? { contextSchema: effective.contextSchema } : {}),
  };
}

/** Adds every connection the graph and the Input shape imply, until nothing more is implied. */
export function withImpliedConnections(draft: SettingsDraft, nodes: readonly GraphStoreNode[], ctx: SettingsImplicationContext = {}): SettingsDraft {
  const graph = contractGraphOf(nodes, []);
  const connections = new Set<WorkflowConnection>(draft.connections);
  for (let round = 0; round < WORKFLOW_CONNECTIONS.length; round += 1) {
    const missing = settingsImplications(graph, { connections: [...connections], sources: draft.sources }, ctx);
    if (missing.length === 0) break;
    for (const implication of missing) connections.add(implication.requires);
  }
  return { ...draft, connections: WORKFLOW_CONNECTIONS.filter((name) => connections.has(name)) };
}

export interface ConnectionOption {
  value: WorkflowConnection;
  label: string;
  description: string;
  checked: boolean;
  locked: boolean;
  lockReason?: string;
}

/** One row per connection: checked when chosen OR implied; locked (with the reason) when implied. */
export function connectionOptions(draft: SettingsDraft, nodes: readonly GraphStoreNode[], ctx: SettingsImplicationContext = {}): ConnectionOption[] {
  const closed = withImpliedConnections(draft, nodes, ctx);
  const graph = contractGraphOf(nodes, []);
  return WORKFLOW_CONNECTIONS.map((value) => {
    const checked = closed.connections.includes(value);
    // Why is `value` required? Ask the implications of the closure WITHOUT it.
    const without = closed.connections.filter((name) => name !== value);
    const reasons = checked ? settingsImplications(graph, { connections: without, sources: draft.sources }, ctx).filter((item) => item.requires === value) : [];
    return {
      value,
      ...CONNECTION_COPY[value],
      checked,
      locked: reasons.length > 0,
      ...(reasons.length > 0 ? { lockReason: reasons.map((item) => item.message).join(' ') } : {}),
    };
  });
}

/** The object written to `graph.settings`: vocabulary order, no duplicates. */
export function toWorkflowSettings(draft: SettingsDraft): WorkflowSettings {
  return {
    connections: WORKFLOW_CONNECTIONS.filter((name) => draft.connections.includes(name)),
    sources: WORKFLOW_SOURCES.filter((name) => draft.sources.includes(name)),
    ...(draft.contextSchema ? { contextSchema: draft.contextSchema } : {}),
  };
}
