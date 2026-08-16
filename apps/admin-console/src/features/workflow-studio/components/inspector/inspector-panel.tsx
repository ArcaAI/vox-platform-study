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
 */
import { CodeEditor, Empty, EmptyDescription, EmptyMedia, EmptyTitle, Skeleton } from '@arcaai/ui';
import { IconLayoutBoard } from '@tabler/icons-react';
import { useState } from 'react';
import { toFieldDescriptors, type FieldDescriptor } from '../../lib/schema-form';
import type { WorkflowFinding } from '../../api/types';
import type { GraphStoreNode } from '../../store/types';
import { FieldRenderer } from './field-renderers';
import { NO_SCHEMA_REASON } from './raw-json-field';

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
    return <WholeConfigJsonEditor node={node} onConfigChange={onConfigChange} />;
  }

  const descriptors = toFieldDescriptors(configSchema);
  const knownPaths = new Set(flattenPaths(descriptors));
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
