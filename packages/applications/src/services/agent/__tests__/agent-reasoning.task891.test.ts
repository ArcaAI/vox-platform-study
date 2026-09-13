/**
 * TASK-891 C1 (owner decision OD-4) — `parameters.generation.reasoning`.
 *
 * > "Per-agent parameters block."
 *
 * The shape is `{ enabled: boolean; effort?: 'minimal' | 'low' | 'medium' | 'high' }`, and
 * an unknown effort is REFUSED at write time rather than shipped to an engine that will
 * ignore it. "Disabled" is not silence — the engine is instructed not to reason; leaving the
 * field out would leave the engine on its own default, which is the state being turned off.
 *
 * TASK-970 changed HOW that instruction travels, not what it means: the block is no longer
 * pre-rendered into OpenAI's `reasoning_effort` here (which collapsed "off" into "minimal"
 * and reached three adapters out of ten) but emitted as the neutral posture
 * `GenerateRequest.reasoning`, for each adapter to render. The cross-language contract is
 * `tests/contracts/reasoning-posture.fixture.json`.
 *
 * Measured motivation (`gemma-4-e2b-it-qat`, LM Studio, idle, 2026-09-07): a SOAP note from
 * a 136-token transcript spent **422 of 538 completion tokens (78%) on reasoning** and took
 * 14.06 s against what was then a 20 s budget.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_REASONING_EFFORTS,
  agentReasoningProblems,
  readAgentReasoning,
  reasoningWire,
  REASONING_EFFORT_EXTRA_KEY,
  REASONING_WIRE_FIELD,
} from '../agent-reasoning';

describe('readAgentReasoning', () => {
  it('reads an authored block', () => {
    expect(readAgentReasoning({ temperature: 0.2, reasoning: { enabled: true, effort: 'low' } })).toEqual({ enabled: true, effort: 'low' });
    expect(readAgentReasoning({ reasoning: { enabled: false } })).toEqual({ enabled: false });
  });

  it('is null for an agent with no opinion', () => {
    expect(readAgentReasoning(undefined)).toBeNull();
    expect(readAgentReasoning({})).toBeNull();
    expect(readAgentReasoning({ reasoning: {} })).toBeNull();
  });

  it('degrades a malformed row to "no opinion" rather than failing a consultation', () => {
    // The authoritative refusal happened at WRITE time; the flush path must not throw over
    // a hyper-parameter.
    expect(readAgentReasoning({ reasoning: 'on' })).toBeNull();
    expect(readAgentReasoning({ reasoning: { enabled: 'yes' } })).toBeNull();
    expect(readAgentReasoning({ reasoning: { enabled: true, effort: 'max' } })).toEqual({ enabled: true });
  });
});

describe('reasoningWire — the GenerateRequest.reasoning posture (TASK-970)', () => {
  it('disabled asks the engine not to reason, rather than saying nothing', () => {
    // The posture, NOT `reasoning_effort: 'minimal'`. That rendering is now the receiving
    // adapter's job, and only the `effort-only` engines make it; an engine with a true
    // off-switch gets its own (`think: false`, `thinking: {type: 'disabled'}`).
    expect(reasoningWire({ enabled: false })).toEqual({ enabled: false });
  });

  it('enabled with an effort carries that effort', () => {
    for (const effort of AGENT_REASONING_EFFORTS) {
      expect(reasoningWire({ enabled: true, effort })).toEqual({ enabled: true, effort });
    }
  });

  it('enabled with no effort is now SAYABLE — "on, engine keeps its own budget"', () => {
    // TASK-891 flattened this to silence because `reasoning_effort` had no way to spell it,
    // which on the wire was indistinguishable from an agent with no view at all.
    expect(reasoningWire({ enabled: true })).toEqual({ enabled: true });
  });

  it('an absent posture is still silence — nothing is ever synthesized', () => {
    expect(reasoningWire(null)).toBeUndefined();
  });

  it('drops an effort authored beside `enabled: false` — one instruction per wire', () => {
    expect(reasoningWire({ enabled: false, effort: 'high' })).toEqual({ enabled: false });
  });

  it('names the field it is written to, and keeps the caller-pin key it no longer renders', () => {
    expect(REASONING_WIRE_FIELD).toBe('reasoning');
    expect(REASONING_EFFORT_EXTRA_KEY).toBe('reasoning_effort');
  });
});

describe('agentReasoningProblems — write-time validation', () => {
  it('accepts an absent block and every declared effort', () => {
    expect(agentReasoningProblems({})).toEqual([]);
    expect(agentReasoningProblems({ generation: {} })).toEqual([]);
    for (const effort of AGENT_REASONING_EFFORTS) {
      expect(agentReasoningProblems({ generation: { reasoning: { enabled: true, effort } } })).toEqual([]);
    }
  });

  it('rejects an unknown effort, and names the four that exist', () => {
    const problems = agentReasoningProblems({ generation: { reasoning: { enabled: true, effort: 'max' } } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('parameters/generation/reasoning/effort');
    expect(problems[0]).toContain('minimal, low, medium, high');
  });

  it('rejects a missing or non-boolean `enabled`, and an unknown property', () => {
    expect(agentReasoningProblems({ generation: { reasoning: {} } })[0]).toContain('enabled');
    expect(agentReasoningProblems({ generation: { reasoning: { enabled: 1 } } })[0]).toContain('enabled');
    expect(agentReasoningProblems({ generation: { reasoning: { enabled: true, budget: 10 } } })[0]).toContain('unknown property');
    expect(agentReasoningProblems({ generation: { reasoning: true } })[0]).toContain('must be an object');
  });
});
