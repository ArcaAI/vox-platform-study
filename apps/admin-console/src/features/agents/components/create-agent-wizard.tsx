/**
 * TASK-1036 C5 (OD-12) — the wizard moved to `@/shared/agent-wizard` so the Workflow Studio's
 * `core.agent` picker can open it too (rule 13: a feature never imports another feature). This
 * re-export keeps the agents screen and its tests on their original import path.
 */
export { AgentWizard as CreateAgentWizard, buildCreateRequest, slugify } from '@/shared/agent-wizard/agent-wizard';
