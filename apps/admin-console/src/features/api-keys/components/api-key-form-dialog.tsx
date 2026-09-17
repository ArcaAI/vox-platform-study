'use client';

/**
 * Create / edit an API key.
 *
 * Creating one used to open on 99 scope checkboxes across 15 categories — an
 * admin issuing a key for a clinic app had to derive, one checkbox at a time,
 * which nineteen of them that means, and a key that is missing one fails at
 * runtime in the integrator's code rather than here. So the dialog asks the
 * question an admin can actually answer: **what is this key for?**
 *
 * The four purpose cards are three presets plus Custom. The presets come from
 * the `GET admin/api-keys/scopes` response, which serves `API_KEY_SCOPE_PRESETS`
 * from `@arcaai/types` verbatim — the same declaration the seed and both SDKs
 * read. Rendering a local copy is how a card keeps promising scopes the
 * platform stopped granting.
 *
 * The checklist is still there, still complete, and still editable: a preset is
 * a starting point, not a lock. It sits behind one disclosure that reports the
 * selection count, so the dialog can be both honest about what is granted and
 * short enough to read.
 *
 * EDIT mode skips purpose entirely and opens on the checklist. Changing an
 * existing key's scopes IS the reason that dialog is open, and re-deriving them
 * from a preset would silently widen or narrow a credential already in use.
 */

import { useId, useState, type FormEvent } from 'react';
import { IconChevronRight } from '@tabler/icons-react';
import { toast } from 'sonner';
import type { ApiKeyScopePreset } from '@arcaai/types';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@arcaai/ui/components/shadcn/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { RadioGroup, RadioGroupItem } from '@arcaai/ui/components/shadcn/radio-group';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { useApiKeyScopes, useCreateApiKey, useUpdateApiKey } from '../api/hooks';
import type { ApiKey, ApiKeyScopeCategories, CreateApiKeyResult } from '../api/types';
import { cx } from '@/shared/cx';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';

const CUSTOM = 'custom';

