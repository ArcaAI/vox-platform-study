'use client';

/**
 * `InspectorPanel` (TASK-719 Task 9) — the node config editor. Descriptors compiled by
 * `toFieldDescriptors` (Task 8, `lib/schema-form.ts`) render through the `Field` family
 * (`field-renderers.tsx`); a node type with NO delivered config schema — the REAL registry
 * state today, see `contracts/registry.contract.md` — falls back whole-panel to the raw
 * `CodeEditor`, never a bare `<Textarea>` (rule 11).
 *
 * Server `ValidationReport` problems for the selected node are matched to a field by
 * `WorkflowFinding.path` and rendered via `FieldError`, distinguished from any future
 * client-side fast-fail problems by their `ruleId` prefix (`WF-*`) — this panel never
 * re-validates client-side; `jsonSchemaValueProblems` is not called here (README pitfall 1 /
 * Task 8's own discipline: the compiler only decides how to RENDER, never whether a value is
 * valid).
 *
 * TASK-810 §7b item 2 does the mirror-image swap for DD-2's DOCUMENT binding: where the schema
 * DOES declare `documentTemplateId`, its two generated fields (a free-text UUID box and a bare
 * number box) are withheld and one `DocumentBindingField` renders in their place — a picker over
 * the tenant's servable templates plus a version pin that reports its own staleness. It is keyed
 * on the schema DECLARING the binding rather than on a node-type allow-list, so the next
 * generation node someone registers gets the control for free; and it is never offered on the
 * no-schema fallback, because a node type with no schema (`passthrough`) has no document shape to
 * bind.
 *
 * Task 19 adds a standalone `PromptTemplatePicker` section (`config.promptTemplateId`) — shown
 * whenever the schema does NOT already declare a field at that path (the real registry state
 * today: no delivered node type has a config schema at all, so `promptTemplateId` is otherwise
 * unreachable except by hand-editing raw JSON). If a future schema DOES declare
 * `promptTemplateId` itself, the generic `field-renderers.tsx` string control already renders it
 * and this section steps aside rather than offering a second, duplicate control for the same key.
 */
import { CodeEditor, Empty, EmptyDescription, EmptyMedia, EmptyTitle, Skeleton } from '@arcaai/ui';
import { IconLayoutBoard } from '@tabler/icons-react';
import { useState } from 'react';
import { toFieldDescriptors, type FieldDescriptor } from '../../lib/schema-form';
import type { WorkflowFinding } from '../../api/types';
import type { GraphStoreNode } from '../../store/types';
import { DocumentBindingField } from './document-binding-field';
import { FieldRenderer } from './field-renderers';
import { PromptTemplatePicker } from './prompt-template-picker';
import { NO_SCHEMA_REASON } from './raw-json-field';

const PROMPT_TEMPLATE_PATH = 'promptTemplateId';
const DOCUMENT_TEMPLATE_PATH = 'documentTemplateId';
const DOCUMENT_VERSION_PATH = 'documentVersionNumber';
/** The two schema-declared keys `DocumentBindingField` renders as ONE control. */
const DOCUMENT_BINDING_PATHS = new Set<string>([DOCUMENT_TEMPLATE_PATH, DOCUMENT_VERSION_PATH]);

export interface InspectorPanelProps {
  node: GraphStoreNode | null;
  /** The registry node-type's config JSON Schema, or `undefined` when none is known — an
   *  always-possible state against the real registry today, not an edge case. */
  configSchema: unknown | undefined;
  /** Server findings for THIS node only (already filtered by `nodeId` — see
   *  `store/selectors.ts#findingsByNodeId`). */
  problems: WorkflowFinding[];
  onConfigChange: (config: Record<string, unknown>) => void;
  loading?: boolean;
  readOnly?: boolean;
}

function errorsForPath(problems: WorkflowFinding[], path: string): string[] {
  return problems.filter((problem) => (problem.path ?? '') === path).map((problem) => problem.message);
}

function flattenPaths(descriptors: FieldDescriptor[]): string[] {
  return descriptors.flatMap((descriptor) => {
    if (descriptor.kind === 'group') return [descriptor.path, ...flattenPaths(descriptor.fields)];
    if (descriptor.kind === 'discriminated') return [descriptor.path, ...descriptor.branches.flatMap((branch) => flattenPaths(branch.fields))];
    return [descriptor.path];
  });
}

