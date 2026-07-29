'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconDatabaseCog, IconPlus } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { RequirePermission } from '@/shared/auth/require-permission';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime, formatNumber } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useCreateGoldenCase, useCreateGoldenSet, useGoldenCases, useGoldenSet, useGoldenSets } from '../api';
import type { GoldenSet } from '../api';

const EM_DASH = '\u2014';
const PAGE_LIMIT = 50;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="min-w-0 truncate text-sm font-medium">{children}</dd>
    </div>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/** Create-set form. The tenant is resolved server-side — never sent in the body. */
function CreateGoldenSetDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const fieldId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pinnedVersion, setPinnedVersion] = useState('');
  const createSet = useCreateGoldenSet();

  function reset() {
    setName('');
    setDescription('');
    setPinnedVersion('');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    createSet.mutate(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        pinnedVersion: pinnedVersion.trim() || undefined,
      },
      {
        onSuccess: (created) => {
          toast.success(`Golden set "${created.name}" created`);
          reset();
          onOpenChange(false);
        },
        onError: (error) => toast.error(errorMessage(error, 'Could not create the golden set')),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New golden set</DialogTitle>
            <DialogDescription>A named collection of reference cases used to score harness output.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-name`}>Name *</Label>
              <Input
                id={`${fieldId}-name`}
                aria-label="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={200}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-description`}>Description</Label>
              <Textarea
                id={`${fieldId}-description`}
                aria-label="Description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2000}
                className="resize-none"
                rows={3}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-pinned`}>Pinned version</Label>
              <Input
                id={`${fieldId}-pinned`}
                aria-label="Pinned version"
                value={pinnedVersion}
                onChange={(event) => setPinnedVersion(event.target.value)}
                maxLength={100}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || createSet.isPending}>
              {createSet.isPending ? <Spinner aria-hidden /> : null}
              Create set
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Add-case form. `transcript`/`referenceNote` are PHI and WRITE-ONLY through
 * this surface: the gateway encrypts them at rest and the 201 response carries
 * the metadata projection only, so nothing typed here is ever read back.
 */
function AddGoldenCaseDialog({
  goldenSetId,
  open,
  onOpenChange,
}: {
  goldenSetId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fieldId = useId();
  const [transcript, setTranscript] = useState('');
  const [referenceNote, setReferenceNote] = useState('');
  const [label, setLabel] = useState('');
  const createCase = useCreateGoldenCase(goldenSetId);

  function submit(event: FormEvent) {
    event.preventDefault();
    createCase.mutate(
      { transcript, referenceNote, label: label.trim() || undefined },
      {
        onSuccess: () => {
          toast.success('Case added to the golden set');
          setTranscript('');
          setReferenceNote('');
          setLabel('');
          onOpenChange(false);
        },
        onError: (error) => toast.error(errorMessage(error, 'Could not add the case')),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] flex-col sm:max-w-[70vw]">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogHeader className="shrink-0">
            <DialogTitle>Add case</DialogTitle>
            <DialogDescription>
              The transcript and reference note are PHI: encrypted at rest and never returned by the admin read plane.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-transcript`}>Transcript *</Label>
              <Textarea
                id={`${fieldId}-transcript`}
                aria-label="Transcript"
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                className="min-h-0 flex-1 resize-none"
                required
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-reference`}>Reference note *</Label>
              <Textarea
                id={`${fieldId}-reference`}
                aria-label="Reference note"
                value={referenceNote}
                onChange={(event) => setReferenceNote(event.target.value)}
                className="min-h-0 flex-1 resize-none"
                required
              />
            </div>
            <div className="flex shrink-0 flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-label`}>Label</Label>
              <Input id={`${fieldId}-label`} aria-label="Label" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={200} />
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!transcript || !referenceNote || createCase.isPending}>
              {createCase.isPending ? <Spinner aria-hidden /> : null}
              Add case to set
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Golden-set detail. Renders METADATA ONLY, for both the set and its cases —
 * `GET golden-sets/:id/cases` is a PHI-safe projection (`id`, `label`,
 * timestamps, `createdBy`) and the encrypted clinical payloads are never
 * surfaced by the API. Do NOT add a field here that would display case content.
 */
