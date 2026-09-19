'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  IconAlertTriangle,
  IconArrowsDiff,
  IconArchive,
  IconDownload,
  IconGitBranch,
  IconPlayerPlay,
  IconPlayerPlayFilled,
  IconRocket,
  IconShieldCheck,
  IconTrash,
} from '@tabler/icons-react';
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
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { EmptyState } from '@/shared/state/empty-state';
import {
  ActivateVersionDialog,
  ActiveBadge,
  AssignmentBadges,
  DeprecateVersionDialog,
  DiscardDraftDialog,
  IntegrationPanel,
  OriginBadge,
  VersionCompareDialog,
  VersionHistoryPanel,
  type VersionRow,
  type VersionRowAction,
} from '@/shared/versioning';
import {
  AGENT_TASK_LABEL,
  instructionForm,
  readFragments,
  useActivateAgent,
  useAgent,
  useAgentAssignments,
  useAgentLineageBySlug,
  useAgentLineageVersions,
  useDeleteAgent,
  useDeprecateAgent,
  useDepartments,
  useExportAgent,
  useNewAgentVersion,
  usePublishAgent,
  useRemoveAgentAssignment,
  useUpdateAgent,
  useUpsertAgentAssignment,
  useValidateAgent,
  type Agent,
  type AgentAssignment,
  type AgentLineage,
  type AgentProblemBody,
  type PromptFragment,
} from '../api';
import { AgentHiddenBadge, AgentTaskBadge } from './agent-status-badge';
import { AgentPublishDialog } from './agent-publish-dialog';
import { DraftTestPanel } from './draft-test-panel';
import { InstructionBindingForm, instructionFromBinding, instructionToBinding, type InstructionBindingValue } from './instruction-binding-form';
import { JsonField } from './json-field';
import { ModelPicker, fallbackModelOptionLabel, useTaskModelCatalogue } from './model-picker';
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

