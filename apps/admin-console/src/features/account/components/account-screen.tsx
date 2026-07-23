'use client';

import { useId, useState } from 'react';
import { IconAdjustmentsHorizontal } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@arcaai/ui/components/shadcn/avatar';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { useSession } from '@/shared/auth/hooks';
import { formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import type { UserSetting } from '@/features/users/api/types';
import { useMyDepartments, useMyPreferences, useMySettings, useUpdateMyPreferences, useUpdateMySetting } from '../api/hooks';
import type { WorkflowMode } from '../api/types';

function initials(username: string): string {
    const parts = username.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    const letters = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : username.slice(0, 2);
    return letters.toUpperCase();
}

function ReadOnlyField({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm">{children}</dd>
        </div>
    );
}

/** Skeletons mirroring the three loaded regions (rule 10). */
function AccountSkeleton() {
    return (
        <div className="flex flex-col gap-6" aria-hidden>
            <Card className="p-6">
                <div className="flex items-center gap-4">
                    <Skeleton className="size-10 rounded-full" />
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-5 w-40" />
                        <Skeleton className="h-4 w-56 max-w-full" />
                    </div>
                </div>
            </Card>
            <div className="flex flex-col gap-2 rounded-md border p-3">
                {Array.from({ length: 3 }, (_, index) => (
                    <Skeleton key={index} className="h-12 w-full" />
                ))}
            </div>
            <Skeleton className="h-64" />
        </div>
    );
}

/**
 * Frame 25 (account half) — Account (/account, tier 20-29). The caller's own
 * surfaces: BFF session identity, raw "my settings" rows saved per row to
 * PATCH /user/me/settings/:namespace/:key, and the preferences form over
 * PATCH /user/me/preferences (real fields: workflowMode/language/dnaStyleId;
 * pipeline assignment and voice profile are read-only).
 */
export function AccountScreen() {
    const uid = useId();
    const sessionQuery = useSession();
    const settingsQuery = useMySettings();
    const preferencesQuery = useMyPreferences();
    const departmentsQuery = useMyDepartments();
    const updateSetting = useUpdateMySetting();
    const updatePreferences = useUpdateMyPreferences();

    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [prefDraft, setPrefDraft] = useState<{ workflowMode?: WorkflowMode; language?: string; dnaStyleId?: string }>({});

    const session = sessionQuery.data;
    // /account shows the EFFECTIVE identity: the
    // impersonated target while impersonating, else the operator's own.
    const identityUser = session?.effectiveUser;
    const departments = departmentsQuery.data ?? [];
    const primaryDepartment = departments.find((d) => d.isPrimary) ?? departments[0];
    const settings = settingsQuery.data ?? [];
    const preferences = preferencesQuery.data;
    const isBusy = sessionQuery.isFetching || settingsQuery.isFetching || preferencesQuery.isFetching || departmentsQuery.isFetching;

    const workflowMode = prefDraft.workflowMode ?? preferences?.workflowMode;
    const language = prefDraft.language ?? preferences?.language ?? '';
    const dnaStyleId = prefDraft.dnaStyleId ?? preferences?.dnaStyleId ?? '';
    const preferencesDirty = preferences
        ? workflowMode !== preferences.workflowMode || language !== (preferences.language ?? '') || dnaStyleId !== (preferences.dnaStyleId ?? '')
        : false;

    function saveSetting(setting: UserSetting) {
        const value = drafts[setting.id];
        // Rows without a namespace cannot be addressed by the PATCH route.
        if (value === undefined || !setting.namespace) return;
        updateSetting.mutate(
            { namespace: setting.namespace, key: setting.key, body: { value } },
            {
                onSuccess: () => {
                    toast.success(`${setting.key} updated`);
                    setDrafts(({ [setting.id]: _saved, ...rest }) => rest);
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not update the setting.'),
            },
        );
    }

    function savePreferences() {
        if (!preferences) return;
        updatePreferences.mutate(
            {
                ...(workflowMode ? { workflowMode } : {}),
                ...(language.trim() ? { language: language.trim() } : {}),
                ...(dnaStyleId.trim() ? { dnaStyleId: dnaStyleId.trim() } : {}),
            },
            {
                onSuccess: () => {
                    toast.success('Preferences saved');
                    setPrefDraft({});
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not save preferences.'),
            },
        );
    }

    return (
        <ScreenTemplate
            header={<PageHeader title="Account" meta={identityUser ? <span>{identityUser.username}</span> : null} />}
            footer={
                <StatusFooter
                    start={<span>{isBusy ? 'Refreshing' : 'Up to date'}</span>}
                    end={
                        <span aria-hidden className="font-mono">
                            GET /user/me/*
                        </span>
                    }
                />
            }
        >
            {sessionQuery.isPending ? (
                <AccountSkeleton />
            ) : sessionQuery.error || !session || !identityUser ? (
                <ErrorState error={sessionQuery.error} onRetry={() => void sessionQuery.refetch()} />
            ) : (
                <div className="flex flex-col gap-6">
                    <section aria-labelledby={`${uid}-identity`} className="flex flex-col gap-3">
                        <h2 id={`${uid}-identity`} className="text-base font-semibold">
                            Identity
                        </h2>
                        <Card className="gap-4 p-6">
                            <div className="flex flex-wrap items-center gap-4">
                                <Avatar size="lg">
                                    <AvatarFallback>{initials(identityUser.username)}</AvatarFallback>
                                </Avatar>
                                <div className="flex min-w-0 flex-col">
                                    <span className="text-lg font-semibold">{identityUser.username}</span>
                                    {identityUser.email ? <span className="text-muted-foreground text-sm">{identityUser.email}</span> : null}
                                </div>
                                <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
                                    {identityUser.roles.map((role) => (
                                        <Badge key={role} variant="secondary" className="font-mono text-[10px]">
                                            {role}
                                        </Badge>
                                    ))}
                                </div>
                            </div>
                            {session.workingTenantName ? (
                                <p className="text-muted-foreground text-sm">
                                    Acting on <span className="text-foreground font-medium">{session.workingTenantName}</span>
                                </p>
                            ) : null}
                            {primaryDepartment ? (
                                <p className="text-muted-foreground text-sm">
                                    Department: <span className="text-foreground font-medium">{primaryDepartment.departmentName ?? primaryDepartment.departmentId}</span>
                                </p>
                            ) : null}
                        </Card>
                    </section>
                    <section aria-labelledby={`${uid}-settings`} className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <h2 id={`${uid}-settings`} className="text-base font-semibold">
                                My settings
                            </h2>
                            <p className="text-muted-foreground text-sm">
                                Raw key-value settings written by the apps you use. Saves go to PATCH /user/me/settings/:namespace/:key.
                            </p>
                        </div>
                        {settingsQuery.isPending ? (
                            <Card className="gap-4 p-6">
                                <Skeleton className="h-9 w-full" />
                                <Skeleton className="h-9 w-full" />
                            </Card>
                        ) : settingsQuery.error ? (
                            <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />
                        ) : settings.length === 0 ? (
                            <EmptyState
                                icon={IconAdjustmentsHorizontal}
                                title="No settings yet"
                                description="Settings appear here the first time an app (e.g. the consultation SDK) stores one for you."
                            />
                        ) : (
                            <Card className="gap-0 divide-y p-0">
                                {settings.map((setting) => {
                                    const editable = Boolean(setting.namespace);
                                    const draft = drafts[setting.id];
                                    const dirty = draft !== undefined && draft !== setting.value;
                                    return (
                                        <div key={setting.id} className="flex flex-wrap items-center gap-3 p-4">
                                            <div className="min-w-0 flex-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="text-sm font-medium">{setting.name}</span>
                                                    {setting.namespace ? <span className="text-muted-foreground text-xs">{setting.namespace}</span> : null}
                                                    <Badge variant="outline" className="text-muted-foreground font-mono text-[10px]">
                                                        {setting.dataType}
                                                    </Badge>
                                                </div>
                                                <div className="text-muted-foreground font-mono text-xs">{setting.key}</div>
                                                <p className="text-muted-foreground mt-1 text-xs">Updated {formatRelativeTime(setting.updatedAt)}</p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Input
                                                    aria-label={`Value for ${setting.key}`}
                                                    value={draft ?? setting.value}
                                                    onChange={(event) => setDrafts((current) => ({ ...current, [setting.id]: event.target.value }))}
                                                    disabled={!editable}
                                                    className="h-8 w-56 font-mono text-xs"
                                                />
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    aria-label={`Save ${setting.key}`}
                                                    disabled={!editable || !dirty || updateSetting.isPending}
                                                    onClick={() => saveSetting(setting)}
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
                    <section aria-labelledby={`${uid}-preferences`} className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <h2 id={`${uid}-preferences`} className="text-base font-semibold">
                                Preferences
                            </h2>
                            <p className="text-muted-foreground text-sm">
                                Consultation workflow defaults. Pipeline assignment and voice enrollment are managed by your admin.
                            </p>
                        </div>
                        {preferencesQuery.isPending ? (
                            <Card className="gap-4 p-6">
                                <div className="grid gap-4 sm:grid-cols-2">
                                    {Array.from({ length: 4 }, (_, index) => (
                                        <div key={index} className="flex flex-col gap-2">
                                            <Skeleton className="h-3 w-24" />
                                            <Skeleton className="h-9 w-full" />
                                        </div>
                                    ))}
                                </div>
                            </Card>
                        ) : preferencesQuery.error || !preferences ? (
                            <ErrorState error={preferencesQuery.error} onRetry={() => void preferencesQuery.refetch()} />
                        ) : (
                            <Card className="gap-5 p-6">
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <div className="flex flex-col gap-2">
                                        <Label htmlFor={`${uid}-workflow`}>Workflow mode</Label>
                                        <Select
                                            value={workflowMode ?? ''}
                                            onValueChange={(next) => setPrefDraft((current) => ({ ...current, workflowMode: next as WorkflowMode }))}
                                        >
                                            <SelectTrigger id={`${uid}-workflow`} className="w-full">
                                                <SelectValue placeholder="Not set" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {/* TASK-545: local (in-browser) transcription is disabled
                                                platform-wide — disabled, not removed, so an existing
                                                doctor's stored "local" selection still renders. */}
                                                <SelectItem value="local" disabled>
                                                    Local (on-device pipeline)
                                                </SelectItem>
                                                <SelectItem value="remote">Remote (server pipeline)</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <p className="text-muted-foreground text-xs">Local transcription is disabled platform-wide — backend transcription only.</p>
                                    </div>
                                    <div className="flex flex-col gap-2">
                                        <Label htmlFor={`${uid}-language`}>Language</Label>
                                        <Input
                                            id={`${uid}-language`}
                                            placeholder="e.g. sv-SE"
                                            value={language}
                                            onChange={(event) => setPrefDraft((current) => ({ ...current, language: event.target.value }))}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-2">
                                        <Label htmlFor={`${uid}-dna`}>DNA style ID</Label>
                                        <Input
                                            id={`${uid}-dna`}
                                            placeholder="Writing-style ID"
                                            className="font-mono"
                                            value={dnaStyleId}
                                            onChange={(event) => setPrefDraft((current) => ({ ...current, dnaStyleId: event.target.value }))}
                                        />
                                    </div>
                                </div>
                                <dl className="grid gap-x-8 gap-y-3 border-t pt-4 sm:grid-cols-2">
                                    <ReadOnlyField label="Transcription mode">
                                        <Badge variant="outline" className="font-mono text-[10px]">
                                            {preferences.transcriptionMode}
                                        </Badge>
                                        {preferences.transcriptionModeLocked ? <Badge variant="outline">Locked by admin</Badge> : null}
                                    </ReadOnlyField>
                                    {preferences.remoteConfig ? (
                                        <ReadOnlyField label="Assigned pipeline">
                                            <span>{preferences.remoteConfig.pipelineName ?? preferences.remoteConfig.pipelineId}</span>
                                            <Badge variant="outline" className="text-muted-foreground font-mono text-[10px]">
                                                {preferences.remoteConfig.assignedBy}
                                            </Badge>
                                            {preferences.remoteConfig.codeSwitchingEnabled ? <Badge variant="outline">Code-switching</Badge> : null}
                                        </ReadOnlyField>
                                    ) : null}
                                    {preferences.activeVoiceProfile ? (
                                        <ReadOnlyField label="Active voice profile">
                                            <span>{preferences.activeVoiceProfile.label ?? preferences.activeVoiceProfile.id}</span>
                                            <span className="text-muted-foreground text-xs">
                                                enrolled {formatRelativeTime(preferences.activeVoiceProfile.createdAt)}
                                            </span>
                                        </ReadOnlyField>
                                    ) : null}
                                </dl>
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <span className="text-muted-foreground text-xs">Last saved {formatRelativeTime(preferences.updatedAt)}</span>
                                    <Button size="sm" disabled={!preferencesDirty || updatePreferences.isPending} onClick={savePreferences}>
                                        {updatePreferences.isPending ? <Spinner /> : null}
                                        Save preferences
                                    </Button>
                                </div>
                            </Card>
                        )}
                    </section>
                </div>
            )}
        </ScreenTemplate>
    );
}
