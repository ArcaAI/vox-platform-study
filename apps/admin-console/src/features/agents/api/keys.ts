import type { ListParams } from '@/shared/api';
import type { AgentTask } from './types';

/** Query-key factory — every key roots at ['agent-entities'] (the prompt-template feature owns ['prompt-templates']). */
export const agentKeys = {
  root: ['agent-entities'] as const,
  list: (task?: AgentTask) => [...agentKeys.root, 'list', task ?? 'all'] as const,
  /**
   * TASK-965 — the LINEAGE register (`GET admin/agents/lineages`). Keyed by the serialized
   * params because the route is server-paged: two pages of the same list are two cache entries,
   * and `useInvalidateAgents` still drops both (every key roots at `agentKeys.root`).
   */
  lineages: (params?: ListParams) => [...agentKeys.root, 'lineages', params ?? {}] as const,
  /** One lineage resolved by slug — the deep-link path, when the row is not on the open page. */
  lineageBySlug: (slug: string) => [...agentKeys.root, 'lineage', slug] as const,
  detail: (id: string) => [...agentKeys.root, 'detail', id] as const,
  versions: (id: string) => [...agentKeys.root, 'versions', id] as const,
  assignments: (task?: AgentTask) => [...agentKeys.root, 'assignments', task ?? 'all'] as const,
  departments: () => [...agentKeys.root, 'departments'] as const,
};
