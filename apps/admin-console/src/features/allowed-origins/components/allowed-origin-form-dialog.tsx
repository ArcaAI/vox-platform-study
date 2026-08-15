'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { useSession } from '@/shared/auth';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useAllowedOrigin, useCreateAllowedOrigin, useUpdateAllowedOrigin } from '../api';
import type { CreateAllowedOriginRequest, TenantAllowedOrigin, UpdateAllowedOriginRequest } from '../api';

/** FR-2 — only a SUPER_ADMIN may register or escalate into a wildcard/pattern origin; the server 403s a non-elevated attempt on both create and update. */
const WILDCARD_REASON = 'Wildcard patterns are managed by platform administrators.';

interface FormValues {
  origin: string;
  label: string;
  description: string;
}

const EMPTY: FormValues = {
  origin: '',
  label: '',
  description: '',
};

function toValues(origin?: TenantAllowedOrigin): FormValues {
  if (!origin) return EMPTY;
  return {
    origin: origin.origin,
    label: origin.label,
    description: origin.description ?? '',
  };
}

function toCreateBody(values: FormValues): CreateAllowedOriginRequest {
  return {
    origin: values.origin.trim(),
    label: values.label.trim(),
    ...(values.description.trim() ? { description: values.description.trim() } : {}),
  };
}

function toUpdateBody(values: FormValues): UpdateAllowedOriginRequest {
  return {
    origin: values.origin.trim(),
    label: values.label.trim(),
    description: values.description.trim() === '' ? null : values.description.trim(),
  };
}

/**
 * Form body remounts via `key` when the loaded row changes — field state
 * initializes once from props (no setState-in-effect).
 */
