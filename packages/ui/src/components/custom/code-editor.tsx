'use client';

import { Braces, Check, CircleAlert, Copy } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { formatJson, type JsonToken, type JsonValidation, tokenizeJson, validateJson } from '@/lib/json-editor';
import { cn } from '@/lib/utils';

/**
 * A small JSON code editor (TASK-437): line numbers, synchronous syntax
 * highlighting, live validation with a line/column error, Format and Copy. It is
 * a transparent `<textarea>` overlaying a highlighted `<pre>` — no async
 * highlighter — on a FIXED dark surface (`--code-editor-*` tokens) in both
 * themes, matching artboard 5c. `language` is JSON-only today but kept as a prop
 * so callers can opt into more later.
 */

const TOKEN_COLOR: Record<JsonToken['type'], string> = {
  key: 'text-[var(--code-editor-key)]',
  string: 'text-[var(--code-editor-string)]',
  number: 'text-[var(--code-editor-number)]',
  boolean: 'text-[var(--code-editor-boolean)]',
  null: 'text-[var(--code-editor-null)]',
  punctuation: 'text-[var(--code-editor-punctuation)]',
  text: '',
};

// Textarea, highlight <pre> and gutter share these so the layers line up exactly.
const TYPE_CLASS = 'font-mono text-[13px] leading-5';
const PAD_Y = 'py-3';

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** Only `'json'` is supported today; the prop reserves room to extend. */
  language?: 'json';
  /** Override validation. Defaults to JSON parse validation for `language='json'`. */
  validate?: (value: string) => JsonValidation;
  /** Handle Format yourself. Default pretty-prints via `formatJson` and calls `onChange`. */
  onFormat?: (value: string) => void;
  readOnly?: boolean;
  /** Hide the Format/validity/Copy toolbar. */
  showToolbar?: boolean;
  'aria-label': string;
  className?: string;
}

function CodeEditorToolbar({
  validation,
  showFormat,
  canFormat,
  onFormat,
  onCopy,
  copied,
}: {
  validation: JsonValidation;
  showFormat: boolean;
  canFormat: boolean;
  onFormat: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-white/10 px-2 py-1.5">
      {showFormat ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-white/80 hover:bg-white/10 hover:text-white"
          disabled={!canFormat}
          onClick={onFormat}
        >
          <Braces aria-hidden />
          Format
        </Button>
      ) : null}
      <div role="status" aria-live="polite" className="min-w-0 flex-1 truncate text-xs">
        {validation.ok ? (
          <Badge variant="secondary" className="gap-1">
            <Check aria-hidden />
            Valid JSON
          </Badge>
        ) : (
          <span className="text-destructive inline-flex items-center gap-1">
            <CircleAlert aria-hidden className="size-3.5 shrink-0" />
            {validation.line !== undefined ? `Invalid JSON — line ${validation.line}, column ${validation.column}` : 'Invalid JSON'}
          </span>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Copy JSON"
        className="text-white/80 hover:bg-white/10 hover:text-white"
        onClick={onCopy}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </div>
  );
}

export function CodeEditor({
  value,
  onChange,
  // `language` is a reserved prop (JSON only today); read by callers, not here.
  validate,
  onFormat,
  readOnly = false,
  showToolbar = true,
  className,
  'aria-label': ariaLabel,
}: CodeEditorProps) {
  const preRef = React.useRef<HTMLPreElement>(null);
  const gutterRef = React.useRef<HTMLDivElement>(null);
  const [copied, setCopied] = React.useState(false);

  const validation = React.useMemo(() => (validate ?? validateJson)(value), [validate, value]);
  const tokens = React.useMemo(() => tokenizeJson(value), [value]);
  const lineCount = React.useMemo(() => value.split('\n').length, [value]);

  // Keep the highlight overlay and gutter aligned with the textarea as it scrolls.
  function handleScroll(event: React.UIEvent<HTMLTextAreaElement>) {
    const { scrollTop, scrollLeft } = event.currentTarget;
    if (preRef.current) {
      preRef.current.scrollTop = scrollTop;
      preRef.current.scrollLeft = scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = scrollTop;
  }

  function handleFormat() {
    if (readOnly || !validation.ok) return;
    let formatted: string;
    try {
      formatted = formatJson(value);
    } catch {
      return;
    }
    if (onFormat) onFormat(formatted);
    else onChange?.(formatted);
  }

  function handleCopy() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div
      data-slot="code-editor"
      className={cn(
        'flex flex-col overflow-hidden rounded-md border bg-[var(--code-editor-bg)] text-[var(--code-editor-fg)] selection:bg-[var(--code-editor-selection)]',
        className,
      )}
    >
      {showToolbar ? (
        <CodeEditorToolbar
          validation={validation}
          showFormat={!readOnly}
          canFormat={!readOnly && validation.ok}
          onFormat={handleFormat}
          onCopy={handleCopy}
          copied={copied}
        />
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={gutterRef}
          aria-hidden
          className={cn(TYPE_CLASS, PAD_Y, 'shrink-0 select-none overflow-hidden px-3 text-right text-[var(--code-editor-gutter)]')}
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <pre
            ref={preRef}
            aria-hidden
            className={cn(TYPE_CLASS, PAD_Y, 'pointer-events-none absolute inset-0 m-0 overflow-auto whitespace-pre pr-3')}
          >
            <code>
              {tokens.map((token, i) => (
                <span key={i} className={TOKEN_COLOR[token.type]}>
                  {token.value}
                </span>
              ))}
              {/* Trailing newline keeps the last line's height in sync with the textarea. */}
              {'\n'}
            </code>
          </pre>
          <textarea
            aria-label={ariaLabel}
            aria-invalid={!validation.ok}
            value={value}
            readOnly={readOnly}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            wrap="off"
            onChange={(event) => onChange?.(event.target.value)}
            onScroll={handleScroll}
            className={cn(
              TYPE_CLASS,
              PAD_Y,
              'absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre border-0 bg-transparent pr-3 pl-0 text-transparent caret-white outline-none',
              'focus-visible:ring-primary/50 focus-visible:ring-2 focus-visible:ring-inset',
            )}
          />
        </div>
      </div>
    </div>
  );
}

export { CodeEditorToolbar };
