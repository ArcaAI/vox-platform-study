'use client';

/**
 * Searchable template picker for assembled mode's `prompt_template_id` field
 * (frame 54, matrix row 38 — was a raw text Input). Replaces free-typed ids
 * with a combobox over GET admin/prompt-templates (search-as-you-type,
 * server-side via `search`), matching the `UserPicker` pattern
 * (`features/tenants/components/user-picker.tsx`).
 *
 * Escape hatch: if the list read fails, the picker falls back to the
 * original plain text Input (with a toast) rather than blocking the
 * playground — a template id the operator already knows should still work.
 */

import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconSelector } from '@tabler/icons-react';
import { toast } from 'sonner';
import { cn } from '@arcaai/ui';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@arcaai/ui/components/shadcn/command';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Popover, PopoverContent, PopoverTrigger } from '@arcaai/ui/components/shadcn/popover';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { usePromptTemplates } from '../api/hooks';
import type { PromptTemplateOption } from '../api/types';

function templateContext(template: PromptTemplateOption): string {
  if (template.departmentId) return `dept ${template.departmentId}`;
  return template.scope ?? 'TENANT_DEFAULT';
}

function templateLabel(template: PromptTemplateOption): string {
  return `${template.name} — ${templateContext(template)}`;
}

export function TemplatePicker({ id, value, onChange }: { id?: string; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const templatesQuery = usePromptTemplates({ search: query.trim() || undefined, limit: 20 }, { enabled: open });
  const failed = templatesQuery.isError;

  // The toast is a one-shot notification, not derived render state — a ref
  // (not setState) tracks it so this effect never triggers a cascading
  // render; `failed` itself (query state) already drives the fallback below.
  const toastedRef = useRef(false);
  useEffect(() => {
    if (failed && !toastedRef.current) {
      toastedRef.current = true;
      toast.error('Could not load templates — enter the template ID directly.');
    }
  }, [failed]);

  if (failed) {
    return (
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder="prompt template id (optional)" />
    );
  }

  const results = templatesQuery.data?.data ?? [];
  const selected = results.find((template) => template.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            'border-input flex min-h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm outline-none',
            'hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {selected ? templateLabel(selected) : value ? value : 'No template — raw prompt'}
          </span>
          <IconSelector aria-hidden="true" className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] min-w-64 p-0">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search templates…" />
          <CommandList>
            {templatesQuery.isFetching ? (
              <div className="flex flex-col gap-1 p-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : (
              <CommandGroup>
                <CommandItem
                  value="__none__"
                  onSelect={() => {
                    onChange('');
                    setOpen(false);
                  }}
                >
                  <span className="text-muted-foreground flex-1">No template — raw prompt</span>
                  {!value ? <IconCheck aria-hidden="true" className="text-foreground size-4" /> : null}
                </CommandItem>
                {results.length === 0 ? (
                  <div className="text-muted-foreground py-6 text-center text-sm">
                    {query.trim() ? 'No template found.' : 'Type to search templates.'}
                  </div>
                ) : (
                  results.map((template) => {
                    const active = template.id === value;
                    return (
                      <CommandItem
                        key={template.id}
                        value={template.id}
                        onSelect={() => {
                          onChange(template.id);
                          setOpen(false);
                        }}
                      >
                        <span className="flex-1 truncate">{templateLabel(template)}</span>
                        {active ? <IconCheck aria-hidden="true" className="text-foreground size-4" /> : null}
                      </CommandItem>
                    );
                  })
                )}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
