'use client';

import { useRef } from 'react';
import { IconFingerprint, IconPlus } from '@tabler/icons-react';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { PlaygroundBanner } from '@/shared/page/playground-banner';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { useVoiceProfiles } from '../api';
import { EnrollmentCard } from './enrollment-card';
import { ProfileListCard } from './profile-list-card';

/**
 * Frame 52 — Playground voice profile enrollment (tier 50–59, matrix row 36).
 * Own-account plane: record-or-upload enrollment wizard next to the caller's
 * profile list with activate/deactivate toggles and a destructive delete.
 * Deliberately NO WorkingTenantGate — voice profiles are user-owned rows in
 * the caller's home tenant, so this plane works with or without a
 * working-tenant selection, and there is no admin surface over other users'
 * biometrics.
 */
export function VoiceProfilesScreen() {
    const profiles = useVoiceProfiles();
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
                            <span>Enroll & manage speaker profiles {'\u00b7'} runs under your own account</span>
                            <StatusBadge label={'Biometric \u00b7 user-owned only'} colorRole="info" icon={<IconFingerprint aria-hidden />} />
                        </>
                    }
                    actions={
                        <Button onClick={focusWizard}>
                            <IconPlus aria-hidden />
                            New profile
                        </Button>
                    }
                />
            }
            statusBanner={<PlaygroundBanner />}
            footer={
                <StatusFooter
                    start={
                        <span>
                            {(profiles.isFetching && !profiles.isLoading ? 'Refreshing' : 'Up to date') +
                                (profiles.data ? ` \u00b7 ${formatNumber(profiles.data.length)} profiles` : '')}
                        </span>
                    }
                    end={
                        <span aria-hidden className="font-mono">
                            GET /voice-profile {'\u00b7'} POST /voice-profile/enroll
                        </span>
                    }
                />
            }
        >
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                <EnrollmentCard ref={wizardRef} />
                <ProfileListCard query={profiles} onEnroll={focusWizard} />
            </div>
        </ScreenTemplate>
    );
}
