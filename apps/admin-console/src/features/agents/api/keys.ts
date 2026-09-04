import type { AgentTask } from './types';

/** Query-key factory — every key roots at ['agent-entities'] (the prompt-template feature owns ['prompt-templates']). */
export const agentKeys = {
  root: ['agent-entities'] as const,
  list: (task?: AgentTask) => [...agentKeys.root, 'list', task ?? 'all'] as const,
  detail: (id: string) => [...agentKeys.root, 'detail', id] as const,
  versions: (id: string) => [...agentKeys.root, 'versions', id] as const,
  assignments: (task?: AgentTask) => [...agentKeys.root, 'assignments', task ?? 'all'] as const,
  registryModels: () => [...agentKeys.root, 'registry-models'] as const,
  instructionTemplates: () => [...agentKeys.root, 'instruction-templates'] as const,
  departments: () => [...agentKeys.root, 'departments'] as const,
};
