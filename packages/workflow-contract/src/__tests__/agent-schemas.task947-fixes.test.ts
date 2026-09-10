/**
 * TASK-947 — R1 #2: a `when` of 120 nested parentheses (244 characters, far under the 2 000-char
 * cap) parses in TypeScript and raised an uncaught `RecursionError` on the Python worker, so
 * publish accepted what the durable lane could not evaluate. The Python evaluator now answers an
 * error (→ a `condition_error` exclusion, OD-5); this cap makes PUBLISH refuse the shape first,
 * so the two runtimes cannot disagree on it.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_PROMPT_CONDITION_MAX_DEPTH } from '../agent-instruction';
import { agentConfigProblems, type AgentConfigView } from '../agent-schemas';

const view = (when: string): AgentConfigView => ({
  task: 'TEXT_GENERATION',
  instruction: {
    fragments: [
      { key: 'base', systemPrompt: 'B' },
      { key: 'deep', systemPrompt: 'D', when },
    ],
  },
  parameters: {},
});

const nested = (depth: number): string => `${'('.repeat(depth)}true${')'.repeat(depth)}`;

describe('fragmentProblems — the nesting cap on `when`', () => {
  it('declares a cap well under the depth the Python parser tolerates (120)', () => {
    expect(AGENT_PROMPT_CONDITION_MAX_DEPTH).toBeLessThanOrEqual(64);
    expect(AGENT_PROMPT_CONDITION_MAX_DEPTH).toBeGreaterThanOrEqual(16);
  });

  it('accepts a condition at the cap and refuses one past it, with the CONDITION_SYNTAX code', () => {
    expect(agentConfigProblems(view(nested(AGENT_PROMPT_CONDITION_MAX_DEPTH)))).toEqual([]);
    const found = agentConfigProblems(view(nested(AGENT_PROMPT_CONDITION_MAX_DEPTH + 1)));
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('instruction.fragments[1].when');
    expect(found[0]?.code).toBe('PROMPT_FRAGMENT_CONDITION_SYNTAX');
    expect(found[0]?.message).toMatch(/nest/i);
  });

  it('counts brackets and braces too, and only OPEN depth (a flat list of groups is fine)', () => {
    expect(
      agentConfigProblems(view(`${'['.repeat(AGENT_PROMPT_CONDITION_MAX_DEPTH + 1)}1${']'.repeat(AGENT_PROMPT_CONDITION_MAX_DEPTH + 1)} == [1]`)),
    ).toHaveLength(1);
    expect(agentConfigProblems(view(Array.from({ length: 100 }, () => '(true)').join(' && ')))).toEqual([]);
  });
});
