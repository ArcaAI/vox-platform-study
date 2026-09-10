/**
 * TASK-947 §4.1/§4.5 item 3 — the composable-fragments row editor. Two layers of coverage:
 * pure round-trip + validation helpers (no DOM), then the rendered editor (add/remove/move,
 * source toggle, `when` input, and the union "Variable bindings" fieldset with a conflict).
 * `fetch` is stubbed at the network boundary, as in `instruction-binding-form.task890.test.tsx`.
 */
import { useState } from 'react';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { AgentPromptVariableBinding, PromptFragment } from '../../api/types';
import {
  FragmentListEditor,
  defaultFragmentRow,
  fragmentListProblems,
  fragmentRowsFromFragments,
  fragmentsFromRows,
  type FragmentRow,
} from '../fragment-list-editor';

describe('fragmentRowsFromFragments / fragmentsFromRows (pure round trip)', () => {
  it('round-trips a template fragment with a pinned version and a condition', () => {
    const fragments: PromptFragment[] = [{ key: 'revisit', promptTemplateId: 'tpl-1', promptVersionNumber: 5, when: "has(context.visit_type) && context.visit_type == 'revisit'" }];
    expect(fragmentsFromRows(fragmentRowsFromFragments(fragments))).toEqual(fragments);
  });

  it('round-trips an inline fragment with no condition (the base)', () => {
    const fragments: PromptFragment[] = [{ key: 'base', systemPrompt: 'You are a scribe.' }];
    expect(fragmentsFromRows(fragmentRowsFromFragments(fragments))).toEqual(fragments);
  });

  it('round-trips a template fragment with no version pin (follow approved)', () => {
    const fragments: PromptFragment[] = [{ key: 'base', promptTemplateId: 'tpl-1' }];
    expect(fragmentsFromRows(fragmentRowsFromFragments(fragments))).toEqual(fragments);
  });

  it('preserves authored order', () => {
    const fragments: PromptFragment[] = [
      { key: 'base', promptTemplateId: 'tpl-1' },
      { key: 'revisit', promptTemplateId: 'tpl-2', when: 'has(context.visit_type)' },
      { key: 'peds', systemPrompt: 'Minor.', when: 'has(context.patient_age) && context.patient_age < 18' },
    ];
    expect(fragmentsFromRows(fragmentRowsFromFragments(fragments))).toEqual(fragments);
  });
});

describe('fragmentListProblems', () => {
  function row(overrides: Partial<FragmentRow> = {}): FragmentRow {
    return { ...defaultFragmentRow(), key: 'base', promptTemplateId: 'tpl-1', ...overrides };
  }

  it('is empty for a single, valid, unconditional (base) fragment', () => {
    expect(fragmentListProblems([row()])).toEqual([]);
  });

  it('flags a duplicate key', () => {
    const problems = fragmentListProblems([row({ key: 'dup' }), row({ key: 'dup', when: 'has(context.x)' })]);
    expect(problems).toContain('Duplicate fragment key: "dup" is used 2 times.');
  });

  it('flags a key that does not match the pattern', () => {
    const problems = fragmentListProblems([row({ key: 'Bad Key!' })]);
    expect(problems.some((problem) => problem.includes('must be 2–48 lowercase letters, digits, or underscores'))).toBe(true);
  });

  it('flags a missing base — every fragment carries a condition', () => {
    const problems = fragmentListProblems([row({ when: 'has(context.a)' }), row({ key: 'other', when: 'has(context.b)' })]);
    expect(problems).toContain('At least one fragment must have no condition — this is the base that always applies.');
  });

  it('flags a template-source row with no template chosen', () => {
    const problems = fragmentListProblems([row({ promptTemplateId: null })]);
    expect(problems.some((problem) => problem.includes('needs a prompt template'))).toBe(true);
  });

  it('flags an inline-source row with no content', () => {
    const problems = fragmentListProblems([row({ source: 'inline', promptTemplateId: null, systemPrompt: '' })]);
    expect(problems.some((problem) => problem.includes('needs inline prompt text'))).toBe(true);
  });

  it('is empty for 16 fragments and flags 17', () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => row({ key: `f${i}`, when: i === 0 ? '' : 'has(context.x)' }));
    expect(fragmentListProblems(sixteen)).toEqual([]);
    const seventeen = [...sixteen, row({ key: 'f16', when: 'has(context.x)' })];
    expect(fragmentListProblems(seventeen)).toContain('At most 16 fragments are allowed (17 present).');
  });
});

const TEMPLATE_A = {
  id: 'tpl-a',
  name: 'SOAP note',
  status: 'APPROVED' as const,
  category: 'SUMMARY',
  approvedVersionNumber: 3,
  currentVersionNumber: 3,
  contentPreview: 'Base note {{context.visit_type}}',
  declaredVariables: [{ name: 'tone', type: 'string' as const, required: false, default: 'clinical' }],
};

