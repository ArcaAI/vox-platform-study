'use client';

import { IconTrash } from '@tabler/icons-react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useTemplate } from '../api/hooks';
import { ApprovalPin, TemplateOriginBadge, TemplateStatusBadge } from './approval-pin';
import type { PromptTemplate, PromptTemplateCategory } from '../api/types';
import { CreateTemplateForm, EditTemplateForm } from './template-form-dialog';
import { TestRunPanel } from './test-run-panel';
import { VersionsPanel } from './version-diff-panel';

type AgentTab = 'overview' | 'versions' | 'test';

const AGENT_TABS = ['overview', 'versions', 'test'] as const;

const TAB_DEFS: { value: AgentTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'versions', label: 'Versions' },
  { value: 'test', label: 'Test run' },
];

const CATEGORY_LABELS: Record<PromptTemplateCategory, string> = {
  SYSTEM: 'System',
  SUMMARY: 'Summary',
  DNA_ANALYSIS: 'DNA analysis',
  CUSTOM: 'Custom',
};

/** Active detail tab in the URL (`?atab=`), shared by header list and body panels. */
function useAgentTab() {
  return useQueryState('atab', parseAsStringLiteral(AGENT_TABS).withDefault('overview'));
}

/**
 * Header status. The local badge this replaces collapsed everything that was
 * not DRAFT into "Published", so an APPROVED template read as "Published" in
 * the drawer while the grid (which uses these same two components) called it
 * "Approved" — and the header said nothing at all about the version clinical
 * resolution is actually pinned to.
 */
function StatusBadge({ template }: { template: PromptTemplate }) {
  return (
    <>
      <TemplateStatusBadge status={template.status} />
      <ApprovalPin template={template} />
    </>
  );
}

function AgentTabsList() {
  return (
    <TabsList variant="line">
      {TAB_DEFS.map((tab) => (
        <TabsTrigger key={tab.value} value={tab.value}>
          {tab.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

function AgentMeta({ template, departmentLabel }: { template: PromptTemplate; departmentLabel: string | null }) {
  return (
    <>
      <span className="font-mono">{template.id}</span>
      <CopyButton value={template.id} label="Copy template id" />
      <span aria-hidden>&middot;</span>
      <span>{CATEGORY_LABELS[template.category] ?? template.category}</span>
      <span aria-hidden>&middot;</span>
      <span>{departmentLabel ?? 'All departments'}</span>
      <span aria-hidden>&middot;</span>
      <span className="font-mono">v{template.currentVersionNumber} active</span>
      <span aria-hidden>&middot;</span>
      <span>Updated {formatDateTime(template.updatedAt)}</span>
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/**
 * Console-wide record detail for Agents & Prompt Templates — a right slide-over
 * (full-screen sheet on mobile). Overview (edit form, OCC) · Versions (activate /
 * diff) · Test run (OCC dry-run) tabs; create mode reuses the same surface with a
 * single create form. Retires the former create/edit modals (build spec
 */
export function AgentDetailDrawer({
  templateId,
  creating,
  departmentLabel,
  onOpenChange,
  onCreated,
  onRequestDelete,
}: {
  templateId: string | null;
  creating: boolean;
  departmentLabel: string | null;
  onOpenChange: (open: boolean) => void;
  onCreated: (template: PromptTemplate) => void;
  onRequestDelete: (template: PromptTemplate) => void;
}) {
  const open = creating || templateId !== null;
  const [tab, setTab] = useAgentTab();
  const detail = useTemplate(templateId ?? '');
  const template = templateId ? (detail.data?.data ?? null) : null;
  const etag = detail.data?.etag ?? null;

  // Create mode: a single form, no tabs, no detail read.
  if (creating) {
    return (
      <DetailDrawer open={open} onOpenChange={onOpenChange} size="lg" title="New prompt template">
        <CreateTemplateForm onCreated={onCreated} onCancel={() => onOpenChange(false)} />
      </DetailDrawer>
    );
  }

  return (
    <Tabs value={tab} onValueChange={(next) => void setTab(next as AgentTab)}>
      <DetailDrawer
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={template ? template.name : 'Template'}
        badges={
          template ? (
            <>
              <StatusBadge template={template} />
              <TemplateOriginBadge template={template} />
              <ResourceStatusBadge status={template.resourceStatus} />
            </>
          ) : null
        }
        meta={template ? <AgentMeta template={template} departmentLabel={departmentLabel} /> : null}
        tabs={template ? <AgentTabsList /> : null}
        footer={
          template ? (
            <Button variant="destructive" size="sm" onClick={() => onRequestDelete(template)}>
              <IconTrash aria-hidden />
              Delete
            </Button>
          ) : null
        }
      >
        {!open ? null : detail.isPending ? (
          <DetailSkeleton />
        ) : detail.error || !template ? (
          <ErrorState
            error={detail.error ?? new GatewayError(404, 'This template does not exist or is outside your access scope.')}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <>
            <TabsContent value="overview" className="mt-0 flex min-h-0 flex-1 flex-col">
              <EditTemplateForm
                key={`${template.id}-${template.updatedAt}`}
                template={template}
                etag={etag}
                onSaved={() => void detail.refetch()}
                onReload={() => void detail.refetch()}
              />
            </TabsContent>
            <TabsContent value="versions" className="mt-0">
              <VersionsPanel template={template} />
            </TabsContent>
            <TabsContent value="test" className="mt-0">
              <TestRunPanel template={template} />
            </TabsContent>
          </>
        )}
      </DetailDrawer>
    </Tabs>
  );
}
