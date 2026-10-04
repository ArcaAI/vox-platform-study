/**
 * TASK-1036 §10.1 — the TemplateEditor as the composer's field picker:
 *
 *  - options are GROUPED (section per scope, in the order given), shown by LABEL (`Transcribe ›
 *    transcript`) and insert the STORED path (`{{nodes.asr.outputs.transcript}}`);
 *  - type-aware ranking: the best match first and badged, a convertible item says how it
 *    converts, a blocked item stays visible but inserts nothing and says why;
 *  - samples ride on the option;
 *  - `/` at the start of a word opens the same list (Dify-style), replacing the `/query`;
 *  - `editorRef.insertAtCursor` is the "+ Insert field" button's way in.
 */
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { CompletionContext, type Completion } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import {
  TemplateEditor,
  renderVariablePathBadges,
  slashCompletionSource,
  templateCompletionSource,
  templateEditorView,
  type TemplateEditorHandle,
  type VariablePath,
} from '../../custom/template-editor';

const PATHS: VariablePath[] = [
  { path: 'nodes.asr.outputs.transcript', label: 'Transcribe › transcript', type: 'text', group: 'Earlier steps', scope: 'steps', bestMatch: true, sample: '“chest pain”', phiClass: 'PHI' },
  { path: 'nodes.asr.outputs.segments', label: 'Transcribe › segments', type: 'list<segment>', group: 'Earlier steps', scope: 'steps', convertNote: 'Formatted as text' },
  { path: 'nodes.tts.outputs.audio', label: 'Speak › audio', type: 'audio', group: 'Earlier steps', scope: 'steps', disabledReason: 'Can’t use audio here' },
  { path: 'consultation.patient.age', type: 'number', group: 'Consultation', scope: 'consultation' },
];

function contextAt(doc: string, pos = doc.length) {
  return new CompletionContext(EditorState.create({ doc }), pos, false);
}

function apply(view: Parameters<NonNullable<Exclude<Completion['apply'], string>>>[0], option: Completion, from: number, to: number) {
  (option.apply as (v: unknown, c: Completion, f: number, t: number) => void)(view, option, from, to);
}

describe('TemplateEditor — grouped, labelled, ranked options', () => {
  it('shows labels, groups them in the given order, and ranks the best match first', () => {
    const result = templateCompletionSource(() => PATHS)(contextAt('{{'));
    const options = result?.options ?? [];
    expect(options.map((option) => option.label)).toEqual(['Transcribe › transcript', 'Transcribe › segments', 'Speak › audio', 'consultation.patient.age']);
    const sections = options.map((option) => (typeof option.section === 'object' ? option.section?.name : option.section));
    expect(sections).toEqual(['Earlier steps', 'Earlier steps', 'Earlier steps', 'Consultation']);
    expect((options[0]?.boost ?? 0) > (options[1]?.boost ?? 0)).toBe(true);
    expect((options[2]?.boost ?? 0) < 0).toBe(true);
  });

  it('inserts the STORED path for a labelled option, and nothing for a blocked one', () => {
    render(<TemplateEditor value="Note: {{" onChange={() => {}} label="Prompt" paths={PATHS} />);
    const view = templateEditorView(screen.getByRole('textbox', { name: 'Prompt' }));
    if (!view) throw new Error('no view');
    const result = templateCompletionSource(() => PATHS)(new CompletionContext(view.state, 8, false));
    act(() => apply(view, result?.options[2] as Completion, result?.from ?? 0, 8));
    expect(view.state.doc.toString()).toBe('Note: {{');
    act(() => apply(view, result?.options[0] as Completion, result?.from ?? 0, 8));
    expect(view.state.doc.toString()).toBe('Note: {{nodes.asr.outputs.transcript}}');
  });

  it('badges best match, conversion, the blocked reason and the sample', () => {
    const result = templateCompletionSource(() => PATHS)(contextAt('{{'));
    const text = (index: number) => (renderVariablePathBadges(result?.options[index] as Completion) as HTMLElement | null)?.textContent ?? '';
    expect(text(0)).toContain('Best match');
    expect(text(0)).toContain('“chest pain”');
    expect(text(0)).toContain('PHI');
    expect(text(1)).toContain('Formatted as text');
    expect(text(2)).toContain('Can’t use audio here');
  });
});

describe('TemplateEditor — `/` opens the picker', () => {
  it('matches `/query` at the start of a word, not inside one', () => {
    expect(slashCompletionSource(() => PATHS)(contextAt('Summarise /trans'))?.from).toBe(11);
    expect(slashCompletionSource(() => PATHS)(contextAt('and/or'))).toBeNull();
  });

  it('replaces the `/query` with the placeholder', () => {
    render(<TemplateEditor value="Summarise /tr" onChange={() => {}} label="Prompt" paths={PATHS} />);
    const view = templateEditorView(screen.getByRole('textbox', { name: 'Prompt' }));
    if (!view) throw new Error('no view');
    const result = slashCompletionSource(() => PATHS)(new CompletionContext(view.state, 13, false));
    act(() => apply(view, result?.options[0] as Completion, result?.from ?? 0, 13));
    expect(view.state.doc.toString()).toBe('Summarise {{nodes.asr.outputs.transcript}}');
  });
});

describe('TemplateEditor — editorRef', () => {
  it('inserts text at the cursor', () => {
    const ref = createRef<TemplateEditorHandle>();
    let latest = '';
    render(<TemplateEditor value="Hello " onChange={(next) => (latest = next)} label="Prompt" editorRef={ref} />);
    const view = templateEditorView(screen.getByRole('textbox', { name: 'Prompt' }));
    act(() => view?.dispatch({ selection: { anchor: 6 } }));
    act(() => ref.current?.insertAtCursor('{{context.name}}'));
    expect(latest).toBe('Hello {{context.name}}');
  });
});
