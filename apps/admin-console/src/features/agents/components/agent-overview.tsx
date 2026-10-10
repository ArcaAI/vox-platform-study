'use client';

/**
 * TASK-1036 W2 — the agent described as a product, not as a database row.
 *
 * Owner direction W2: "a simple, friendly UI … Do not show advanced configuration or model
 * encoder/decoder hyperparameters." The Overview used to print the raw instruction, the whole
 * parameter tree, both I/O schemas, the compiled config and its checksum. It now shows summary
 * sections — what the agent does, its model, its prompt, its settings in plain on/off facts, and
 * its inputs and outputs as a small field table — and keeps the raw configuration behind ONE
 * collapsed "Technical details" disclosure that only a super admin ever sees (support use).
 *
 * `AgentConfigurationSummary` is the shared core: the read-only draft view renders it too, so a
 * draft and a published version read the same way.
 */
import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { IconAlertTriangle, IconShieldCheck } from '@tabler/icons-react';
import { CodeEditor } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { capabilitiesOf, hasEditablePath, type WithCapabilities } from '@/shared/agent-wizard/capabilities';
import { useDocumentTemplateCatalog, useContextSchemaCatalog, useContextSchemaDefinition } from '@/shared/catalog';
import { contextCompletionPaths } from '@/shared/template-editor';
import { withPathSuggestions } from '../lib/path-suggestion';
import { formatDateTime } from '@/shared/format';
import { usePromptTemplateQuickView } from '@/shared/prompt-picker';
import { AGENT_TASK_LABEL, instructionForm, readFragments, type Agent, type AgentLineage, type PromptFragment } from '../api';
import { useTaskModelCatalogue } from './model-picker';
import {
  AGENT_TASK_PURPOSE,
  asrHintFacts,
  effectiveIoSchema,
  generationFacts,
  schemaFields,
  taskSwitchFacts,
  type Fact,
} from './agent-summary';

const PREVIEW_CHARS = 200;

const STATUS_WORDS: Record<Agent['status'], string> = {
  DRAFT: 'Draft',
  VALIDATED: 'Draft — checked, ready to publish',
  PUBLISHED: 'Published',
  DEPRECATED: 'Deprecated',
};

