'use client';

import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CodeEditor, validateJson } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useDeleteRuntimeProfile, useResolvedRuntimeProfile, useRuntimeProfile, useUpsertRuntimeProfile } from '../api/hooks';
import { CAPACITY_KNOBS, PROVIDER_DEFAULT_SLUG, SAMPLING_KNOBS, TIMING_KNOBS, type KnobSpec } from '../api/types';
import { KnobField } from './knob-field';
import { bodyFromDraft, draftFromProfile, isDraftClean, validateDraft, type KnobDraft } from './profile-draft';

/** The row this drawer edits. `modelSlug: ''` addresses the provider default. */
export interface RuntimeProfileTarget {
  provider: string;
  modelSlug: string;
}

function KnobGroup({
  title,
  specs,
  draft,
  resolved,
  errors,
  onChange,
  disabled,
  idPrefix,
}: {
  title: string;
  specs: readonly KnobSpec[];
  draft: KnobDraft;
  resolved: Partial<Record<KnobSpec['name'], number | null>>;
  errors: Partial<Record<KnobSpec['name'], string>>;
  onChange: (name: KnobSpec['name'], value: string) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {specs.map((spec) => (
        <KnobField
          key={spec.name}
          spec={spec}
          idPrefix={idPrefix}
          value={draft[spec.name]}
          inherited={resolved[spec.name] ?? null}
          onChange={(next) => onChange(spec.name, next)}
          disabled={disabled}
          invalid={errors[spec.name]}
        />
      ))}
    </section>
  );
}

function DrawerSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {Array.from({ length: 3 }, (_, group) => (
        <div key={group} className="flex flex-col gap-3 rounded-xl border p-4">
          <Skeleton className="h-5 w-32" />
          {Array.from({ length: 3 }, (_, row) => (
            <div key={row} className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The runtime-profile editor — hyperparameters, capacity and timing for one
 * (provider, model) pair.
 *
 * These knobs have been API-only since the routes shipped: `admin/ai-runtime-profiles`
 * exposes five operations and the console had no feature folder and no screen,
 * so temperature, context length, concurrency, TPM/RPM ceilings and timeouts
 * could only be changed with a hand-rolled HTTP call.
 *
 * Three things this drawer is deliberate about:
 *
 *  1. **Empty means `null`, and `null` is a real edit.** Clearing a field hands
 *     the knob back to the cascade; it is not the same as leaving it alone. The
 *     diff in `profile-draft.ts` preserves that distinction all the way to the
 *     wire.
 *  2. **Inheritance is shown, not implied.** The Resolved tab is the merge the
 *     gateway would actually inject, and each cleared field names the value it
 *     inherits — so "unset" never has to be guessed at.
 *  3. **A concurrent edit surfaces as a conflict.** `PUT row` is
 *     `@RequiresIfMatch()` unconditionally; drift returns 412 and the admin is
 *     offered a reload rather than having their write silently win or silently
 *     lose.
 */
export function RuntimeProfileDrawer({
  target,
  open,
  onOpenChange,
}: {
  target: RuntimeProfileTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const uid = useId();
  const provider = target?.provider ?? null;
  const modelSlug = target?.modelSlug ?? PROVIDER_DEFAULT_SLUG;

  const rowQuery = useRuntimeProfile(provider, modelSlug, open);
  const resolvedQuery = useResolvedRuntimeProfile(provider, modelSlug, open);
  const upsert = useUpsertRuntimeProfile();
  const remove = useDeleteRuntimeProfile();

  // `null` = untouched, so the form DERIVES its values from the server during
  // render instead of syncing them in an effect: a background refetch or a
  // post-conflict re-read lands immediately without stomping in-progress input.
  const [edited, setEdited] = useState<KnobDraft | null>(null);
  const [extraDraft, setExtraDraft] = useState<string | null>(null);

  const stored = rowQuery.data?.data;
  const etag = rowQuery.data?.etag ?? null;
  const serverDraft = useMemo(() => draftFromProfile(stored), [stored]);
  const draft = edited ?? serverDraft;

  const storedExtra = stored?.extraJson ?? null;
  const serverExtraText = storedExtra === null ? '' : JSON.stringify(storedExtra, null, 2);
  const extraText = extraDraft ?? serverExtraText;
  const extraDirty = extraDraft !== null && extraDraft !== serverExtraText;
  const extraValid = extraText.trim() === '' || validateJson(extraText).ok;

  const errors = useMemo(() => validateDraft(draft), [draft]);
  const hasErrors = Object.keys(errors).length > 0;

  const parsedExtra = useMemo(() => {
    if (!extraDirty || !extraValid) return undefined;
    if (extraText.trim() === '') return null;
    return JSON.parse(extraText) as Record<string, unknown>;
  }, [extraDirty, extraValid, extraText]);

  const body = useMemo(() => bodyFromDraft(draft, stored, parsedExtra, extraDirty), [draft, stored, parsedExtra, extraDirty]);
  const clean = isDraftClean(body);

  const resolved = resolvedQuery.data ?? {};
  const isNewRow = (stored?.version ?? 0) === 0;

  const reset = () => {
    setEdited(null);
    setExtraDraft(null);
  };

  const onSave = () => {
    if (!provider || hasErrors || !extraValid) return;
    upsert.mutate(
      { provider, modelSlug, body, etag },
      {
        onSuccess: () => {
          reset();
          toast.success(`Runtime profile saved for ${provider}${modelSlug ? ` · ${modelSlug}` : ' (provider default)'}.`);
        },
        onError: (error) => {
          const status = error instanceof GatewayError ? error.status : undefined;
          if (status === 412 || status === 428) {
            // Re-read and let the admin re-apply against the winning row. A
            // blind retry is exactly the overwrite OCC exists to prevent, so
            // the local draft is dropped rather than resubmitted.
            reset();
            void rowQuery.refetch();
            void resolvedQuery.refetch();
            return;
          }
          toast.error(error instanceof GatewayError ? error.message : 'Could not save the runtime profile.');
        },
      },
    );
  };

  const onDelete = () => {
    if (!provider) return;
    remove.mutate(
      { provider, modelSlug },
      {
        onSuccess: () => {
          reset();
          toast.success('Runtime profile removed; the cascade now applies.');
          onOpenChange(false);
        },
        onError: () => toast.error('Could not remove the runtime profile.'),
      },
    );
  };

  const busy = upsert.isPending || remove.isPending;
  const title = provider ? `${provider}${modelSlug ? ` · ${modelSlug}` : ''}` : 'Runtime profile';

  return (
    <Tabs defaultValue="knobs">
      <DetailDrawer
        open={open}
        onOpenChange={(next) => {
          if (!next) reset();
          onOpenChange(next);
        }}
        size="lg"
        title={title}
        badges={
          <>
            {modelSlug === PROVIDER_DEFAULT_SLUG ? <Badge variant="secondary">Provider default</Badge> : <Badge variant="outline">Model-scoped</Badge>}
            {isNewRow ? <Badge variant="outline">Not configured</Badge> : <Badge variant="secondary">v{stored?.version}</Badge>}
          </>
        }
        meta={
          <span>
            Platform (SYSTEM) configuration &middot; super administrators only &middot; <span className="font-mono">PUT admin/ai-runtime-profiles/row</span>{' '}
            with If-Match
          </span>
        }
        closeBlockedReason={busy ? 'a save is in progress' : undefined}
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="knobs">Knobs</TabsTrigger>
            <TabsTrigger value="resolved">Resolved</TabsTrigger>
          </TabsList>
        }
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={onDelete} disabled={busy || isNewRow}>
              {remove.isPending ? <Spinner /> : null}
              Remove row
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={reset} disabled={busy || (clean && !extraDirty)}>
                Discard changes
              </Button>
              <Button size="sm" onClick={onSave} disabled={busy || clean || hasErrors || !extraValid}>
                {upsert.isPending ? <Spinner /> : null}
                Save
              </Button>
            </div>
          </div>
        }
      >
        {rowQuery.isPending ? (
          <DrawerSkeleton />
        ) : rowQuery.error ? (
          <ErrorState error={rowQuery.error} onRetry={() => void rowQuery.refetch()} />
        ) : (
          <div className="flex flex-col gap-4">
            <OccConflictAlert
              error={upsert.error}
              onReload={() => {
                reset();
                void rowQuery.refetch();
              }}
            />
            <TabsContent value="knobs" className="flex flex-col gap-4">
              <p className="text-muted-foreground text-sm">
                Every knob is optional. Leave a field empty for &ldquo;no opinion&rdquo; &mdash; the value then falls through to the provider default
                row, and past that to the consuming service&rsquo;s own default.
              </p>
              <KnobGroup
                title="Sampling"
                specs={SAMPLING_KNOBS}
                draft={draft}
                resolved={resolved}
                errors={errors}
                disabled={busy}
                idPrefix={uid}
                onChange={(name, value) => setEdited({ ...draft, [name]: value })}
              />
              <KnobGroup
                title="Capacity"
                specs={CAPACITY_KNOBS}
                draft={draft}
                resolved={resolved}
                errors={errors}
                disabled={busy}
                idPrefix={uid}
                onChange={(name, value) => setEdited({ ...draft, [name]: value })}
              />
              <KnobGroup
                title="Timing"
                specs={TIMING_KNOBS}
                draft={draft}
                resolved={resolved}
                errors={errors}
                disabled={busy}
                idPrefix={uid}
                onChange={(name, value) => setEdited({ ...draft, [name]: value })}
              />
              <section className="flex flex-col gap-2 rounded-xl border p-4">
                <h3 className="text-sm font-medium">Engine extras</h3>
                <p className="text-muted-foreground text-xs">
                  Engine-specific fields with no dedicated column (<span className="font-mono">n_threads</span>,{' '}
                  <span className="font-mono">n_gpu_layers</span>, <span className="font-mono">num_predict</span>, …). Leave empty to clear.
                </p>
                <CodeEditor
                  aria-label="Engine extras JSON"
                  language="json"
                  value={extraText}
                  readOnly={busy}
                  onChange={setExtraDraft}
                  className="min-h-40"
                />
                {!extraValid ? <p className="text-destructive text-sm">Engine extras must be valid JSON, or empty.</p> : null}
              </section>
            </TabsContent>
            <TabsContent value="resolved">
              <ResolvedPane provider={provider} modelSlug={modelSlug} query={resolvedQuery} />
            </TabsContent>
          </div>
        )}
      </DetailDrawer>
    </Tabs>
  );
}

/** What the gateway would actually inject for this pair — the inspection read. */
function ResolvedPane({
  provider,
  modelSlug,
  query,
}: {
  provider: string | null;
  modelSlug: string;
  query: ReturnType<typeof useResolvedRuntimeProfile>;
}) {
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  if (query.error || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const resolved = query.data;
  const rows = [...SAMPLING_KNOBS, ...CAPACITY_KNOBS, ...TIMING_KNOBS];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        The model-scoped row merged over the provider default, per field &mdash; exactly what the gateway injects for{' '}
        <span className="font-mono text-xs">
          {provider}
          {modelSlug ? `/${modelSlug}` : ''}
        </span>
        .
      </p>
      {resolved.isEmpty ? (
        <p className="rounded-md border border-dashed p-3 text-sm">
          Nothing is injected. No level carries an opinion, so the consuming service keeps its own defaults entirely.
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {rows.map((spec) => {
          const value = resolved[spec.name] as number | null;
          return (
            <div key={spec.name} className="contents">
              <dt className="text-muted-foreground">{spec.label}</dt>
              <dd className="font-mono text-xs">{value === null ? <span className="not-italic">not set</span> : value}</dd>
            </div>
          );
        })}
        <dt className="text-muted-foreground">Engine extras</dt>
        <dd className="font-mono text-xs break-all">{resolved.extraJson === null ? 'not set' : JSON.stringify(resolved.extraJson)}</dd>
      </dl>
    </div>
  );
}
