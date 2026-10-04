'use client';

/**
 * The numbered steps of the Integration tab (TASK-1036 §3.6): Authenticate → Connect → Send input →
 * Receive output → Handle errors. The content is `buildRunGuide`'s; this file only lays it out.
 *
 * One lane is shown at a time (vox-node · vox 5.0 · raw), chosen by the tab list the parent owns, so
 * a step never prints three copies of the same idea at once. Every step has a snippet in every lane.
 */
import { IconCircleCheck, IconCircleDashed } from '@tabler/icons-react';
import { Badge, FieldDescription } from '@arcaai/ui';
import { CopyButton } from '@/shared/copy-button';
import type { RunGuideLane, RunGuideStep } from '@/shared/docs/run-guide';
import { CONNECTION_COPY } from '../../lib/settings-model';

export function SnippetBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="group/code relative" role="group" aria-label={label}>
      <pre tabIndex={0} className="bg-muted text-foreground overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton value={code} label={`Copy the ${label}`} />
      </div>
    </div>
  );
}

function ConnectionList({ lanes }: { lanes: NonNullable<RunGuideStep['lanes']> }) {
  return (
    <ul className="flex flex-col gap-1.5" role="list" aria-label="Connections">
      {lanes.map((lane) => (
        <li key={lane.connection} className="flex flex-wrap items-start gap-x-2 gap-y-0.5 text-sm">
          {lane.enabled ? <IconCircleCheck aria-hidden className="text-success mt-0.5 size-4 shrink-0" /> : <IconCircleDashed aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />}
          <span className={lane.enabled ? 'font-medium' : 'text-muted-foreground font-medium'}>{CONNECTION_COPY[lane.connection].label}</span>
          {lane.enabled ? <Badge variant="default">Enabled</Badge> : <Badge variant="outline">Off in Settings</Badge>}
          <span className="text-muted-foreground w-full pl-6 text-xs">{lane.summary}</span>
        </li>
      ))}
    </ul>
  );
}

export interface RunGuideStepsProps {
  steps: readonly RunGuideStep[];
  lane: RunGuideLane;
}

export function RunGuideSteps({ steps, lane }: RunGuideStepsProps) {
  return (
    <ol role="list" aria-label="Integration steps" className="flex flex-col gap-4">
      {steps.map((step, index) => {
        const snippets = step.snippets.filter((snippet) => snippet.lane === lane);
        return (
          <li key={step.id} className="flex min-w-0 flex-col gap-3 rounded-lg border p-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-semibold">{`${index + 1}. ${step.title}`}</h3>
              <p className="text-muted-foreground text-sm">{step.summary}</p>
            </div>
            {step.lanes ? <ConnectionList lanes={step.lanes} /> : null}
            {snippets.map((snippet) => (
              <div key={snippet.label} className="flex flex-col gap-1">
                <FieldDescription>{snippet.label.replace(/ snippet$/, '')}</FieldDescription>
                <SnippetBlock label={snippet.label} code={snippet.code} />
              </div>
            ))}
            {step.notes.length > 0 ? (
              <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-5 text-xs" role="list">
                {step.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
