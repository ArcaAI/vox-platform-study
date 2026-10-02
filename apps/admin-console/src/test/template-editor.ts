/**
 * Drives a `TemplateEditor` (CodeMirror 6) from a test. CodeMirror owns a contenteditable, so
 * `fireEvent.change` cannot reach it; these go through the editor's own transaction API, which is
 * what a keystroke ends up as anyway.
 */
import { act } from '@testing-library/react';
import { templateEditorView } from '@arcaai/ui/components/custom/template-editor';

function viewOf(element: HTMLElement) {
  const view = templateEditorView(element);
  if (!view) throw new Error('not a TemplateEditor');
  return view;
}

/** Replace the editor's whole content, as a user would by select-all + type. */
export function setTemplateEditorValue(element: HTMLElement, text: string): void {
  const view = viewOf(element);
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' });
  });
}

export function templateEditorValue(element: HTMLElement): string {
  return viewOf(element).state.doc.toString();
}