function promptTemplateValue(config: Record<string, unknown>): string {
  const value = config[PROMPT_TEMPLATE_PATH];
  return typeof value === 'string' ? value : '';
}

function PromptTemplateSection({
  node,
  onConfigChange,
  problems,
  readOnly,
}: {
  node: GraphStoreNode;
  onConfigChange: (config: Record<string, unknown>) => void;
  problems: WorkflowFinding[];
  readOnly?: boolean;
}) {
  return (
    <PromptTemplatePicker
      id={`${node.id}-${PROMPT_TEMPLATE_PATH}`}
      label="Prompt template"
      description="Optional — links this node to a tenant prompt template."
      value={promptTemplateValue(node.config)}
      onChange={(next) => {
        const { [PROMPT_TEMPLATE_PATH]: _omit, ...rest } = node.config;
        onConfigChange(next ? { ...rest, [PROMPT_TEMPLATE_PATH]: next } : rest);
      }}
      disabled={readOnly}
      errors={errorsForPath(problems, PROMPT_TEMPLATE_PATH)}
    />
  );
}

function WholeConfigJsonEditor({ node, onConfigChange }: { node: GraphStoreNode; onConfigChange: (config: Record<string, unknown>) => void }) {
  const [text, setText] = useState(() => JSON.stringify(node.config, null, 2));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">{NO_SCHEMA_REASON}</p>
      <CodeEditor
        aria-label={`${node.type} configuration (JSON)`}
        value={text}
        onChange={(next) => {
          setText(next);
          try {
            onConfigChange(JSON.parse(next));
          } catch {
            // Invalid JSON mid-edit — CodeEditor's own toolbar surfaces the parse error.
          }
        }}
      />
    </div>
  );
}

export function InspectorPanel({ node, configSchema, problems, onConfigChange, loading, readOnly }: InspectorPanelProps) {
  if (!node) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <IconLayoutBoard aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No node selected</EmptyTitle>
        <EmptyDescription>Select a node on the canvas or in the list view to configure it.</EmptyDescription>
      </Empty>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-6 w-11" />
      </div>
    );
  }

  if (configSchema === undefined) {
    return (
      <div className="flex flex-col gap-4">
        <WholeConfigJsonEditor node={node} onConfigChange={onConfigChange} />
        <PromptTemplateSection node={node} onConfigChange={onConfigChange} problems={problems} readOnly={readOnly} />
      </div>
    );
  }

  const allDescriptors = toFieldDescriptors(configSchema);
  // The document binding's own two descriptors are withheld from the generic renderer, not
  // dropped: `DocumentBindingField` renders both keys, and their paths stay in `knownPaths` so a
  // server finding at either one is still routed to a field rather than to the graph-level list.
  const descriptors = allDescriptors.filter((descriptor) => !DOCUMENT_BINDING_PATHS.has(descriptor.path));
  const hasDocumentBinding = descriptors.length !== allDescriptors.length;
  const knownPaths = new Set(flattenPaths(allDescriptors));
  const graphLevelErrors = problems.filter((problem) => !knownPaths.has(problem.path ?? ''));

  return (
    <fieldset disabled={readOnly} className="flex flex-col gap-4">
      {descriptors.map((descriptor) => (
        <FieldRenderer
          key={descriptor.path}
          descriptor={descriptor}
          config={node.config}
          onConfigChange={onConfigChange}
          errors={errorsForPath(problems, descriptor.path)}
          idPrefix={node.id}
        />
      ))}
      {hasDocumentBinding ? (
        <DocumentBindingField
          idPrefix={node.id}
          config={node.config}
          onConfigChange={onConfigChange}
          templateErrors={errorsForPath(problems, DOCUMENT_TEMPLATE_PATH)}
          versionErrors={errorsForPath(problems, DOCUMENT_VERSION_PATH)}
        />
      ) : null}
      {!knownPaths.has(PROMPT_TEMPLATE_PATH) ? (
        <PromptTemplateSection node={node} onConfigChange={onConfigChange} problems={problems} readOnly={readOnly} />
      ) : null}
      {graphLevelErrors.length > 0 ? (
        <div role="alert" className="text-destructive text-sm">
          {graphLevelErrors.map((problem) => (
            <p key={`${problem.ruleId}-${problem.message}`}>{problem.message}</p>
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}