const TEMPLATE_B = {
  id: 'tpl-b',
  name: 'Revisit addendum',
  status: 'APPROVED' as const,
  category: 'SUMMARY',
  approvedVersionNumber: 2,
  currentVersionNumber: 2,
  contentPreview: 'Revisit addendum',
  // Conflicts with TEMPLATE_A's `tone` (string) by declaring it as a number.
  declaredVariables: [{ name: 'tone', type: 'number' as const, required: false }],
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(`admin/prompt-templates/${TEMPLATE_A.id}`)) return Response.json(TEMPLATE_A);
      if (url.includes(`admin/prompt-templates/${TEMPLATE_B.id}`)) return Response.json(TEMPLATE_B);
      if (url.includes('admin/prompt-templates')) return Response.json({ data: [TEMPLATE_A, TEMPLATE_B] });
      return new Response('not found', { status: 404 });
    }),
  );
}

function Host({ initial, onFragmentsChange }: { initial: FragmentRow[]; onFragmentsChange?: (rows: FragmentRow[]) => void }) {
  const [fragments, setFragments] = useState<FragmentRow[]>(initial);
  const [variables, setVariables] = useState<Record<string, AgentPromptVariableBinding>>({});
  return (
    <FragmentListEditor
      fragments={fragments}
      onFragmentsChange={(next) => {
        setFragments(next);
        onFragmentsChange?.(next);
      }}
      variables={variables}
      onVariablesChange={setVariables}
    />
  );
}

beforeEach(() => stubFetch());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FragmentListEditor (rendered)', () => {
  it('renders an empty state and "Add fragment" adds one row', async () => {
    renderWithProviders(<Host initial={[]} />);
    expect(screen.getByText(/No fragments yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add fragment' }));
    expect(await screen.findByLabelText('Key *')).toBeTruthy();
  });

  it('move up/down reorders rows, and the boundary buttons are disabled at the ends', async () => {
    renderWithProviders(<Host initial={[{ ...defaultFragmentRow(), key: 'first' }, { ...defaultFragmentRow(), key: 'second', when: 'has(context.x)' }]} />);
    const keys = () => screen.getAllByLabelText('Key *').map((input) => (input as HTMLInputElement).value);
    expect(keys()).toEqual(['first', 'second']);
    expect((screen.getByRole('button', { name: 'Move first up' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move first down' }));
    expect(keys()).toEqual(['second', 'first']);
    expect((screen.getByRole('button', { name: 'Move first down' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('remove deletes the row', async () => {
    renderWithProviders(<Host initial={[{ ...defaultFragmentRow(), key: 'only' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove only' }));
    expect(screen.getByText(/No fragments yet/)).toBeTruthy();
  });

  it('toggling a row to inline reveals the inline textarea and hides the template picker for that row', async () => {
    renderWithProviders(<Host initial={[{ ...defaultFragmentRow(), key: 'base' }]} />);
    expect(await screen.findByLabelText('Prompt template')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Use an inline prompt'));
    expect(screen.queryByLabelText('Prompt template')).toBeNull();
    expect(screen.getByLabelText('Inline prompt *')).toBeTruthy();
  });

  it('a duplicate key and a missing base are both flagged inline', () => {
    renderWithProviders(
      <Host
        initial={[
          { ...defaultFragmentRow(), key: 'dup', when: 'has(context.a)' },
          { ...defaultFragmentRow(), key: 'dup', when: 'has(context.b)' },
        ]}
      />,
    );
    expect(screen.getByText('Duplicate fragment key: "dup" is used 2 times.')).toBeTruthy();
    expect(screen.getByText('At least one fragment must have no condition — this is the base that always applies.')).toBeTruthy();
  });

  it('unions declared variables across two template fragments and flags a type conflict', async () => {
    renderWithProviders(
      <Host
        initial={[
          { ...defaultFragmentRow(), key: 'base', promptTemplateId: TEMPLATE_A.id },
          { ...defaultFragmentRow(), key: 'revisit', promptTemplateId: TEMPLATE_B.id, when: 'has(context.visit_type)' },
        ]}
      />,
    );
    expect(await screen.findByText(/Variable "tone" is declared differently/)).toBeTruthy();
  });

  it('has no axe violations with two fragments (WCAG 2.2 AA gate)', async () => {
    const { container } = renderWithProviders(
      <Host initial={[{ ...defaultFragmentRow(), key: 'base' }, { ...defaultFragmentRow(), key: 'revisit', when: 'has(context.x)' }]} />,
    );
    expect((await screen.findAllByLabelText('Prompt template')).length).toBe(2);
    expect(await axe(container)).toHaveNoViolations();
  });
});
