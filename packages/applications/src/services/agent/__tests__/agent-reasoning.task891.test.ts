/**
 * TASK-891 C1 (owner decision OD-4) — `parameters.generation.reasoning`.
 *
 * > "Per-agent parameters block."
 *
 * The shape is `{ enabled: boolean; effort?: 'minimal' | 'low' | 'medium' | 'high' }`, and
 * an unknown effort is REFUSED at write time rather than shipped to an engine that will
 * ignore it. "Disabled" is not silence — it is `reasoning_effort: 'minimal'`, i.e. the
 * engine is instructed not to reason; leaving the field out would leave the engine on its
 * own default, which is the state being turned off.
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
  reasoningExtra,
  REASONING_EFFORT_EXTRA_KEY,
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

describe('reasoningExtra — the GenerateRequest.extra ride-along', () => {
  it('disabled asks the engine not to reason, rather than saying nothing', () => {
    expect(reasoningExtra({ enabled: false })).toEqual({ [REASONING_EFFORT_EXTRA_KEY]: 'minimal' });
  });

  it('enabled with an effort sends that effort', () => {
    for (const effort of AGENT_REASONING_EFFORTS) {
      expect(reasoningExtra({ enabled: true, effort })).toEqual({ [REASONING_EFFORT_EXTRA_KEY]: effort });
    }
  });

  it('enabled with no effort sends nothing — the engine keeps its own budget', () => {
    expect(reasoningExtra({ enabled: true })).toBeUndefined();
    expect(reasoningExtra(null)).toBeUndefined();
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
