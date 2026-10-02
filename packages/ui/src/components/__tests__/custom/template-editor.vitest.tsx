import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';
import { CompletionContext, completionStatus, currentCompletions, type Completion } from '@codemirror/autocomplete';
import { forEachDiagnostic } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import {
  TemplateEditor,
  celCompletionSource,
  renderVariablePathBadges,
  templateCompletionSource,
  templateEditorView,
  type VariablePath,
} from '../../custom/template-editor';

expect.extend(axeMatchers);

const PATHS: VariablePath[] = [
  { path: 'context.patient.age', type: 'integer', required: true, phiClass: 'PHI', description: 'Age in years', deprecated: false },
  { path: 'context.visit.reason', type: 'string', required: false, phiClass: 'NON_PHI', description: null, deprecated: false },
  { path: 'trigger.context.note', type: 'string', required: false, phiClass: null, description: null, deprecated: false },
];

function contextAt(doc: string, pos = doc.length, explicit = false) {
  return new CompletionContext(EditorState.create({ doc }), pos, explicit);
}

function editorFor(label: string) {
  const content = screen.getByRole('textbox', { name: label });
  const view = templateEditorView(content);
  if (!view) throw new Error('no editor view');
  return { content, view };
}

describe('TemplateEditor', () => {
  it('renders a labelled multi-line textbox holding the value', () => {
    render(<TemplateEditor value="Hello {{context.patient.age}}" onChange={() => {}} label="Prompt content" paths={PATHS} />);
    const { content, view } = editorFor('Prompt content');
    expect(content.getAttribute('aria-multiline')).toBe('true');
    expect(view.state.doc.toString()).toBe('Hello {{context.patient.age}}');
  });

  it('reports edits through onChange and follows an external value', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TemplateEditor value="a" onChange={onChange} label="Prompt content" />);
    const { view } = editorFor('Prompt content');
    act(() => view.dispatch({ changes: { from: 1, insert: 'b' } }));
    expect(onChange).toHaveBeenLastCalledWith('ab');
    rerender(<TemplateEditor value="replaced" onChange={onChange} label="Prompt content" />);
    expect(view.state.doc.toString()).toBe('replaced');
  });

  it('offers every path after `{{` and nothing outside a placeholder', () => {
    const result = templateCompletionSource(() => PATHS)(contextAt('Age: {{pat'));
    expect(result).not.toBeNull();
    expect(result?.options.map((option) => option.label)).toEqual(PATHS.map((entry) => entry.path));
    expect(templateCompletionSource(() => PATHS)(contextAt('Age: plain text'))).toBeNull();
  });

  it('selecting a completion inserts `{{path}}` and consumes a closing brace pair', () => {
    render(<TemplateEditor value="Age: {{con}}" onChange={() => {}} label="Prompt content" paths={PATHS} />);
    const { view } = editorFor('Prompt content');
    const result = templateCompletionSource(() => PATHS)(new CompletionContext(view.state, 10, false));
    const option = result?.options[0] as Completion;
    act(() => {
      (option.apply as (view: unknown, completion: Completion, from: number, to: number) => void)(view, option, result?.from ?? 0, 10);
    });
    expect(view.state.doc.toString()).toBe('Age: {{context.patient.age}}');
  });

  it('opens the completion list when `{{` is typed', async () => {
    render(<TemplateEditor value="" onChange={() => {}} label="Prompt content" paths={PATHS} />);
    const { view } = editorFor('Prompt content');
    act(() => {
      view.focus();
      view.dispatch({ changes: { from: 0, insert: '{{' }, selection: { anchor: 2 }, userEvent: 'input.type' });
    });
    await waitFor(() => expect(completionStatus(view.state)).toBe('active'));
    expect(currentCompletions(view.state).map((option) => option.label)).toContain('context.patient.age');
  });

  it('labels each option with type, required and PHI badges', () => {
    const option = templateCompletionSource(() => PATHS)(contextAt('{{'))?.options[0] as Completion;
    const node = renderVariablePathBadges(option);
    expect(node?.textContent).toContain('integer');
    expect(node?.textContent).toContain('required');
    expect(node?.textContent).toContain('PHI');
  });

  it('in CEL mode completes after a root and not after `{{`', () => {
    const source = celCompletionSource(() => PATHS);
    const result = source(contextAt('size(context.pa'));
    expect(result?.options.map((option) => option.label)).toContain('context.patient.age');
    expect(result?.from).toBe(5);
    expect(source(contextAt('{{'))).toBeNull();
    expect(source(contextAt('nodes.'))).not.toBeNull();
  });

  it('renders lint diagnostics as squiggles plus an accessible summary', async () => {
    const lint = (content: string) =>
      content.includes('{{nope}}') ? [{ from: 4, to: 12, message: '`nope` is not a declared variable', severity: 'error' as const }] : [];
    render(<TemplateEditor value="Hi, {{nope}}" onChange={() => {}} label="Prompt content" lint={lint} lintDelay={0} />);
    const { content, view } = editorFor('Prompt content');
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/1 problem/));
    expect(screen.getByText('`nope` is not a declared variable')).toBeDefined();
    expect(content.getAttribute('aria-invalid')).toBe('true');
    const found: string[] = [];
    forEachDiagnostic(view.state, (diagnostic) => found.push(diagnostic.message));
    expect(found).toEqual(['`nope` is not a declared variable']);
  });

  it('is not editable when readOnly', () => {
    render(<TemplateEditor value="fixed" onChange={() => {}} label="Prompt content" readOnly />);
    const { content } = editorFor('Prompt content');
    expect(content.getAttribute('contenteditable')).toBe('false');
    expect(content.getAttribute('aria-readonly')).toBe('true');
  });

  it('has no axe violations', async () => {
    const lint = () => [{ from: 0, to: 2, message: 'Problem', severity: 'warning' as const }];
    const { container } = render(
      <TemplateEditor value="Hi {{context.patient.age}}" onChange={() => {}} label="Prompt content" paths={PATHS} lint={lint} lintDelay={0} />,
    );
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/1 problem/));
    expect(await axe(container)).toHaveNoViolations();
  });
});
