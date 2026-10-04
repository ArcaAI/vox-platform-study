'use client';

/**
 * The workflow name as the page's one `h1`, renamed in place. A rename is STAGED, not saved: the
 * caller marks the definition dirty and the studio's single explicit Save writes it (TASK-893
 * OD-7). Enter or blur commits, Escape cancels, and an empty name is refused — the old one stays.
 *
 * TASK-1036 review R-C #12: Enter and Escape hand focus back to the name's button (the input
 * unmounts, and focus must not fall to <body> — WCAG 2.4.3); blur does not, because the author has
 * already moved on. A refused empty name is SAID, in a polite status line, never dropped silently.
 */
import { useEffect, useRef, useState } from 'react';
import { IconPencil } from '@tabler/icons-react';
import { Input } from '@arcaai/ui';

export interface InlineNameProps {
  name: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
}

export function InlineName({ name, onChange, readOnly }: InlineNameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [notice, setNotice] = useState('');
  // Escape sets this so the blur that follows the unmount-by-state-change does not commit the draft.
  const cancelled = useRef(false);
  // Set by Enter / Escape: once the input is gone, focus returns to the name's button.
  const refocus = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    triggerRef.current?.focus();
  }, [editing]);

  function begin() {
    cancelled.current = false;
    setNotice('');
    setDraft(name);
    setEditing(true);
  }
  function commit() {
    if (cancelled.current) return;
    cancelled.current = true;
    const next = draft.trim();
    setEditing(false);
    if (next.length === 0) {
      setNotice(`The name can’t be empty — kept “${name}”.`);
      return;
    }
    if (next !== name) onChange(next);
  }

  if (readOnly) return <h1 className="min-w-0 truncate text-2xl font-medium tracking-tight">{name}</h1>;

  return (
    <>
      <h1 className="min-w-0 text-2xl font-medium tracking-tight">
        {editing ? (
          <Input
            autoFocus
            aria-label="Workflow name"
            value={draft}
            maxLength={160}
            className="h-9 text-xl"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                refocus.current = true;
                commit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelled.current = true;
                refocus.current = true;
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            ref={triggerRef}
            type="button"
            title="Rename this workflow"
            onClick={begin}
            className="hover:bg-muted focus-visible:ring-ring group inline-flex max-w-full items-center gap-2 rounded-md px-1 text-left focus-visible:ring-2 focus-visible:outline-none"
          >
            <span className="truncate">{name}</span>
            <IconPencil aria-hidden="true" className="text-muted-foreground size-4 shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
          </button>
        )}
      </h1>
      {/* A polite live region (not `role="status"`: the slug's "Copied" already is the header's status). */}
      <p aria-live="polite" data-slot="inline-name-notice" className="text-destructive text-sm empty:hidden">
        {notice}
      </p>
    </>
  );
}
