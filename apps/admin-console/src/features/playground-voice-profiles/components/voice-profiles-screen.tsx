'use client';

import { useRef } from 'react';
import { IconFingerprint, IconPlus } from '@tabler/icons-react';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { CanvasHeader, PlaygroundCanvas } from '@/features/playground-shared/components/playground-canvas';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { useVoiceProfileEnrollmentTarget, useVoiceProfiles } from '../api';
import { EnrollmentCard } from './enrollment-card';
import { ProfileListCard, isStaleForTarget } from './profile-list-card';

/**
 * Frame 52 / artboard 4d — Playground voice enrollment & profiles (tier 50–59,
 * matrix row 36). Own-account plane rendered as a single centered canvas:
 * enrollment wizard stacked over the caller's profile list.
 * Deliberately NO WorkingTenantGate — voice profiles are user-owned rows in
 * the caller's home tenant, so this plane works with or without a
 * working-tenant selection, and there is no admin surface over other users'
 * biometrics. The "runs under your own account" framing now lives in the top
 * bar's persona control, so there is no page-level playground banner.
 *
 * Frame: `ScreenTemplate` (rule 11 §1) in `scroll` mode. The canvas header is
 * pinned in the `header` slot — width-matched to the 760px work column so the
 * two stay aligned — and only the enrollment/profile stack below it scrolls.
 */
export function VoiceProfilesScreen() {
  const profiles = useVoiceProfiles();
  // TASK-887 — no agent is named: a clinician enrols for the agent their sessions actually
  // run, which is the tenant's assigned one, and the gateway resolves the same cascade.
  const enrollmentTarget = useVoiceProfileEnrollmentTarget();
  const wizardRef = useRef<HTMLDivElement | null>(null);

  const target = enrollmentTarget.data;
  const activeProfiles = profiles.data?.filter((profile) => profile.isActive) ?? [];
  const activeCount = activeProfiles.length;
  // "Enrolled" and "enrolled for THIS agent" are different questions: a profile from another
  // embedding model is invisible to the agent, so an active-but-stale set still means no
  // speaker attribution.
  const needsReenrollment = activeCount > 0 && activeProfiles.every((profile) => isStaleForTarget(profile, target));

  /** Header/empty CTA: the wizard is inline, so "enroll" = move focus to it. */
  function focusWizard() {
    wizardRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    wizardRef.current?.focus();
  }

  return (
    <ScreenTemplate
      header={
        <div className="mx-auto w-full max-w-[760px] px-4">
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
        </div>
      }
      footer={
        <StatusFooter
          start={
            profiles.isPending
              ? 'Loading your voice profiles…'
              : profiles.isError
                ? 'Could not load your voice profiles'
                : needsReenrollment
                  ? `Your active profile was enrolled with a different speaker model — re-enroll for ${target?.agentSlug ?? 'your agent'}`
                  : activeCount > 0
                    ? `${activeCount} active profile${activeCount === 1 ? '' : 's'} — auto-attached to live sessions`
                    : 'No active profile — live sessions run without speaker attribution'
          }
          end={
            profiles.data ? (
              <span className="font-mono">
                {profiles.data.length} profile{profiles.data.length === 1 ? '' : 's'}
              </span>
            ) : null
          }
        />
      }
    >
      <PlaygroundCanvas>
        <EnrollmentCard ref={wizardRef} />
        <ProfileListCard query={profiles} target={target} onEnroll={focusWizard} />
      </PlaygroundCanvas>
    </ScreenTemplate>
  );
}
