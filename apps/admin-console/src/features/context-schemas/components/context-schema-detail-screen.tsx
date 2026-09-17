'use client';

/**
 * One context schema, as a PAGE.
 *
 * It was an `xl` `DetailDrawer` with four tabs, a 23-control kind editor and a
 * standing Delete button in the footer. A drawer is the right surface for a
 * record you glance at; this is a record an admin AUTHORS, with a draft that
 * survives across tabs, a publish that changes what every client may send, and
 * a version history. So: a page, one column, one primary action.
 *
 * What moved where, and why:
 *   • **Settings** was a tab; it is four fields and a save. A tab for that costs
 *     an admin a click on every visit to learn it holds nothing they need.
 *     It is now "Rename & settings" in the `⋯` menu.
 *   • **Tester** was a tab that made you re-pick a kind from a dropdown. It is
 *     now a button inside each kind — the kind is chosen by where you clicked.
 *   • **Publish** was a section at the bottom of the Definition tab. It is the
 *     page's one primary action, and its confirmation says what will happen.
 *   • **Delete** was a standing destructive button in the drawer footer, one
 *     mis-click from the tab bar. It is in the `⋯` menu behind type-to-confirm.
 *
 * That leaves two tabs (Definition · Versions), both deep-linkable via `?tab=`.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { IconArrowLeft, IconDotsVertical, IconSettings, IconStar, IconTrash } from '@tabler/icons-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { useUnsavedChangesGuard } from '@/shared/navigation/use-unsaved-changes-guard';
import { useTrailingBreadcrumb } from '@/shared/navigation/breadcrumb-store';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useContextSchema, useContextSchemaUsages, useContextSchemaVersions, useDeleteContextSchema, usePublishContextSchema } from '../api/hooks';
import { emptyDefinition, type ContextSchemaDefinition, type ContextSchemaUsagesResponse } from '../api/types';
import { publishRejection } from '../lib/publish-error';
import { DefinitionEditor } from './definition-editor';
import { PublishConfirmDialog } from './publish-confirm-dialog';
import { SchemaUsagesLine } from './schema-usages-line';
import { SettingsForm } from './settings-form';
import { VersionsPanel } from './versions-panel';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';

const TAB_VALUES = ['definition', 'versions'] as const;
type SchemaTab = (typeof TAB_VALUES)[number];

const LEAVE_MESSAGE = 'You have unpublished changes to this definition. Leave without publishing?';

/** Route-level `loading.tsx` mirrors this shape (rule 10). */
export function ContextSchemaDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-72" />
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-9" />
        </div>
      </div>
      <Skeleton className="h-5 w-72" />
      <Skeleton className="h-9 w-64" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}

function latestDefinition(versions: { versionNumber: number; definition: ContextSchemaDefinition }[]): ContextSchemaDefinition {
  if (versions.length === 0) return emptyDefinition();
  return [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0].definition;
}

/** Kind keys this draft introduces over the pinned version — the server's `additions`, computed locally so the confirmation can name them BEFORE the write. */
function additionsOver(draft: ContextSchemaDefinition, published: ContextSchemaDefinition | null): string[] {
  const known = new Set((published?.kinds ?? []).map((kind) => kind.key));
  return draft.kinds.map((kind) => kind.key).filter((key) => key && !known.has(key));
}

