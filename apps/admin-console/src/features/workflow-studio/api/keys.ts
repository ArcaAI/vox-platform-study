/** Query-key factory — every key roots at ['workflow-studio'] for coarse invalidation (rule 13
 *  §Data & State). The node registry gets its own leaf, `registry()`, since it invalidates on a
 *  different cadence (code-owned, effectively static) than definition rows. */
export const workflowStudioKeys = {
  root: ['workflow-studio'] as const,
  list: () => [...workflowStudioKeys.root, 'list'] as const,
  detail: (id: string) => [...workflowStudioKeys.root, 'detail', id] as const,
  versions: (id: string) => [...workflowStudioKeys.root, 'versions', id] as const,
  registry: () => [...workflowStudioKeys.root, 'registry'] as const,
  promptTemplates: () => [...workflowStudioKeys.root, 'prompt-templates'] as const,
  // TASK-733 half (a) — assignment matrix.
  assignments: (paletteKey: string) => [...workflowStudioKeys.root, 'assignments', paletteKey] as const,
  departmentOptions: () => [...workflowStudioKeys.root, 'department-options'] as const,
  // DD-11 (TASK-810) — per-definition prompt bindings, and the version list of
  // one template (keyed by template id, not by definition: the same template is
  // legitimately referenced from several definitions).
  promptBindings: (definitionId: string) => [...workflowStudioKeys.root, 'prompt-bindings', definitionId] as const,
  promptTemplateVersions: (promptTemplateId: string) => [...workflowStudioKeys.root, 'prompt-template-versions', promptTemplateId] as const,
  // TASK-812 (D-10) — the ordered consultation endpoint sequence. Keyed by SCOPE because the
  // key is `maxScope: 'tenant'`: the platform row and the caller tenant's override are two
  // different rows with two different ETags, and caching them under one key would precondition a
  // tenant write on the platform row's version (a permanent 412).
  endpointSequence: (scope: string) => [...workflowStudioKeys.root, 'endpoint-sequence', scope] as const,
};
