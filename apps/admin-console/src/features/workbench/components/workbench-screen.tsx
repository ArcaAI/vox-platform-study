'use client';

import { useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { PlaygroundBanner } from '@/shared/page/playground-banner';
import { PageHeader } from '@/shared/page/page-header';
import { SandboxBanner } from '@/shared/page/sandbox-banner';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { useWorkflowDefinitions } from '../api/hooks';
import { FixturePicker } from './fixture-picker';
import { NodeRunInspector } from './node-run-inspector';
import { RelatedPlaygrounds } from './related-playgrounds';
import { RunPanel } from './run-panel';

/**
 * The Workbench (TASK-721 Phase C) — extends the playground tier (design.md §Plane 3):
 * sandboxed interpreter runs against synthetic inputs. Region contract (rule 11 §1 Screen
 * Template): `header` (one h1) → `statusBanner` (sandbox watermark + the playground own-account
 * disclosure) → `toolbar` (definition + fixture selectors) → content (run panel, node
 * inspector, cross-links to the existing STT/text-gen playgrounds).
 *
 * `?definitionId=` is the ONLY identity param the URL needs: a `WorkflowDefinition` row IS a
 * version (`workflow-definition.prisma`'s own file header) — there is no separate "version"
 * concept to select once a row is chosen. This is a deliberate, narrower choice than the
 * ticket's original `?definitionId=&version=` sketch, made once Task 2's contract review
 * confirmed the row-is-a-version model; see the ticket README §7.
 *
 * Isolated node test (§1 item 4) is NOT rendered — Task 2's contract confirmed the interpreter
 * has no single-node dispatch entry point (R2's blocking condition). Simulating it client-side
 * would produce results the interpreter would not; the gap is documented, not built.
 */
export function WorkbenchScreen() {
  const [definitionId, setDefinitionId] = useQueryState('definitionId', parseAsString);
  const [fixtureId, setFixtureId] = useQueryState('fixtureId', parseAsString);
  // Not URL state deliberately — a run id is a one-shot artifact of THIS visit, not a
  // shareable filter (nuqs is reserved for shareable state per rule 13 §Data & State).
  const [runId, setRunId] = useState<string | null>(null);

  const definitionsQuery = useWorkflowDefinitions();
  const definitions = definitionsQuery.data?.data ?? [];

  return (
    <ScreenTemplate
      header={<PageHeader title="Workbench" meta="Run a workflow definition — DRAFT or published — in sandbox mode against a synthetic input." />}
      statusBanner={
        <div className="flex flex-col gap-2">
          <SandboxBanner />
          <PlaygroundBanner />
        </div>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-3">
          {definitionsQuery.isLoading ? (
            <Skeleton className="h-9 w-64" />
          ) : (
            <Select value={definitionId ?? ''} onValueChange={(next) => setDefinitionId(next || null)}>
              <SelectTrigger className="w-72" aria-label="Workflow definition">
                <SelectValue placeholder="Choose a workflow definition" />
              </SelectTrigger>
              <SelectContent>
                {definitions.map((definition) => (
                  <SelectItem key={definition.id} value={definition.id}>
                    {definition.name} · v{definition.versionNumber} · {definition.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <FixturePicker workflowDefinitionId={definitionId} value={fixtureId} onChange={setFixtureId} />
        </div>
      }
      contentMode="scroll"
    >
      <div className="flex flex-col gap-6">
        <RunPanel definitionId={definitionId} fixtureId={fixtureId} onRunIdChange={setRunId} />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Node inspector</h2>
            <NodeRunInspector runId={runId} />
          </div>
          <RelatedPlaygrounds />
        </div>
      </div>
    </ScreenTemplate>
  );
}
