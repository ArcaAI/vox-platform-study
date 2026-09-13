/**
 * `@/shared/versioning` — TASK-965: the console-wide kit for versioned items (agents, workflow
 * definitions, and the head+version screens). Grows with WS-3; today it carries the one surface
 * every published lineage needs regardless of screen: how a developer reaches it.
 */
export { EXPOSABLE_PALETTE_KEY, IntegrationPanel } from './integration-panel';
export type { AgentIntegrationProps, IntegrationAgentTask, IntegrationPanelProps, WorkflowIntegrationProps } from './integration-panel';