function ContextSchemaDetailBody({ id }: { id: string }) {
  const router = useRouter();
  const [tab, setTab] = useQueryState('tab', parseAsStringLiteral(TAB_VALUES).withDefault('definition'));

  const detail = useContextSchema(id);
  const versionsQuery = useContextSchemaVersions(id);
  const usagesQuery = useContextSchemaUsages(id);
  const publish = usePublishContextSchema();
  const deleteSchema = useDeleteContextSchema();

  const schema = detail.data?.data ?? null;
  const etag = detail.data?.etag ?? null;
  const versions = versionsQuery.data ?? [];

  const [draft, setDraft] = useState<ContextSchemaDefinition>(emptyDefinition());
  const [publishOpen, setPublishOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [changeReason, setChangeReason] = useState('');
  const [breakingChanges, setBreakingChanges] = useState<string[] | null>(null);
  const [refusedImpact, setRefusedImpact] = useState<ContextSchemaUsagesResponse | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);

  // Re-seed the draft from the latest published version once per (schema, first
  // successful version load) — adjusted DURING RENDER rather than in an effect,
  // so it never fires twice for the same load and a background refetch never
  // clobbers in-progress edits.
  const seedKey = versionsQuery.isSuccess ? id : null;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seedKey && seedKey !== seededFor) {
    setSeededFor(seedKey);
    setDraft(latestDefinition(versions));
  }

  const publishedDefinition = versions.length > 0 ? latestDefinition(versions) : null;
  const isDirty = seededFor !== null && JSON.stringify(draft) !== JSON.stringify(publishedDefinition ?? emptyDefinition());
  useUnsavedChangesGuard(isDirty, LEAVE_MESSAGE);
  useTrailingBreadcrumb(schema?.name);

  function runPublish(acknowledgements: { allowBreakingChange?: boolean; acknowledgeImpact?: boolean }) {
    publish.mutate(
      { id, body: { definition: draft, changeReason: changeReason.trim() || undefined, ...acknowledgements } },
      {
        onSuccess: () => {
          toast.success('Definition published');
          setPublishOpen(false);
          setBreakingChanges(null);
          setRefusedImpact(null);
          setProblems(null);
          setChangeReason('');
          void detail.refetch();
          void versionsQuery.refetch();
          void usagesQuery.refetch();
        },
        onError: (error) => {
          const rejection = publishRejection(error);
          // A structural problem is a DEFECT in the definition: close the
          // decision dialog and point at the field, in the editor.
          if (rejection?.problems) {
            setProblems(rejection.problems);
            setPublishOpen(false);
            return;
          }
          // The other two are DECISIONS: keep the dialog open and re-state it
          // with what the server just told us.
          if (rejection?.breakingChanges) {
            setBreakingChanges(rejection.breakingChanges);
            return;
          }
          if (rejection?.impactUnacknowledged && rejection.impact) {
            setRefusedImpact(rejection.impact);
            return;
          }
          toast.error(error instanceof GatewayError ? error.message : 'Could not publish the definition.');
        },
      },
    );
  }

  function handleDelete() {
    if (!schema) return;
    deleteSchema.mutate(schema.id, {
      onSuccess: () => {
        toast.success('Context schema deleted');
        setDeleteOpen(false);
        router.push('/context-schemas');
      },
      onError: (error) => {
        toast.error(error instanceof GatewayError ? error.message : 'Could not delete the context schema.');
        setDeleteOpen(false);
      },
    });
  }

  if (detail.isPending) return <ContextSchemaDetailSkeleton />;

  if ((detail.error instanceof GatewayError && detail.error.isNotFound) || (!detail.isPending && !schema)) {
    // 404-over-403 posture: cross-tenant and missing look identical.
    return (
      <div className="flex flex-col gap-4">
        <ErrorState title="Context schema not found" error={new Error('This context schema does not exist or is outside your access scope.')} />
        <div className="flex justify-center">
          <Button variant="outline" asChild>
            <Link href="/context-schemas">
              <IconArrowLeft aria-hidden />
              Back to context schemas
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (detail.error || !schema) {
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  }

  // The next version follows the HIGHEST existing version, not the pin: a rolled-back schema
  // (pinned to v1 with v3 in its history) publishes v4, never "v2" again.
  const nextVersion = Math.max(0, ...versions.map((version) => version.versionNumber), schema.pinnedVersionNumber ?? 0) + 1;
  const outputCount = draft.outputs?.length ?? 0;

  return (
    <Tabs value={tab} onValueChange={(next) => void setTab(next as SchemaTab)} className="flex min-h-0 flex-1 flex-col">
      <ScreenTemplate
        header={
          <PageHeader
            title={schema.name}
            meta={
              <>
                <span className="font-mono">{schema.slug}</span>
                <CopyButton value={schema.id} label="Copy schema id" />
                <Badge variant="outline">{schema.status}</Badge>
                {schema.isDefault ? (
                  <Badge className="gap-1">
                    <IconStar aria-hidden className="size-3" />
                    Default
                  </Badge>
                ) : null}
                <Badge variant="secondary">
                  {schema.pinnedVersionNumber != null ? `Pinned v${schema.pinnedVersionNumber}` : 'No published version'}
                </Badge>
              </>
            }
            actions={
              <>
                <Button type="button" disabled={draft.kinds.length === 0 || publish.isPending} onClick={() => setPublishOpen(true)}>
                  {publish.isPending ? <Spinner /> : null}
                  Publish
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="icon" aria-label="More schema actions">
                      <IconDotsVertical aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                      <IconSettings aria-hidden />
                      Rename &amp; settings
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                      <IconTrash aria-hidden />
                      Delete schema
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            }
          />
        }
        stats={<SchemaUsagesLine usages={usagesQuery.data} isPending={usagesQuery.isPending} error={usagesQuery.error} />}
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="definition">Definition</TabsTrigger>
            <TabsTrigger value="versions">Versions ({versions.length})</TabsTrigger>
          </TabsList>
        }
        footer={
          <StatusFooter
            start={
              <span>
                {schema.status === 'DRAFT' ? 'Draft' : schema.status === 'APPROVED' ? 'Approved' : 'Published'}
                {' · '}
                {draft.kinds.length} kind{draft.kinds.length === 1 ? '' : 's'}, {outputCount} output{outputCount === 1 ? '' : 's'}
                {' · '}
                {isDirty ? 'unsaved changes' : 'Saved'}
              </span>
            }
            end={
              <span aria-hidden className="font-mono">
                GET /admin/consultation-context-schemas/{schema.id}
              </span>
            }
          />
        }
      >
        <TabsContent value="definition" className="mt-0">
          <DefinitionEditor definition={draft} onDefinitionChange={setDraft} problems={problems} />
        </TabsContent>
        <TabsContent value="versions" className="mt-0">
          <VersionsPanel
            schema={schema}
            versions={versions}
            isPending={versionsQuery.isPending}
            error={versionsQuery.error}
            onRetry={() => void versionsQuery.refetch()}
            onChanged={() => {
              void detail.refetch();
              void versionsQuery.refetch();
              void usagesQuery.refetch();
            }}
          />
        </TabsContent>
      </ScreenTemplate>

      <PublishConfirmDialog
        open={publishOpen}
        onOpenChange={(open) => {
          setPublishOpen(open);
          if (!open) {
            setBreakingChanges(null);
            setRefusedImpact(null);
          }
        }}
        nextVersion={nextVersion}
        currentVersion={schema.pinnedVersionNumber}
        additions={additionsOver(draft, publishedDefinition)}
        impact={refusedImpact ?? usagesQuery.data ?? null}
        breakingChanges={breakingChanges}
        changeReason={changeReason}
        onChangeReasonChange={setChangeReason}
        onConfirm={runPublish}
        isPending={publish.isPending}
      />

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className={DIALOG_SIZE_CLASS.md}>
          <DialogHeader>
            <DialogTitle>Rename &amp; settings</DialogTitle>
            <DialogDescription>
              Metadata only — the definition itself is edited on the Definition tab and changes only when you publish.
            </DialogDescription>
          </DialogHeader>
          <SettingsForm
            key={`${schema.id}-${schema.updatedAt}`}
            schema={schema}
            etag={etag}
            onSaved={() => {
              setSettingsOpen(false);
              void detail.refetch();
            }}
            onReload={() => void detail.refetch()}
          />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete context schema?"
        description={`Soft-deletes "${schema.name}". Its published version history is kept — a context item stamped with one must resolve it forever.`}
        confirmLabel="Delete schema"
        destructive
        typeToConfirm={schema.name}
        onConfirm={handleDelete}
        isPending={deleteSchema.isPending}
      />
    </Tabs>
  );
}

export function ContextSchemaDetailScreen({ id }: { id: string }) {
  return (
    <WorkingTenantGate
      title="Context schema"
      description="Context schemas are administered per tenant. Pick a working tenant from the switcher in the top bar to load this schema."
    >
      <ContextSchemaDetailBody id={id} />
    </WorkingTenantGate>
  );
}
