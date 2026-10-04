'use client';

import {
  autocompletion,
  closeBrackets,
  closeCompletion,
  completionStatus,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
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
 * TASK-1036 §10.1 — the same list is the composer's field PICKER: options may carry a display
 * `label` (a step's name, `Transcribe › transcript`) and still insert their stored `path`; a
 * `group` sorts them into sections in the order given (Earlier steps · Context · Consultation ·
 * Run & variables); `bestMatch` / `convertNote` / `disabledReason` rank them by fit (a blocked
 * option stays visible, says why, and inserts nothing); `sample` shows what the last run held. In
 * template mode, `/` at the start of a word opens the same list (`slashCommand`), and
 * `editorRef.insertAtCursor` lets an outside "+ Insert field" button write at the cursor.
 *
 * TASK-1036 R-C — `/` is ordinary punctuation in clinical text ("and/or", "BP 120/80"), so it
 * opens the list only before a LETTER (or on an explicit Ctrl/Cmd-Space), and Enter on a `/` list
 * the author has not navigated is a NEWLINE: nothing is picked until an arrow key moves through
 * the list (`slashGuard`). A `{{` list keeps Enter-to-pick — the braces are the explicit request.
 * Each row carries `cm-scope-<scope>`, which the theme colours with the four scope tokens.
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
  /** TASK-1036 — what the option SHOWS (a step label path); `path` is still what is inserted. */
  readonly label?: string;
  /** TASK-1036 — the section the option is listed under; sections keep the order they first appear in. */
  readonly group?: string;
  /** TASK-1036 — the scope family (`steps`, `context`, `consultation`, `run`), exposed as `data-scope`. */
  readonly scope?: string;
  /** TASK-1036 — the first option that fits the target type as-is. */
  readonly bestMatch?: boolean;
  /** TASK-1036 — how a convertible option converts ("Formatted as text"). */
  readonly convertNote?: string;
  /** TASK-1036 — why the option cannot be used here; it stays listed and inserts nothing. */
  readonly disabledReason?: string;
  /** TASK-1036 — a short rendering of the value from the last test run. */
  readonly sample?: string;
}

/** TASK-1036 — imperative access for a picker outside the editor ("+ Insert field"). */
export interface TemplateEditorHandle {
  /** Inserts `text` at the cursor (replacing the selection) and focuses the editor. */
  insertAtCursor: (text: string) => void;
  focus: () => void;
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
  /** TASK-1036 — template mode: `/` at the start of a word opens the field list. Default `true`. */
  slashCommand?: boolean;
  /** TASK-1036 — imperative handle (`insertAtCursor`, `focus`). */
  editorRef?: React.Ref<TemplateEditorHandle>;
}

/** A completion source that answers synchronously. */
export type SyncCompletionSource = (context: CompletionContext) => CompletionResult | null;

interface PathCompletion extends Completion {
  readonly variablePath: VariablePath;
}

const COMPLETION_ROOTS = ['context', 'trigger', 'nodes'] as const;

/** Ranking: best match first, then required, then the rest; a blocked option sinks to the bottom. */
function boostOf(entry: VariablePath): number {
  if (entry.disabledReason) return -99;
  return (entry.bestMatch ? 50 : 0) + (entry.convertNote ? -1 : 0) + (entry.required ? 1 : 0);
}

/** One CodeMirror section per `group`, ranked by first appearance so the caller's order holds. */
function sectionsOf(paths: readonly VariablePath[]): Map<string, { name: string; rank: number }> {
  const sections = new Map<string, { name: string; rank: number }>();
  for (const entry of paths) if (entry.group && !sections.has(entry.group)) sections.set(entry.group, { name: entry.group, rank: sections.size });
  return sections;
}

/** A blocked option is listed but inserts nothing — choosing it only closes the list. */
const NOOP_APPLY: Completion['apply'] = () => undefined;

function pathOption(entry: VariablePath, apply?: Completion['apply'], sections?: Map<string, { name: string; rank: number }>): PathCompletion {
  const section = entry.group ? sections?.get(entry.group) : undefined;
  const resolvedApply = entry.disabledReason ? NOOP_APPLY : apply;
  return {
    label: entry.label ?? entry.path,
    type: 'variable',
    detail: entry.deprecated ? 'deprecated' : undefined,
    info: [entry.label ? entry.path : null, entry.description].filter(Boolean).join(' — ') || undefined,
    boost: boostOf(entry),
    variablePath: entry,
    ...(section ? { section } : {}),
    ...(entry.disabledReason || entry.scope
      ? { class: [entry.scope ? `cm-scope-${entry.scope}` : null, entry.disabledReason ? 'cm-completion-disabled' : null].filter(Boolean).join(' ') }
      : {}),
    ...(resolvedApply ? { apply: resolvedApply } : entry.label ? { apply: entry.path } : {}),
  };
}

/** Options for `paths`, sorted so groups stay contiguous and ranked within each group. */
function rankedOptions(paths: readonly VariablePath[], applyFor?: (entry: VariablePath) => Completion['apply']): PathCompletion[] {
  const sections = sectionsOf(paths);
  return paths
    .map((entry, index) => ({
      option: pathOption(entry, applyFor?.(entry), sections),
      index,
      rank: entry.group ? (sections.get(entry.group)?.rank ?? 0) : -1,
    }))
    .sort((a, b) => a.rank - b.rank || (b.option.boost ?? 0) - (a.option.boost ?? 0) || a.index - b.index)
    .map((entry) => entry.option);
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
    const options = rankedOptions(getPaths(), (entry) => (view: EditorView, completion: Completion, _from: number, to: number) => {
      const closing = view.state.sliceDoc(to, to + 2) === '}}' ? 2 : 0;
      const insert = `{{${entry.path}}}`;
      view.dispatch({
        changes: { from: braceStart, to: to + closing, insert },
        selection: { anchor: braceStart + insert.length },
        annotations: pickedCompletion.of(completion),
        userEvent: 'input.complete',
      });
    });
    // A labelled option filters on its label, so the typed text must be allowed to hold spaces and `›`.
    return { from, options, validFor: /^[^{}]*$/ };
  };
}

