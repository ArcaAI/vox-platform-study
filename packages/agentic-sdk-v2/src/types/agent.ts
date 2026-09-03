/**
 * @arcaai/vox - Agent types (TASK-865)
 *
 * The BUSINESS-plane view of a published Agent — what a clinician-facing
 * client may select, never how it is configured. Backed by the TASK-863 routes
 * (`GET /agents?task=…`, `GET /agents/{slug}`). Administration of agents is the
 * admin plane (`/admin/agents/**`) and lives in `@arcaai/vox-node`'s generated
 * `hope.admin.agent.*`, not here.
 */

/** The task family a published Agent serves. */
export type AgentTask = 'SPEECH_TO_TEXT' | 'TEXT_GENERATION' | 'TEXT_TO_SPEECH';

/**
 * One published, active Agent visible to the tenant (the same predicate the
 * gateway resolves `agentSlug` with, so anything listed is accepted at use).
 */
export interface SelectableAgent {
  /** The value to send as `agentSlug` — a lineage key, stable across versions. */
  slug: string;
  name: string;
  description: string | null;
  task: AgentTask;
  /** The ACTIVE published version currently resolved for this slug. */
  versionNumber: number;
  /**
   * `true` for the slug the TENANT-level assignment names — what governs when no
   * selection is made. A department override can still win at resolution, so
   * treat this as a sensible preselection, not a promise about a given session.
   */
  isTenantDefault: boolean;
  /** JSON Schema of the invocation input (TEXT_GENERATION / TEXT_TO_SPEECH); absent for realtime ASR. */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema of the invocation output. */
  outputSchema?: Record<string, unknown>;
  /** Wire protocols the agent is reachable over (e.g. `'invocation'`, `'speech'`, `'transcription'`, `'stream-session'`). */
  protocols?: string[];
}

/** An ASR (`SPEECH_TO_TEXT`) Agent — what `audio.start({ agentSlug })` selects. */
export type SelectableAsrAgent = SelectableAgent & { task: 'SPEECH_TO_TEXT' };
