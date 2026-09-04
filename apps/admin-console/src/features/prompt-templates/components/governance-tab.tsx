'use client';

/**
 * Governance tab — prompt approval, versions and diffs.
 *
 * Folded in from the retired `/prompt-studio` screen.
 * Prompt governance was split across two routes that hit the SAME backend
 * (`admin/prompt-templates`) — `/agents` owned CRUD + versions + diff, while
 * `/prompt-studio` added only the approve write on top of a second copy of the
 * same list. `/agents` is now the single authoritative surface; `/prompt-studio`
 * redirects here for one release.
 *
 * TIER NOTE: `/prompt-studio` sat in tier 10-19 but was `WorkingTenantGate`d
 * and read per-tenant data (a super-admin-only screen over per-tenant
 * data). Moving to `/agents` (tier 30-49) is therefore behaviour-neutral —
 * both require a working tenant, and both gate the tab itself on an
 * elevated session. Approve authority is NOT a console concern: the service
 * raises a SUPER_ADMIN 403 no matter which surface calls it, so hiding the
 * tab is convenience, never the boundary.
 */

import { useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { IconCircleCheck, IconFileText, IconFlask, IconPlayerPlay, IconSearch } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { formatDateTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useAgentEvalRuns, useApproveTemplate, useEvalGoldenSets, useRunGoldenSetEval, useTemplate, useTemplates } from '../api';
import type { PromptTemplate, PromptTemplateStatus } from '../api';
import { ApprovalPin, TemplateStatusBadge, statusVariant } from './approval-pin';
import { VersionsPanel } from './versions-panel';

/** Governance-focused list: filter by approval status, select to inspect. */
function GovernanceList({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | PromptTemplateStatus>('');
  const query = useTemplates({
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(status ? { status } : {}),
    limit: 50,
  });

  return (
    <Card className="flex min-h-0 flex-col gap-3 p-3 lg:h-full">
      <div className="flex flex-col gap-2">
        <div className="relative">
          <IconSearch aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
          <Input
            aria-label="Search templates"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={'Search templates…'}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <NativeSelect
          aria-label="Filter by status"
          value={status}
          onChange={(event) => setStatus(event.target.value as '' | PromptTemplateStatus)}
          className="h-8 text-xs"
        >
          <NativeSelectOption value="">All statuses</NativeSelectOption>
          <NativeSelectOption value="DRAFT">Draft</NativeSelectOption>
          <NativeSelectOption value="PUBLISHED">Published</NativeSelectOption>
          <NativeSelectOption value="APPROVED">Approved</NativeSelectOption>
        </NativeSelect>
      </div>

      {query.isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.data.length === 0 ? (
        <EmptyState icon={IconFileText} title="No templates" description="No prompt templates match the current filters." />
      ) : (
        <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
          {query.data.data.map((template) => (
            <li key={template.id}>
              <button
                type="button"
                onClick={() => onSelect(template.id)}
                aria-current={template.id === selectedId}
                className="hover:bg-muted aria-[current=true]:bg-muted flex w-full cursor-pointer flex-col items-start gap-1 rounded-md p-2 text-left"
              >
                <span className="truncate text-sm font-medium">{template.name}</span>
                <span className="flex items-center gap-2">
                  <Badge variant={statusVariant(template.status)}>{template.status}</Badge>
                  <ApprovalPin template={template} />
                  <span className="text-muted-foreground font-mono text-xs">v{template.version}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function evalRunStatusVariant(status: string | null): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'COMPLETED') return 'default';
  if (status === 'FAILED') return 'destructive';
  return 'outline';
}

/** How the run was triggered (EvalRun.triggerType) — MANUAL (run-now) | PROMOTION (approve/pin gate) | CI. */
function triggerTypeVariant(triggerType: string | null): 'default' | 'secondary' | 'outline' {
  if (triggerType === 'PROMOTION') return 'default';
  if (triggerType === 'CI') return 'secondary';
  return 'outline';
}

/** Compact `metric: value` badges from the free-form `aggregateScores` JSON. */
function AggregateScoreBadges({ aggregates }: { aggregates: unknown }) {
  if (!aggregates || typeof aggregates !== 'object' || Array.isArray(aggregates)) return null;
  const entries = Object.entries(aggregates as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  if (entries.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([key, value]) => (
        <Badge key={key} variant="outline" className="font-mono text-xs">
          {key}: {Math.round(value * 100) / 100}
        </Badge>
      ))}
    </span>
  );
}

/**
 * Eval gate panel — a golden-set picker, the last runs + scores for the picked
 * set, and a manual run-now. Independent of the promotion gate that runs
 * automatically on Approve; running it here just lets an admin check the gate
 * before approving. Golden-set CRUD and the full eval-runs grid stay on
 * `/harness/observability` (one authoritative editor per resource, rule 13) —
 * this panel only reads + triggers runs.
 *
 * ## What changed here
 *
 * The picker used to default to the golden set attached to a `DepartmentAgent`
 * bound to this template, and it annotated each set with the agents holding it.
 * OD-11 moved that binding onto the WORKFLOW NODE that references the template
 * (`config.evalGate`), so there is no per-template agent list to read and the
 * picker no longer pre-selects. The binding an admin actually edits lives in
 * the Workflow Studio node inspector, and the gate that fires on Approve reads
 * it from there — this panel is, and always was, the manual check.
 */
function EvalPanel({ template: _template }: { template: PromptTemplate }) {
  const goldenSetsQuery = useEvalGoldenSets({ limit: 200 });
  const [picked, setPicked] = useState('');

  const goldenSetId = picked;
  const goldenSets = goldenSetsQuery.data?.items ?? [];

  const runsQuery = useAgentEvalRuns(goldenSetId || null, 5);
  const runEval = useRunGoldenSetEval();

  function handleRun() {
    if (!goldenSetId) return;
    runEval.mutate(goldenSetId, {
      onSuccess: (result) => {
        if (result.passed) toast.success(`Eval passed — run ${result.runId.slice(0, 8)}`);
        else toast.error(`Eval gate failed: ${result.failures[0] ?? 'regression detected'}`);
      },
      onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not run the eval.'),
    });
  }

  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Eval gate</h3>
        <p className="text-muted-foreground text-xs">
          Golden-set evaluation for this template. Approving runs this automatically when a workflow node that binds this template carries an enabled
          eval gate &mdash; run it manually here to check first.
        </p>
      </div>

      {goldenSetsQuery.isPending ? (
        <Skeleton className="h-8 w-full" />
      ) : goldenSets.length === 0 ? (
        <EmptyState
          icon={IconFlask}
          title="No golden sets yet"
          description="Create one on the Harness Observability board, then bind it to a workflow node's eval gate in Workflow Studio."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <NativeSelect
              aria-label="Golden set"
              value={goldenSetId}
              onChange={(event) => setPicked(event.target.value)}
              className="h-8 flex-1 text-sm"
            >
              <NativeSelectOption value="">Select a golden set…</NativeSelectOption>
              {goldenSets.map((set) => (
                <NativeSelectOption key={set.id} value={set.id}>
                  {set.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button type="button" size="sm" onClick={handleRun} disabled={!goldenSetId || runEval.isPending}>
              {runEval.isPending ? <Spinner aria-hidden /> : <IconPlayerPlay aria-hidden />}
              Run now
            </Button>
          </div>
          {goldenSetId ? (
            <p className="text-muted-foreground text-xs">
              Running here does not gate promotion &mdash; the gate that blocks an approval is the one bound on a workflow node.
            </p>
          ) : null}

          {!goldenSetId ? null : runsQuery.isPending ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 2 }, (_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : runsQuery.error ? (
            <ErrorState error={runsQuery.error} onRetry={() => void runsQuery.refetch()} />
          ) : (runsQuery.data?.items.length ?? 0) === 0 ? (
            <p className="text-muted-foreground text-sm">No eval runs yet for this golden set.</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Recent eval runs">
              {runsQuery.data?.items.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-2">
                  <span className="flex items-center gap-2">
                    <Badge variant={evalRunStatusVariant(run.status)}>{run.status ?? 'UNKNOWN'}</Badge>
                    {run.triggerType ? <Badge variant={triggerTypeVariant(run.triggerType)}>{run.triggerType}</Badge> : null}
                    <span className="text-muted-foreground text-xs">{formatDateTime(run.startedAt ?? run.createdAt)}</span>
                  </span>
                  <AggregateScoreBadges aggregates={run.aggregateScores} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <Link href="/harness/observability" className="text-foreground text-xs underline-offset-4 hover:underline">
        Manage golden sets on the Harness Observability board &rarr;
      </Link>
    </Card>
  );
}

/** The approve write itself — OCC via If-Match folded from the detail ETag. */
function ApprovePanel({ template, etag }: { template: PromptTemplate; etag: string | null }) {
  const uid = useId();
  const approve = useApproveTemplate();
  const [reason, setReason] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!etag) return;
    approve.mutate(
      { id: template.id, reason: reason.trim() || undefined, etag },
      {
        onSuccess: () => {
          toast.success(`"${template.name}" approved for clinical use`);
          setReason('');
        },
        onError: (error) => {
          // OCC conflicts render the inline reload-merge alert instead.
          if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
          toast.error(error instanceof GatewayError ? error.message : 'Could not approve the template.');
        },
      },
    );
  }

  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Governance approval</h3>
        <p className="text-muted-foreground text-sm">
          Approves the current version for clinical flows &mdash; <span className="font-mono text-xs">POST :id/approve</span> with If-Match; pins a
          PromptVersion snapshot and writes a WORM change row. Until this runs, resolution keeps serving the previously pinned version.
        </p>
        <p className="text-muted-foreground text-xs">
          A tenant-owned template needs <span className="font-mono">manage:PromptTemplate</span> for its tenant; SYSTEM/library templates stay
          SUPER_ADMIN-only. Either way the gate is server-side.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-reason`} className="text-muted-foreground text-xs font-medium">
            Approval reason
          </Label>
          <Input
            id={`${uid}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder={'Why this template is cleared…'}
          />
        </div>
        <OccConflictAlert error={approve.error} onReload={() => approve.reset()} />
        <div className="flex justify-end">
          <Button type="submit" disabled={!etag || approve.isPending}>
            {approve.isPending ? <Spinner /> : <IconCircleCheck aria-hidden />}
            Approve for clinical use
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Right pane: metadata header, version history/diff, then the approval panel. */
function TemplateGovernanceDetail({ id }: { id: string }) {
  const query = useTemplate(id);

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const template = query.data.data;

  return (
    <div className="flex flex-col gap-3">
      <Card className="gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{template.name}</h3>
          <span className="flex items-center gap-2">
            <TemplateStatusBadge status={template.status} />
            {/* Which PromptVersion the approval is pinned to — what
                resolution actually serves, not the current content row. */}
            <ApprovalPin template={template} />
          </span>
        </div>
        <p className="text-muted-foreground text-xs">
          <span className="font-mono">row v{template.version}</span>
          {template.updatedAt ? <> &middot; updated {formatDateTime(template.updatedAt)}</> : null}
        </p>
      </Card>
      <VersionsPanel template={template} />
      <EvalPanel template={template} />
      <ApprovePanel template={template} etag={query.data.etag} />
    </div>
  );
}

/**
 * The tab body. Rendered only for elevated sessions (the caller owns that
 * check) — the server is still the authority on who may approve.
 */
export function GovernanceTab() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <section className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium">Prompt governance</h2>
        <p className="text-muted-foreground text-sm">
          Version history, field-level diffs and clinical approval for this tenant&apos;s prompt templates.
        </p>
      </div>
      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <GovernanceList selectedId={selectedId} onSelect={setSelectedId} />
        {selectedId ? (
          <TemplateGovernanceDetail id={selectedId} />
        ) : (
          <EmptyState
            icon={IconFileText}
            title="Select a template"
            description="Choose a prompt template to inspect its versions, diffs and approval state."
          />
        )}
      </div>
    </section>
  );
}
