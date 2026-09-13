// The PLATFORM default reasoning posture for the TEXT plane.
//
// TASK-968 (owner directive 2026-09-13: reasoning OFF for text generation; configuration
// belongs to the platform admin, not to an environment variable or to an engine).
//
// ## The gap this closes
//
// TASK-891 OD-4 put the reasoning posture on the AGENT (`parameters.generation.reasoning`),
// which is right: it is a per-agent decision, reversible without a deploy, and the realtime
// and finalize tiers of one tenant legitimately want opposite ones. But it gave the cascade
// only ONE tier. The wire producer says nothing for an agent that authored nothing, so
// "nobody decided" resolved to the ENGINE's default — measured on `gemma-4-e2b-it-qat` at
// 5168 ms / 184 reasoning tokens against 1237 ms / 30 at `minimal`.
//
// That left the directive enforceable only by authoring a block on every agent that will ever
// exist, forever, on every tenant — which is not a posture, it is a chore with a failure mode.
// This key is the second tier, so the cascade reads the way every other one in the platform
// does (`00-project-context.md` §Configuration Principles rule 2):
//
//     the agent's authored block  →  THIS key  →  nothing
//
// ## What it does NOT do
//
// It fills ABSENCE only, exactly like `AiProviderConnection` (absent = no opinion → platform
// default; present = the tenant's own value wins and the platform is not consulted). An agent
// that authored `{ enabled: true }` with no effort still sends nothing: it stated a posture,
// and overriding an explicit "reason" with a platform floor would invert the cascade rather
// than complete it. Widening on absence is the rule; widening over an opinion is the bug the
// rule exists to prevent.
//
// ## Why PLATFORM scope, and not a tenant tier
//
// A tenant that wants its own posture already has a deeper, more expressive surface — the
// agent — and adding a middle tier nobody asked for would put two ways to say one thing in
// front of a tenant admin. `maxScope: 'system'` + `globalOnly: true` says so structurally,
// matching `TEXT_GENERATION_SETTINGS`, which is the same shape of value (the last fallback
// before the floor, for a caller with no resolvable profile).
//
// ## Why `engine-default` is a member
//
// Because "give the platform admin control" has to include the ability to choose the state
// this ticket removed. The difference is that it becomes a DECIDED state with a row behind it
// and an admin's name on it, rather than the accident of nobody having said anything.

import type { AgentReasoning } from '../../agent/agent-reasoning';
import { SettingDescriptor } from '../registry.types';

/**
 * The platform vocabulary: the four engine efforts, plus an explicit opt-out.
 *
 * There is no `enabled` half, unlike the agent's `{ enabled, effort }` block, because
 * `minimal` IS this tier's "off" — TASK-968 chose it as the value that carries the owner
 * directive, and the descriptor copy below says so. A second boolean would be a second name
 * for one state, which is what `HARNESS_JUDGE_SUPPRESS_REASONING` was and why it is gone.
 *
 * TASK-970 is what makes that choice actually enforceable: {@link textReasoningPlatformPosture}
 * renders `minimal` as the POSTURE `{ enabled: false }` rather than as the string
 * `reasoning_effort: 'minimal'`, so an engine with a true off-switch is told to stop rather
 * than told to think a little.
 */
export const TEXT_REASONING_DEFAULT_EFFORTS = ['minimal', 'low', 'medium', 'high', 'engine-default'] as const;

export type TextReasoningDefaultEffort = (typeof TEXT_REASONING_DEFAULT_EFFORTS)[number];

/**
 * The member that means "send nothing and let the engine decide".
 *
 * `satisfies` rather than a type ANNOTATION: annotating it as the union widens it, and a
 * comparison against a widened constant narrows nothing — which is how
 * {@link textReasoningPlatformPosture} below would otherwise be handed `'engine-default'` in
 * the branch that maps an EFFORT.
 */
export const TEXT_REASONING_ENGINE_DEFAULT = 'engine-default' satisfies TextReasoningDefaultEffort;

export const TEXT_REASONING_DEFAULT_EFFORT_KEY = 'text.reasoning.defaultEffort';

