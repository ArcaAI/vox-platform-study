'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { IconAlertTriangle, IconDownload, IconGitBranch, IconPlayerPlay, IconRocket, IconShieldCheck, IconTrash } from '@tabler/icons-react';
import { AGENT_TAG_PATTERN } from '@arcaai/workflow-contract';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError, postJson } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import {
  AGENT_TASK_LABEL,
  useAgent,
  useAgentAssignments,
  useAgentVersions,
  useDeleteAgent,
  useDeprecateAgent,
  useExportAgent,
  useNewAgentVersion,
  usePublishAgent,
  useUpdateAgent,
  useUpsertAgentAssignment,
  useValidateAgent,
  type Agent,
  type AgentProblemBody,
} from '../api';
import { AgentOwnerBadge, AgentStatusBadge, AgentTaskBadge, isPlatformAgent } from './agent-status-badge';
import { JsonField } from './json-field';
import { ParametersForm } from './parameters-form';

/** Surfaces the gateway's coded finding when there is one — shared with the list screen's import action. */
export function problemToast(error: unknown, fallback: string): void {
  if (error instanceof GatewayError) {
    const body = error.details as AgentProblemBody | undefined;
    const first = body?.findings?.find((finding) => finding.severity === 'ERROR');
    toast.error(first ? `${first.code}: ${first.message}` : error.message);
    return;
  }
  toast.error(fallback);
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{label}</h3>
      <pre className="bg-muted max-h-64 overflow-auto rounded-md p-3 font-mono text-xs">{value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

function FindingsList({ agent }: { agent: Agent }) {
  const report = agent.validationReport;
  if (!report) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Validation findings">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {report.blocking ? <IconAlertTriangle aria-hidden className="text-destructive size-4" /> : <IconShieldCheck aria-hidden className="text-success size-4" />}
        {report.blocking ? 'Blocking findings' : 'Validated'} · {formatDateTime(report.checkedAt)}
      </h3>
      {report.findings.length === 0 ? (
        <p className="text-muted-foreground text-sm">No findings.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {report.findings.map((finding, index) => (
            <li key={`${finding.path}-${index}`} className="flex items-start gap-2 text-sm">
              <Badge variant={finding.severity === 'ERROR' ? 'destructive' : 'secondary'}>{finding.code}</Badge>
              <span>
                <span className="font-mono text-xs">{finding.path}</span> — {finding.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Overview · Configuration · Versions · Test run · Usage (TASK-863 §3.6). */
export function AgentDetailDrawer({ agentId, onOpenChange, onSelect }: { agentId: string | null; onOpenChange: (open: boolean) => void; onSelect: (id: string) => void }) {
  const detail = useAgent(agentId);
  const agent = detail.data?.data ?? null;
  const etag = detail.data?.etag ?? null;
  const versions = useAgentVersions(agentId);
  const assignments = useAgentAssignments(agent?.task);
  const validate = useValidateAgent();
  const publish = usePublishAgent();
  const deprecate = useDeprecateAgent();
  const remove = useDeleteAgent();
  const branch = useNewAgentVersion();
  const update = useUpdateAgent();
  const upsertAssignment = useUpsertAgentAssignment();
  const exportAgent = useExportAgent();
  const [confirm, setConfirm] = useState<'deprecate' | 'delete' | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ name: string; description: string; parameters: Record<string, unknown>; inputSchema: Record<string, unknown> | null; outputSchema: Record<string, unknown> | null } | null>(null);
  // TASK-884 — the assignment tier this section writes. Empty = the tenant's UNQUALIFIED
  // default (what the section always wrote); a `key:value` list addresses the tag-qualified
  // row of the same tier instead, which the cascade tries first for a request carrying them.
  const [selectorInput, setSelectorInput] = useState('');
  const [testInput, setTestInput] = useState('');
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const isPlatform = agent ? isPlatformAgent(agent.tenantId) : false;
  const mutable = !!agent && !isPlatform && (agent.status === 'DRAFT' || agent.status === 'VALIDATED');
  const selectorTags = useMemo(
    () => [...new Set(selectorInput.split(',').map((tag) => tag.trim()).filter(Boolean))].sort(),
    [selectorInput],
  );
  const selectorProblem = selectorTags.find((tag) => !AGENT_TAG_PATTERN.test(tag));
  const selectorKey = selectorTags.join(',');
  // The row this section targets is the one whose SELECTOR matches — the selector is part of an
  // assignment's identity, so an empty box means the unqualified row, not "any row".
  const tenantDefault = useMemo(
    () =>
      (assignments.data ?? []).find(
        (row) => row.scope === 'TENANT' && !isPlatformAgent(row.tenantId) && [...(row.selectorTags ?? [])].sort().join(',') === selectorKey,
      ),
    [assignments.data, selectorKey],
  );
  const isTenantDefault = !!agent && tenantDefault?.agentSlug === agent.slug;

  async function run(action: () => Promise<Agent>, success: string, fallback: string) {
    try {
      const result = await action();
      toast.success(success);
      return result;
    } catch (error) {
      problemToast(error, fallback);
      return null;
    }
  }

  async function saveDraft() {
    if (!agent || !draft || !etag) return;
    try {
      await update.mutateAsync({
        id: agent.id,
        etag,
        patch: {
          name: draft.name,
          description: draft.description,
          parameters: draft.parameters,
          ...(draft.inputSchema ? { inputSchema: draft.inputSchema } : {}),
          ...(draft.outputSchema ? { outputSchema: draft.outputSchema } : {}),
        },
      });
      toast.success('Draft saved');
      setEditing(false);
    } catch (error) {
      problemToast(error, 'Could not save the draft.');
    }
  }

  async function setAsTenantDefault() {
    if (!agent) return;
    try {
      await upsertAssignment.mutateAsync({
        body: {
          scope: 'TENANT',
          task: agent.task,
          agentSlug: agent.slug,
          ...(selectorTags.length ? { selectorTags } : {}),
          reason: `Set from the Agents screen (${agent.slug} v${agent.versionNumber})`,
        },
        ...(tenantDefault ? { etag: `"${tenantDefault.version}"` } : {}),
      });
      toast.success(
        selectorTags.length
          ? `${agent.name} now serves ${AGENT_TASK_LABEL[agent.task].toLowerCase()} for ${selectorTags.join(' + ')}`
          : `${agent.name} is now the tenant default for ${AGENT_TASK_LABEL[agent.task].toLowerCase()}`,
      );
    } catch (error) {
      problemToast(error, 'Could not update the assignment.');
    }
  }

  /**
   * Download the bundle the gateway produced. The viewer's browser does the saving; nothing is
   * re-serialised here, so the file is byte-for-byte what `GET :slug/export` returned.
   */
  async function downloadBundle() {
    if (!agent) return;
    try {
      const bundle = await exportAgent.mutateAsync({ slug: agent.slug, versionNumber: agent.versionNumber });
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `agent-${agent.slug}-v${agent.versionNumber}.json`;
      link.click();
      URL.revokeObjectURL(url);
      const notes = (bundle.payload.notes ?? []).length;
      toast.success(notes ? `Exported ${agent.slug} v${agent.versionNumber} — ${notes} note(s) in the bundle about what was not carried.` : `Exported ${agent.slug} v${agent.versionNumber}`);
    } catch (error) {
      problemToast(error, 'Could not export this agent.');
    }
  }

  async function testRun() {
    if (!agent) return;
    setTesting(true);
    setTestOutput(null);
    try {
      const result = await postJson<{ output: { text: string } }>(`agents/${encodeURIComponent(agent.slug)}/invocations`, { text: testInput }, { mode: 'blocking' });
      setTestOutput(result.output.text);
    } catch (error) {
      problemToast(error, 'The test run failed.');
    } finally {
      setTesting(false);
    }
  }

  const busy = validate.isPending || publish.isPending || deprecate.isPending || remove.isPending || branch.isPending;

  return (
    <Tabs defaultValue="overview">
      <DetailDrawer
        open={!!agentId}
        onOpenChange={onOpenChange}
        size="lg"
        title={agent ? agent.name : <Skeleton className="h-6 w-48" />}
        badges={
          agent ? (
            <>
              <AgentTaskBadge task={agent.task} />
              <AgentStatusBadge status={agent.status} isActive={agent.isActive} />
              <AgentOwnerBadge tenantId={agent.tenantId} />
              {isTenantDefault ? <Badge variant="secondary">Tenant default</Badge> : null}
            </>
          ) : null
        }
        meta={
          agent ? (
            <span className="font-mono text-xs">
              {agent.slug} · v{agent.versionNumber} · {agent.modelSlug ?? agent.modelId}
            </span>
          ) : null
        }
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="configuration">Configuration</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
            <TabsTrigger value="test">Test run</TabsTrigger>
            <TabsTrigger value="usage">Usage</TabsTrigger>
          </TabsList>
        }
        footer={
          agent ? (
            <div className="flex w-full flex-wrap items-center justify-end gap-2">
              {mutable ? (
                <>
                  <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => validate.mutateAsync(agent.id), 'Validation complete', 'Validation failed.')}>
                    {validate.isPending ? <Spinner /> : <IconShieldCheck aria-hidden className="size-4" />}
                    Validate
                  </Button>
                  <Button type="button" disabled={busy} onClick={() => void run(() => publish.mutateAsync({ id: agent.id, body: { activate: true } }), 'Agent published', 'Publish failed.')}>
                    {publish.isPending ? <Spinner /> : <IconRocket aria-hidden className="size-4" />}
                    Publish
                  </Button>
                </>
              ) : null}
              {!isPlatform && agent.status === 'PUBLISHED' ? (
                <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm('deprecate')}>
                  Deprecate
                </Button>
              ) : null}
              <Button type="button" variant="outline" disabled={busy || exportAgent.isPending} onClick={() => void downloadBundle()}>
                {exportAgent.isPending ? <Spinner /> : <IconDownload aria-hidden className="size-4" />}
                Export
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(() => branch.mutateAsync({ id: agent.id }), isPlatform ? 'Branched into a tenant draft' : 'New draft version created', 'Could not branch a new version.').then((created) => {
                    if (created) onSelect(created.id);
                  })
                }
              >
                {branch.isPending ? <Spinner /> : <IconGitBranch aria-hidden className="size-4" />}
                {isPlatform ? 'Branch as my agent' : 'New version'}
              </Button>
              {!isPlatform && !agent.isActive ? (
                <Button type="button" variant="destructive" disabled={busy} onClick={() => setConfirm('delete')} aria-label="Delete this version">
                  <IconTrash aria-hidden className="size-4" />
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {!agent ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <>
            <TabsContent value="overview" className="flex flex-col gap-4">
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Task</dt>
                <dd>{AGENT_TASK_LABEL[agent.task]}</dd>
                <dt className="text-muted-foreground">Model</dt>
                <dd className="font-mono">{agent.modelSlug ?? agent.modelId}</dd>
                <dt className="text-muted-foreground">Fallbacks</dt>
                <dd className="font-mono">{agent.fallbacks.length ? agent.fallbacks.map((fallback) => fallback.modelSlug ?? fallback.modelId).join(' → ') : '—'}</dd>
                <dt className="text-muted-foreground">Description</dt>
                <dd>{agent.description ?? '—'}</dd>
                <dt className="text-muted-foreground">Published</dt>
                <dd>{agent.publishedAt ? formatDateTime(agent.publishedAt) : '—'}</dd>
                <dt className="text-muted-foreground">Updated</dt>
                <dd>{formatDateTime(agent.updatedAt)}</dd>
                <dt className="text-muted-foreground">Checksum</dt>
                <dd className="font-mono text-xs">{agent.compiledConfigChecksum ?? '—'}</dd>
              </dl>
              <FindingsList agent={agent} />
              {agent.status === 'PUBLISHED' && agent.isActive ? (
                <section className="flex flex-col gap-3 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col text-sm">
                      <span className="font-medium">
                        {selectorTags.length ? `Assignment for ${selectorTags.join(' + ')}` : `Tenant default for ${AGENT_TASK_LABEL[agent.task].toLowerCase()}`}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {tenantDefault ? `Currently ${tenantDefault.agentSlug}` : selectorTags.length ? 'Not assigned — requests fall back to the unqualified assignment' : 'Currently the platform default'}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isTenantDefault || upsertAssignment.isPending || !!selectorProblem}
                      onClick={() => void setAsTenantDefault()}
                    >
                      {upsertAssignment.isPending ? <Spinner /> : null}
                      {isTenantDefault ? 'Is assigned' : selectorTags.length ? 'Assign for these tags' : 'Set as tenant default'}
                    </Button>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="assignment-selector">Tag selector (optional)</Label>
                    <Input
                      id="assignment-selector"
                      value={selectorInput}
                      onChange={(event) => setSelectorInput(event.target.value)}
                      placeholder="specialty:rheumatology, lang:ml"
                      aria-describedby="assignment-selector-hint"
                      aria-invalid={!!selectorProblem}
                    />
                    <p id="assignment-selector-hint" className={selectorProblem ? 'text-destructive text-sm' : 'text-muted-foreground text-xs'}>
                      {selectorProblem
                        ? `“${selectorProblem}” is not a key:value tag — write it as key:value (for example specialty:${selectorProblem.toLowerCase()}).`
                        : 'Comma-separated key:value tags. Leave empty for the tier’s default assignment; a tag-qualified one is matched first for requests carrying those tags.'}
                    </p>
                  </div>
                </section>
              ) : null}
            </TabsContent>

            <TabsContent value="configuration" className="flex flex-col gap-4">
              {mutable && !editing ? (
                <Button
                  type="button"
                  variant="outline"
                  className="self-start"
                  onClick={() => {
                    setDraft({ name: agent.name, description: agent.description ?? '', parameters: agent.parameters ?? {}, inputSchema: agent.inputSchema, outputSchema: agent.outputSchema });
                    setEditing(true);
                  }}
                >
                  Edit draft
                </Button>
              ) : null}
              {editing && draft ? (
                <form
                  className="flex flex-col gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveDraft();
                  }}
                >
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="edit-name">
                      Name <span aria-hidden>*</span>
                    </Label>
                    <Input id="edit-name" required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="edit-description">Description</Label>
                    <Textarea id="edit-description" rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
                  </div>
                  <ParametersForm task={agent.task} value={draft.parameters} onChange={(parameters) => setDraft({ ...draft, parameters })} />
                  <JsonField label="Input schema" value={draft.inputSchema} onChange={(inputSchema) => setDraft({ ...draft, inputSchema })} />
                  <JsonField label="Output schema" value={draft.outputSchema} onChange={(outputSchema) => setDraft({ ...draft, outputSchema })} />
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={update.isPending}>
                      {update.isPending ? <Spinner /> : null}
                      Save draft
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <JsonBlock label="Instruction" value={agent.instruction} />
                  <JsonBlock label="Parameters" value={agent.parameters} />
                  <JsonBlock label="Input schema" value={agent.inputSchema ?? 'task default'} />
                  <JsonBlock label="Output schema" value={agent.outputSchema ?? 'task default'} />
                  {agent.tools?.length ? <JsonBlock label="Tools" value={agent.tools} /> : null}
                  {agent.compiledConfig ? <JsonBlock label="Compiled config (server-stamped at publish)" value={agent.compiledConfig} /> : null}
                </>
              )}
            </TabsContent>

            <TabsContent value="versions">
              {versions.isPending ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : (
                <ul className="flex flex-col divide-y" aria-label={`Versions (${versions.data?.length ?? 0})`}>
                  {(versions.data ?? []).map((version) => (
                    <li key={version.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <button type="button" className="hover:underline focus-visible:ring-ring rounded text-left focus-visible:ring-2 focus-visible:outline-none" onClick={() => onSelect(version.id)} aria-current={version.id === agent.id ? 'true' : undefined}>
                        v{version.versionNumber} · {version.name}
                      </button>
                      <span className="flex items-center gap-2">
                        <AgentStatusBadge status={version.status} isActive={version.isActive} />
                        <span className="text-muted-foreground text-xs">{formatDateTime(version.updatedAt)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>

            <TabsContent value="test" className="flex flex-col gap-3">
              {agent.task === 'TEXT_GENERATION' && agent.status === 'PUBLISHED' && agent.isActive ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="test-input">Input text</Label>
                    <Textarea id="test-input" rows={5} value={testInput} onChange={(event) => setTestInput(event.target.value)} />
                  </div>
                  <Button type="button" className="self-start" disabled={testing || testInput.trim().length === 0} onClick={() => void testRun()}>
                    {testing ? <Spinner /> : <IconPlayerPlay aria-hidden className="size-4" />}
                    Run
                  </Button>
                  {testOutput !== null ? <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{testOutput}</pre> : null}
                </>
              ) : (
                <EmptyState
                  icon={IconPlayerPlay}
                  title="Test run"
                  description={
                    agent.task !== 'TEXT_GENERATION'
                      ? 'Direct test runs cover text-generation agents; speech and transcription agents are exercised from the Playground.'
                      : 'Publish and activate this version to run it through POST /agents/{slug}/invocations.'
                  }
                />
              )}
            </TabsContent>

            <TabsContent value="usage">
              <EmptyState icon={IconRocket} title="Usage" description="Per-agent usage attribution arrives with the AI usage ledger's agent dimension; runs are visible under AI Operations." />
            </TabsContent>
          </>
        )}
      </DetailDrawer>

      <ConfirmDialog
        open={confirm === 'deprecate'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Deprecate this version?"
        description="It stops being served for new calls and stays immutable. Publish another version to serve the slug again."
        confirmLabel="Deprecate"
        destructive
        isPending={deprecate.isPending}
        onConfirm={() => {
          if (!agent) return;
          void run(() => deprecate.mutateAsync(agent.id), 'Agent version deprecated', 'Could not deprecate.').then(() => setConfirm(null));
        }}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Delete this version?"
        description="The version is soft-deleted. The active published version of a slug cannot be deleted — deprecate it first."
        confirmLabel="Delete"
        destructive
        isPending={remove.isPending}
        onConfirm={() => {
          if (!agent) return;
          void run(() => remove.mutateAsync(agent.id), 'Agent version deleted', 'Could not delete.').then((deleted) => {
            setConfirm(null);
            if (deleted) onOpenChange(false);
          });
        }}
      />
    </Tabs>
  );
}
