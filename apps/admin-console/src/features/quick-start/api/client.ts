/**
 * The admin endpoints the quick start drives — the SAME routes the full editors use (context
 * schemas, agents, workflow definitions, workflow assignments), re-declared here because features
 * never import each other. Every call is a plain create / publish; nothing is edited in place, so
 * no If-Match is involved.
 */
import { postJson } from '@/shared/api';
import type { QuickStartApi } from '../lib/quick-start-plan';

const SCHEMAS = 'admin/consultation-context-schemas';
const AGENTS = 'admin/agents';
const DEFINITIONS = 'admin/workflow-definitions';
const ASSIGNMENTS = 'admin/workflow-assignments';

export const quickStartApi: QuickStartApi = {
  createContextSchema: (body) => postJson(SCHEMAS, body),
  publishContextSchema: (id, body) => postJson(`${SCHEMAS}/${encodeURIComponent(id)}/publish`, body),
  createAgent: (body) => postJson(AGENTS, body),
  publishAgent: (id, body) => postJson(`${AGENTS}/${encodeURIComponent(id)}/publish`, body),
  createWorkflowDefinition: (body) => postJson(DEFINITIONS, body),
  publishWorkflowDefinition: (id, body) => postJson(`${DEFINITIONS}/${encodeURIComponent(id)}/publish`, body),
  createWorkflowAssignment: (body) => postJson(ASSIGNMENTS, body),
};