export const TEXT_REASONING_DEFAULT_EFFORT: SettingDescriptor = {
  key: TEXT_REASONING_DEFAULT_EFFORT_KEY,
  // D-2: `global-kv` is the tier with a complete read + write + cascade + invalidate loop, and
  // one scalar does not earn a table of its own.
  tier: 'global-kv',
  // NO `consumedBy`. This key is read by the GATEWAY (`TextRequestEnrichmentService`), which
  // owns the agent cascade and is therefore the only place that knows an agent authored
  // nothing. Putting it on `apps/text`'s pull snapshot would move the decision to a service
  // that cannot see the agent, and `extra_body` is forwarded verbatim there by design.
  dataType: 'enum',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  // TUNING, so `open-to-default`: an unwritten row leaves the platform on `minimal`, which is
  // already the directive's posture. Fail-closed would turn "nobody has configured this yet"
  // into a failed consultation over a hyper-parameter.
  failMode: 'open-to-default',
  category: 'Service Runtime',
  label: 'Default reasoning effort (agents that authored none)',
  description:
    "How hard the engine is told to think on a text-generation call whose agent authored no reasoning posture of its own. Sent as the neutral GenerateRequest.reasoning posture, the same field an agent's own block uses, and rendered into each engine's own parameter by its adapter. 'minimal' (default) is the platform's OFF posture: reasoning is not free, and a JSON-shaped clinical note rarely earns it — measured on gemma-4-e2b-it-qat, leaving the engine to decide cost 5168 ms against 1237 ms at minimal. On an OpenAI-compatible engine that is still reasoning_effort: minimal; on an engine with a true off switch it is that off switch. Raising it buys deliberation for every unprofiled call. 'engine-default' sends nothing at all and hands the decision back to the engine. An agent that DID author a posture is unaffected by this key in every case: the agent tier wins outright.",
  default: 'minimal',
  validate: (value: unknown) => {
    if (typeof value !== 'string' || !(TEXT_REASONING_DEFAULT_EFFORTS as readonly string[]).includes(value)) {
      return `Default reasoning effort must be one of ${TEXT_REASONING_DEFAULT_EFFORTS.join(', ')}.`;
    }
  },
};

export const TEXT_REASONING_SETTINGS: SettingDescriptor[] = [TEXT_REASONING_DEFAULT_EFFORT];

/**
 * The PLATFORM tier's value, rendered into the ONE posture the wire carries.
 *
 * This is the only place the two vocabularies meet, and the mapping is fixed by what
 * TASK-968 already declared this key to MEAN rather than by the shape of the strings:
 *
 * | value | posture | why |
 * |---|---|---|
 * | `engine-default` | `null` — send nothing | the removed state, kept as a DECISION |
 * | `minimal` | `{ enabled: false }` | the descriptor's own words: the platform's off switch |
 * | `low` / `medium` / `high` | `{ enabled: true, effort }` | reason, at a named budget |
 *
 * The `minimal` row is the load-bearing one. Rendering it as `{ enabled: true, effort:
 * 'minimal' }` would leave the platform tier with NO way to say "off" at all (since
 * `engine-default` means silence), and would send `think: true` to Ollama for every
 * unprofiled agent — the exact inverse of the directive this key exists to carry. On an
 * `effort-only` adapter `{ enabled: false }` renders straight back to
 * `reasoning_effort: 'minimal'`, so the OpenAI family sees the bytes it saw before TASK-970;
 * only the engines that were silently dropping the posture change behaviour, which is the
 * whole ticket.
 *
 * An agent that wants "reason, but cheaply" still says so exactly: `{ enabled: true, effort:
 * 'minimal' }` on its own block. That posture is reachable — just not from this tier, which
 * has one string per state and must spend it on the state the platform actually needs.
 */
export function textReasoningPlatformPosture(effort: TextReasoningDefaultEffort): AgentReasoning | null {
  if (effort === TEXT_REASONING_ENGINE_DEFAULT) return null;
  if (effort === 'minimal') return { enabled: false };
  return { enabled: true, effort };
}
