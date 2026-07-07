'use client';

import { useState } from 'react';
import { IconBolt } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { useSession } from '@/shared/auth';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useDnaJobProgress, useDnaSettings, useGenerateMyStyle, useMyReports, useMyStyle } from '../api';
import { DnaSettingsCard } from './dna-settings-card';
import { GeneratePane } from './generate-pane';
import { ImpersonationGatePanel } from './impersonation-gate-panel';
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

    const refreshing = (myStyle.isFetching || mine.isFetching || settings.isFetching) && !myStyle.isPending && !mine.isPending;

    return (
        <ScreenTemplate
            header={
                <PageHeader
                    title="My DNA Writing Style"
                    meta={
                        <>
                            <span>Per-doctor writing-style reports (PHI-derived) {'\u2014'} the self/doctor plane.</span>
                            {mine.data ? (
                                <span>
                                    {mine.data.length} {mine.data.length === 1 ? 'report' : 'reports'}
                                </span>
                            ) : mine.isPending ? (
                                <Skeleton className="h-4 w-16" />
                            ) : null}
                        </>
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
            }
            footer={
                <StatusFooter
                    start={<span>{refreshing ? 'Refreshing' : 'Up to date'}</span>}
                    end={
                        <span aria-hidden className="font-mono">
                            GET /dna-writing-styles {'\u00b7'} matrix row 37
                        </span>
                    }
                />
            }
        >
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,22rem)]">
                <div className="flex flex-col gap-4">
                    <ImpersonationGatePanel session={safe} gated={gated} />
                    <DnaSettingsCard settings={settings} gated={gated} onGate={() => setGateHit(true)} />
                </div>
                <div className="flex flex-col gap-4">
                    <MyStyleCard
                        myStyle={myStyle}
                        settings={settings}
                        gated={gated}
                        onGenerate={handleGenerate}
                        generatePending={generate.isPending}
                    />
                    <MyReportsCard reports={mine} myStyleReportId={myStyle.data?.data.id ?? null} />
                </div>
                <GeneratePane
                    samplesText={samplesText}
                    onSamplesTextChange={setSamplesText}
                    onGenerate={handleGenerate}
                    isPending={generate.isPending}
                    gated={gated}
                    activeJobId={activeJobId}
                    progress={progress}
                />
            </div>
        </ScreenTemplate>
    );
}

/**
 * Frame 53 — My DNA Writing Style (playground tier 50-59, matrix row 37).
 * The SELF/doctor plane over `dna-writing-styles/*` (the tenant-admin grid
 * is the separate frame 33 feature). Tenant-scoped: elevated sessions need a
 * working tenant before any query mounts; tenant admins pass straight
 * through (tenant-pinned).
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
