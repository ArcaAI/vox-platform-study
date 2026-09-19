'use client';

import { useState } from 'react';
import { IconBolt } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { useSession } from '@/shared/auth';
import { CanvasHeader, PlaygroundCanvas } from '@/features/playground-shared/components/playground-canvas';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useDnaJobProgress, useDnaSettings, useGenerateMyStyle, useMyRedactionRules, useMyReports, useMyStyle } from '../api';
import type { DnaJobStatus } from '../api';
import { DnaErasureCard } from './dna-erasure-card';
import { DnaRedactionCard } from './dna-redaction-card';
import { DnaSettingsCard } from './dna-settings-card';
import { GeneratePane } from './generate-pane';
import { ImpersonationGatePanel } from './impersonation-gate-panel';
import { IngestPane } from './ingest-pane';
import { MyReportsCard } from './my-reports-card';
import { MyStyleCard } from './my-style-card';

/** Mirrors the gateway's DNA_DOCTOR_ROLES set behind `assertActingAsDoctor`. */
const CLINICAL_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'];

/** Blank-line-separated blocks become individual textSamples; empty = server-side gathering. */
function splitTextSamples(samplesText: string): string[] {
  return samplesText
    .split(/\n\s*\n/)
    .map((sample) => sample.trim())
    .filter(Boolean);
}

/**
 * The one line the footer status bar carries — generation is the page's only
 * async verb. Deliberately no percentage: `GeneratePane` owns the progress
 * readout, and the pinned footer must not repeat it (it would double-announce
 * every SSE tick through the footer's polite live region).
 */
function footerStatus(gated: boolean, queuing: boolean, job: DnaJobStatus | null): string {
  if (gated) return 'Read-only — generation and settings need a doctor context';
  if (queuing) return 'Queuing the generation job…';
  if (!job) return 'Idle — no generation this session';
  switch (job.status) {
    case 'completed':
      return 'Generation complete — your style was updated';
    case 'failed':
      return job.error ? `Generation failed — ${job.error}` : 'Generation failed';
    default:
      return 'Generating your style…';
  }
}

function MyDnaStyleBody() {
  const session = useSession();
  // Reactive gate: a 403 from generate / PUT settings is the DESIGNED gate
  // state (assertActingAsDoctor), surfaced by the panel — never a toast.
  const [gateHit, setGateHit] = useState(false);

  const safe = session.data;
  const impersonating = !!safe?.impersonatingUserId;
  const clinical = safe?.user.roles.some((role) => CLINICAL_ROLES.includes(role)) ?? false;
  // Proactive gate: everyone on this screen is an admin (tier 50-59 layout
  // guard), so no doctor context = gated, matching the gateway check.
  const gated = gateHit || (!!safe && !impersonating && !clinical);

  const myStyle = useMyStyle();
  const mine = useMyReports();
  const settings = useDnaSettings();
  const redaction = useMyRedactionRules();

  const [samplesText, setSamplesText] = useState('');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const generate = useGenerateMyStyle();
  const progress = useDnaJobProgress(activeJobId, {
    onTerminal: (job) => {
      if (job.status === 'completed') {
        toast.success('DNA style generated');
      } else {
        toast.error(job.error || 'DNA generation failed');
      }
    },
  });

  function handleGenerate() {
    const textSamples = splitTextSamples(samplesText);
    generate.mutate(textSamples.length > 0 ? { textSamples } : {}, {
      onSuccess: (job) => setActiveJobId(job.jobId),
      onError: (error) => {
        if (error instanceof GatewayError && error.status === 403) {
          setGateHit(true);
          return;
        }
        toast.error(error instanceof GatewayError ? error.message : 'Could not queue the generation job.');
      },
    });
  }

  return (
    <ScreenTemplate
      header={
        <div className="mx-auto w-full max-w-[760px] px-4">
          <CanvasHeader
            title="My DNA Writing Style"
            description={'Your personal writing style \u00b7 versioned \u00b7 generation streams over SSE'}
            badges={
              mine.data ? (
                <span className="text-muted-foreground text-xs">
                  {mine.data.length} {mine.data.length === 1 ? 'report' : 'reports'}
                </span>
              ) : mine.isPending ? (
                <Skeleton className="h-4 w-16" />
              ) : null
            }
            actions={
              <>
                {gated ? <span className="text-muted-foreground text-xs">Requires acting as a doctor</span> : null}
                <Button onClick={handleGenerate} disabled={gated || generate.isPending}>
                  {generate.isPending ? <Spinner /> : <IconBolt aria-hidden />}
                  Generate my style
                </Button>
              </>
            }
          />
        </div>
      }
      footer={
        <StatusFooter
          start={footerStatus(gated, generate.isPending, progress.job)}
          end={
            activeJobId ? (
              <span className="font-mono" title={activeJobId}>
                job {activeJobId}
              </span>
            ) : null
          }
        />
      }
    >
      <PlaygroundCanvas>
        {/* Centered flow (\u00a74): gate/status \u2192 settings \u2192 current style \u2192
                generate \u2192 ingest \u2192 history \u2192 erasure. The gate remains the
                DESIGNED assertActingAsDoctor state; switching persona now happens in the
                top-bar persona control. Erasure sits LAST, after the history it destroys. */}
        <ImpersonationGatePanel session={safe} gated={gated} />
        <DnaSettingsCard settings={settings} gated={gated} onGate={() => setGateHit(true)} />
        <MyStyleCard myStyle={myStyle} settings={settings} gated={gated} onGenerate={handleGenerate} generatePending={generate.isPending} />
        <DnaRedactionCard myStyle={myStyle} redaction={redaction} settings={settings} gated={gated} />
        <GeneratePane
          samplesText={samplesText}
          onSamplesTextChange={setSamplesText}
          onGenerate={handleGenerate}
          isPending={generate.isPending}
          gated={gated}
          activeJobId={activeJobId}
          progress={progress}
        />
        <IngestPane gated={gated} onGate={() => setGateHit(true)} />
        <MyReportsCard reports={mine} myStyleReportId={myStyle.data?.data.id ?? null} gated={gated} onGate={() => setGateHit(true)} />
        <DnaErasureCard reports={mine} settings={settings} gated={gated} onGate={() => setGateHit(true)} />
      </PlaygroundCanvas>
    </ScreenTemplate>
  );
}

/**
 * Frame 53 — My DNA Writing Style (playground tier 50-59, matrix row 37).
 * The SELF/doctor plane over `dna-writing-styles/*` (the tenant-admin grid
 * is the separate frame 33 feature). Tenant-scoped: elevated sessions need a
 * working tenant before any query mounts; tenant admins pass straight
 * through (tenant-pinned).
 *
 * Frame: `ScreenTemplate` (rule 11 §1) in `scroll` mode — the canvas header
 * and the generation status bar are pinned, the centered card flow scrolls
 * between them.
 */
export function MyDnaStyleScreen() {
  return (
    <WorkingTenantGate
      title="My DNA Writing Style"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /dna-writing-styles/my-style
        </span>
      }
      description="Playground actions run in the working tenant under your account. Pick a working tenant from the switcher in the top bar to load your DNA style."
    >
      <MyDnaStyleBody />
    </WorkingTenantGate>
  );
}
