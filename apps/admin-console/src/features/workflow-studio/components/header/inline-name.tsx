'use client';

/**
 * The workflow name as the page's one `h1`, renamed in place. A rename is STAGED, not saved: the
 * caller marks the definition dirty and the studio's single explicit Save writes it (TASK-893
 * OD-7). Enter or blur commits, Escape cancels, and an empty name is refused — the old one stays.
 */
import { useRef, useState } from 'react';
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
  // Escape sets this so the blur that follows the unmount-by-state-change does not commit the draft.
  const cancelled = useRef(false);

  function begin() {
    cancelled.current = false;
    setDraft(name);
    setEditing(true);
  }
  function commit() {
    if (cancelled.current) return;
    const next = draft.trim();
    setEditing(false);
    if (next.length > 0 && next !== name) onChange(next);
  }

  if (readOnly) return <h1 className="min-w-0 truncate text-2xl font-medium tracking-tight">{name}</h1>;

  return (
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
              commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelled.current = true;
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
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
  );
}
