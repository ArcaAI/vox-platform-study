'use client';

/**
 * Workflow Studio — Integration tab (TASK-1036 §3.6): how a developer reaches THIS workflow, as five
 * numbered steps — Authenticate → Connect → Send input → Receive output → Handle errors — each with a
 * vox-node (`RunHandle`), a vox (browser, 5.0) and a raw HTTP / SSE / socket snippet.
 *
 * Everything is derived, nothing is typed by hand:
 *  - the slug and lifecycle from the definition;
 *  - the connections from the EFFECTIVE settings (`graph.settings`, or — for one release — the
 *    legacy trigger kinds and output protocols), so Connect never documents a lane the workflow
 *    does not enable;
 *  - the Input and Output shapes from the workflow's context schema (a referenced schema version, or
 *    an inline payload schema), which also feeds the example input and the audio / attachment notes.
 *
 * A DRAFT still shows the snippets — with its slug — under a "publish this version" banner: the
 * guide is useful before there is an endpoint, and the banner says why the calls would not work yet.
 * Replaces the placeholder the studio shell (lane C2a) mounted; the props contract is unchanged.
 */
import { useMemo, useState } from 'react';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { effectiveSettings } from '@arcaai/workflow-contract';
import { Alert, AlertDescription, AlertTitle, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui';
import { publicEnv } from '@/config/public-env';
import { useContextSchemaDefinition } from '@/shared/catalog';
import { CopyButton } from '@/shared/copy-button';
import { RUN_GUIDE_LANES, RUN_GUIDE_LANE_LABEL, buildRunGuide, type RunGuideLane } from '@/shared/docs/run-guide';
import { deriveRunShapes } from '@/shared/docs/run-shapes';
import { useWorkflowDefinition } from '../../api/hooks';
import type { WorkflowDefinition } from '../../api/types';
import { RunGuideSteps } from './run-guide-steps';
import { ShapeTables } from './shape-tables';

export interface IntegrationTabProps {
  definitionId: string;
  /**
   * The editor buffer has changes that are not saved. This guide is built from the SAVED
   * definition, so the tab says so rather than letting the snippets pass for the canvas.
   */
  unsavedChanges?: boolean;
}

type EffectiveInput = Parameters<typeof effectiveSettings>[0];

function LifecycleBanner({ definition }: { definition: WorkflowDefinition }) {
  if (definition.status === 'DRAFT' || definition.status === 'VALIDATED') {
    return (
      <Alert role="status">
        <IconInfoCircle aria-hidden />
        <AlertTitle>Publish this version to get a live endpoint</AlertTitle>
        <AlertDescription>
          <code className="font-mono">{definition.slug}</code> is not callable until a version is published and active. The snippets below are what you will
          write against it; the calls will not work yet.
        </AlertDescription>
      </Alert>
    );
  }
  if (definition.status === 'DEPRECATED') {
    return (
      <Alert role="status">
        <IconAlertTriangle aria-hidden />
        <AlertTitle>This version is deprecated</AlertTitle>
        <AlertDescription>
          A deprecated version does not serve new runs. The endpoint resolves the active version of <code className="font-mono">{definition.slug}</code>, if there is one.
        </AlertDescription>
      </Alert>
    );
  }
  if (!definition.isActive) {
    return (
      <Alert role="status">
        <IconInfoCircle aria-hidden />
        <AlertTitle>Published, not active</AlertTitle>
        <AlertDescription>
          This version is frozen, but the endpoint keeps resolving the ACTIVE version of <code className="font-mono">{definition.slug}</code>. Activate it from the
          version history when it should serve.
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-3 p-1" aria-hidden>
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function IntegrationTab({ definitionId, unsavedChanges = false }: IntegrationTabProps) {
  const query = useWorkflowDefinition(definitionId);
  const definition = query.data?.data;
  const [lane, setLane] = useState<RunGuideLane>('vox-node');

  const effective = useMemo(() => (definition ? effectiveSettings(definition.graph as EffectiveInput) : null), [definition]);
  const setting = effective?.contextSchema ?? null;
  const reference = setting && 'contextSchemaId' in setting ? setting : null;
  // Called unconditionally (hooks): `null` id = nothing to fetch.
  const fetched = useContextSchemaDefinition(reference?.contextSchemaId ?? null, reference?.versionNumber ?? null);
  const schema = setting && 'inline' in setting ? setting.inline : reference ? fetched.definition : null;
  const shapes = useMemo(() => deriveRunShapes(schema), [schema]);

  const connections = effective?.connections;
  const steps = useMemo(
    () =>
      definition && connections
        ? buildRunGuide({
            kind: 'workflow',
            slug: definition.slug,
            connections,
            exampleInput: shapes.exampleInput,
            streamAudioIn: shapes.streamAudioIn,
            attachmentsIn: shapes.attachmentsIn,
            streamAudioOut: shapes.streamAudioOut,
            baseUrl: publicEnv.apiHost,
          })
        : [],
    [definition, connections, shapes],
  );

  if (query.isPending) return <LoadingState />;
  if (query.isError || !definition) {
    return (
      <Alert variant="destructive">
        <IconAlertTriangle aria-hidden />
        <AlertTitle>Couldn&apos;t read this workflow</AlertTitle>
        <AlertDescription>The integration guide is built from the saved definition, which could not be loaded. Reload the studio to retry.</AlertDescription>
      </Alert>
    );
  }

  const runPath = `POST /workflows/${definition.slug}/runs`;

  return (
    <section data-slot="workflow-integration-tab" data-definition-id={definitionId} aria-labelledby={`integration-${definitionId}`} className="@container flex flex-col gap-4 p-1">
      <header className="flex flex-col gap-2">
        <h2 id={`integration-${definitionId}`} className="text-lg font-semibold">
          Integration
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <code className="bg-muted rounded-md border px-2 py-1 font-mono text-xs">{runPath}</code>
          <CopyButton value={runPath} label="Copy the run endpoint" />
        </div>
      </header>

      {unsavedChanges ? (
        <p role="status" className="border-warning/40 bg-warning/10 text-warning-strong rounded-md border px-3 py-2 text-sm">
          Showing the saved version — save to update.
        </p>
      ) : null}

      <LifecycleBanner definition={definition} />

      <ShapeTables input={shapes.input} output={shapes.output} loading={reference !== null && fetched.isLoading} />

      <Tabs value={lane} onValueChange={(next) => setLane(next as RunGuideLane)} className="gap-3">
        <TabsList aria-label="SDK or protocol">
          {RUN_GUIDE_LANES.map((name) => (
            <TabsTrigger key={name} value={name}>
              {RUN_GUIDE_LANE_LABEL[name]}
            </TabsTrigger>
          ))}
        </TabsList>
        {RUN_GUIDE_LANES.map((name) => (
          <TabsContent key={name} value={name}>
            <RunGuideSteps steps={steps} lane={name} />
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
