'use client';

import { useRef } from 'react';
import { IconFingerprint, IconPlus } from '@tabler/icons-react';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { CanvasHeader, PlaygroundCanvas } from '@/features/playground-shared/components/playground-canvas';
import { useVoiceProfiles } from '../api';
import { EnrollmentCard } from './enrollment-card';
import { ProfileListCard } from './profile-list-card';

/**
 * Frame 52 / artboard 4d — Playground voice enrollment & profiles (tier 50–59,
 * matrix row 36). Own-account plane rendered as a single centered canvas
 * (TASK-442 §4): enrollment wizard stacked over the caller's profile list.
 * Deliberately NO WorkingTenantGate — voice profiles are user-owned rows in
 * the caller's home tenant, so this plane works with or without a
 * working-tenant selection, and there is no admin surface over other users'
 * biometrics. The "runs under your own account" framing now lives in the top
 * bar's persona control, so there is no page-level playground banner.
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
        <PlaygroundCanvas>
            <CanvasHeader
                title="My Voice Enrollment & Profiles"
                description={'Enroll & manage speaker profiles · runs under your own account'}
                badges={<StatusBadge label={'Biometric · user-owned only'} colorRole="info" icon={<IconFingerprint aria-hidden />} />}
                actions={
                    <Button onClick={focusWizard}>
                        <IconPlus aria-hidden />
                        New profile
                    </Button>
                }
            />
            <EnrollmentCard ref={wizardRef} />
            <ProfileListCard query={profiles} onEnroll={focusWizard} />
        </PlaygroundCanvas>
    );
}
