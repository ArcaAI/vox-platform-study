/**
 * TASK-329 — LiveCodePanel
 *
 * A shared, reactive code-sample panel. Each playground passes a `code` string
 * derived from its current store + impersonated-user preferences (see
 * `@/lib/playground-snippets`); whenever those change the snippet re-renders, so
 * the sample always mirrors what the user is doing on screen.
 *
 * Rendering reuses `@arcaai/ui`'s prompt-kit code-block (Shiki syntax
 * highlighting). It is imported via its package subpath so the ui-playground
 * vitest stub (`/^@arcaai\/ui\//`) can intercept it, and so the app tsconfig's
 * `@arcaai/ui/*` → barrel-types alias still type-checks (the top-level barrel
 * re-exports prompt-kit's `CodeBlock` / `CodeBlockCode`).
 */
import { CodeBlock, CodeBlockCode } from '@arcaai/ui/components/registries/prompt-kit/code-block';
import { Check, Code2, Copy } from 'lucide-react';
import { useState } from 'react';

export interface LiveCodePanelProps {
  /** The snippet to display — typically built from a `@/lib/playground-snippets` builder. */
  code: string;
  /** Shiki language id. Defaults to `tsx`. */
  language?: string;
  /** Filename shown above the snippet. Defaults to `example.tsx`. */
  filename?: string;
  title?: string;
  description?: string;
  className?: string;
}

export function LiveCodePanel({
  code,
  language = 'tsx',
  filename = 'example.tsx',
  title = 'Live SDK sample',
  description = 'Reflects the current selections + impersonated user — copy & paste into your app.',
  className,
}: LiveCodePanelProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <section
      data-testid="live-code-panel"
      className={`bg-card text-card-foreground overflow-hidden rounded-xl border shadow-sm ${className ?? ''}`.trim()}
    >
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Code2 className="size-4" aria-hidden="true" />
            <h3 className="text-base font-semibold">{title}</h3>
          </div>
          {description && <p className="text-muted-foreground text-xs">{description}</p>}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy code"
          className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
        >
          {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="text-muted-foreground border-b px-4 py-1.5 font-mono text-xs">{filename}</div>
      <CodeBlock className="rounded-none border-0">
        <CodeBlockCode code={code} language={language} />
      </CodeBlock>
    </section>
  );
}
