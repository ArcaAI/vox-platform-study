import type { AiTaskKey } from './types';

/** Scope key: undefined tenantId = the caller's CLS scope (tenant admins). */
const scope = (tenantId?: string) => tenantId ?? 'self';

export const aiTaskDefaultKeys = {
  root: ['ai-task-defaults'] as const,
  effectiveAll: (tenantId?: string) => [...aiTaskDefaultKeys.root, 'effective-all', scope(tenantId)] as const,
  effective: (taskKey: AiTaskKey, tenantId?: string) => [...aiTaskDefaultKeys.root, 'effective', taskKey, scope(tenantId)] as const,
  row: (taskKey: AiTaskKey, tenantId?: string) => [...aiTaskDefaultKeys.root, 'row', taskKey, scope(tenantId)] as const,
  options: (taskKey: AiTaskKey) => [...aiTaskDefaultKeys.root, 'options', taskKey] as const,
};