function GoldenSetDetailDrawer({
  goldenSetId,
  fallback,
  onOpenChange,
  onAddCase,
}: {
  goldenSetId: string | null;
  fallback?: GoldenSet;
  onOpenChange: (open: boolean) => void;
  onAddCase: () => void;
}) {
  const setQuery = useGoldenSet(goldenSetId);
  const casesQuery = useGoldenCases(goldenSetId, { limit: PAGE_LIMIT });
  const set = setQuery.data ?? fallback;
  const cases = casesQuery.data;

  return (
    <DetailDrawer
      open={!!goldenSetId}
      onOpenChange={onOpenChange}
      size="lg"
      title={set?.name ?? 'Golden set'}
      badges={set?.pinnedVersion ? <Badge variant="secondary">{set.pinnedVersion}</Badge> : null}
      meta={
        <>
          <span className="font-mono">{goldenSetId}</span>
          <span aria-hidden className="font-mono">
            GET golden-sets/:id/cases {'\u00b7'} PHI-safe metadata
          </span>
        </>
      }
      footer={
        <RequirePermission action="manage" subject="HarnessEval">
          <Button onClick={onAddCase}>
            <IconPlus aria-hidden />
            Add case
          </Button>
        </RequirePermission>
      }
    >
      <div className="flex flex-col gap-4">
        <dl className="flex flex-col gap-1.5">
          <MetaRow label="Created">{formatDateTime(set?.createdAt)}</MetaRow>
          <MetaRow label="Updated">{formatDateTime(set?.updatedAt)}</MetaRow>
          <MetaRow label="Created by">
            <span className="font-mono text-xs">{set?.createdBy ?? 'system'}</span>
          </MetaRow>
          <MetaRow label="Cases">{cases ? formatNumber(cases.total) : EM_DASH}</MetaRow>
        </dl>
        {set?.description ? <p className="text-muted-foreground text-sm">{set.description}</p> : null}
        {casesQuery.isLoading ? (
          <ListSkeleton rows={3} />
        ) : casesQuery.error ? (
          <ErrorState error={casesQuery.error} onRetry={() => void casesQuery.refetch()} />
        ) : cases && cases.items.length === 0 ? (
          <EmptyState
            icon={IconDatabaseCog}
            title="No cases in this set"
            description="Cases carry encrypted clinical payloads; only their metadata is listed here."
          />
        ) : cases ? (
          <ul className="flex flex-col gap-2" aria-label="Golden set cases">
            {cases.items.map((goldenCase) => (
              <li key={goldenCase.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{goldenCase.label ?? EM_DASH}</span>
                  <span className="text-muted-foreground block truncate font-mono text-xs" title={goldenCase.id}>
                    {goldenCase.id}
                  </span>
                </span>
                <span className="text-muted-foreground text-xs whitespace-nowrap">{formatDateTime(goldenCase.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </DetailDrawer>
  );
}

/**
 * Golden datasets on the harness observability
 * board. Reads are `read:HarnessEval`; both create flows are gated on
 * `manage:HarnessEval` (client-side visibility only — the gateway enforces).
 */
export function GoldenSetsPanel() {
  const [openSetId, setOpenSetId] = useState<string | null>(null);
  const [createSetOpen, setCreateSetOpen] = useState(false);
  const [addCaseOpen, setAddCaseOpen] = useState(false);
  const setsQuery = useGoldenSets({ limit: PAGE_LIMIT });
  const sets = setsQuery.data;
  const openSet = sets?.items.find((item) => item.id === openSetId);

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="gap-1 px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Golden sets</h2>
          <RequirePermission action="manage" subject="HarnessEval">
            <Button size="sm" variant="outline" onClick={() => setCreateSetOpen(true)}>
              <IconPlus aria-hidden />
              New golden set
            </Button>
          </RequirePermission>
        </div>
        <span className="text-muted-foreground text-sm">
          {sets ? `${formatNumber(sets.total)} sets` : ' '}
          <span aria-hidden className="font-mono text-xs">
            {' '}
            {'\u00b7'} GET golden-sets {'\u00b7'} row click {'\u2192'} PHI-safe case metadata
          </span>
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        {setsQuery.isLoading ? (
          <ListSkeleton rows={3} />
        ) : setsQuery.error ? (
          <ErrorState error={setsQuery.error} onRetry={() => void setsQuery.refetch()} />
        ) : sets && sets.items.length === 0 ? (
          <EmptyState
            icon={IconDatabaseCog}
            title="No golden sets yet"
            description="Golden sets pin the reference cases that eval runs score against."
          />
        ) : sets ? (
          <ul className="flex flex-col gap-2" aria-label="Golden sets">
            {sets.items.map((set) => (
              <li key={set.id}>
                <button
                  type="button"
                  onClick={() => setOpenSetId(set.id)}
                  className="hover:bg-accent focus-visible:ring-ring flex w-full flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span className="flex w-full flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">{set.name}</span>
                    {set.pinnedVersion ? <Badge variant="secondary">{set.pinnedVersion}</Badge> : null}
                  </span>
                  {set.description ? <span className="text-muted-foreground line-clamp-1 text-xs">{set.description}</span> : null}
                  <span className="text-muted-foreground font-mono text-xs">{formatDateTime(set.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <GoldenSetDetailDrawer
          goldenSetId={openSetId}
          fallback={openSet}
          onOpenChange={(open) => !open && setOpenSetId(null)}
          onAddCase={() => setAddCaseOpen(true)}
        />
        <CreateGoldenSetDialog open={createSetOpen} onOpenChange={setCreateSetOpen} />
        <AddGoldenCaseDialog goldenSetId={openSetId} open={addCaseOpen} onOpenChange={setAddCaseOpen} />
      </CardContent>
    </Card>
  );
}
