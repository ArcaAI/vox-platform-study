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
export type AgentTask = 'SPEECH_TO_TEXT' | 'TEXT_GENERATION' | 'TEXT_TO_SPEECH' | 'NAMED_ENTITY_RECOGNITION';

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
  /**
   * TASK-983 R9 — the placeholder PATHS this agent's instruction reads that carry no
   * `default("…")` and that the agent does not bind itself: sorted, de-duplicated, published so
   * a caller can assemble a correct body from the contract instead of discovering it one 400 at
   * a time.
   *
   * Send each path under the request key its root names — `trigger.*` / `context.*` → `context`,
   * `input.*` → the invocation body, a bare name → `variables`. Omitting one is a 400
   * `PROMPT_VARIABLES_MISSING`, whose `missingVariables` names ALL of them at once.
   *
   * Optional: a gateway older than TASK-983 sends no such field, and absence means "this gateway
   * does not publish the list", never "nothing is required".
   */
  requiredVariables?: string[];
  // TASK-983 OD-6 — `protocols` (a static per-task constant) is REMOVED: the gateway never
  // enforced it. See `docs/operations/deprecation-register.md` §SDK.
}

/** An ASR (`SPEECH_TO_TEXT`) Agent — what `audio.start({ agentSlug })` selects. */
export type SelectableAsrAgent = SelectableAgent & { task: 'SPEECH_TO_TEXT' };

// =============================================================================
// Invocation (TASK-890, OD-F) — the browser calls a published agent
// =============================================================================

/**
 * The body of `POST /agents/{slug}/invocations`.
 *
 * Open by design: the gateway validates it against the AGENT'S OWN `inputSchema` (TIER 3),
 * whose default is `{ text, variables? }` but which a tenant may author freely. Narrowing it
 * here would mean this SDK deciding what a tenant's agent accepts.
 */
export interface AgentInvocationInput {
  text?: string;
  variables?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * The `?mode=blocking` 200 body of an agent invocation.
 *
 * `TOutput` defaults to the TEXT_GENERATION shape, which is what every existing call site
 * means. A task with a different output — `NAMED_ENTITY_RECOGNITION` answers
 * {@link NamedEntityRecognitionOutput} — names it explicitly:
 * `invoke<NamedEntityRecognitionOutput>(slug, { text })`. The envelope around `output` is the
 * same for every task, which is why this is one generic type rather than one type per task.
 */
export interface AgentInvocationResult<TOutput = { text: string }> {
  agentSlug: string;
  /** The exact published version that answered — pin it in a log; the slug alone is a lineage. */
  agentVersionId: string;
  output: TOutput;
  /** The provider that served it, or `null` when the resolver could not attribute one. */
  provider: string | null;
  model: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
}

/**
 * The DEFAULT input of a `NAMED_ENTITY_RECOGNITION` agent (TASK-930 §2.3).
 *
 * A convenience, not a constraint — {@link AgentInvocationInput} stays open, because the
 * gateway validates against the AGENT'S OWN `inputSchema` and a tenant may author its own.
 */
export interface NamedEntityRecognitionInput {
  text: string;
  /** ISO 639-1 hint; omit to let the agent decide. */
  language?: string;
  [key: string]: unknown;
}

/** One entity a NER agent found. `start`/`end` are character offsets into the input `text`. */
export interface RecognizedEntity {
  text: string;
  label: string;
  start: number;
  end: number;
  /** Model confidence in `0..1`. Absent for a checkpoint that reports none. */
  score?: number;
}

/**
 * The DEFAULT output of a `NAMED_ENTITY_RECOGNITION` agent —
 * `invoke<NamedEntityRecognitionOutput>(slug, { text })`.
 *
 * NER is a ONE-SHOT task: `?mode=stream` on a NER agent is a gateway 400 (`MODE_UNSUPPORTED`),
 * so `stream()` on one fails rather than answering slowly. There is nothing to stream — the
 * answer is a single spans array.
 */
export interface NamedEntityRecognitionOutput {
  entities: RecognizedEntity[];
}

/**
 * One decoded `?mode=stream` frame.
 *
 * Deliberately opaque: the gateway relays the TEXT service's frames VERBATIM, so their shape
 * belongs to `apps/text` and not to this contract. Read the fields you know and ignore the
 * rest rather than having this type go stale behind a provider change.
 */
export type AgentInvocationFrame = Record<string, unknown>;
