'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconArrowLeft, IconKey, IconSpy, IconTrash, IconUserCheck, IconUserOff } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { formatDateTime, formatRelativeTime } from '@/shared/format';
import { useTrailingBreadcrumb } from '@/shared/navigation/breadcrumb-store';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useUser } from '../api/hooks';
import { UserActionDialogs, type UserActionRequest } from './user-action-dialogs';
import { UserAvatar } from './user-avatar';
import { UserDepartmentsTab } from './user-departments-tab';
import { UserProfileTab } from './user-profile-tab';
import { UserRolesTab } from './user-roles-tab';
import { UserSecurityTab } from './user-security-tab';
import { UserSettingsTab } from './user-settings-tab';

const TAB_VALUES = ['roles', 'departments', 'settings', 'profile', 'security'] as const;

/** Route-level loading.tsx mirrors this shape (rule 10). */
export function UserDetailSkeleton() {
    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                    <Skeleton className="size-10 rounded-full" />
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-8 w-56" />
                        <Skeleton className="h-4 w-80" />
                    </div>
                </div>
                <div className="flex gap-2">
                    <Skeleton className="h-9 w-28" />
                    <Skeleton className="h-9 w-32" />
                    <Skeleton className="h-9 w-24" />
                    <Skeleton className="h-9 w-24" />
                </div>
            </div>
            <Skeleton className="h-9 w-96" />
            <Skeleton className="h-64 w-full" />
        </div>
    );
}

/** Frame 20.1 — User detail: header + actions + URL-synced tabs. */
export function UserDetailScreen({ id }: { id: string }) {
    const router = useRouter();
    const { data: user, isLoading, error, refetch } = useUser(id);
    useTrailingBreadcrumb(user?.username);
    const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('roles'));
    const [action, setAction] = useState<UserActionRequest | null>(null);

    if (isLoading) {
        return <UserDetailSkeleton />;
    }
    if (error instanceof GatewayError && error.isNotFound) {
        // 404-over-403 posture: cross-tenant and missing look identical.
        return (
            <div className="flex flex-col gap-4">
                <ErrorState title="User not found" error={new Error('It may not exist or you may not have access.')} />
                <div className="flex justify-center">
                    <Button variant="outline" onClick={() => router.push('/users')}>
                        <IconArrowLeft aria-hidden />
                        Back to users
                    </Button>
                </div>
            </div>
        );
    }
    if (error || !user) {
        return <ErrorState error={error ?? new Error('The user could not be loaded.')} onRetry={() => refetch()} />;
    }

    const tab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'roles';
    const enabled = user.resourceStatus === 'ENABLED';

    return (
        <Tabs value={tab} onValueChange={(next) => setTabParam(next === 'roles' ? null : next)} className="flex min-h-0 flex-1 flex-col">
            <ScreenTemplate
                header={
                    <PageHeader
                        title={
                            <span className="flex items-center gap-3">
                                <UserAvatar username={user.username} size="lg" />
                                {user.username}
                            </span>
                        }
                        meta={
                            <>
                                <span className="flex items-center gap-1">
                                    <span className="font-mono text-xs">{user.id}</span>
                                    <CopyButton value={user.id} label="Copy user ID" />
                                </span>
                                {user.externalId ? <span className="font-mono text-xs">ext:{user.externalId}</span> : null}
                                <ResourceStatusBadge status={user.resourceStatus} />
                                {user.isServiceAccount ? <Badge variant="outline">Service account</Badge> : null}
                                <span>created {formatDateTime(user.createdAt, 'date')}</span>
                                <span>last login {formatRelativeTime(user.lastLoginAt)}</span>
                                <span>last active {formatRelativeTime(user.lastActiveAt)}</span>
                            </>
                        }
                        actions={
                            <>
                                <Button variant="outline" onClick={() => setAction({ action: 'impersonate', user })}>
                                    <IconSpy aria-hidden />
                                    Impersonate
                                </Button>
                                <Button variant="outline" onClick={() => setAction({ action: 'reset-password', user })}>
                                    <IconKey aria-hidden />
                                    Reset password
                                </Button>
                                {enabled ? (
                                    <Button variant="outline" onClick={() => setAction({ action: 'disable', user })}>
                                        <IconUserOff aria-hidden />
                                        Disable
                                    </Button>
                                ) : (
                                    <Button variant="outline" onClick={() => setAction({ action: 'enable', user })}>
                                        <IconUserCheck aria-hidden />
                                        Enable
                                    </Button>
                                )}
                                <Button variant="destructive" onClick={() => setAction({ action: 'delete', user })}>
                                    <IconTrash aria-hidden />
                                    Delete
                                </Button>
                            </>
                        }
                    />
                }
                tabs={
                    <TabsList variant="line">
                        <TabsTrigger value="roles">Roles</TabsTrigger>
                        <TabsTrigger value="departments">Departments</TabsTrigger>
                        <TabsTrigger value="settings">Settings</TabsTrigger>
                        <TabsTrigger value="profile">Profile</TabsTrigger>
                        <TabsTrigger value="security">Security</TabsTrigger>
                    </TabsList>
                }
                footer={
                    <StatusFooter
                        start={<ResourceStatusBadge status={user.resourceStatus} />}
                        end={
                            <span aria-hidden className="font-mono">
                                GET /admin/users/{user.id}
                            </span>
                        }
                    />
                }
            >
                <TabsContent value="roles">
                    <UserRolesTab id={id} />
                </TabsContent>
                <TabsContent value="departments">
                    <UserDepartmentsTab id={id} />
                </TabsContent>
                <TabsContent value="settings">
                    <UserSettingsTab id={id} />
                </TabsContent>
                <TabsContent value="profile">
                    <UserProfileTab id={id} />
                </TabsContent>
                <TabsContent value="security">
                    <UserSecurityTab id={id} onResetPassword={() => setAction({ action: 'reset-password', user })} />
                </TabsContent>
            </ScreenTemplate>
            <UserActionDialogs request={action} onOpenChange={(open) => !open && setAction(null)} onDeleted={() => router.push('/users')} />
        </Tabs>
    );
}