/** `/` at the start of a word followed by a letter — the only typed shape that opens the `/` list. */
const SLASH_TYPED = /(?:^|\s)\/[A-Za-z][^\s/{}]*$/;
/** Any `/query` at the start of a word — what an EXPLICIT request (Ctrl/Cmd-Space) may complete. */
const SLASH_ANY = /(?:^|\s)\/[^\s/{}]*$/;

/**
 * TASK-1036 — `/` at the start of a word (Dify-style). The match starts AT the slash so the whole
 * `/query` is replaced by the placeholder; `and/or` never opens it. R-C: typing opens it only
 * when a LETTER follows the slash ("BP /80", "Plan /" stay plain text); an explicit request
 * (Ctrl/Cmd-Space) still opens it right after a bare slash.
 */
export function slashCompletionSource(getPaths: () => readonly VariablePath[]): SyncCompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(context.explicit ? SLASH_ANY : SLASH_TYPED);
    if (!match) return null;
    const slash = match.from + match.text.indexOf('/');
    const options = rankedOptions(getPaths(), (entry) => (view: EditorView, completion: Completion, _from: number, to: number) => {
      const insert = `{{${entry.path}}}`;
      view.dispatch({
        changes: { from: slash, to, insert },
        selection: { anchor: slash + insert.length },
        annotations: pickedCompletion.of(completion),
        userEvent: 'input.complete',
      });
    });
    return { from: slash + 1, options, validFor: /^[^\s/{}]*$/ };
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
      return { from: word ? word.from : context.pos, options: rankedOptions(getPaths()), validFor: /^[\w.]*$/ };
    }
    const typed = match[1] as string;
    return { from: context.pos - typed.length, options: rankedOptions(getPaths()), validFor: /^[\w.]*$/ };
  };
}

/** Set when an arrow key has moved through the open list; cleared whenever the list closes. */
const setListNavigated = StateEffect.define<boolean>();
const listNavigated = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setListNavigated)) return effect.value;
    return completionStatus(transaction.state) === null ? false : value;
  },
});

