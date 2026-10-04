'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconX } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@arcaai/ui/components/shadcn/command';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { normalizeTag, TAG_MAX_COUNT, validateTag } from './tag-grammar';
import { useTagSuggestions } from './use-tag-suggestions';

export interface TagsFieldProps {
  /** Prefix for the field's own element ids (the combobox input's id is owned by cmdk). */
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  label?: string;
  /** Helper text under the field (replaced by the error while one is showing). */
  description?: ReactNode;
  placeholder?: string;
  /**
   * TASK-1036 C5 — where suggestions come from; defaults to the Hope Prompt tag route. The agent
   * editor passes `admin/agents/tags` so it autocompletes over agent tags, not prompt tags.
   */
  suggestionsPath?: string;
  /** Replaces the Hope Prompt grammar (`validateTag`) — agent tags are `key:value` only. `null` = valid. */
  validate?: (tag: string) => string | null;
}

const SUGGESTION_DEBOUNCE_MS = 300;

/**
 * The console tag editor: removable chips + a combobox over the tenant's existing tags
 * (`GET admin/prompt-templates/tags`, ranked by use) that also accepts free entry.
 *
 * Keyboard: type; Enter adds what you typed; ArrowDown/ArrowUp walk the suggestions and Enter
 * adds the highlighted one; a comma commits (a comma-separated paste adds several); Backspace on
 * an empty draft removes the last chip; Escape closes the list. A tag that breaks the grammar is
 * refused with the rule spelled out under the field. Input is trimmed and lower-cased before it is
 * validated (the gateway does the same), so `Pre-Summary` is added as `pre-summary`.
 */
export function TagsField({
  id,
  value,
  onChange,
  label = 'Tags',
  description,
  placeholder = 'Add a tag — e.g. dept:cardiology',
  suggestionsPath,
  validate = validateTag,
}: TagsFieldProps) {
  const messageId = `${id}-message`;
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [attemptError, setAttemptError] = useState<string | null>(null);
  // True once the user walked the list with the arrows since the last keystroke — Enter then
  // takes the highlighted suggestion; otherwise Enter takes the typed text.
  const navigated = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced (300ms, house value) so a burst of keystrokes is one request.
  const [debouncedDraft, setDebouncedDraft] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedDraft(draft), SUGGESTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  const suggestionsQuery = useTagSuggestions(debouncedDraft, open, suggestionsPath);
  const suggestions = (suggestionsQuery.data ?? []).filter((suggestion) => !value.includes(suggestion.tag));

  const trimmedDraft = draft.trim();
  // Validate what the server will store (trimmed, lower-case), not the raw keystrokes.
  const liveError = trimmedDraft ? validate(normalizeTag(trimmedDraft)) : null;
  const error = liveError ?? attemptError;

  /** Adds every acceptable tag in `raw`; returns what could not be added (invalid ones, to keep in the draft). */
  function commit(raw: string): string[] {
    const next = [...value];
    const rejected: string[] = [];
    let notice: string | null = null;
    for (const original of raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)) {
      const tag = normalizeTag(original);
      const problem = validate(tag);
      if (problem) {
        rejected.push(original);
      } else if (next.includes(tag)) {
        notice = `"${tag}" is already added.`;
      } else if (next.length >= TAG_MAX_COUNT) {
        notice = `At most ${TAG_MAX_COUNT} tags.`;
        rejected.push(original);
      } else {
        next.push(tag);
      }
    }
    if (next.length !== value.length) onChange(next);
    setAttemptError(notice);
    return rejected;
  }

  function commitDraft(): void {
    if (!trimmedDraft) return;
    const rejected = commit(trimmedDraft);
    setDraft(rejected.join(', '));
    navigated.current = false;
  }

  function addSuggestion(tag: string): void {
    commit(tag);
    setDraft('');
    navigated.current = false;
  }

  function handleChange(raw: string): void {
    navigated.current = false;
    setAttemptError(null);
    setOpen(true);
    if (raw.includes(',')) {
      setDraft(commit(raw).join(', '));
      return;
    }
    setDraft(raw);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      navigated.current = true;
      setOpen(true);
      return; // cmdk moves the highlight
    }
    if (event.key === 'Enter') {
      if (navigated.current && open && suggestions.length > 0) return; // cmdk selects the highlighted suggestion
      event.preventDefault();
      event.stopPropagation(); // never submit the surrounding form from this field
      commitDraft();
      return;
    }
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
      return;
    }
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      setOpen(false);
    }
  }

  const showList = open;
  const hasList = showList && (suggestionsQuery.isFetching && !suggestionsQuery.data ? true : suggestions.length > 0);

  return (
    <div className="flex flex-col gap-2">
      {/* cmdk wires the input's accessible name from `Command label` (below); this is the visible twin. */}
      <Label aria-hidden onClick={() => inputRef.current?.focus()}>
        {label}
      </Label>
      {value.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label={`${label} added`}>
          {value.map((tag) => (
            <li key={tag}>
              <Badge variant="outline" className="rounded-full py-0.5 pr-1 font-mono text-[11px]">
                {tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring ml-1 cursor-pointer rounded-full focus-visible:ring-2"
                  onClick={() => onChange(value.filter((entry) => entry !== tag))}
                >
                  <IconX aria-hidden className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <Command label={label} shouldFilter={false} className="h-auto overflow-visible rounded-md border bg-transparent shadow-none">
        <CommandInput
          ref={inputRef}
          aria-autocomplete="list"
          aria-invalid={error ? true : undefined}
          aria-describedby={messageId}
          autoComplete="off"
          value={draft}
          placeholder={placeholder}
          onValueChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            if (!liveError) commitDraft();
          }}
          className="h-9"
        />
        {/* Always mounted: cmdk points the input's aria-controls at this list. */}
        <CommandList aria-label="Existing tags" hidden={!hasList} onMouseDown={(event) => event.preventDefault()}>
          {suggestionsQuery.isFetching && !suggestionsQuery.data ? (
            <div className="flex flex-col gap-1 p-2" aria-hidden>
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-3/4" />
            </div>
          ) : (
            <CommandGroup heading="Existing tags">
              {suggestions.map((suggestion) => (
                <CommandItem key={suggestion.tag} value={suggestion.tag} onSelect={() => addSuggestion(suggestion.tag)}>
                  <span className="flex-1 truncate font-mono text-xs">{suggestion.tag}</span>
                  <span className="text-muted-foreground text-xs">{suggestion.count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
      <div id={messageId} className="text-xs">
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : (
          <p className="text-muted-foreground">
            {description ?? 'Press Enter or comma to add. Suggestions come from tags already used in this tenant.'}
          </p>
        )}
      </div>
    </div>
  );
}
