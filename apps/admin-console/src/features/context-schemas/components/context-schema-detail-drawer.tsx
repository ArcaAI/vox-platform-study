'use client';

/**
 * `ConsultationContextSchema` detail drawer (TASK-666) — the console-wide
 * `DetailDrawer` hosting one schema. Tabs: Settings (metadata OCC PATCH) →
 * Definition (kind/output editor + publish) → Versions (history + pin) →
 * Tester (sample-payload tester against the in-progress draft).
 *
 * The Definition draft is lifted HERE (not owned by `DefinitionEditor`) so
 * the Tester tab validates against the exact same in-progress kinds/outputs
 * the admin is editing, not a stale published copy.
 */

import { useState } from 'react';
import { IconStar, IconTrash } from '@tabler/icons-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { ErrorState } from '@/shared/state/error-state';
import { useContextSchema, useContextSchemaVersions } from '../api/hooks';
import { emptyDefinition, type ConsultationContextSchema, type ContextSchemaDefinition } from '../api/types';
import { CreateSchemaForm } from './create-schema-form';
import { DefinitionEditor } from './definition-editor';
import { PayloadTester } from './payload-tester';
import { SettingsForm } from './settings-form';
import { VersionsPanel } from './versions-panel';

type ContextSchemaTab = 'settings' | 'definition' | 'versions' | 'tester';
const CONTEXT_SCHEMA_TABS = ['settings', 'definition', 'versions', 'tester'] as const;

function useContextSchemaTab() {
  return useQueryState('cstab', parseAsStringLiteral(CONTEXT_SCHEMA_TABS).withDefault('definition'));
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function latestDefinition(versions: { versionNumber: number; definition: ContextSchemaDefinition }[]): ContextSchemaDefinition {
  if (versions.length === 0) return emptyDefinition();
  return [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0].definition;
}

export function ContextSchemaDetailDrawer({
  schemaId,
  creating,
  onOpenChange,
  onCreated,
  onRequestDelete,
}: {
  schemaId: string | null;
  creating: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (schema: ConsultationContextSchema) => void;
  onRequestDelete: (schema: ConsultationContextSchema) => void;
}) {
  const open = creating || schemaId !== null;
  const [tab, setTab] = useContextSchemaTab();
  const detail = useContextSchema(schemaId ?? '');
  const versionsQuery = useContextSchemaVersions(schemaId ?? '');
  const schema = schemaId ? (detail.data?.data ?? null) : null;
  const etag = detail.data?.etag ?? null;
  const versions = versionsQuery.data ?? [];

  const [draft, setDraft] = useState<ContextSchemaDefinition>(emptyDefinition());

  // Re-seed the draft from the latest published version once per (schema,
  // first successful version load) — adjusted DURING RENDER rather than in
  // an effect (React's "adjusting state when a prop changes" pattern), so it
  // never fires twice for the same load. `versionsQuery.isSuccess` flips
  // false -> true exactly once per schema's query instance and then stays
  // true across background refetches, so this never clobbers in-progress
  // edits on an unrelated refetch (e.g. after `Save changes` on the Settings
  // tab) — only a genuine schema switch or the initial load reseeds.
  const seedKey = schemaId && versionsQuery.isSuccess ? schemaId : null;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seedKey && seedKey !== seededFor) {
    setSeededFor(seedKey);
    setDraft(latestDefinition(versions));
  }

  if (creating) {
    return (
      <DetailDrawer open={open} onOpenChange={onOpenChange} size="lg" title="New context schema">
        <CreateSchemaForm onCreated={onCreated} onCancel={() => onOpenChange(false)} />
      </DetailDrawer>
    );
  }

  return (
    <Tabs value={tab} onValueChange={(next) => void setTab(next as ContextSchemaTab)}>
      <DetailDrawer
        open={open}
        onOpenChange={onOpenChange}
        size="xl"
        title={schema ? schema.name : 'Context schema'}
        badges={
          schema ? (
            <>
              <Badge variant="outline">{schema.status}</Badge>
              {schema.isDefault ? (
                <Badge className="gap-1">
                  <IconStar aria-hidden className="size-3" />
                  Default
                </Badge>
              ) : null}
            </>
          ) : null
        }
        meta={
          schema ? (
            <>
              <span className="font-mono">{schema.id}</span>
              <CopyButton value={schema.id} label="Copy schema id" />
              <span aria-hidden>&middot;</span>
              <span className="font-mono">{schema.slug}</span>
              <span aria-hidden>&middot;</span>
              <span>{schema.pinnedVersionNumber != null ? `Pinned to v${schema.pinnedVersionNumber}` : 'No published version'}</span>
            </>
          ) : null
        }
        tabs={
          schema ? (
            <TabsList variant="line">
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="definition">Definition</TabsTrigger>
              <TabsTrigger value="versions">Versions ({versions.length})</TabsTrigger>
              <TabsTrigger value="tester">Tester</TabsTrigger>
            </TabsList>
          ) : null
        }
        footer={
          schema ? (
            <Button variant="destructive" size="sm" onClick={() => onRequestDelete(schema)}>
              <IconTrash aria-hidden />
              Delete
            </Button>
          ) : null
        }
      >
        {!open ? null : detail.isPending ? (
          <DetailSkeleton />
        ) : detail.error || !schema ? (
          <ErrorState
            error={detail.error ?? new GatewayError(404, 'This context schema does not exist or is outside your access scope.')}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <>
            <TabsContent value="settings" className="mt-0">
              <SettingsForm
                key={`${schema.id}-${schema.updatedAt}`}
                schema={schema}
                etag={etag}
                onSaved={() => void detail.refetch()}
                onReload={() => void detail.refetch()}
              />
            </TabsContent>
            <TabsContent value="definition" className="mt-0">
              <DefinitionEditor
                schemaId={schema.id}
                definition={draft}
                onDefinitionChange={setDraft}
                onPublished={() => {
                  void detail.refetch();
                  void versionsQuery.refetch();
                }}
              />
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
                }}
              />
            </TabsContent>
            <TabsContent value="tester" className="mt-0">
              <PayloadTester definition={draft} />
            </TabsContent>
          </>
        )}
      </DetailDrawer>
    </Tabs>
  );
}