/** The full grantable catalogue, grouped, every box editable. */
function ScopeChecklist({
  categories,
  selected,
  onToggle,
}: {
  categories: ApiKeyScopeCategories;
  selected: string[];
  onToggle: (scope: string, checked: boolean) => void;
}) {
  const uid = useId();
  return (
    <div className="flex max-h-64 flex-col gap-3 overflow-y-auto rounded-md border p-3">
      {Object.entries(categories).map(([category, scopes]) => (
        <fieldset key={category} className="flex flex-col gap-2">
          <legend className="text-muted-foreground pb-1 text-xs font-medium">{category}</legend>
          {scopes.map(({ scope, description }) => {
            const id = `${uid}-${scope}`;
            return (
              <div key={scope} className="flex items-start gap-2">
                <Checkbox id={id} checked={selected.includes(scope)} onCheckedChange={(checked) => onToggle(scope, checked === true)} />
                <div className="flex min-w-0 flex-col">
                  <Label htmlFor={id} className="font-mono text-xs font-normal">
                    {scope}
                  </Label>
                  <p className="text-muted-foreground text-xs">{description}</p>
                </div>
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

function PurposeCards({ presets, value, onChange }: { presets: readonly ApiKeyScopePreset[]; value: string; onChange: (next: string) => void }) {
  const uid = useId();
  const options = [
    ...presets.map((preset) => ({ key: preset.key as string, label: preset.label, description: preset.description })),
    { key: CUSTOM, label: 'Custom', description: 'Choose individual permissions yourself.' },
  ];

  return (
    <RadioGroup value={value} onValueChange={onChange} className="gap-2" aria-label="Purpose">
      {options.map((option) => {
        const id = `${uid}-${option.key}`;
        return (
          <div key={option.key} className="hover:bg-muted/50 flex items-start gap-3 rounded-md border p-3">
            <RadioGroupItem id={id} value={option.key} className="mt-0.5" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label htmlFor={id} className="font-medium">
                {option.label}
              </Label>
              <p className="text-muted-foreground text-xs">{option.description}</p>
            </div>
          </div>
        );
      })}
    </RadioGroup>
  );
}

export function ApiKeyFormDialog({
  initial,
  onOpenChange,
  onCreated,
}: {
  /** null = create mode. */
  initial: ApiKey | null;
  onOpenChange: (open: boolean) => void;
  onCreated?: (result: CreateApiKeyResult) => void;
}) {
  const uid = useId();
  const isEdit = initial !== null;
  const { data: catalog, isPending: catalogPending } = useApiKeyScopes();
  const [name, setName] = useState(initial?.keyName ?? '');
  const [scopes, setScopes] = useState<string[]>(initial?.scopes ?? []);
  const [expiresAt, setExpiresAt] = useState('');
  const [purpose, setPurpose] = useState<string>('');
  // An edit opens ON the checklist; a create opens on the purpose question.
  const [scopesOpen, setScopesOpen] = useState(isEdit);
  const createMutation = useCreateApiKey();
  const updateMutation = useUpdateApiKey();
  const isPending = createMutation.isPending || updateMutation.isPending;

  function toggleScope(scope: string, checked: boolean) {
    setScopes((current) => (checked ? [...current, scope] : current.filter((entry) => entry !== scope)));
  }

  function choosePurpose(next: string) {
    setPurpose(next);
    // Custom means "I will pick them", so it clears rather than keeping whatever
    // the last preset left behind.
    const preset = catalog?.presets.find((entry) => entry.key === next);
    setScopes(preset ? [...preset.scopes] : []);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isEdit) {
      updateMutation.mutate(
        { id: initial.id, body: { keyName: name.trim(), scopes } },
        {
          onSuccess: () => {
            toast.success('API key updated');
            onOpenChange(false);
          },
          onError: (error) => toast.error(error.message),
        },
      );
    } else {
      createMutation.mutate(
        { keyName: name.trim(), scopes, ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) },
        {
          onSuccess: (result) => {
            toast.success('API key created');
            onCreated?.(result);
          },
          onError: (error) => toast.error(error.message),
        },
      );
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className={cx('flex max-h-[85vh] flex-col', DIALOG_SIZE_CLASS.md)}>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit API key' : 'Create API key'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Rename the key or adjust its scopes. The secret itself never changes here — use rotate for that.'
              : 'The secret key is generated server-side and shown exactly once after creation.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {!isEdit ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                Purpose
                <span aria-hidden className="text-destructive">
                  *
                </span>
              </span>
              {catalogPending ? (
                <div className="flex flex-col gap-2">
                  {Array.from({ length: 4 }, (_, index) => (
                    <Skeleton key={index} className="h-16 w-full" />
                  ))}
                </div>
              ) : (
                <PurposeCards presets={catalog?.presets ?? []} value={purpose} onChange={choosePurpose} />
              )}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-name`}>
              Name
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <Input
              id={`${uid}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              className="font-mono"
              placeholder="svc_reporting"
            />
          </div>

          {!isEdit ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${uid}-expires`}>Expires</Label>
              <Input id={`${uid}-expires`} type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
              <p className="text-muted-foreground text-xs">Leave empty for a non-expiring key.</p>
            </div>
          ) : null}

          <Collapsible open={scopesOpen} onOpenChange={setScopesOpen} className="flex flex-col gap-2">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" className="h-auto w-full justify-start gap-2 px-2 py-2 font-medium">
                <IconChevronRight aria-hidden className={scopesOpen ? 'size-4 rotate-90 transition-transform' : 'size-4 transition-transform'} />
                Show all scopes ({scopes.length} selected)
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {catalogPending ? (
                <div className="flex flex-col gap-2 rounded-md border p-3">
                  {Array.from({ length: 4 }, (_, index) => (
                    <Skeleton key={index} className="h-5 w-full" />
                  ))}
                </div>
              ) : (
                <ScopeChecklist categories={catalog?.categories ?? {}} selected={scopes} onToggle={toggleScope} />
              )}
            </CollapsibleContent>
          </Collapsible>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !name.trim() || scopes.length === 0}>
              {isPending ? <Spinner /> : null}
              {isEdit ? 'Save changes' : 'Create key'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
