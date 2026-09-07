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
 * ## The wire
 *
 * `GenerateRequest.extra` is ALREADY declared on `apps/text` and ALREADY forwarded as
 * `extra_body` to the OpenAI-compatible family, and its own field comment names
 * `reasoning_effort` as the example. So this file adds NO transport: it maps an authored
 * block onto the ride-along that already exists.
 *
 * `enabled: false` means *instruct the engine not to reason* — `reasoning_effort: 'minimal'`,
 * the engine's own off switch — never "drop the field and hope". An absent field is the
 * engine's default, which is precisely the state the measurements above were taken in.
 */

/** The efforts an engine may be asked for, in ascending cost. */
export const AGENT_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];

/** `parameters.generation.reasoning` — the authored block. */
export interface AgentReasoning {
  enabled: boolean;
  effort?: AgentReasoningEffort;
}

/** The `extra` key the OpenAI-compatible family forwards as `extra_body.reasoning_effort`. */
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
 * The `extra` ride-along for an authored reasoning block, or `undefined` when there is
 * nothing to say.
 *
 *  - `enabled: false` → `minimal`: OD-4's "instruct the engine not to reason". Silence would
 *    leave the engine on its own default, which is the state being turned off.
 *  - `enabled: true` with an effort → that effort.
 *  - `enabled: true` with none → nothing. The agent asked for reasoning without naming a
 *    budget, and inventing one here would be this file deciding a tenant's spend.
 */
export function reasoningExtra(reasoning: AgentReasoning | null): Record<string, unknown> | undefined {
  if (!reasoning) return undefined;
  if (!reasoning.enabled) return { [REASONING_EFFORT_EXTRA_KEY]: 'minimal' };
  return reasoning.effort ? { [REASONING_EFFORT_EXTRA_KEY]: reasoning.effort } : undefined;
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
