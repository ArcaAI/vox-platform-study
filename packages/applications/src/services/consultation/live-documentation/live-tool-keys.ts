/**
 * The live loop's TOOL vocabulary.
 *
 * These three keys are the closed set of per-turn tools the live executor may
 * dispatch, and {@link LIVE_TOOL_KEYS} is the ONE list they are declared in —
 * `live-tool-registry.ts` keys its executor table 1:1 to it, and
 * `ResolvedToolPlan` (`live-agent.port.ts`) is a `Record<LiveToolKey, …>`. A
 * second list would let the registry and the plan disagree about what a tool is.
 *
 *   ner → the NLP token-classification call that extracts entities
 *   vitals → the vitals block of that SAME NLP response (filtered off
 *                  when disabled — it is not a second HTTP call)
 *   groundedness → the optional guardrail groundedness check
 *
 * Previously declared in `services/departmentAgent/constants.ts`. It moved here
 * with the retirement of `DepartmentAgent` because it never was an
 * agent concept: it names what the LIVE LOOP can run. The tool PLAN — which of
 * them are on for a given session — is resolved from workflow node config, but
 * the vocabulary itself is code-owned and not configurable, exactly as before.
 */
export const LIVE_TOOL_KEYS = ['ner', 'vitals', 'groundedness'] as const;

export type LiveToolKey = (typeof LIVE_TOOL_KEYS)[number];
