'use client';

import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { usePutProviderConnection } from '../api/hooks';
import { gatewayErrorCode, isReservedConnectionSlug, isValidConnectionSlug, type ProviderService } from '../api/types';
import type { ProviderMeta } from './provider-meta';

/**
 * TASK-958 D-2/D-10 — a SECOND account of one vendor.
 *
 * Short create-only dialog (rule 11 §1: a dialog is a confirmation or a single
 * form, never a record editor). It asks for the two things the gateway cannot
 * infer and nothing else:
 *
 *  - **the slug**, which IS the route segment (`PUT admin/providers/:service/:slug`)
 *    and the prefix of every model slug this connection mints. It is IMMUTABLE
 *    after create, so the pattern is enforced here as well as server-side —
 *    this is the last place a typo is still free.
 *  - **the name**, which is free text and the only thing a tenant can rename
 *    later (OQ-7).
 *
 * The credential is deliberately NOT here. The row is created `enabled: false`
 * and keyless, the dialog closes onto the new card, and the key is typed there
 * — one home per fact, and the same card that rotates it later.
 */
export function AddConnectionDialog({
  service,
  meta,
  tenantId,
  existingSlugs,
  open,
  onOpenChange,
  onCreated,
}: {
  service: ProviderService;
  meta: ProviderMeta;
  tenantId?: string;
  /** Slugs this provider's group already holds — a duplicate would PUT OVER an existing row. */
  existingSlugs: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (slug: string) => void;
}) {
  const uid = useId();
  const put = usePutProviderConnection();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Re-seed on each open: a dialog that reopens holding the last attempt's
  // refusal would explain a row the admin is no longer creating.
  const [openedFor, setOpenedFor] = useState(false);
  if (open !== openedFor) {
    setOpenedFor(open);
    if (open) {
      setSlug('');
      setName('');
      setError(null);
      put.reset();
    }
  }

  /** The one sentence that turns any reserved-name refusal into an action. */
  const reservedHint = `Choose a name of your own, such as “${meta.id}-research”.`;

  function validate(): string | null {
    const value = slug.trim();
    if (!value) return 'Enter a connection id.';
    if (!isValidConnectionSlug(value)) {
      return 'Use 2–63 lowercase letters, digits or hyphens, starting with a letter or digit.';
    }
    if (existingSlugs.includes(value)) return `This tenant already has a ${meta.label} connection called “${value}”.`;
    // TASK-958 — the gateway's `CONNECTION_SLUG_RESERVED`, caught here because
    // the slug is IMMUTABLE after create. The duplicate check above cannot
    // stand in for it: this group knows only ITS OWN provider's slugs, so
    // naming an OpenAI sibling `sarvam` looks valid right up to the 400.
    if (isReservedConnectionSlug(value)) {
      return value === 'platform-defaults'
        ? `“${value}” is reserved — it is a route name on this API, so a connection called that could not be opened. ${reservedHint}`
        : `“${value}” is reserved: it names a provider, and that name belongs to the provider’s own default connection. ${reservedHint}`;
    }
    return null;
  }

  function submit() {
    const refusal = validate();
    if (refusal) {
      setError(refusal);
      return;
    }
    const value = slug.trim();
    put.mutate(
      {
        service,
        slug: value,
        // `provider` is REQUIRED whenever the slug is not itself a provider id
        // (D-2) — and always sent, so the row's vendor is what this button said
        // it was rather than whatever the gateway could infer from the string.
        body: { provider: meta.id, ...(name.trim() ? { name: name.trim() } : {}), enabled: false },
        // No stored row to be stale against: `null` becomes the documented
        // `If-Match: "0"` create precondition.
        etag: null,
        tenantId,
      },
      {
        onSuccess: () => {
          toast.success(`${meta.label} connection “${name.trim() || value}” created — add its credential to enable it`);
          onOpenChange(false);
          onCreated(value);
        },
        // A reserved name the CLIENT mirror does not know about (the gateway's
        // provider table may be wider than what a tenant may bring) still comes
        // back as `CONNECTION_SLUG_RESERVED` — rendered with the same one action
        // that unblocks it, so a server-only refusal is no less actionable.
        onError: (mutationError) =>
          setError(
            gatewayErrorCode(mutationError) === 'CONNECTION_SLUG_RESERVED' ? `${mutationError.message} ${reservedHint}` : mutationError.message,
          ),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !put.isPending && onOpenChange(next)}>
      <DialogContent className="flex flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add another {meta.label} connection</DialogTitle>
          <DialogDescription>
            A second {meta.label} account for this tenant. Declare models on it to bind agents to this key; the tenant’s DEFAULT connection keeps
            serving every platform model.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-slug`}>
              Connection id <span aria-hidden>*</span>
            </Label>
            {/*
              One validation authority, on purpose: `validate()` below owns the
              refusal, so the field carries NO `required`/`pattern`. With both,
              the browser blocks the submit with its own bubble and the message
              that names the actual rule (and the duplicate-slug case, which no
              pattern can express) never runs.
            */}
            <Input
              id={`${uid}-slug`}
              autoFocus
              value={slug}
              onChange={(event) => {
                setSlug(event.target.value);
                setError(null);
              }}
              placeholder={`${meta.id}-research`}
              aria-describedby={`${uid}-slug-help`}
              aria-invalid={error ? true : undefined}
              className="font-mono"
            />
            <p id={`${uid}-slug-help`} className="text-muted-foreground text-xs">
              Lowercase letters, digits and hyphens. Permanent — it names this connection in every model it declares. Rename the label below instead.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-name`}>Display name</Label>
            <Input
              id={`${uid}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Research account"
              maxLength={120}
            />
          </div>
          {error ? (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={put.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={put.isPending}>
              {put.isPending ? <Spinner /> : null}
              Create connection
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