/** TASK-947 §4.5 item 5 — a published composite agent's fragments, read-only: key, source, and its condition (or "Base" when unconditional). */
function CompositeInstructionSummary({ fragments }: { fragments: PromptFragment[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Instruction — composable fragments ({fragments.length})</h3>
      <ol className="flex flex-col gap-2">
        {fragments.map((fragment, index) => (
          <li key={`${fragment.key}-${index}`} className="flex flex-col gap-1 rounded-md border p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground font-mono text-xs">{index + 1}.</span>
              <span className="font-mono font-medium">{fragment.key}</span>
              <Badge variant="outline">{fragment.promptTemplateId ? 'Template' : 'Inline'}</Badge>
              {!fragment.when ? <Badge variant="secondary">Base — always included</Badge> : null}
            </div>
            {fragment.when ? <p className="text-muted-foreground font-mono text-xs">when: {fragment.when}</p> : null}
          </li>
        ))}
      </ol>
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

interface DraftState {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  modelId: string;
  fallbackModelIds: string[];
  tags: string;
  binding: InstructionBindingValue;
  initialPrompt: string;
  hotwords: string;
  /** TASK-930 — the NER label set, comma-separated in the field and split on save (same shape as `hotwords`). */
  labels: string;
}

function stringField(instruction: Record<string, unknown> | null, key: string): string {
  const value = instruction?.[key];
  return typeof value === 'string' ? value : '';
}

function draftFromAgent(agent: Agent): DraftState {
  const instruction = agent.instruction as Record<string, unknown> | null;
  const hotwords = instruction?.hotwords;
  const labels = instruction?.labels;
  return {
    name: agent.name,
    description: agent.description ?? '',
    parameters: agent.parameters ?? {},
    inputSchema: agent.inputSchema,
    outputSchema: agent.outputSchema,
    modelId: agent.modelId,
    fallbackModelIds: [...agent.fallbacks].sort((a, b) => a.priority - b.priority).map((fallback) => fallback.modelId),
    tags: agent.tags.join(', '),
    // TASK-947 — one shared pair (`instructionToBinding` / `instructionFromBinding`) for all
    // three TEXT_GENERATION instruction forms, so the wizard and this edit-draft form cannot
    // drift on how an instruction round-trips through the editor.
    binding: instructionToBinding(instruction, agent.contextSchemaId, agent.contextSchemaVersionNumber),
    initialPrompt: stringField(instruction, 'initialPrompt'),
    hotwords: Array.isArray(hotwords) ? hotwords.join(', ') : '',
    labels: Array.isArray(labels) ? labels.join(', ') : '',
  };
}

/**
 * One version row in the KIT's vocabulary. Everything agent-specific — the model it binds, its
 * fallback chain — goes behind the panel's disclosure rather than into the row, so a lineage with
 * twelve versions still reads as a list of versions and not as twelve configuration dumps.
 */
function toVersionRow(version: Agent): VersionRow {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    label: version.name,
    isActive: version.isActive,
    createdAt: version.createdAt,
    validatedAt: version.validatedAt,
    publishedAt: version.publishedAt,
    deprecatedAt: version.deprecatedAt,
    updatedAt: version.updatedAt,
    by: version.updatedBy ?? version.createdBy,
    checksum: version.compiledConfigChecksum,
    detail: (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Model</dt>
        <dd className="font-mono">{version.modelSlug ?? version.modelId}</dd>
        <dt className="text-muted-foreground">Fallbacks</dt>
        <dd className="font-mono">{version.fallbacks.length ? version.fallbacks.map((fallback) => fallback.modelSlug ?? fallback.modelId).join(' → ') : '—'}</dd>
        <dt className="text-muted-foreground">Tags</dt>
        <dd className="font-mono">{version.tags.length ? version.tags.join(', ') : '—'}</dd>
      </dl>
    ),
  };
}

/**
 * What "Compare with previous" diffs. The FROZEN compiled config when the version has one (that
 * is literally what the runtime executes); otherwise the editable body, so a draft can still be
 * compared with the published version it branched from.
 */
function comparable(version: Agent): unknown {
  return (
    version.compiledConfig ?? {
      model: version.modelSlug ?? version.modelId,
      fallbacks: version.fallbacks.map((fallback) => fallback.modelSlug ?? fallback.modelId),
      instruction: version.instruction,
      parameters: version.parameters,
      inputSchema: version.inputSchema,
      outputSchema: version.outputSchema,
      tags: version.tags,
    }
  );
}

/** The dialog a version row action opens. Carried with its row so a later refetch cannot swap the subject. */
type LifecycleDialog =
  | { kind: 'activate' | 'deprecate' | 'discard' | 'delete'; version: Agent }
  | { kind: 'compare'; version: Agent; previous: Agent }
  | null;

function scopeLabel(assignment: AgentAssignment, departmentName: (id: string | null) => string): string {
  if (assignment.scope === 'TENANT') return 'Tenant';
  if (assignment.scope === 'DEPARTMENT') return `Department · ${departmentName(assignment.scopeId)}`;
  return `Doctor · ${assignment.scopeId ?? '—'}`;
}

/**
 * TASK-965 WS-4 — the agent detail surface, rebuilt on the LINEAGE.
 *
 * It used to be addressed by a version row id, which is what made every defect in §2.4 C possible
 * at once: the grid listed versions, a link pinned one, the drawer's edit form could be seeded
 * from v1 and saved onto v2, "Tenant default" was badged on a DRAFT although assignment is per
 * slug, and there was no way to move the active pointer back. The drawer is now keyed by SLUG:
 * the lineage names the object, the Versions tab is where versions live, and every verb that
 * moves the pointer states what it demotes before it is armed.
 */
export function AgentLineageDrawer({
  slug,
  lineage: lineageProp,
  onOpenChange,
}: {
  slug: string | null;
  /** The row the grid already holds; omitted (or null) for a deep link to a lineage off the page. */
  lineage?: AgentLineage | null;
  onOpenChange: (open: boolean) => void;
}) {
  const resolved = useAgentLineageBySlug(slug, { enabled: !!slug && !lineageProp });
  const lineage = lineageProp ?? resolved.data ?? null;

  const versions = useAgentLineageVersions(lineage);
  const versionRows = useMemo(() => [...(versions.data ?? [])].sort((a, b) => b.versionNumber - a.versionNumber), [versions.data]);

  // The version the read-only tabs show. Defaults to what the lineage SERVES — an admin opening
  // an agent is asking "what is running", not "what did I last touch".
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const defaultInspectedId = lineage?.active?.id ?? lineage?.draft?.id ?? versionRows[0]?.id ?? null;
  const effectiveInspectedId = inspectedId ?? defaultInspectedId;

  const inspected = useAgent(effectiveInspectedId);
  const agent = inspected.data?.data ?? null;

  const draftId = lineage?.draft?.id ?? null;
  const draftQuery = useAgent(draftId);
  const draftAgent = draftQuery.data?.data ?? null;
  const draftEtag = draftQuery.data?.etag ?? null;

  const assignments = useAgentAssignments(lineage?.task);
  const departments = useDepartments();

  const validate = useValidateAgent();
  const publish = usePublishAgent();
  const activate = useActivateAgent();
  const deprecate = useDeprecateAgent();
  const remove = useDeleteAgent();
  const branch = useNewAgentVersion();
  const update = useUpdateAgent();
  const upsertAssignment = useUpsertAgentAssignment();
  const removeAssignment = useRemoveAgentAssignment();
  const exportAgent = useExportAgent();
  const catalogue = useTaskModelCatalogue(lineage?.task ?? 'TEXT_GENERATION');

  const [dialog, setDialog] = useState<LifecycleDialog>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<Agent | null>(null);
  // TASK-884 — the assignment tier this section writes. Empty = the tenant's UNQUALIFIED
  // default; a `key:value` list addresses the tag-qualified row of the same tier instead.
  const [selectorInput, setSelectorInput] = useState('');
  const [testInput, setTestInput] = useState('');
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // TASK-965 (AG-1, WS-4) — transient state is per LINEAGE now, not per version row. The drawer
  // stays mounted when the grid selection moves, so an edit form seeded from one agent's draft
  // would otherwise save onto another's. Adjusted during render — the pattern React prescribes
  // for prop-derived state; the compiler lint forbids doing it in an effect.
  const [seenSlug, setSeenSlug] = useState(slug);
  if (slug !== seenSlug) {
    setSeenSlug(slug);
    setInspectedId(null);
    setEditing(false);
    setDraft(null);
    setPublishing(false);
    setPublished(null);
    setDialog(null);
    setSelectorInput('');
    setTestInput('');
    setTestOutput(null);
    setTesting(false);
    update.reset();
  }

  const departmentName = (id: string | null) => departments.data?.find((department) => department.id === id)?.name ?? id ?? '—';

  const selectorTags = useMemo(() => [...new Set(selectorInput.split(',').map((tag) => tag.trim()).filter(Boolean))].sort(), [selectorInput]);
  const selectorProblem = selectorTags.find((tag) => !AGENT_TAG_PATTERN.test(tag));
  const selectorKey = selectorTags.join(',');
  // The row this control targets is the one whose SELECTOR matches — a selector is part of an
  // assignment's identity, so an empty box means the unqualified row, not "any row".
  const tenantRow = useMemo(
    () => (assignments.data ?? []).find((row) => row.scope === 'TENANT' && [...(row.selectorTags ?? [])].sort().join(',') === selectorKey),
    [assignments.data, selectorKey],
  );
  const isTenantDefault = !!lineage && tenantRow?.agentSlug === lineage.slug;
  const taskAssignments = useMemo(() => (assignments.data ?? []).filter((row) => !lineage || row.task === lineage.task), [assignments.data, lineage]);

  async function run<T>(action: () => Promise<T>, success: string, fallback: string): Promise<T | null> {
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
    if (!draftAgent || !draft || !draftEtag) return;
    let instruction: Record<string, unknown> | undefined;
    if (draftAgent.task === 'TEXT_GENERATION') {
      instruction = instructionFromBinding(draft.binding);
    } else if (draftAgent.task === 'SPEECH_TO_TEXT') {
      const hotwords = draft.hotwords
        .split(',')
        .map((word) => word.trim())
        .filter(Boolean);
      instruction = { ...(draft.initialPrompt ? { initialPrompt: draft.initialPrompt } : {}), ...(hotwords.length ? { hotwords } : {}) };
    } else if (draftAgent.task === 'NAMED_ENTITY_RECOGNITION') {
      // TASK-930 — the label set is the whole instruction. Left undefined when empty so a
      // fixed-label checkpoint keeps emitting its own taxonomy rather than an empty declaration.
      const labels = draft.labels
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean);
      instruction = labels.length ? { labels } : undefined;
    }
    const tags = draft.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    try {
      await update.mutateAsync({
        id: draftAgent.id,
        etag: draftEtag,
        patch: {
          name: draft.name,
          description: draft.description,
          modelId: draft.modelId,
          fallbackModelIds: draft.fallbackModelIds,
          parameters: draft.parameters,
          tags,
          ...(instruction ? { instruction } : {}),
          ...(draftAgent.task === 'TEXT_GENERATION' ? { contextSchemaId: draft.binding.contextSchemaId, contextSchemaVersionNumber: draft.binding.contextSchemaVersionNumber } : {}),
          ...(draft.inputSchema ? { inputSchema: draft.inputSchema } : {}),
          ...(draft.outputSchema ? { outputSchema: draft.outputSchema } : {}),
        },
      });
      toast.success('Draft saved');
      setEditing(false);
    } catch (error) {
      // TASK-965 (AG-5) — a 412 is NOT a toast: the stale ETag would be reused on the next
      // attempt and fail identically. `OccConflictAlert` renders inline above the form and its
      // Reload re-seeds the buffer from the row as it now is.
      if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
      problemToast(error, 'Could not save the draft.');
    }
  }

  /** The only escape from a 412 that can succeed: take the row as it is now, re-seed, retry. */
  async function reloadAfterConflict() {
    const fresh = await draftQuery.refetch();
    const next = fresh.data?.data;
    if (next) setDraft(draftFromAgent(next));
    update.reset();
  }

  async function confirmPublish(activateOnPublish: boolean) {
    if (!draftAgent) return;
    try {
      const result = await publish.mutateAsync({ id: draftAgent.id, body: { activate: activateOnPublish } });
      toast.success('Agent published');
      setPublished(result);
    } catch (error) {
      problemToast(error, 'Publish failed.');
    }
  }

  async function setAsTenantDefault() {
    if (!lineage) return;
    try {
      await upsertAssignment.mutateAsync({
        body: {
          scope: 'TENANT',
          task: lineage.task,
          agentSlug: lineage.slug,
          ...(selectorTags.length ? { selectorTags } : {}),
          reason: `Set from the Agents screen (${lineage.slug})`,
        },
        ...(tenantRow ? { etag: `"${tenantRow.version}"` } : {}),
      });
      toast.success(
        selectorTags.length
          ? `${lineage.name} now serves ${AGENT_TASK_LABEL[lineage.task].toLowerCase()} for ${selectorTags.join(' + ')}`
          : `${lineage.name} is now the tenant default for ${AGENT_TASK_LABEL[lineage.task].toLowerCase()}`,
      );
    } catch (error) {
      problemToast(error, 'Could not update the assignment.');
    }
  }

  /**
   * Download the bundle the gateway produced. The viewer's browser does the saving; nothing is
   * re-serialised here, so the file is byte-for-byte what `GET :slug/export` returned.
   */
  async function downloadBundle(version: Agent) {
    try {
      const bundle = await exportAgent.mutateAsync({ slug: version.slug, versionNumber: version.versionNumber });
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `agent-${version.slug}-v${version.versionNumber}.json`;
      link.click();
      URL.revokeObjectURL(url);
      const notes = (bundle.payload.notes ?? []).length;
      toast.success(notes ? `Exported ${version.slug} v${version.versionNumber} — ${notes} note(s) in the bundle about what was not carried.` : `Exported ${version.slug} v${version.versionNumber}`);
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

  const busy = validate.isPending || publish.isPending || activate.isPending || deprecate.isPending || remove.isPending || branch.isPending;

  /**
   * The verbs for ONE version row. Gating lives here, with the feature that knows the lifecycle —
   * the kit only renders what it is handed, and a disabled verb always carries a visible reason.
   */
  function versionActions(row: VersionRow): VersionRowAction[] {
    const version = versionRows.find((candidate) => candidate.id === row.id);
    if (!version || !lineage) return [];
    const openDraft = lineage.draft;
    const index = versionRows.findIndex((candidate) => candidate.id === version.id);
    const previous = versionRows[index + 1] ?? null;
    const actions: VersionRowAction[] = [];

    if (version.status === 'PUBLISHED') {
      actions.push({
        key: 'activate',
        label: `Activate v${version.versionNumber}`,
        icon: IconPlayerPlayFilled,
        disabled: version.isActive,
        disabledReason: version.isActive ? 'Already the version this slug serves.' : undefined,
        onSelect: () => setDialog({ kind: 'activate', version }),
      });
      actions.push({
        key: 'deprecate',
        label: `Deprecate v${version.versionNumber}`,
        icon: IconArchive,
        onSelect: () => setDialog({ kind: 'deprecate', version }),
      });
    }

    if (version.status === 'PUBLISHED' || version.status === 'DEPRECATED') {
      // OD-965-9 / AG-19 — a new draft is offered only where one can honestly be branched, and
      // never while a draft is already open: that is exactly how a slug accumulated four
      // identical-looking drafts, which is the symptom the owner reported.
      actions.push({
        key: 'branch',
        label: `New draft from v${version.versionNumber}`,
        icon: IconGitBranch,
        disabled: !!openDraft,
        disabledReason: openDraft ? `Draft v${openDraft.versionNumber} is already open — continue or discard it first.` : undefined,
        onSelect: () => {
          void run(() => branch.mutateAsync({ id: version.id }), 'New draft version created', 'Could not branch a new version.');
        },
      });
    }

    if (version.status === 'DRAFT' || version.status === 'VALIDATED') {
      actions.push({
        key: 'discard',
        label: `Discard draft v${version.versionNumber}`,
        icon: IconTrash,
        destructive: true,
        onSelect: () => setDialog({ kind: 'discard', version }),
      });
    }

    if (version.status === 'DEPRECATED') {
      actions.push({
        key: 'delete',
        label: `Delete v${version.versionNumber}`,
        icon: IconTrash,
        destructive: true,
        onSelect: () => setDialog({ kind: 'delete', version }),
      });
    }

    actions.push({
      key: 'compare',
      label: previous ? `Compare with v${previous.versionNumber}` : 'Compare with previous',
      icon: IconArrowsDiff,
      disabled: !previous,
      disabledReason: previous ? undefined : 'This is the first version — there is nothing before it.',
      onSelect: () => {
        if (previous) setDialog({ kind: 'compare', version, previous });
      },
    });

    actions.push({ key: 'export', label: `Export v${version.versionNumber}`, icon: IconDownload, onSelect: () => void downloadBundle(version) });
    return actions;
  }

  const noneActive = !!lineage && !lineage.active;
  const hidden = !!lineage?.hidden;
  const inspectedIsActive = !!agent && !!lineage?.active && agent.id === lineage.active.id;
  const branchSource = lineage?.active?.id ?? versionRows.find((row) => row.status === 'PUBLISHED' || row.status === 'DEPRECATED')?.id ?? null;

  return (
    <Tabs defaultValue="overview">
      <DetailDrawer
        open={!!slug}
        onOpenChange={onOpenChange}
        size="lg"
        title={lineage ? lineage.name : <Skeleton className="h-6 w-48" />}
        badges={
          lineage ? (
            <>
              <AgentTaskBadge task={lineage.task} />
              <ActiveBadge active={!noneActive} noneActive={noneActive} />
              <AssignmentBadges {...lineage.assignment} />
              <OriginBadge sourceTenantId={lineage.origin.sourceTenantId} />
              <AgentHiddenBadge hidden={lineage.hidden} />
            </>
          ) : null
        }
        meta={
          lineage ? (
            <span className="font-mono text-xs">
              {lineage.slug} · {lineage.versionCount} version{lineage.versionCount === 1 ? '' : 's'}
              {lineage.active ? ` · serving v${lineage.active.versionNumber}` : ''}
              {lineage.draft ? ` · draft v${lineage.draft.versionNumber}` : ''}
            </span>
          ) : null
        }
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
            <TabsTrigger value="draft">Draft</TabsTrigger>
            <TabsTrigger value="assignments">Assignments</TabsTrigger>
            <TabsTrigger value="integration">Integration</TabsTrigger>
            <TabsTrigger value="test">Test run</TabsTrigger>
          </TabsList>
        }
        footer={
          lineage ? (
            <div className="flex w-full flex-wrap items-center justify-end gap-2">
              {/* TASK-974 D-1 — a platform service agent belongs to the platform admin: a tenant
                  surface lists it so it is not invisible, and offers it no verbs. */}
              {hidden ? (
                <span className="text-muted-foreground mr-auto text-xs">Platform service agent — managed by the platform administrator.</span>
              ) : lineage.draft ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !draftAgent}
                    onClick={() => draftAgent && void run(() => validate.mutateAsync(draftAgent.id), 'Validation complete', 'Validation failed.')}
                  >
                    {validate.isPending ? <Spinner /> : <IconShieldCheck aria-hidden className="size-4" />}
                    Validate
                  </Button>
                  <Button
                    type="button"
                    disabled={busy || !draftAgent}
                    onClick={() => {
                      setPublished(null);
                      setPublishing(true);
                    }}
                  >
                    {publish.isPending ? <Spinner /> : <IconRocket aria-hidden className="size-4" />}
                    Publish
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || !branchSource}
                  onClick={() => branchSource && void run(() => branch.mutateAsync({ id: branchSource }), 'New draft version created', 'Could not branch a new version.')}
                >
                  {branch.isPending ? <Spinner /> : <IconGitBranch aria-hidden className="size-4" />}
                  New draft
                </Button>
              )}
              <Button type="button" variant="outline" disabled={!agent || exportAgent.isPending} onClick={() => agent && void downloadBundle(agent)}>
                {exportAgent.isPending ? <Spinner /> : <IconDownload aria-hidden className="size-4" />}
                Export{agent ? ` v${agent.versionNumber}` : ''}
              </Button>
            </div>
          ) : null
        }
      >
        {!lineage ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <>
            <TabsContent value="overview" className="flex flex-col gap-4">
              {noneActive ? (
                <p className="text-warning-strong flex items-start gap-2 text-sm">
                  <IconAlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                  No version of {lineage.slug} is active, so nothing assigned to it resolves. Activate a published version from the Versions tab.
                </p>
              ) : null}
              {agent && !inspectedIsActive && lineage.active ? (
                <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
                  Showing v{agent.versionNumber}, which is not the version being served.
                  <Button type="button" variant="link" className="h-auto p-0" onClick={() => setInspectedId(lineage.active?.id ?? null)}>
                    Show active v{lineage.active.versionNumber}
                  </Button>
                </p>
              ) : null}
              {!agent ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : (
                <>
                  <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">Task</dt>
                    <dd>{AGENT_TASK_LABEL[agent.task]}</dd>
                    <dt className="text-muted-foreground">Version</dt>
                    <dd className="font-mono">
                      v{agent.versionNumber} of {lineage.versionCount}
                      {lineage.deprecatedCount > 0 ? ` · ${lineage.deprecatedCount} deprecated` : ''}
                    </dd>
                    <dt className="text-muted-foreground">Model</dt>
                    <dd className="font-mono">{agent.modelSlug ?? agent.modelId}</dd>
                    <dt className="text-muted-foreground">Fallbacks</dt>
                    <dd className="font-mono">{agent.fallbacks.length ? agent.fallbacks.map((fallback) => fallback.modelSlug ?? fallback.modelId).join(' → ') : '—'}</dd>
                    <dt className="text-muted-foreground">Description</dt>
                    <dd>{agent.description ?? '—'}</dd>
                    <dt className="text-muted-foreground">Published</dt>
                    <dd>{agent.publishedAt ? formatDateTime(agent.publishedAt) : '—'}</dd>
                    <dt className="text-muted-foreground">Published by</dt>
                    <dd className="font-mono text-xs">{lineage.active?.publishedBy ?? '—'}</dd>
                    <dt className="text-muted-foreground">Updated</dt>
                    <dd>{formatDateTime(agent.updatedAt)}</dd>
                    <dt className="text-muted-foreground">Checksum</dt>
                    <dd className="font-mono text-xs">{agent.compiledConfigChecksum ?? '—'}</dd>
                  </dl>
                  <FindingsList agent={agent} />
                  {agent.task === 'TEXT_GENERATION' && instructionForm(agent.instruction) === 'fragments' ? (
                    <CompositeInstructionSummary fragments={readFragments(agent.instruction)} />
                  ) : (
                    <JsonBlock label="Instruction" value={agent.instruction} />
                  )}
                  <JsonBlock label="Parameters" value={agent.parameters} />
                  <JsonBlock label="Input schema" value={agent.inputSchema ?? 'task default'} />
                  <JsonBlock label="Output schema" value={agent.outputSchema ?? 'task default'} />
                  {agent.tools?.length ? <JsonBlock label="Tools" value={agent.tools} /> : null}
                  {agent.compiledConfig ? <JsonBlock label="Compiled config (server-stamped at publish)" value={agent.compiledConfig} /> : null}
                </>
              )}
            </TabsContent>

            <TabsContent value="versions">
              <VersionHistoryPanel
                aria-label={`Versions of ${lineage.slug}`}
                versions={versionRows.map(toVersionRow)}
                isPending={versions.isPending}
                error={versions.error}
                onRetry={() => void versions.refetch()}
                actions={hidden ? undefined : versionActions}
                onOpenVersion={(row) => setInspectedId(row.id)}
                caption={
                  lineage.active
                    ? `Every call to ${lineage.slug} runs the ACTIVE version, v${lineage.active.versionNumber}. Activating another published version moves that pointer; every assignment naming this slug follows it.`
                    : `No version of ${lineage.slug} is active, so the slug resolves to nothing. Activate a published version to make it serve again.`
                }
                emptyTitle="No versions yet"
                emptyDescription="This lineage has no live version rows."
              />
            </TabsContent>

            <TabsContent value="draft" className="flex flex-col gap-4">
              {!lineage.draft ? (
                <EmptyState
                  icon={IconGitBranch}
                  title="No draft is open"
                  description={`A published version is immutable. Branch a new draft from ${lineage.active ? `v${lineage.active.versionNumber}` : 'a published version'} to change the model, instruction, parameters or tags.`}
                  action={
                    hidden ? undefined : (
                      <Button
                        type="button"
                        disabled={busy || !branchSource}
                        onClick={() => branchSource && void run(() => branch.mutateAsync({ id: branchSource }), 'New draft version created', 'Could not branch a new version.')}
                      >
                        <IconGitBranch aria-hidden className="size-4" />
                        New draft
                      </Button>
                    )
                  }
                />
              ) : !draftAgent ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ) : (
                <>
                  <p className="text-muted-foreground text-sm">
                    Continue draft v{draftAgent.versionNumber} — {draftAgent.status === 'VALIDATED' ? 'validated and ready to publish' : 'not validated yet'}.
                  </p>
                  {/* AG-5 — a 412 gets the inline alert, not a toast: only a reload can succeed. */}
                  <OccConflictAlert error={update.error} onReload={() => void reloadAfterConflict()} />
                  {!editing ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="self-start"
                      onClick={() => {
                        setDraft(draftFromAgent(draftAgent));
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

                      <ModelPicker id="edit-model" task={draftAgent.task} value={draft.modelId} onChange={(modelId) => setDraft({ ...draft, modelId, fallbackModelIds: draft.fallbackModelIds.filter((id) => id !== modelId) })} />
                      {draft.fallbackModelIds.length ? (
                        <p className="text-muted-foreground text-xs">
                          Fallbacks:{' '}
                          {draft.fallbackModelIds
                            .map((id) => {
                              const model = catalogue.models.find((candidate) => candidate.id === id);
                              // TASK-958 — the connection is what distinguishes two same-named BYO
                              // models; without it the chain reads as the same model listed twice.
                              return model ? fallbackModelOptionLabel(model, catalogue.providers) : id;
                            })
                            .join(' → ')}
                        </p>
                      ) : null}

                      {draftAgent.task === 'TEXT_GENERATION' ? (
                        <fieldset className="flex flex-col gap-3">
                          <legend className="text-sm font-medium">Instruction</legend>
                          <InstructionBindingForm value={draft.binding} onChange={(binding) => setDraft({ ...draft, binding })} />
                        </fieldset>
                      ) : draftAgent.task === 'SPEECH_TO_TEXT' ? (
                        <fieldset className="flex flex-col gap-3">
                          <legend className="text-sm font-medium">Instruction</legend>
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor="edit-initial-prompt">Initial prompt</Label>
                            <Textarea id="edit-initial-prompt" rows={3} maxLength={1000} value={draft.initialPrompt} onChange={(event) => setDraft({ ...draft, initialPrompt: event.target.value })} />
                          </div>
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor="edit-hotwords">Hotwords</Label>
                            <Input id="edit-hotwords" placeholder="comma-separated" value={draft.hotwords} onChange={(event) => setDraft({ ...draft, hotwords: event.target.value })} />
                          </div>
                        </fieldset>
                      ) : draftAgent.task === 'NAMED_ENTITY_RECOGNITION' ? (
                        <fieldset className="flex flex-col gap-3">
                          <legend className="text-sm font-medium">Instruction</legend>
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor="edit-labels">Entity labels</Label>
                            <Input id="edit-labels" placeholder="comma-separated" value={draft.labels} onChange={(event) => setDraft({ ...draft, labels: event.target.value })} />
                            <p className="text-muted-foreground text-xs">Honoured by zero-shot extractors; a fixed-label checkpoint emits its own set.</p>
                          </div>
                        </fieldset>
                      ) : null}

                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="edit-tags">Tags</Label>
                        <Input id="edit-tags" placeholder="key:value, key:value" value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
                      </div>

                      <ParametersForm task={draftAgent.task} value={draft.parameters} onChange={(parameters) => setDraft({ ...draft, parameters })} modelId={draft.modelId} />
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
                      {draftAgent.task === 'TEXT_GENERATION' && instructionForm(draftAgent.instruction) === 'fragments' ? (
                        <CompositeInstructionSummary fragments={readFragments(draftAgent.instruction)} />
                      ) : (
                        <JsonBlock label="Instruction" value={draftAgent.instruction} />
                      )}
                      <JsonBlock label="Parameters" value={draftAgent.parameters} />
                      <FindingsList agent={draftAgent} />
                    </>
                  )}
                </>
              )}
            </TabsContent>

            <TabsContent value="assignments" className="flex flex-col gap-4">
              {/* AG-16 — the assignment section used to render only on the ACTIVE published row, so
                  the moment that version was deprecated nothing showed what the slug served.
                  Assignment belongs to the LINEAGE, so it lives on the lineage's own tab. */}
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">What serves {AGENT_TASK_LABEL[lineage.task].toLowerCase()}</h3>
                {assignments.isPending ? (
                  <Skeleton className="h-16 w-full" />
                ) : taskAssignments.length === 0 ? (
                  // AG-3 — resolution is department → tenant and then a fail-closed 503. There is
                  // no platform tier for content (TASK-890 OD-M), so "nothing is assigned" is a
                  // warning about refused requests, never "the platform has it covered".
                  <p className="text-warning-strong flex items-start gap-2 text-sm">
                    <IconAlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                    Nothing is assigned for {AGENT_TASK_LABEL[lineage.task].toLowerCase()}. Requests fail with AGENT_NOT_ASSIGNED until an agent is assigned — resolution is department → tenant, and there is no platform fallback.
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y" aria-label="Assignments for this task">
                    {taskAssignments.map((row) => (
                      <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <Badge variant="outline">{scopeLabel(row, departmentName)}</Badge>
                          <span className={row.agentSlug === lineage.slug ? 'font-mono font-medium' : 'text-muted-foreground font-mono'}>{row.agentSlug}</span>
                          {row.agentSlug === lineage.slug ? <Badge variant="secondary">This agent</Badge> : null}
                          {(row.selectorTags ?? []).length ? (
                            <span className="text-muted-foreground font-mono text-xs">{(row.selectorTags ?? []).join(' + ')}</span>
                          ) : null}
                        </span>
                        {hidden ? null : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={removeAssignment.isPending}
                            onClick={() =>
                              void run(
                                () => removeAssignment.mutateAsync({ id: row.id, version: row.version, reason: 'Removed from the Agents screen' }),
                                'Assignment removed',
                                'Could not remove that assignment.',
                              )
                            }
                            aria-label={`Remove the ${scopeLabel(row, departmentName)} assignment for ${row.agentSlug}`}
                          >
                            Remove
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {hidden ? null : (
                <section className="flex flex-col gap-3 rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-col text-sm">
                      <span className="font-medium">{selectorTags.length ? `Assignment for ${selectorTags.join(' + ')}` : `Tenant default for ${AGENT_TASK_LABEL[lineage.task].toLowerCase()}`}</span>
                      <span className="text-muted-foreground text-xs">{tenantRow ? `Currently ${tenantRow.agentSlug}` : 'Not assigned yet'}</span>
                    </div>
                    <Button type="button" variant="outline" size="sm" disabled={isTenantDefault || upsertAssignment.isPending || !!selectorProblem} onClick={() => void setAsTenantDefault()}>
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
              )}
            </TabsContent>

            {/* TASK-965 (O-2 / AG-8) — the endpoint and SDK snippet live on the LINEAGE, not only
                in the one-shot publish dialog: derived from slug + task, reopenable at any time. */}
            <TabsContent value="integration" className="flex flex-col gap-4">
              {agent && (agent.status === 'PUBLISHED' || agent.status === 'DEPRECATED') ? (
                <IntegrationPanel
                  kind="agent"
                  slug={lineage.slug}
                  task={lineage.task}
                  versionNumber={agent.versionNumber}
                  isActive={agent.isActive}
                  /* TASK-971 lane B — the example body in every lane comes from the agent's own
                     declared input, not a placeholder. FU-1: `inputSchema` is only half of it —
                     `compiledConfig` carries the instruction's `trigger.*` bindings, which the
                     schema never declares and the invocation still requires. TASK-991 wave 2: it
                     also carries `requiredVariables` (stamped at publish), which is where the
                     panel now reads the prompt placeholders from — so no separate prop is needed. */
                  inputSchema={agent.inputSchema}
                  compiledConfig={agent.compiledConfig}
                />
              ) : (
                <EmptyState
                  icon={IconRocket}
                  title="Not published yet"
                  description={`Publish a version to expose ${lineage.slug} on the business plane. The endpoint and the @arcaai/vox-node snippet appear here once it is published.`}
                />
              )}
            </TabsContent>

            <TabsContent value="test" className="flex flex-col gap-3">
              {draftAgent && (draftAgent.status === 'DRAFT' || draftAgent.status === 'VALIDATED') ? (
                <DraftTestPanel agent={draftAgent} />
              ) : lineage.task === 'TEXT_GENERATION' && lineage.active ? (
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
                    lineage.task !== 'TEXT_GENERATION'
                      ? 'Direct test runs cover text-generation agents; every other task is exercised from the Playground.'
                      : 'Activate a published version to run it through POST /agents/{slug}/invocations.'
                  }
                />
              )}
            </TabsContent>
          </>
        )}
      </DetailDrawer>

      {draftAgent ? (
        <AgentPublishDialog
          open={publishing}
          onOpenChange={(open) => {
            setPublishing(open);
            if (!open) setPublished(null);
          }}
          onConfirm={(activateOnPublish) => void confirmPublish(activateOnPublish)}
          confirming={publish.isPending}
          agent={draftAgent}
          published={published}
        />
      ) : null}

      {lineage && dialog?.kind === 'activate' ? (
        <ActivateVersionDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          itemLabel={lineage.name}
          slug={lineage.slug}
          versionNumber={dialog.version.versionNumber}
          currentActiveVersionNumber={lineage.active?.versionNumber ?? null}
          assignment={lineage.assignment}
          isPending={activate.isPending}
          onConfirm={() => {
            void run(() => activate.mutateAsync(dialog.version.id), `v${dialog.version.versionNumber} is now the active version`, 'Could not activate that version.').then(() => setDialog(null));
          }}
        />
      ) : null}

      {lineage && dialog?.kind === 'deprecate' ? (
        <DeprecateVersionDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          itemLabel={lineage.name}
          slug={lineage.slug}
          versionNumber={dialog.version.versionNumber}
          isActive={dialog.version.isActive}
          assignment={lineage.assignment}
          isPending={deprecate.isPending}
          onConfirm={() => {
            void run(() => deprecate.mutateAsync(dialog.version.id), 'Agent version deprecated', 'Could not deprecate.').then(() => setDialog(null));
          }}
        />
      ) : null}

      {lineage && dialog?.kind === 'discard' ? (
        <DiscardDraftDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          itemLabel={lineage.name}
          slug={lineage.slug}
          versionNumber={dialog.version.versionNumber}
          isPending={remove.isPending}
          onConfirm={() => {
            void run(() => remove.mutateAsync(dialog.version.id), 'Draft discarded', 'Could not discard that draft.').then(() => setDialog(null));
          }}
        />
      ) : null}

      {lineage && dialog?.kind === 'delete' ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={`Delete v${dialog.version.versionNumber}?`}
          description={`The deprecated version is soft-deleted and disappears from the history of ${lineage.slug}. The active version and every other version are untouched.`}
          confirmLabel={`Delete v${dialog.version.versionNumber}`}
          destructive
          typeToConfirm={lineage.slug}
          isPending={remove.isPending}
          onConfirm={() => {
            void run(() => remove.mutateAsync(dialog.version.id), 'Agent version deleted', 'Could not delete.').then(() => setDialog(null));
          }}
        />
      ) : null}

      {dialog?.kind === 'compare' ? (
        <VersionCompareDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          from={{ label: `v${dialog.previous.versionNumber}`, value: comparable(dialog.previous) }}
          to={{ label: `v${dialog.version.versionNumber}`, value: comparable(dialog.version) }}
          title={`Compare v${dialog.previous.versionNumber} with v${dialog.version.versionNumber}`}
          description={`What changed between these two versions of ${lineage?.slug ?? 'this agent'}. A published version compares its frozen compiled config; a draft compares its editable body.`}
        />
      ) : null}
    </Tabs>
  );
}
