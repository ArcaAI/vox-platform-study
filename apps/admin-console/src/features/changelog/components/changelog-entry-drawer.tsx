'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { useChangelogEntryWithEtag, useCreateChangelogEntry, usePublishChangelogEntry, useUpdateChangelogEntry } from '../api/hooks';
import type { ChangelogAudience, ChangelogSeverity, CreateChangelogEntryRequest } from '../api/types';

const EMPTY_DRAFT: CreateChangelogEntryRequest = { platformVersion: '', title: '', summary: '', body: '', severity: 'INFO', audience: 'ALL' };

/**
 * Super-admin-only authoring surface — reuses `DetailDrawer` (never a bespoke
 * modal, per `11-ux-ui-principles.md`). Publish goes through If-Match/ETag OCC
 * (428 missing header, 412 drift), surfaced as toasts via GatewayError.
 */
export function ChangelogEntryDrawer({ open, onOpenChange, entryId }: { open: boolean; onOpenChange: (open: boolean) => void; entryId: string | null }) {
  const isEditing = Boolean(entryId);
  const { data: existing, isLoading } = useChangelogEntryWithEtag(entryId);
  const [draft, setDraft] = useState<CreateChangelogEntryRequest>(EMPTY_DRAFT);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);

  const create = useCreateChangelogEntry();
  const update = useUpdateChangelogEntry();
  const publish = usePublishChangelogEntry();

  // Render-time derived-state hydration (no effect) — sync the form once per entry load.
  if (existing && hydratedFor !== existing.data.id) {
    setHydratedFor(existing.data.id);
    setDraft({
      platformVersion: existing.data.platformVersion,
      title: existing.data.title,
      summary: existing.data.summary,
      body: existing.data.body,
      severity: existing.data.severity,
      audience: existing.data.audience,
    });
  }
  if (!isEditing && hydratedFor !== null) {
    setHydratedFor(null);
    setDraft(EMPTY_DRAFT);
  }

  async function handleSave() {
    try {
      if (isEditing && entryId && existing?.etag) {
        await update.mutateAsync({ id: entryId, body: draft, etag: existing.etag });
        toast.success('Entry saved');
      } else {
        await create.mutateAsync(draft);
        toast.success('Draft created');
        onOpenChange(false);
      }
    } catch (error) {
      if (error instanceof GatewayError && error.isVersionConflict) {
        toast.error('This entry changed elsewhere — reload and reapply your edits.');
      } else if (error instanceof GatewayError && error.isMissingPrecondition) {
        toast.error('Missing precondition — please retry.');
      } else {
        toast.error('Failed to save the entry');
      }
    }
  }

  async function handlePublish() {
    if (!entryId || !existing?.etag) return;
    try {
      await publish.mutateAsync({ id: entryId, etag: existing.etag });
      toast.success('Published');
    } catch (error) {
      if (error instanceof GatewayError && error.isVersionConflict) {
        toast.error('This entry changed elsewhere — reload before publishing.');
      } else if (error instanceof GatewayError && error.status === 409) {
        toast.error('Already published');
      } else {
        toast.error('Failed to publish');
      }
    }
  }

  const isDraft = existing?.data.publishStatus === 'DRAFT';
  const saving = create.isPending || update.isPending;

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={isEditing ? existing?.data.title || 'Edit entry' : 'New changelog entry'}
      badges={isEditing && existing ? <Badge variant={isDraft ? 'outline' : 'secondary'}>{existing.data.publishStatus}</Badge> : undefined}
      size="lg"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          {isEditing && isDraft ? (
            <Button type="button" variant="secondary" onClick={handlePublish} disabled={publish.isPending}>
              {publish.isPending ? <Spinner className="mr-2 size-4" /> : null}
              Publish
            </Button>
          ) : null}
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? <Spinner className="mr-2 size-4" /> : null}
            Save
          </Button>
        </div>
      }
    >
      {isLoading && isEditing ? (
        // Rule 10: the skeleton mirrors the loaded form — three label+input
        // pairs, the severity/audience row, then the flex-1 markdown body.
        <div aria-hidden="true" className="flex flex-col gap-4">
          {[0, 1, 2].map((field) => (
            <div key={field} className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
          <div className="flex flex-wrap gap-4">
            {[0, 1].map((field) => (
              <div key={field} className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="min-h-[240px] w-full flex-1" />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="changelog-version">Platform version *</Label>
            <Input
              id="changelog-version"
              value={draft.platformVersion}
              onChange={(event) => setDraft((prev) => ({ ...prev, platformVersion: event.target.value }))}
              placeholder="2.1.0"
              disabled={isEditing}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="changelog-title">Title *</Label>
            <Input id="changelog-title" value={draft.title} onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="changelog-summary">Summary *</Label>
            <Input id="changelog-summary" value={draft.summary} onChange={(event) => setDraft((prev) => ({ ...prev, summary: event.target.value }))} />
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="changelog-severity">Severity</Label>
              <Select value={draft.severity} onValueChange={(value) => setDraft((prev) => ({ ...prev, severity: value as ChangelogSeverity }))}>
                <SelectTrigger id="changelog-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="INFO">Info</SelectItem>
                  <SelectItem value="IMPORTANT">Important</SelectItem>
                  <SelectItem value="BREAKING">Breaking</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="changelog-audience">Audience</Label>
              <Select value={draft.audience} onValueChange={(value) => setDraft((prev) => ({ ...prev, audience: value as ChangelogAudience }))}>
                <SelectTrigger id="changelog-audience">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All</SelectItem>
                  <SelectItem value="SUPER_ADMIN">Super admin</SelectItem>
                  <SelectItem value="TENANT_ADMIN">Tenant admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="changelog-body">Body (markdown) *</Label>
            <Textarea
              id="changelog-body"
              className="min-h-[240px] flex-1 resize-none"
              value={draft.body}
              onChange={(event) => setDraft((prev) => ({ ...prev, body: event.target.value }))}
            />
          </div>
        </div>
      )}
    </DetailDrawer>
  );
}
