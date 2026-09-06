/**
* Query-key factory — every key roots at ['workflow-studio'] for coarse invalidation (rule 13
 * & State). The node registry() gets its own leaf, `registry`, since it invalidates on a
 *  different cadence (code-owned, effectively static) than definition rows. 
 */
export const workflowStudioKeys = {
  root: ['workflow-studio'] as const,
  list: () => [...workflowStudioKeys.root, 'list'] as const,
  detail: (id: string) => [...workflowStudioKeys.root, 'detail', id] as const,
  versions: (id: string) => [...workflowStudioKeys.root, 'versions', id] as const,
  registry: () => [...workflowStudioKeys.root, 'registry'] as const,
  // the SYSTEM template library. Its own leaf, not a variant of `list()`: it is a
  // different tenant's rows on a different cadence (platform releases, not tenant authoring),
  // and folding it into the tenant list() key would serve one as the other on invalidation.
  templates: () => [...workflowStudioKeys.root, 'templates'] as const,
  promptTemplates: () => [...workflowStudioKeys.root, 'prompt-templates'] as const,
  // half (a) — assignment matrix.
  assignments: (paletteKey: string) => [...workflowStudioKeys.root, 'assignments', paletteKey] as const,
  departmentOptions: () => [...workflowStudioKeys.root, 'department-options'] as const,
  // TASK-864 — the `core.agent` picker's options, per task (TASK-863 §3.5 `GET /admin/agents?task=`).
  agentOptions: (task: string) => [...workflowStudioKeys.root, 'agent-options', task] as const,
  // DD-11 — per-definition prompt bindings, and the version list() of
  // one template (keyed by template id, not by definition: the same template is
  // legitimately referenced from several definitions).
  promptBindings: (definitionId: string) => [...workflowStudioKeys.root, 'prompt-bindings', definitionId] as const,
  promptTemplateVersions: (promptTemplateId: string) => [...workflowStudioKeys.root, 'prompt-template-versions', promptTemplateId] as const,
  // TASK-890 §3.4 — `core.trigger`'s context-schema reference picker (the option list itself
  // is `@/shared/catalog`'s own query key; this is the per-schema VERSION list only).
  contextSchemaVersions: (schemaId: string) => [...workflowStudioKeys.root, 'context-schema-versions', schemaId] as const,
  // TASK-890 §3.9/§3.10 — the PublishDialog's resolved endpoints panel.
  runSchema: (slug: string) => [...workflowStudioKeys.root, 'run-schema', slug] as const,
};
