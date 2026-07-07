'use client';

import { useRef } from 'react';
import { IconFingerprint, IconInfoCircle, IconPlus } from '@tabler/icons-react';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { useVoiceProfiles } from '../api';
import { EnrollmentCard } from './enrollment-card';
import { ProfileListCard } from './profile-list-card';

/**
 * Frame 52's repurposed NoTenant panel: an informational annotation, not a
 * gate — voice profiles are user-owned rows in the caller's home tenant, so
 * this plane works with or without a working-tenant selection.
 */
function OwnAccountNote() {
    return (
        <div role="note" className="border-info/25 bg-info/10 flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
            <IconInfoCircle aria-hidden className="text-info mt-0.5 size-4 shrink-0" />
            <span className="min-w-0">
                Voice profiles are user-owned and live in your home tenant {'\u2014'} this screen works with or without a working-tenant
                selection, and there is no admin surface over other users{'\u2019'} biometrics.
            </span>
        </div>
    );
}

/**
 * Frame 52 — Playground voice profile enrollment (tier 50–59, matrix row 36).
 * Own-account plane: record-or-upload enrollment wizard next to the caller's
 * profile list with activate/deactivate toggles and a destructive delete.
 * Deliberately NO WorkingTenantGate (see OwnAccountNote).
 */
export function VoiceProfilesScreen() {
    const profiles = useVoiceProfiles();
    const activeCount = profiles.data?.filter((profile) => profile.isActive).length ?? 0;
    const wizardRef = useRef<HTMLDivElement | null>(null);

    /** Header/empty CTA: the wizard is inline, so "enroll" = move focus to it. */
    function focusWizard() {
        wizardRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        wizardRef.current?.focus();
    }

    return (
        <ScreenTemplate
            header={
                <PageHeader
                    title="Voice Profiles"
                    meta={
                        <>
                            {profiles.data ? (
                                <span>
                                    {formatNumber(profiles.data.length)} profiles {'\u00b7'} {formatNumber(activeCount)} active
                                </span>
                            ) : (
                                <Skeleton className="h-4 w-32" />
                            )}
                            <StatusBadge label={'Biometric \u00b7 user-owned only'} colorRole="info" icon={<IconFingerprint aria-hidden />} />
                        </>
                    }
                    actions={
                        <Button onClick={focusWizard}>
                            <IconPlus aria-hidden />
                            Enroll voice profile
                        </Button>
                    }
                />
            }
            statusBanner={<OwnAccountNote />}
            footer={
                <StatusFooter
                    start={<span>{profiles.isFetching && !profiles.isLoading ? 'Refreshing' : 'Up to date'}</span>}
                    end={
                        <span aria-hidden className="font-mono">
                            GET /voice-profile
                        </span>
                    }
                />
            }
        >
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
                <EnrollmentCard ref={wizardRef} />
                <ProfileListCard query={profiles} onEnroll={focusWizard} />
            </div>
        </ScreenTemplate>
    );
}