/** One titled section; `aria-labelledby` makes it a named region a screen reader can jump to. */
function SummarySection({ title, children, description }: { title: string; description?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 rounded-md border p-3">
      <h3 id={id} className="text-sm font-medium">
        {title}
      </h3>
      {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
      {children}
    </section>
  );
}

function FactList({ facts, children }: { facts: Fact[]; children?: ReactNode }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      {facts.map((fact) => (
        <FactRow key={fact.label} label={fact.label}>
          {fact.value}
        </FactRow>
      ))}
      {children}
    </dl>
  );
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** TASK-947 §4.5 item 5 — a composite agent's fragments, read-only: key, source, and its condition (or "Base" when unconditional). */
export function CompositeInstructionSummary({ fragments }: { fragments: PromptFragment[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Instruction — composable fragments ({fragments.length})</p>
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
    </div>
  );
}

/**
 * The schema `{{context.*}}` resolves against for this version: the gateway's
 * `effectiveContextSchema` when it sends one (which covers a schema lent by a workflow), else the
 * agent's own binding. Read-only — an inherited schema is changed on the workflow's trigger.
 */
function EffectiveContextSchemaValue({ agent }: { agent: Agent }) {
  const catalog = useContextSchemaCatalog();
  const effective =
    agent.effectiveContextSchema !== undefined
      ? agent.effectiveContextSchema
      : agent.contextSchemaId
        ? { id: agent.contextSchemaId, versionNumber: agent.contextSchemaVersionNumber, inheritedFrom: 'agent' as const }
        : null;
  if (!effective) return <>None</>;
  const name = (catalog.data ?? []).find((schema) => schema.id === effective.id)?.name;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {name ? <span>{name}</span> : catalog.isLoading ? <Skeleton className="h-4 w-28" /> : <span>Schema not found</span>}
      {effective.versionNumber !== null ? <span>v{effective.versionNumber}</span> : <span className="text-muted-foreground text-xs">follows latest</span>}
      {effective.inheritedFrom === 'workflow' ? <Badge variant="secondary">Inherited from workflow</Badge> : null}
    </span>
  );
}

/** A version's publish check, in words. The machine code stays on hover for whoever has to report it. */
export function FindingsList({ agent }: { agent: Agent }) {
  const effective =
    agent.effectiveContextSchema !== undefined
      ? agent.effectiveContextSchema
      : agent.contextSchemaId
        ? { id: agent.contextSchemaId, versionNumber: agent.contextSchemaVersionNumber }
        : null;
  const { definition } = useContextSchemaDefinition(effective?.id ?? null, effective?.versionNumber ?? null);
  const report = agent.validationReport;
  if (!report) return null;
  const findings = withPathSuggestions(report.findings, contextCompletionPaths(definition));
  return (
    <section className="flex flex-col gap-2" aria-label="Validation findings">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {report.blocking ? <IconAlertTriangle aria-hidden className="text-destructive size-4" /> : <IconShieldCheck aria-hidden className="text-success size-4" />}
        {report.blocking ? 'Needs fixing before it can be published' : 'Checked'} · {formatDateTime(report.checkedAt)}
      </h3>
      {findings.length === 0 ? (
        <p className="text-muted-foreground text-sm">No problems found.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {findings.map((finding, index) => (
            <li key={`${finding.path}-${index}`} className="flex items-start gap-2 text-sm">
              <Badge variant={finding.severity === 'ERROR' ? 'destructive' : 'secondary'} title={finding.code}>
                {finding.severity === 'ERROR' ? 'Must fix' : 'Warning'}
              </Badge>
              <span>
                {finding.message}
                {finding.path ? <span className="text-muted-foreground block font-mono text-xs">{finding.path}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The model's display name, its provider, and the fallback chain in model names. */
function ModelSection({ agent }: { agent: Agent }) {
  const catalogue = useTaskModelCatalogue(agent.task);
  const nameOf = (id: string, slug: string | null | undefined) => catalogue.models.find((model) => model.id === id)?.name ?? slug ?? 'Unknown model';
  const model = catalogue.models.find((candidate) => candidate.id === agent.modelId);
  const provider = model ? catalogue.providers.find((candidate) => candidate.id === model.providerId) : undefined;
  const fallbacks = [...agent.fallbacks].filter((fallback) => fallback.enabled !== false).sort((a, b) => a.priority - b.priority);
  return (
    <SummarySection title="Model">
      {catalogue.isPending ? (
        <Skeleton className="h-4 w-48" />
      ) : (
        <FactList facts={[]}>
          <FactRow label="Model">{nameOf(agent.modelId, agent.modelSlug)}</FactRow>
          {provider ? <FactRow label="Provider">{provider.name}</FactRow> : null}
        </FactList>
      )}
      {catalogue.isPending ? null : (
        <p className="text-muted-foreground text-sm">
          {fallbacks.length ? `Falls back to: ${fallbacks.map((fallback) => nameOf(fallback.modelId, fallback.modelSlug)).join(' → ')}` : 'No fallback model.'}
        </p>
      )}
    </SummarySection>
  );
}

function LibraryPrompt({ templateId, pinned }: { templateId: string; pinned: number | null }) {
  const template = usePromptTemplateQuickView(templateId);
  return (
    <FactList facts={[]}>
      <FactRow label="Library prompt">
        {template.isPending ? (
          <Skeleton className="h-4 w-36" />
        ) : (
          <Link href={`/prompt-templates?template=${encodeURIComponent(templateId)}`} className="underline underline-offset-2">
            {template.data?.name ?? 'Open the prompt'}
          </Link>
        )}
      </FactRow>
      <FactRow label="Version">
        {pinned !== null
          ? `Pinned to v${pinned}`
          : `Follows the approved version${template.data?.approvedVersionNumber ? ` (currently v${template.data.approvedVersionNumber})` : ''}`}
      </FactRow>
    </FactList>
  );
}

function InlinePrompt({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > PREVIEW_CHARS;
  const shown = expanded || !long ? text : `${text.slice(0, PREVIEW_CHARS).trimEnd()}…`;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted-foreground text-xs">Inline instruction</p>
      <p className="bg-muted/40 rounded-md p-2 text-sm whitespace-pre-wrap">{shown}</p>
      {long ? (
        <Button type="button" variant="link" size="sm" className="h-auto self-start p-0" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show full'}
        </Button>
      ) : null}
    </div>
  );
}

function PromptSection({ agent }: { agent: Agent }) {
  const instruction = agent.instruction;
  if (agent.task === 'SPEECH_TO_TEXT') {
    const facts = asrHintFacts(instruction);
    return (
      <SummarySection title="Prompt">
        {facts.length ? <FactList facts={facts} /> : <p className="text-muted-foreground text-sm">No hints — the model transcribes without a prompt.</p>}
      </SummarySection>
    );
  }
  if (agent.task !== 'TEXT_GENERATION') return null;
  const form = instructionForm(instruction);
  const pinned = typeof instruction?.promptVersionNumber === 'number' ? instruction.promptVersionNumber : null;
  return (
    <SummarySection title="Prompt">
      {form === 'template' ? (
        <LibraryPrompt templateId={String(instruction?.promptTemplateId)} pinned={pinned} />
      ) : form === 'inline' ? (
        <InlinePrompt text={String(instruction?.systemPrompt)} />
      ) : form === 'fragments' ? (
        <CompositeInstructionSummary fragments={readFragments(instruction)} />
      ) : (
        <p className="text-muted-foreground text-sm">No prompt set yet.</p>
      )}
      <FactList facts={[]}>
        <FactRow label="Context schema">
          <EffectiveContextSchemaValue agent={agent} />
        </FactRow>
      </FactList>
    </SummarySection>
  );
}

function SettingsSection({ agent }: { agent: Agent }) {
  const catalogue = useTaskModelCatalogue(agent.task);
  const templates = useDocumentTemplateCatalog();
  const model = catalogue.models.find((candidate) => candidate.id === agent.modelId);
  const capabilities = capabilitiesOf(model as WithCapabilities | undefined);
  const facts = [
    ...taskSwitchFacts(agent.task, agent.parameters, agent.instruction, {
      documentTemplateName: (slug) => (templates.data ?? []).find((template) => template.slug === slug)?.name,
    }),
    ...(agent.task === 'TEXT_GENERATION' ? generationFacts(agent.parameters, (path) => hasEditablePath(agent.task, capabilities, path)) : []),
    { label: 'Guardrails', value: 'Always on' },
  ];
  return (
    <SummarySection title="Settings">
      <FactList facts={facts} />
    </SummarySection>
  );
}

function FieldTable({ caption, schema, isStandard }: { caption: string; schema: unknown; isStandard: boolean }) {
  const fields = schemaFields(schema);
  return (
    <div className="flex flex-col gap-1">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {caption}
        <Badge variant={isStandard ? 'secondary' : 'outline'}>{isStandard ? 'Standard for this task' : 'Custom'}</Badge>
      </p>
      {fields.length === 0 ? (
        <p className="text-muted-foreground text-sm">No named fields.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="text-muted-foreground text-xs">
            <tr>
              <th scope="col" className="py-1 pr-3 font-normal">
                Field
              </th>
              <th scope="col" className="py-1 pr-3 font-normal">
                Type
              </th>
              <th scope="col" className="py-1 font-normal">
                Required
              </th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr key={field.name} className="border-t align-top">
                <td className="py-1 pr-3 font-mono text-xs" title={field.description}>
                  {field.name}
                </td>
                <td className="py-1 pr-3">{field.type}</td>
                <td className="py-1">{field.required ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * What the agent takes and returns, as two plain field tables. Exported for the agent wizard
 * (via `shared/agent-wizard/agents-feature`), which shows the same view while creating.
 */
export function AgentIoSummary({ task, inputSchema, outputSchema }: { task: Agent['task']; inputSchema: Agent['inputSchema']; outputSchema: Agent['outputSchema'] }) {
  const input = effectiveIoSchema(task, 'input', inputSchema);
  const output = effectiveIoSchema(task, 'output', outputSchema);
  return (
    <SummarySection title="Inputs and outputs">
      <FieldTable caption="It takes" schema={input.schema} isStandard={input.isStandard} />
      <FieldTable caption="It returns" schema={output.schema} isStandard={output.isStandard} />
    </SummarySection>
  );
}

/** Model, prompt, settings and I/O — shared by the Overview and the read-only draft view. */
export function AgentConfigurationSummary({ agent }: { agent: Agent }) {
  return (
    <div className="flex flex-col gap-3">
      <ModelSection agent={agent} />
      <PromptSection agent={agent} />
      <SettingsSection agent={agent} />
      <AgentIoSummary task={agent.task} inputSchema={agent.inputSchema} outputSchema={agent.outputSchema} />
    </div>
  );
}

function ReadOnlyJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium">{label}</p>
      <CodeEditor aria-label={`${label} (read-only)`} language="json" readOnly value={JSON.stringify(value ?? null, null, 2)} className="max-h-64" />
    </div>
  );
}

/** Super admin only: the raw configuration, for support. Collapsed by default. */
function TechnicalDetails({ agent, lineage }: { agent: Agent; lineage: AgentLineage }) {
  return (
    <details className="rounded-md border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">Technical details</summary>
      <div className="flex flex-col gap-3 pt-3">
        <p className="text-muted-foreground text-xs">Visible to platform administrators only. The raw configuration this version runs with, for support.</p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Slug</dt>
          <dd className="font-mono break-all">{agent.slug}</dd>
          <dt className="text-muted-foreground">Version id</dt>
          <dd className="font-mono break-all">{agent.id}</dd>
          <dt className="text-muted-foreground">Model id</dt>
          <dd className="font-mono break-all">
            {agent.modelId}
            {agent.modelSlug ? ` (${agent.modelSlug})` : ''}
          </dd>
          <dt className="text-muted-foreground">Published by</dt>
          <dd className="font-mono break-all">{lineage.active?.publishedBy ?? '—'}</dd>
          <dt className="text-muted-foreground">Config checksum</dt>
          <dd className="font-mono break-all">{agent.compiledConfigChecksum ?? '—'}</dd>
        </dl>
        <ReadOnlyJson label="Instruction" value={agent.instruction} />
        <ReadOnlyJson label="Parameters" value={agent.parameters} />
        <ReadOnlyJson label="Input schema" value={agent.inputSchema} />
        <ReadOnlyJson label="Output schema" value={agent.outputSchema} />
        {agent.tools?.length ? <ReadOnlyJson label="Tools" value={agent.tools} /> : null}
        {agent.compiledConfig ? <ReadOnlyJson label="Compiled config" value={agent.compiledConfig} /> : null}
      </div>
    </details>
  );
}

export interface AgentOverviewProps {
  agent: Agent;
  lineage: AgentLineage;
  /** Super admin (impersonation-aware) — the only audience for "Technical details". */
  elevated: boolean;
}

export function AgentOverview({ agent, lineage, elevated }: AgentOverviewProps) {
  return (
    <div className="flex flex-col gap-3">
      <SummarySection title="About">
        <FactList
          facts={[
            { label: 'What it does', value: `${AGENT_TASK_LABEL[agent.task]} — ${AGENT_TASK_PURPOSE[agent.task]}` },
            { label: 'Description', value: agent.description?.trim() || '—' },
            {
              label: 'Version',
              value: `v${agent.versionNumber} of ${lineage.versionCount} · ${agent.isActive ? 'Live' : STATUS_WORDS[agent.status]}${lineage.deprecatedCount > 0 ? ` · ${lineage.deprecatedCount} deprecated` : ''}`,
            },
            { label: 'Published', value: agent.publishedAt ? formatDateTime(agent.publishedAt) : 'Not yet' },
            { label: 'Last changed', value: formatDateTime(agent.updatedAt) },
          ]}
        />
      </SummarySection>
      <FindingsList agent={agent} />
      <AgentConfigurationSummary agent={agent} />
      {elevated ? <TechnicalDetails agent={agent} lineage={lineage} /> : null}
    </div>
  );
}