function AllowedOriginForm({
  initial,
  etag,
  canRegisterWildcard,
  onDone,
  onCancel,
  onReloadLatest,
}: {
  initial?: TenantAllowedOrigin;
  etag?: string;
  /** FR-2 — false for a non-elevated (tenant-admin) session; true keeps today's full SUPER_ADMIN capability. */
  canRegisterWildcard: boolean;
  onDone: () => void;
  onCancel: () => void;
  onReloadLatest?: () => void;
}) {
  const uid = useId();
  const isEdit = Boolean(initial);
  const createMutation = useCreateAllowedOrigin();
  const updateMutation = useUpdateAllowedOrigin();
  const [values, setValues] = useState<FormValues>(() => toValues(initial));
  const pending = createMutation.isPending || updateMutation.isPending;
  const mutationError = isEdit ? updateMutation.error : createMutation.error;
  // Presence of the wildcard token, not full origin grammar (the server owns
  // that, see the field comment below) — the one signal the UI needs to keep
  // a non-elevated caller from submitting a request the server will 403.
  const attemptsWildcard = !canRegisterWildcard && values.origin.includes('*');

  function setField<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleReloadLatest() {
    updateMutation.reset();
    onReloadLatest?.();
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!values.origin.trim() || !values.label.trim()) {
      toast.error('Origin and label are required');
      return;
    }
    // Defense in depth — the submit button is already disabled for this
    // case, but Enter-to-submit and programmatic submits go through here too.
    if (attemptsWildcard) {
      toast.error(WILDCARD_REASON);
      return;
    }

    if (isEdit && initial) {
      if (!etag) {
        toast.error('Missing ETag — reload and try again');
        return;
      }
      updateMutation.mutate(
        { id: initial.id, patch: toUpdateBody(values), etag },
        {
          onSuccess: () => {
            toast.success('Origin updated');
            onDone();
          },
          onError: (error) => {
            if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
            toast.error(error.message);
          },
        },
      );
      return;
    }

    createMutation.mutate(toCreateBody(values), {
      onSuccess: () => {
        toast.success('Origin registered');
        onDone();
      },
      onError: (error) => toast.error(error.message),
    });
  }

  return (
    <form id={`${uid}-form`} onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      {isEdit && onReloadLatest ? <OccConflictAlert error={mutationError} onReload={handleReloadLatest} /> : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-origin`}>
          Origin <span className="text-destructive">*</span>
        </Label>
        {/*
          type="text", NOT type="url". Browser-native URL validation rejects
          every non-exact form this field must accept — `new URL()` throws on
          `*`, on `https://*.bcmch.org:*` and on `http://localhost:*` (a `*`
          port is not a valid URL). With type="url" the form silently refuses
          to submit them, so wildcard patterns and the allow-all token were
          reachable only through the API or a seed.

          Origin SYNTAX is decided server-side by `normalizeOrigin` /
          `normalizeOriginPattern`, which is authoritative and returns a clear
          error — the input must not second-guess it with a weaker rule.
        */}
        <Input
          id={`${uid}-origin`}
          type="text"
          inputMode="url"
          value={values.origin}
          onChange={(event) => setField('origin', event.target.value)}
          required
          placeholder="https://app.example.org"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${uid}-origin-hint`}
          className="font-mono text-sm"
        />
        {canRegisterWildcard ? (
          <p id={`${uid}-origin-hint`} className="text-muted-foreground text-xs">
            Exact origin (<code className="font-mono">https://app.example.org</code>), a wildcard pattern (
            <code className="font-mono">https://*.example.org:*</code> — subdomains at any depth, never the apex), or{' '}
            <code className="font-mono">*</code> to admit every origin for this tenant.
          </p>
        ) : (
          <p id={`${uid}-origin-hint`} className="text-muted-foreground text-xs">
            Exact origin only (<code className="font-mono">https://app.example.org</code>). {WILDCARD_REASON}
          </p>
        )}
        {attemptsWildcard ? (
          <p role="alert" className="text-destructive text-sm">
            {WILDCARD_REASON}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-label`}>
          Label <span className="text-destructive">*</span>
        </Label>
        <Input id={`${uid}-label`} value={values.label} onChange={(event) => setField('label', event.target.value)} required autoComplete="off" />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-description`}>Description</Label>
        <Textarea
          id={`${uid}-description`}
          value={values.description}
          onChange={(event) => setField('description', event.target.value)}
          className="min-h-16 resize-none"
        />
      </div>

      <DialogFooter className="mt-auto">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || attemptsWildcard}>
          {pending ? <Spinner /> : null}
          {isEdit ? 'Save changes' : 'Register origin'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Create / edit dialog for an allowed-origin row. Edit loads its ETag for OCC PATCH. */
export function AllowedOriginFormDialog({
  open,
  onOpenChange,
  editingId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingId: string | null;
}) {
  const isEdit = Boolean(editingId);
  const detailQuery = useAllowedOrigin(editingId, open && isEdit);
  const origin = detailQuery.data?.data;
  const session = useSession();
  // FR-2 / FR-5 — SUPER_ADMIN keeps today's full capability; a non-elevated
  // (tenant-admin) session cannot register or escalate into a wildcard —
  // the server 403s it, so the form suppresses the attempt up front.
  const canRegisterWildcard = session.data?.isElevated ?? false;

  function close() {
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] flex-col sm:max-w-[50vw]">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit allowed origin' : 'Register allowed origin'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Saved with optimistic concurrency (If-Match).'
              : 'Registers a CORS allow-list row, effective on the next request — no restart.'}
          </DialogDescription>
        </DialogHeader>

        {!isEdit ? (
          <AllowedOriginForm canRegisterWildcard={canRegisterWildcard} onDone={close} onCancel={close} />
        ) : detailQuery.isPending ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3" aria-hidden>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : detailQuery.error || !origin ? (
          <ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
        ) : (
          <AllowedOriginForm
            key={origin.id}
            initial={origin}
            etag={detailQuery.data?.etag ?? undefined}
            canRegisterWildcard={canRegisterWildcard}
            onDone={close}
            onCancel={close}
            onReloadLatest={() => void detailQuery.refetch()}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
