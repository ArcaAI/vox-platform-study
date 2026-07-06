'use client';

import { useId, useState } from 'react';
import { IconAdjustmentsHorizontal, IconBuildingHospital, IconLock } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { formatBytes, formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import type { CapabilityUsageRow, EntitlementCapabilities } from '@/features/entitlements/api/types';
import type { TenantConfig, TenantPlan } from '@/features/tenants/api/types';
import { useMyEntitlements, useMyTenant, useMyTenantConfigs, useUpdateMyTenantConfigs } from '../api/hooks';

const EM_DASH = '\u2014';

const PLAN_LABELS: Record<TenantPlan, string> = {
    ENTERPRISE: 'Enterprise',
    PRO: 'Pro',
    STARTER: 'Starter',
    TRIAL: 'Trial',
};

/** Display names for the gateway's stable capability keys (unknown keys render as-is). */
const CAPABILITY_LABELS: Record<string, string> = {
    users: 'Users',
    departments: 'Departments',
    promptTemplates: 'Prompt templates',
    asrPipelines: 'ASR pipelines',
    apiKeys: 'API keys',
    storageBytes: 'Storage',
    concurrentSessions: 'Concurrent sessions',
    monthlyConsultations: 'Consultations',
    monthlyTranscriptionMinutes: 'Transcription minutes',
    monthlySummaries: 'Summaries',
};

const FEATURE_LABELS: { key: keyof EntitlementCapabilities['features']; label: string }[] = [
    { key: 'dnaReports', label: 'DNA reports' },
    { key: 'voiceEnrollment', label: 'Voice enrollment' },
    { key: 'monitoringAccess', label: 'Monitoring access' },
];

/**
 * GET /tenant/me answers 400 for a session without tenant context (and a
 * cross-tenant read would surface as 404) — both mean "pick a working
 * tenant", not a failure (frame 25 NoTenant variant).
 */
function isNoTenantError(error: unknown): boolean {
    return error instanceof GatewayError && (error.status === 400 || error.isNotFound);
}

function isOccError(error: unknown): boolean {
    return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

function capabilityUsage(row: CapabilityUsageRow): string {
    const format = row.key === 'storageBytes' ? formatBytes : formatNumber;
    const used = format(row.used ?? null);
    return row.unlimited ? `${used} / Unlimited` : `${used} / ${format(row.limit ?? null)}`;
}

function IdentityField({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-1 text-sm">{children}</dd>
        </div>
    );
}

function CapabilityList({ title, rows }: { title: string; rows: CapabilityUsageRow[] }) {
    return (
        <Card className="gap-3 p-4">
            <h3 className="text-sm font-semibold">{title}</h3>
            <dl className="flex flex-col gap-2">
                {rows.map((row) => (
                    <div key={row.key} className="flex flex-wrap items-center justify-between gap-2">
                        <dt className="text-muted-foreground text-sm">{CAPABILITY_LABELS[row.key] ?? row.key}</dt>
                        <dd className="flex items-center gap-2 text-sm">
                            <span className="tabular-nums">{capabilityUsage(row)}</span>
                            {row.exceeded ? (
                                <StatusBadge label="Exceeded" colorRole="destructive" icon={<StatusDot colorRole="destructive" size="sm" />} />
                            ) : row.nearLimit ? (
                                <StatusBadge label="Near limit" colorRole="warning" icon={<StatusDot colorRole="warning" size="sm" />} />
                            ) : null}
                        </dd>
                    </div>
                ))}
            </dl>
        </Card>
    );
}

/** Skeletons mirroring the three loaded regions (rule 10). */
function TenantProfileSkeleton() {
    return (
        <div className="flex flex-col gap-6" aria-hidden>
            <Card className="p-6">
                <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                    {Array.from({ length: 8 }, (_, index) => (
                        <div key={index} className="flex flex-col gap-2">
                            <Skeleton className="h-3 w-24" />
                            <Skeleton className="h-5 w-40 max-w-full" />
                        </div>
                    ))}
                </div>
            </Card>
            <div className="grid gap-4 lg:grid-cols-3">
                {Array.from({ length: 3 }, (_, index) => (
                    <Skeleton key={index} className="h-40" />
                ))}
            </div>
            <div className="flex flex-col gap-2 rounded-md border p-3">
                {Array.from({ length: 3 }, (_, index) => (
                    <Skeleton key={index} className="h-12 w-full" />
                ))}
            </div>
        </div>
    );
}

/**
 * Frame 25 (tenant half) — Tenant profile (/tenant-profile, tier 20-29).
 * Self-service view of the working tenant: read-only identity (no self-serve
 * tenant PATCH exists), entitlement/usage snapshot, and the editable
 * tenant/me/config rows saved per row with If-Match (412 -> OCC alert).
 * Tenant-less global admins get the frame's NoTenant empty state.
 */
export function TenantProfileScreen() {
    const uid = useId();
    const tenantQuery = useMyTenant();
    const entitlementsQuery = useMyEntitlements();
    const configsQuery = useMyTenantConfigs();
    const updateConfigs = useUpdateMyTenantConfigs();
    const [drafts, setDrafts] = useState<Record<string, string>>({});

    const tenant = tenantQuery.data;
    const capabilities = entitlementsQuery.data;
    const configRows = configsQuery.data?.data.data ?? [];
    const isBusy = tenantQuery.isFetching || entitlementsQuery.isFetching || configsQuery.isFetching;

    function saveConfig(config: TenantConfig) {
        const value = drafts[config.id];
        if (value === undefined) return;
        // Single-row save: If-Match carries this row's version (the header
        // folds onto every row server-side and overrides the body field).
        updateConfigs.mutate(
            { updates: [{ id: config.id, value, expectedVersion: config.version }], etag: `"${config.version}"` },
            {
                onSuccess: () => {
                    toast.success(`${config.key} updated`);
                    setDrafts(({ [config.id]: _saved, ...rest }) => rest);
                },
                onError: (error) => {
                    if (!isOccError(error)) {
                        toast.error(error instanceof GatewayError ? error.message : 'Could not update the setting.');
                    }
                },
            },
        );
    }

    return (
        <ScreenTemplate
            header={
                <PageHeader
                    title="Tenant profile"
                    meta={
                        tenant ? (
                            <>
                                <span>{tenant.name}</span>
                                <span aria-hidden>&middot;</span>
                                <span className="font-mono text-xs">{tenant.key}</span>
                            </>
                        ) : null
                    }
                />
            }
            statusBanner={
                <OccConflictAlert
                    error={updateConfigs.error}
                    onReload={() => {
                        // Drafts stay in memory (frame 25 conflict variant:
                        // "no silent loss") — re-saving applies them against
                        // the freshly loaded row versions.
                        updateConfigs.reset();
                        void configsQuery.refetch();
                    }}
                />
            }
            footer={
                <StatusFooter
                    start={<span>{isBusy ? 'Refreshing' : 'Up to date'}</span>}
                    end={
                        <span aria-hidden className="font-mono">
                            GET /tenant/me
                        </span>
                    }
                />
            }
        >
            {tenantQuery.isPending ? (
                <TenantProfileSkeleton />
            ) : isNoTenantError(tenantQuery.error) ? (
                <EmptyState
                    icon={IconBuildingHospital}
                    title="No working tenant selected"
                    description="Select a working tenant to view its profile. Global admins act on one tenant at a time — pick one from the tenant switcher in the top bar."
                />
            ) : tenantQuery.error || !tenant ? (
                <ErrorState error={tenantQuery.error} onRetry={() => void tenantQuery.refetch()} />
            ) : (
                <div className="flex flex-col gap-6">
                    <section aria-labelledby={`${uid}-identity`} className="flex flex-col gap-3">
                        <h2 id={`${uid}-identity`} className="text-base font-semibold">
                            Organization
                        </h2>
                        <Card className="p-6">
                            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                                <IdentityField label="Organization name">
                                    <span className="font-medium">{tenant.name}</span>
                                </IdentityField>
                                <IdentityField label="Tenant key">
                                    <span className="truncate font-mono text-xs">{tenant.key}</span>
                                    <CopyButton value={tenant.key} label="Copy tenant key" />
                                </IdentityField>
                                <IdentityField label="Plan">
                                    {tenant.plan ? (
                                        <Badge variant="secondary">{PLAN_LABELS[tenant.plan]}</Badge>
                                    ) : (
                                        <span className="text-muted-foreground">{EM_DASH}</span>
                                    )}
                                </IdentityField>
                                <IdentityField label="Status">
                                    <ResourceStatusBadge status={tenant.resourceStatus} />
                                </IdentityField>
                                <IdentityField label="Description">
                                    {tenant.description ? tenant.description : <span className="text-muted-foreground">{EM_DASH}</span>}
                                </IdentityField>
                                <IdentityField label="Tags">
                                    {tenant.tags.length > 0 ? (
                                        tenant.tags.map((tag) => (
                                            <Badge key={tag} variant="outline">
                                                {tag}
                                            </Badge>
                                        ))
                                    ) : (
                                        <span className="text-muted-foreground">{EM_DASH}</span>
                                    )}
                                </IdentityField>
                                <IdentityField label="Created">{formatDateTime(tenant.createdAt)}</IdentityField>
                                <IdentityField label="Updated">{formatRelativeTime(tenant.updatedAt)}</IdentityField>
                            </dl>
                        </Card>
                    </section>
                    <section aria-labelledby={`${uid}-entitlements`} className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <h2 id={`${uid}-entitlements`} className="text-base font-semibold">
                                Plan &amp; entitlements
                            </h2>
                            <p className="text-muted-foreground text-sm">
                                Resolved limits and live usage for this tenant. Limits are managed by the platform team.
                            </p>
                        </div>
                        {entitlementsQuery.isPending ? (
                            <div className="grid gap-4 lg:grid-cols-3">
                                {Array.from({ length: 3 }, (_, index) => (
                                    <Skeleton key={index} className="h-40" />
                                ))}
                            </div>
                        ) : entitlementsQuery.error || !capabilities ? (
                            <ErrorState error={entitlementsQuery.error} onRetry={() => void entitlementsQuery.refetch()} />
                        ) : (
                            <>
                                <div className="flex flex-wrap items-center gap-2">
                                    <Badge variant="outline" className="text-muted-foreground font-mono text-[10px]">
                                        model: {capabilities.modelTier}
                                    </Badge>
                                    <Badge variant="outline" className="text-muted-foreground font-mono text-[10px]">
                                        rate tier: {capabilities.rateLimitTier}
                                    </Badge>
                                    <Badge variant="outline" className="text-muted-foreground font-mono text-[10px]">
                                        enforcement: {capabilities.enforcementEnabled ? 'on' : 'off'}
                                    </Badge>
                                    {capabilities.trial.isTrial ? (
                                        capabilities.trial.expired ? (
                                            <StatusBadge label="Trial expired" colorRole="destructive" icon={<StatusDot colorRole="destructive" size="sm" />} />
                                        ) : (
                                            <StatusBadge
                                                label={`Trial ends ${formatDateTime(capabilities.trial.trialEndsAt, 'date')}`}
                                                colorRole="warning"
                                                icon={<StatusDot colorRole="warning" size="sm" />}
                                            />
                                        )
                                    ) : null}
                                </div>
                                <div className="grid gap-4 lg:grid-cols-3">
                                    <CapabilityList title="Quantity limits" rows={capabilities.quantities} />
                                    <CapabilityList title="Monthly meters" rows={capabilities.meters} />
                                    <Card className="gap-3 p-4">
                                        <h3 className="text-sm font-semibold">Features</h3>
                                        <dl className="flex flex-col gap-2">
                                            {FEATURE_LABELS.map((feature) => (
                                                <div key={feature.key} className="flex flex-wrap items-center justify-between gap-2">
                                                    <dt className="text-muted-foreground text-sm">{feature.label}</dt>
                                                    <dd>
                                                        {capabilities.features[feature.key] ? (
                                                            <StatusBadge label="Enabled" colorRole="success" icon={<StatusDot colorRole="success" size="sm" />} />
                                                        ) : (
                                                            <StatusBadge label="Disabled" colorRole="neutral" icon={<StatusDot colorRole="neutral" size="sm" />} />
                                                        )}
                                                    </dd>
                                                </div>
                                            ))}
                                        </dl>
                                    </Card>
                                </div>
                            </>
                        )}
                    </section>
                    <section aria-labelledby={`${uid}-settings`} className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <h2 id={`${uid}-settings`} className="text-base font-semibold">
                                Tenant settings
                            </h2>
                            <p className="text-muted-foreground text-sm">
                                Tenant-admin editable configuration. Each save sends If-Match with the row version (PATCH /tenant/me/config);
                                locked and computed rows are read-only.
                            </p>
                        </div>
                        {configsQuery.isPending ? (
                            <Card className="gap-4 p-6">
                                <Skeleton className="h-9 w-full" />
                                <Skeleton className="h-9 w-full" />
                                <Skeleton className="h-9 w-full" />
                            </Card>
                        ) : configsQuery.error || !configsQuery.data ? (
                            <ErrorState error={configsQuery.error} onRetry={() => void configsQuery.refetch()} />
                        ) : configRows.length === 0 ? (
                            <EmptyState
                                icon={IconAdjustmentsHorizontal}
                                title="No tenant settings"
                                description="Platform defaults apply until a config row is created for this tenant."
                            />
                        ) : (
                            <Card className="gap-0 divide-y p-0">
                                {configRows.map((config) => {
                                    const readOnly = Boolean(config.locked) || !config.id;
                                    const draft = drafts[config.id];
                                    const dirty = draft !== undefined && draft !== config.value;
                                    return (
                                        <div key={config.id || config.key} className="flex flex-wrap items-center gap-3 p-4">
                                            <div className="min-w-0 flex-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="text-sm font-medium">{config.name}</span>
                                                    {config.namespace ? <span className="text-muted-foreground text-xs">{config.namespace}</span> : null}
                                                    {config.locked ? (
                                                        <Badge variant="outline">
                                                            <IconLock aria-hidden />
                                                            Locked
                                                        </Badge>
                                                    ) : null}
                                                    {!config.id ? <Badge variant="outline">Read-only</Badge> : null}
                                                </div>
                                                <div className="text-muted-foreground font-mono text-xs">{config.key}</div>
                                                {config.description ? <p className="text-muted-foreground mt-1 text-xs">{config.description}</p> : null}
                                                {config.id ? (
                                                    <p className="text-muted-foreground mt-1 text-xs">
                                                        v{config.version} &middot; updated {formatRelativeTime(config.updatedAt)}
                                                    </p>
                                                ) : null}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Input
                                                    aria-label={`Value for ${config.key}`}
                                                    value={draft ?? config.value}
                                                    onChange={(event) => setDrafts((current) => ({ ...current, [config.id]: event.target.value }))}
                                                    disabled={readOnly}
                                                    className="h-8 w-56 font-mono text-xs"
                                                />
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    aria-label={`Save ${config.key}`}
                                                    disabled={readOnly || !dirty || updateConfigs.isPending}
                                                    onClick={() => saveConfig(config)}
                                                >
                                                    Save
                                                </Button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </Card>
                        )}
                    </section>
                </div>
            )}
        </ScreenTemplate>
    );
}
