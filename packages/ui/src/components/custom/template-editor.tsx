'use client';

import {
  autocompletion,
  closeBrackets,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A prompt / condition editor with schema-aware completion and inline lint, on
 * CodeMirror 6.
 *
 * - `mode="template"`: typing `{{` opens the list of `paths`; picking one
 *   inserts `{{path}}` (an existing closing `}}` is consumed, not doubled).
 * - `mode="cel"`: completion opens after `context.` / `trigger.` / `nodes.`
 *   and inserts the bare path.
 *
 * Each option carries type / required / PHI / platform badges and the path's description.
 * `lint` runs debounced (`lintDelay`) over the whole document; its findings
 * render as squiggles in the editor AND as a text summary under it (a polite
 * live region), so they are not conveyed by colour or position alone.
 *
 * Keyboard: Ctrl/Cmd-Space opens completion explicitly, arrows + Enter pick,
 * Escape closes. Tab is NOT bound — it moves focus out of the editor, so the
 * field is never a focus trap.
 */

export interface VariablePath {
  readonly path: string;
  readonly type?: string;
  readonly required?: boolean;
  readonly phiClass?: string | null;
  readonly description?: string | null;
  readonly deprecated?: boolean;
  /** Where the path comes from: a context schema (the default) or the platform's own bound vocabulary. */
  readonly source?: 'schema' | 'platform';
}

export type TemplateDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface TemplateDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly message: string;
  readonly severity: TemplateDiagnosticSeverity;
}

export type TemplateEditorMode = 'template' | 'cel';

export interface TemplateEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** The completion vocabulary (e.g. `schemaVariablePaths(...)`). */
  paths?: readonly VariablePath[];
  /** Whole-document lint; offsets are document character offsets. */
  lint?: (content: string) => readonly TemplateDiagnostic[];
  /** Debounce for `lint`, in ms. */
  lintDelay?: number;
  mode?: TemplateEditorMode;
  /** Accessible name when no `aria-labelledby` is given. */
  label?: string;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  /** Forces the invalid state (e.g. a server finding), on top of lint errors. */
  'aria-invalid'?: boolean;
  readOnly?: boolean;
  /** Minimum visible lines. */
  minLines?: number;
  placeholder?: string;
  className?: string;
}

/** A completion source that answers synchronously. */
export type SyncCompletionSource = (context: CompletionContext) => CompletionResult | null;

interface PathCompletion extends Completion {
  readonly variablePath: VariablePath;
}

const COMPLETION_ROOTS = ['context', 'trigger', 'nodes'] as const;

function pathOption(entry: VariablePath, apply?: Completion['apply']): PathCompletion {
  return {
    label: entry.path,
    type: 'variable',
    detail: entry.deprecated ? 'deprecated' : undefined,
    info: entry.description ?? undefined,
    boost: entry.required ? 1 : 0,
    variablePath: entry,
    ...(apply ? { apply } : {}),
  };
}

/**
 * `{{` completion. The match starts AT the braces so the whole placeholder is
 * replaced; the filter text is whatever follows them.
 */
export function templateCompletionSource(getPaths: () => readonly VariablePath[]): SyncCompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\{\{\s*[\w.]*$/);
    if (!match) return null;
    const braceStart = match.from;
    const typed = match.text.slice(2).trimStart();
    const from = context.pos - typed.length;
    const options = getPaths().map((entry) =>
      pathOption(entry, (view: EditorView, completion: Completion, _from: number, to: number) => {
        const closing = view.state.sliceDoc(to, to + 2) === '}}' ? 2 : 0;
        const insert = `{{${entry.path}}}`;
        view.dispatch({
          changes: { from: braceStart, to: to + closing, insert },
          selection: { anchor: braceStart + insert.length },
          annotations: pickedCompletion.of(completion),
          userEvent: 'input.complete',
        });
      }),
    );
    return { from, options, validFor: /^[\w.]*$/ };
  };
}

/** CEL completion: after a known root (`context.` / `trigger.` / `nodes.`), or on an explicit request. */
export function celCompletionSource(getPaths: () => readonly VariablePath[]): SyncCompletionSource {
  const rootPattern = new RegExp(`(?:^|[^\\w.])((?:${COMPLETION_ROOTS.join('|')})\\.[\\w.]*)$`);
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const match = rootPattern.exec(before);
    if (!match) {
      if (!context.explicit) return null;
      const word = context.matchBefore(/[\w.]*$/);
      return { from: word ? word.from : context.pos, options: getPaths().map((entry) => pathOption(entry)), validFor: /^[\w.]*$/ };
    }
    const typed = match[1] as string;
    return { from: context.pos - typed.length, options: getPaths().map((entry) => pathOption(entry)), validFor: /^[\w.]*$/ };
  };
}

