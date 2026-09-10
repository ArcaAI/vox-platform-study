/**
 * TASK-947 OD-2 — the THIRD instruction form of a TEXT_GENERATION agent: `fragments[]`.
 *
 * Exactly one of `promptTemplateId` / `systemPrompt` / `fragments`; 1–16 fragments; keys on the
 * branch-handle grammar and unique; each fragment exactly one of template / inline; a pin only
 * on a template fragment; `when` a CEL string that parses; and at least ONE fragment with no
 * `when` (OD-6 — the base the runtime can never lose). The two older forms are byte-identical
 * to their TASK-890 behaviour: those suites stay green untouched.
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { AGENT_INSTRUCTION_SCHEMAS, agentConfigProblems, type AgentConfigProblem, type AgentConfigView } from '../agent-schemas';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';

const view = (instruction: Record<string, unknown>): AgentConfigView => ({ task: 'TEXT_GENERATION', instruction, parameters: {} });

const valid = {
  fragments: [
    { key: 'base', promptTemplateId: T1, promptVersionNumber: 3 },
    { key: 'revisit', promptTemplateId: T2, when: "has(context.visit_type) && context.visit_type == 'revisit'" },
    { key: 'peds', systemPrompt: 'The patient is a minor.', when: 'has(context.patient_age) && context.patient_age < 18' },
  ],
  variables: { language: { path: 'context.language' } },
};

function schemaProblems(instruction: Record<string, unknown>): string[] {
  return jsonSchemaValueProblems(AGENT_INSTRUCTION_SCHEMAS.TEXT_GENERATION, instruction, 'instruction');
}

function problems(instruction: Record<string, unknown>): AgentConfigProblem[] {
  return agentConfigProblems(view(instruction));
}

describe('form 3 — a valid composite instruction', () => {
  it('passes both the keyword schema and the semantic checks', () => {
    expect(schemaProblems(valid)).toEqual([]);
    expect(problems(valid)).toEqual([]);
  });

  it('may carry `variables` (bindings) and `evalGate` like form 1', () => {
    expect(problems({ ...valid, evalGate: { goldenSetId: T1, enabled: true } })).toEqual([]);
  });

  it('may be made of inline fragments only', () => {
    expect(
      problems({
        fragments: [
          { key: 'base', systemPrompt: 'B' },
          { key: 'extra', systemPrompt: 'X', when: 'has(context.x)' },
        ],
      }),
    ).toEqual([]);
  });
});

describe('form 3 — mutual exclusion with forms 1 and 2', () => {
  it('refuses `fragments` beside `promptTemplateId` or `systemPrompt`, naming all three', () => {
    for (const extra of [{ promptTemplateId: T1 }, { systemPrompt: 'x' }]) {
      const found = problems({ ...valid, ...extra });
      expect(
        found.some((p) => p.path === 'instruction' && p.severity === 'ERROR' && /fragments/.test(p.message) && /promptTemplateId/.test(p.message)),
      ).toBe(true);
    }
  });

  it('refuses a top-level `promptVersionNumber` with fragments — a pin lives on the fragment', () => {
    const found = problems({ ...valid, promptVersionNumber: 2 });
    expect(found.some((p) => p.path === 'instruction.promptVersionNumber' && p.severity === 'ERROR')).toBe(true);
  });

  it('still refuses an empty instruction with a message that names the three forms', () => {
    const found = problems({});
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toMatch(/fragments/);
  });
});

describe('form 3 — the list', () => {
  it('refuses an empty list and a list of 17, at `instruction.fragments`, with the SHAPE code', () => {
    const empty = problems({ fragments: [] });
    expect(empty.some((p) => p.path === 'instruction.fragments' && p.code === 'PROMPT_FRAGMENT_SHAPE')).toBe(true);
    expect(schemaProblems({ fragments: [] })).not.toEqual([]);

    const seventeen = { fragments: Array.from({ length: 17 }, (_, i) => ({ key: `f_${i}`, systemPrompt: 'x' })) };
    expect(problems(seventeen).some((p) => p.path === 'instruction.fragments' && p.code === 'PROMPT_FRAGMENT_SHAPE')).toBe(true);
    expect(schemaProblems(seventeen)).not.toEqual([]);
  });

  it('refuses a non-object entry', () => {
    const found = problems({ fragments: ['base'] });
    expect(found.some((p) => p.path === 'instruction.fragments[0]' && p.code === 'PROMPT_FRAGMENT_SHAPE')).toBe(true);
  });
});

describe('form 3 — keys', () => {
  it('refuses a missing, malformed or duplicate key at `instruction.fragments[i].key`', () => {
    expect(problems({ fragments: [{ systemPrompt: 'x' }] }).some((p) => p.path === 'instruction.fragments[0].key')).toBe(true);
    expect(problems({ fragments: [{ key: 'Base Prompt', systemPrompt: 'x' }] }).some((p) => p.path === 'instruction.fragments[0].key')).toBe(true);
    expect(schemaProblems({ fragments: [{ key: 'Base Prompt', systemPrompt: 'x' }] })).not.toEqual([]);

    const dup = problems({
      fragments: [
        { key: 'base', systemPrompt: 'x' },
        { key: 'base', systemPrompt: 'y' },
      ],
    });
    expect(dup.some((p) => p.path === 'instruction.fragments[1].key' && /duplicate|unique/i.test(p.message))).toBe(true);
    expect(dup.every((p) => p.code === 'PROMPT_FRAGMENT_SHAPE')).toBe(true);
  });
});

describe('form 3 — each fragment', () => {
  it('refuses a fragment with neither or both of `promptTemplateId` / `systemPrompt`', () => {
    for (const fragment of [{ key: 'base' }, { key: 'base', promptTemplateId: T1, systemPrompt: 'x' }]) {
      const found = problems({ fragments: [fragment] });
      expect(found.some((p) => p.path === 'instruction.fragments[0]' && p.code === 'PROMPT_FRAGMENT_SHAPE')).toBe(true);
    }
    expect(schemaProblems({ fragments: [{ key: 'base', promptTemplateId: T1, extra: 1 }] })).not.toEqual([]);
  });

  it('refuses a version pin on an inline fragment, or a non-positive one', () => {
    expect(
      problems({ fragments: [{ key: 'base', systemPrompt: 'x', promptVersionNumber: 1 }] }).some(
        (p) => p.path === 'instruction.fragments[0].promptVersionNumber',
      ),
    ).toBe(true);
    expect(
      problems({ fragments: [{ key: 'base', promptTemplateId: T1, promptVersionNumber: 0 }] }).some(
        (p) => p.path === 'instruction.fragments[0].promptVersionNumber',
      ),
    ).toBe(true);
    expect(schemaProblems({ fragments: [{ key: 'base', promptTemplateId: T1, promptVersionNumber: 0 }] })).not.toEqual([]);
  });

  it('refuses a `when` that is not a non-empty string within the limit, with the SHAPE code', () => {
    const base = { key: 'base', systemPrompt: 'B' };
    expect(
      problems({ fragments: [base, { key: 'extra', systemPrompt: 'X', when: '' }] }).some(
        (p) => p.path === 'instruction.fragments[1].when' && p.code === 'PROMPT_FRAGMENT_SHAPE',
      ),
    ).toBe(true);
    expect(
      problems({ fragments: [base, { key: 'extra', systemPrompt: 'X', when: 42 }] }).some(
        (p) => p.path === 'instruction.fragments[1].when' && p.code === 'PROMPT_FRAGMENT_SHAPE',
      ),
    ).toBe(true);
    expect(
      problems({ fragments: [base, { key: 'extra', systemPrompt: 'X', when: 'a'.repeat(2001) }] }).some(
        (p) => p.path === 'instruction.fragments[1].when',
      ),
    ).toBe(true);
  });

  it('refuses a `when` that does not parse, with the CONDITION_SYNTAX code and the parser`s reason', () => {
    const found = problems({
      fragments: [
        { key: 'base', systemPrompt: 'B' },
        { key: 'extra', systemPrompt: 'X', when: 'context.visit_type ==' },
      ],
    });
    const syntax = found.find((p) => p.path === 'instruction.fragments[1].when');
    expect(syntax?.code).toBe('PROMPT_FRAGMENT_CONDITION_SYNTAX');
    expect(syntax?.severity).toBe('ERROR');
    expect(syntax?.message).toMatch(/parse/);
  });
});

describe('form 3 — the base fragment (OD-6)', () => {
  it('refuses a list where every fragment carries a `when`, with the NO_BASE code', () => {
    const found = problems({
      fragments: [
        { key: 'alpha', systemPrompt: 'A', when: 'has(context.a)' },
        { key: 'beta', systemPrompt: 'B', when: 'has(context.b)' },
      ],
    });
    expect(found).toHaveLength(1);
    const noBase = found.find((p) => p.code === 'PROMPT_COMPOSITION_NO_BASE');
    expect(noBase?.path).toBe('instruction.fragments');
    expect(noBase?.severity).toBe('ERROR');
    expect(noBase?.message).toMatch(/without.*when|no `when`|unconditional/i);
  });

  it('is satisfied by one unconditional fragment anywhere in the list', () => {
    expect(
      problems({
        fragments: [
          { key: 'alpha', systemPrompt: 'A', when: 'has(context.a)' },
          { key: 'base', systemPrompt: 'B' },
        ],
      }),
    ).toEqual([]);
  });
});

describe('forms 1 and 2 — unchanged', () => {
  it('a template-bound instruction still validates and still refuses a pin without a template', () => {
    expect(problems({ promptTemplateId: T1, promptVersionNumber: 2, variables: { a: { value: 'x' } } })).toEqual([]);
    expect(problems({ systemPrompt: 'x', promptVersionNumber: 2 }).some((p) => p.path === 'instruction')).toBe(true);
  });

  it('carries no `code` on the pre-947 problems — the applications layer keeps deriving those from the path', () => {
    for (const problem of problems({ systemPrompt: 'x', variables: { a: '67' } })) expect(problem.code).toBeUndefined();
  });
});