/** The open list was opened by `/` (not `{{`) and the author has not moved through it yet. */
function slashListPending(state: EditorState): boolean {
  if (completionStatus(state) !== 'active' || state.field(listNavigated, false)) return false;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const before = line.text.slice(0, head - line.from);
  return SLASH_ANY.test(before) && !/\{\{[^}]*$/.test(before);
}

/**
 * R-C #6 — Enter on an un-navigated `/` list closes it and falls through to the newline the
 * author was typing; the arrow keys record that the list was navigated (and then fall through to
 * the completion keymap, which moves the selection). Placed AHEAD of `autocompletion()` so it runs
 * before the completion keymap at the same precedence. `cm-slash-pending` drops the highlight
 * from the pre-selected row so nothing LOOKS chosen while Enter would not choose it.
 */
function slashGuard(): Extension {
  const markNavigated = (view: EditorView) => {
    if (completionStatus(view.state) === 'active' && !view.state.field(listNavigated, false)) view.dispatch({ effects: setListNavigated.of(true) });
    return false;
  };
  return [
    listNavigated,
    Prec.highest(
      keymap.of([
        {
          key: 'Enter',
          run: (view) => {
            if (slashListPending(view.state)) closeCompletion(view);
            return false;
          },
        },
        { key: 'ArrowDown', run: markNavigated },
        { key: 'ArrowUp', run: markNavigated },
        { key: 'PageDown', run: markNavigated },
        { key: 'PageUp', run: markNavigated },
      ]),
    ),
    EditorView.editorAttributes.of((view) => (slashListPending(view.state) ? { class: 'cm-slash-pending' } : null)),
  ];
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
  if (entry.bestMatch && !entry.disabledReason) add('Best match', 'border-primary text-foreground');
  if (entry.type) add(entry.type, 'border-border text-muted-foreground font-mono');
  if (entry.required) add('required', 'border-border text-foreground');
  if (entry.phiClass === 'PHI') add('PHI', 'border-destructive text-destructive');
  if (entry.source === 'platform') add('platform', 'border-border text-muted-foreground');
  if (entry.convertNote && !entry.disabledReason) add(entry.convertNote, 'border-border text-muted-foreground');
  if (entry.disabledReason) add(entry.disabledReason, 'border-border text-muted-foreground italic');
  if (entry.sample) {
    const sample = document.createElement('span');
    sample.className = 'text-muted-foreground ml-1 max-w-[16rem] truncate text-[11px]';
    sample.textContent = entry.sample;
    row.appendChild(sample);
  }
  if (entry.scope) row.dataset.scope = entry.scope;
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
    '.cm-completionSection': {
      color: 'var(--muted-foreground)',
      fontFamily: 'var(--font-sans)',
      fontSize: '11px',
      fontWeight: '600',
      padding: '0.25rem 0.5rem',
    },
    '.cm-completion-disabled': { opacity: '0.6' },
    // TASK-1036 R-C — the four scope colours (§10.1 "Colour encodes scope everywhere"), tokens only.
    // The row's text and badges still SAY the scope, so the bar is never the only signal.
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[class*="cm-scope-"]': { borderLeft: '3px solid transparent' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li.cm-scope-steps': { borderLeftColor: 'var(--primary)' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li.cm-scope-context': { borderLeftColor: 'var(--success)' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li.cm-scope-consultation': { borderLeftColor: 'var(--ai)' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li.cm-scope-run': { borderLeftColor: 'var(--warning-strong, var(--warning))' },
    // R-C #6 — while Enter would insert a newline, no row is drawn as chosen.
    '&.cm-slash-pending .cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'transparent',
      color: 'inherit',
    },
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
  slashCommand = true,
  editorRef,
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
        override:
          mode === 'cel'
            ? [celCompletionSource(() => pathsRef.current)]
            : [templateCompletionSource(() => pathsRef.current), ...(slashCommand ? [slashCompletionSource(() => pathsRef.current)] : [])],
        activateOnTyping: true,
        icons: false,
        addToOptions: [{ render: renderVariablePathBadges, position: 80 }],
      }),
    [mode, slashCommand],
  );

  React.useImperativeHandle(
    editorRef,
    () => ({
      insertAtCursor: (text: string) => {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input' });
        view.focus();
      },
      focus: () => viewRef.current?.focus(),
    }),
    [],
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
          // Ahead of the completion compartment: same precedence, so order decides (R-C #6).
          slashGuard(),
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