const BADGE = 'inline-flex items-center rounded-sm border px-1 text-[10px] leading-4 font-medium';

/** The badge row appended to each completion option. */
export function renderVariablePathBadges(completion: Completion): Node | null {
  const entry = (completion as Partial<PathCompletion>).variablePath;
  if (!entry || typeof document === 'undefined') return null;
  const row = document.createElement('span');
  row.className = 'ml-2 inline-flex items-center gap-1';
  const add = (text: string, className: string) => {
    const badge = document.createElement('span');
    badge.className = cn(BADGE, className);
    badge.textContent = text;
    row.appendChild(badge);
  };
  if (entry.type) add(entry.type, 'border-border text-muted-foreground font-mono');
  if (entry.required) add('required', 'border-border text-foreground');
  if (entry.phiClass === 'PHI') add('PHI', 'border-destructive text-destructive');
  if (entry.source === 'platform') add('platform', 'border-border text-muted-foreground');
  return row;
}

function editorTheme(minLines: number): Extension {
  return EditorView.theme({
    '&': {
      backgroundColor: 'transparent',
      color: 'var(--foreground)',
      fontSize: '13px',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.25rem',
    },
    '.cm-content': {
      minHeight: `${minLines * 1.25}rem`,
      padding: '0.5rem 0',
      caretColor: 'var(--foreground)',
    },
    '.cm-line': { padding: '0 0.75rem' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--accent)',
    },
    '.cm-placeholder': { color: 'var(--muted-foreground)' },
    '.cm-tooltip': {
      backgroundColor: 'var(--popover)',
      color: 'var(--popover-foreground)',
      border: '1px solid var(--border)',
      borderRadius: '0.375rem',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '16rem' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '0.25rem 0.5rem' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--accent)',
      color: 'var(--accent-foreground)',
    },
    '.cm-completionDetail': { color: 'var(--muted-foreground)', fontStyle: 'normal', marginLeft: '0.5rem' },
    '.cm-completionInfo': { padding: '0.375rem 0.5rem', maxWidth: '20rem' },
    // Wavy underlines from tokens instead of CodeMirror's fixed-colour SVG.
    '.cm-lintRange': { backgroundImage: 'none', textDecorationLine: 'underline', textDecorationStyle: 'wavy', textUnderlineOffset: '3px' },
    '.cm-lintRange-error': { textDecorationColor: 'var(--destructive)' },
    '.cm-lintRange-warning': { textDecorationColor: 'var(--warning)' },
    '.cm-lintRange-info': { textDecorationColor: 'var(--muted-foreground)' },
    '.cm-diagnostic-error': { borderLeftColor: 'var(--destructive)' },
    '.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
  });
}

