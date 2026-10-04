/**
 * TASK-1036 R-C #5 / #6 — the `/` trigger must never put a field into clinical text by accident.
 *
 *  - `/` opens the field list only when it is followed by a LETTER (`/tr`), or when the author asks
 *    for the list explicitly (Ctrl/Cmd-Space). A bare `/` — "and/or", "5 / 10", "BP 120/80" — never
 *    opens it.
 *  - Enter on a `/` list the author has NOT navigated inserts a newline (and closes the list); only
 *    after an arrow key moves through it does Enter pick. `{{` lists keep Enter-to-pick: typing
 *    `{{` is an explicit request for a field.
 *  - Completion rows carry their scope (`cm-scope-<scope>`) so the four scope colours style them.
 */
import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { CompletionContext, completionStatus, startCompletion, type Completion } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { runScopeHandlers, type EditorView } from '@codemirror/view';
import { TemplateEditor, slashCompletionSource, templateCompletionSource, templateEditorView, type VariablePath } from '../../custom/template-editor';

const PATHS: VariablePath[] = [
  { path: 'nodes.asr.outputs.transcript', label: 'Transcribe › transcript', type: 'text', group: 'Earlier steps', scope: 'steps' },
  { path: 'context.patient.name', label: 'context.patient.name', type: 'text', group: 'Context', scope: 'context' },
];

function contextAt(doc: string, explicit = false) {
  return new CompletionContext(EditorState.create({ doc }), doc.length, explicit);
}

function press(view: EditorView, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    runScopeHandlers(view, event, 'editor');
  });
}

function mount(value: string) {
  let latest = value;
  render(<TemplateEditor value={value} onChange={(next) => (latest = next)} label="Note" paths={PATHS} />);
  const view = templateEditorView(screen.getByRole('textbox', { name: 'Note' }));
  if (!view) throw new Error('no view');
  act(() => view.dispatch({ selection: { anchor: value.length } }));
  return { view, text: () => latest };
}

async function openList(view: EditorView) {
  act(() => {
    startCompletion(view);
  });
  await waitFor(() => expect(completionStatus(view.state)).toBe('active'));
  // CodeMirror ignores list keys for `interactionDelay` (75 ms) after a list opens.
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
}

describe('TemplateEditor — `/` opens only before a letter', () => {
  it('does not open on a bare slash, nor on a slash before a digit or a space', () => {
    expect(slashCompletionSource(() => PATHS)(contextAt('Plan /'))).toBeNull();
    expect(slashCompletionSource(() => PATHS)(contextAt('BP /8'))).toBeNull();
    expect(slashCompletionSource(() => PATHS)(contextAt('/'))).toBeNull();
  });

  it('opens on `/` followed by a letter', () => {
    expect(slashCompletionSource(() => PATHS)(contextAt('Plan /t'))?.from).toBe(6);
  });

  it('still opens on an explicit request (Ctrl/Cmd-Space) right after a bare slash', () => {
    expect(slashCompletionSource(() => PATHS)(contextAt('Plan /', true))?.from).toBe(6);
  });
});

describe('TemplateEditor — Enter on an un-navigated `/` list is a newline', () => {
  it('inserts a newline and closes the list when nothing was navigated', async () => {
    const { view, text } = mount('Plan /tr');
    await openList(view);
    press(view, 'Enter');
    expect(text()).toBe('Plan /tr\n');
    expect(completionStatus(view.state)).toBeNull();
  });

  it('picks the highlighted field once the author has navigated the list', async () => {
    const { view, text } = mount('Plan /tr');
    await openList(view);
    press(view, 'ArrowDown');
    press(view, 'ArrowUp');
    press(view, 'Enter');
    expect(text()).toBe('Plan {{nodes.asr.outputs.transcript}}');
  });

  it('keeps Enter-to-pick on a `{{` list — typing braces is an explicit request', async () => {
    const { view, text } = mount('Plan {{tr');
    await openList(view);
    press(view, 'Enter');
    expect(text()).toBe('Plan {{nodes.asr.outputs.transcript}}');
  });

  it('marks the editor while a `/` list is pending so no row LOOKS chosen', async () => {
    const { view } = mount('Plan /tr');
    await openList(view);
    expect(view.dom.classList.contains('cm-slash-pending')).toBe(true);
    press(view, 'ArrowDown');
    expect(view.dom.classList.contains('cm-slash-pending')).toBe(false);
  });
});

describe('TemplateEditor — rows are styled by scope', () => {
  it('gives each option a scope class the theme colours', () => {
    const options = (templateCompletionSource(() => PATHS)(contextAt('{{'))?.options ?? []) as Completion[];
    expect(options.map((option) => option.class)).toEqual(['cm-scope-steps', 'cm-scope-context']);
  });
});
