/**
 * TASK-891 C1/C2 (owner decision OD-4) — the agent's REASONING posture.
 *
 * ## Why it lives on the agent and not in the settings registry
 *
 * > "Per-agent parameters block."
 *
 * An agent already owns `temperature`, `maxTokens` and `responseFormat`; how hard the engine
 * is told to think is the same kind of decision, authored with the same row and reversible
 * per agent without a deploy. A governed descriptor would have made it one platform-wide
 * value — which is exactly wrong for a posture that should be OFF on the realtime tier and
 * ON on a finalize tier of the same tenant.
 *
 * ## Why it matters enough to have a control at all
 *
 * Measured against the deployed default (`gemma-4-e2b-it-qat`, LM Studio, cluster idle,
 * 2026-09-07):
 *
 * | probe | wall | completion tokens | reasoning tokens |
 * |---|---|---|---|
 * | `"hello"` | 1.37 s | 50 | **35 (70%)** |
 * | SOAP note, 136-token transcript | 14.06 s | 538 | **422 (78%)** |
 *
 * 78% of the realtime budget went to reasoning for a JSON-shaped note, against a 20 s
 * timeout. Reasoning is not free and it is not always worth buying.
 *
 * ## The wire — TASK-970: the posture travels AS a posture
 *
 * TASK-891 pre-rendered the block here into `extra.reasoning_effort`, mapping
 * `enabled: false` onto `'minimal'`. That was right for the OpenAI-compatible family and
 * WRONG as a wire format, because it is LOSSY: once `'minimal'` is on the wire, "the admin
 * turned reasoning OFF" is indistinguishable from "the admin asked for minimal EFFORT". An
 * engine whose off-switch is a different parameter entirely — Ollama's `think: false`,
 * Anthropic's `thinking: {type: 'disabled'}` — cannot be driven correctly from a value that
 * already collapsed the distinction, and seven of ten adapters simply dropped it.
 *
 * So this file no longer renders. It emits the ONE neutral posture that
 * `GenerateRequest.reasoning` carries, and each adapter renders it into its own engine's
 * vocabulary (`tests/contracts/reasoning-posture.fixture.json` is the written contract; the
 * adapters and their per-engine `support` table are `apps/text`'s half of it). This is the
 * `ResolvedAsrSpec` pattern of TASK-861 applied to generation: the gateway resolves, the
 * service renders.
 *
 * Three states and nothing else — `{enabled: false}`, `{enabled: true[, effort]}`, and
 * ABSENT. Absent means the engine decides and NOTHING is synthesized; it is precisely the
 * state the measurements above were taken in.
 */

/** The efforts an engine may be asked for, in ascending cost. */
export const AGENT_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];

/** `parameters.generation.reasoning` — the authored block. */
export interface AgentReasoning {
  enabled: boolean;
  effort?: AgentReasoningEffort;
}

/** The body field the posture travels in — `GenerateRequest.reasoning` on `apps/text`. */
export const REASONING_WIRE_FIELD = 'reasoning';

/**
 * The RAW OpenAI-shaped ride-along, kept for exactly one job: recognising a CALL SITE that
 * pinned it.
 *
 * It is no longer how this package states a posture (see the header). It stays supported
 * because the contract says so (`wire.caller_override`) — a caller that pinned
 * `extra.reasoning_effort` has decided about that one request and is not second-guessed —
 * and because on an `effort-only` adapter the pin and a rendered posture land on the SAME
 * key, so the two must never travel together.
 */
export const REASONING_EFFORT_EXTRA_KEY = 'reasoning_effort';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEffort(value: unknown): value is AgentReasoningEffort {
  return AGENT_REASONING_EFFORTS.includes(value as AgentReasoningEffort);
}

/**
 * The reasoning block of a resolved agent's `parameters.generation`, or `null` when the
 * agent authored none.
 *
 * Reads leniently on purpose: this runs on the live flush path, where the authoritative
 * rejection of a malformed block already happened at WRITE time
 * ({@link agentReasoningProblems} plus the JSON-Schema gate). A row that somehow carries a
 * bad shape must degrade to "no opinion" — the engine's own default — rather than fail a
 * consultation over a hyper-parameter.
 */
export function readAgentReasoning(generation: unknown): AgentReasoning | null {
  if (!isPlainObject(generation)) return null;
  const raw = generation.reasoning;
  if (!isPlainObject(raw) || typeof raw.enabled !== 'boolean') return null;
  return isEffort(raw.effort) ? { enabled: raw.enabled, effort: raw.effort } : { enabled: raw.enabled };
}

/**
 * The value of `GenerateRequest.reasoning` for a resolved posture, or `undefined` when there
 * is nothing to say.
 *
 * Near-identity by design — the whole point of TASK-970 is that this function STOPS
 * translating — with one normalisation and one refusal:
 *
 *  - `null` → `undefined`. No tier had an opinion, so the field is omitted and the engine
 *    decides. Never a synthesized default: absence is a statement of its own on this wire.
 *  - `enabled: false` → `{enabled: false}`, and any authored `effort` is DROPPED.
 *    {@link agentReasoningProblems} accepts `{enabled: false, effort: 'high'}` because both
 *    keys are individually valid, but a budget for reasoning that will not happen is a
 *    second, contradictory instruction on a wire that must carry exactly one.
 *  - `enabled: true` with no effort → `{enabled: true}`, which is a REAL case now rather
 *    than the silence TASK-891 emitted: the agent asked to reason without naming a budget,
 *    and an adapter can render that ("on, engine's own budget") without this file inventing
 *    a tenant's spend.
 */
export function reasoningWire(reasoning: AgentReasoning | null): AgentReasoning | undefined {
  if (!reasoning) return undefined;
  if (!reasoning.enabled) return { enabled: false };
  return reasoning.effort ? { enabled: true, effort: reasoning.effort } : { enabled: true };
}

/**
 * WRITE-time validation of `parameters.generation.reasoning`, as named messages.
 *
 * The JSON-Schema gate (`AGENT_PARAMETER_SCHEMAS[task]` → `jsonSchemaValueProblems`) refuses
 * the same values, but says only "matches none of the `enum`". An author who wrote
 * `effort: "max"` needs to be told the four efforts that exist, which is the difference
 * between a legible refusal and a puzzle — the same reason `agentConfigProblems` restates
 * the prompt-variable binding rule the schema also enforces.
 */
export function agentReasoningProblems(parameters: unknown): string[] {
  if (!isPlainObject(parameters)) return [];
  const generation = parameters.generation;
  if (!isPlainObject(generation)) return [];
  const raw = generation.reasoning;
  if (raw === undefined) return [];

  const at = 'parameters/generation/reasoning';
  if (!isPlainObject(raw)) {
    return [`${at}: must be an object of the form { enabled: boolean, effort?: ${AGENT_REASONING_EFFORTS.join(' | ')} }`];
  }

  const problems: string[] = [];
  if (typeof raw.enabled !== 'boolean') {
    problems.push(`${at}/enabled: required, and must be a boolean (\`false\` asks the engine not to reason)`);
  }
  if (raw.effort !== undefined && !isEffort(raw.effort)) {
    problems.push(`${at}/effort: must be one of ${AGENT_REASONING_EFFORTS.join(', ')}`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'enabled' && key !== 'effort') problems.push(`${at}/${key}: unknown property`);
  }
  return problems;
}