/** The `EditorView` behind a TemplateEditor's content element (or any node inside it) — for drivers and tests. */
export function templateEditorView(element: Element | null): EditorView | null {
  if (!element) return null;
  const root = element.closest('.cm-editor') ?? element.querySelector('.cm-editor');
  return root instanceof HTMLElement ? EditorView.findFromDOM(root) : null;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function lineOf(value: string, offset: number) {
  let line = 1;
  for (let i = 0; i < Math.min(offset, value.length); i += 1) if (value.charCodeAt(i) === 10) line += 1;
  return line;
}

export function TemplateEditor({
  value,
  onChange,
  paths,
  lint,
  lintDelay = 300,
  mode = 'template',
  label,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  readOnly = false,
  minLines = 3,
  placeholder,
  className,
}: TemplateEditorProps) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const summaryId = React.useId();
  const [diagnostics, setDiagnosticList] = React.useState<readonly TemplateDiagnostic[]>([]);

  // Latest props read by long-lived CodeMirror callbacks.
  const pathsRef = React.useRef<readonly VariablePath[]>(paths ?? []);
  const onChangeRef = React.useRef(onChange);
  pathsRef.current = paths ?? [];
  onChangeRef.current = onChange;

  const compartments = React.useMemo(
    () => ({
      completion: new Compartment(),
      editable: new Compartment(),
      attributes: new Compartment(),
      theme: new Compartment(),
      placeholder: new Compartment(),
    }),
    [],
  );

  const hasError = ariaInvalid === true || diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  const describedBy = [ariaDescribedBy, diagnostics.length > 0 ? summaryId : undefined].filter(Boolean).join(' ') || undefined;

  const attributes = React.useMemo(() => {
    const attrs: Record<string, string> = {};
    if (id) attrs.id = id;
    if (ariaLabelledBy) attrs['aria-labelledby'] = ariaLabelledBy;
    else if (ariaLabel ?? label) attrs['aria-label'] = (ariaLabel ?? label) as string;
    if (describedBy) attrs['aria-describedby'] = describedBy;
    if (hasError) attrs['aria-invalid'] = 'true';
    if (readOnly) attrs['aria-readonly'] = 'true';
    return attrs;
  }, [id, ariaLabelledBy, ariaLabel, label, describedBy, hasError, readOnly]);

  const completionExtension = React.useMemo(
    () =>
      autocompletion({
        override: [mode === 'cel' ? celCompletionSource(() => pathsRef.current) : templateCompletionSource(() => pathsRef.current)],
        activateOnTyping: true,
        icons: false,
        addToOptions: [{ render: renderVariablePathBadges, position: 80 }],
      }),
    [mode],
  );

  // Create the view once; later prop changes reconfigure compartments.
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          closeBrackets(),
          EditorView.lineWrapping,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          compartments.completion.of(completionExtension),
          compartments.editable.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          compartments.attributes.of(EditorView.contentAttributes.of(attributes)),
          compartments.theme.of(editorTheme(minLines)),
          compartments.placeholder.of(placeholder ? placeholderExtension(placeholder) : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount-only: every input below is reconfigured by its own effect.
  }, []);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  React.useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.completion.reconfigure(completionExtension) });
  }, [compartments, completionExtension]);

  React.useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.editable.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    });
  }, [compartments, readOnly]);

  React.useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.attributes.reconfigure(EditorView.contentAttributes.of(attributes)) });
  }, [compartments, attributes]);

  React.useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.theme.reconfigure(editorTheme(minLines)) });
  }, [compartments, minLines]);

  React.useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.placeholder.reconfigure(placeholder ? placeholderExtension(placeholder) : []) });
  }, [compartments, placeholder]);

  // Debounced lint → squiggles (CodeMirror) + the summary below (React).
  React.useEffect(() => {
    if (!lint) {
      setDiagnosticList([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      const length = value.length;
      const found = lint(value).map((diagnostic) => ({
        ...diagnostic,
        from: Math.max(0, Math.min(diagnostic.from, length)),
        to: Math.max(0, Math.min(Math.max(diagnostic.to, diagnostic.from), length)),
      }));
      setDiagnosticList(found);
      const view = viewRef.current;
      if (view && view.state.doc.toString() === value) {
        view.dispatch(setDiagnostics(view.state, found as Diagnostic[]));
      }
    }, lintDelay);
    return () => clearTimeout(timer);
  }, [lint, lintDelay, value]);

  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;

  return (
    <div data-slot="template-editor" data-mode={mode} className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div
        ref={hostRef}
        data-slot="template-editor-surface"
        data-invalid={hasError ? 'true' : undefined}
        className={cn(
          'border-input dark:bg-input/30 min-w-0 rounded-surface border bg-transparent text-sm transition-[color,box-shadow]',
          'focus-within:border-ring focus-within:ring-ring focus-within:ring-[3px]',
          'data-[invalid=true]:border-destructive data-[invalid=true]:ring-destructive/20 dark:data-[invalid=true]:ring-destructive/40',
          readOnly && 'bg-muted/40',
        )}
      />
      <div id={summaryId} role="status" aria-live="polite" data-slot="template-editor-problems" className="text-xs">
        {diagnostics.length > 0 ? (
          <>
            <p className={cn('font-medium', errors > 0 ? 'text-destructive' : 'text-muted-foreground')}>{plural(diagnostics.length, 'problem')}</p>
            <ul className="flex flex-col gap-0.5">
              {diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.from}-${index}`} className={diagnostic.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                  <span className="sr-only">{`${diagnostic.severity}, line ${lineOf(value, diagnostic.from)}: `}</span>
                  {diagnostic.message}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
