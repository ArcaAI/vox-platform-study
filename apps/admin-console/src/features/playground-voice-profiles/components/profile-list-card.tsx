'use client';

import { useState } from 'react';
import { IconMicrophone, IconPlus, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useDeleteVoiceProfile, useSetVoiceProfileActive, useVoiceProfiles } from '../api';
import type { VoiceProfile } from '../api';

function displayName(profile: VoiceProfile): string {
  return profile.label ?? 'Untitled profile';
}

function ProfileRow({ profile, onToggle, onDelete, isBusy }: { profile: VoiceProfile; onToggle: () => void; onDelete: () => void; isBusy: boolean }) {
  const name = displayName(profile);
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        {/* Template active pill: dot-style success StatusBadge; outline = neutral (rule 11 §7). */}
        {profile.isActive ? (
          <StatusBadge label="Active" colorRole="success" icon={<StatusDot colorRole="success" size="sm" />} />
        ) : (
          <Badge variant="outline">Inactive</Badge>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`${profile.isActive ? 'Deactivate' : 'Set active'} ${name}`}
          onClick={onToggle}
          disabled={isBusy}
        >
          {profile.isActive ? 'Deactivate' : 'Set active'}
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${name}`} onClick={onDelete} disabled={isBusy}>
          <IconTrash aria-hidden />
        </Button>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {profile.modelId ? <span className="font-mono">{profile.modelId}</span> : <span>Model pending</span>}
        <span>Enrolled {formatRelativeTime(profile.createdAt)}</span>
        <span>Updated {formatRelativeTime(profile.updatedAt)}</span>
      </div>
    </li>
  );
}

/**
 * Frame 52 profile list — the caller's own biometric rows (GET /voice-profiles)
 * with the active badge, instant activate/deactivate toggles (invalidate, no
 * optimistic write) and delete behind a destructive confirm (biometric
 * removal, frame 05 pattern).
 */
export function ProfileListCard({ query, onEnroll }: { query: ReturnType<typeof useVoiceProfiles>; onEnroll?: () => void }) {
  const setActive = useSetVoiceProfileActive();
  const deleteProfile = useDeleteVoiceProfile();
  const [deleteTarget, setDeleteTarget] = useState<VoiceProfile | null>(null);
  const rows = query.data ?? [];

  function toggle(profile: VoiceProfile) {
    setActive.mutate(
      { id: profile.id, active: !profile.isActive },
      {
        onSuccess: () => toast.success(profile.isActive ? 'Voice profile deactivated' : 'Voice profile activated'),
        onError: (error) => toast.error(error.message),
      },
    );
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    deleteProfile.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast.success('Voice profile deleted');
        setDeleteTarget(null);
      },
      onError: (error) => toast.error(error.message),
    });
  }

  return (
    <>
      <Card className="gap-4">
        <CardHeader>
          <h2 className="text-sm leading-none font-semibold">My profiles</h2>
          <CardAction>
            <span aria-hidden className="text-muted-foreground font-mono text-xs">
              GET /voice-profiles
            </span>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {query.isPending ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex flex-col gap-2 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </div>
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))}
            </div>
          ) : query.isError ? (
            <ErrorState title={'Couldn\u2019t load your voice profiles'} error={query.error} onRetry={() => void query.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={IconMicrophone}
              title="No voice profiles yet"
              description={'Enroll your voice with up to 3 audio samples \u2014 \u226410 MB each, audio/* only.'}
              action={
                onEnroll ? (
                  <Button onClick={onEnroll}>
                    <IconPlus aria-hidden />
                    Enroll voice profile
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul aria-label="Voice profiles" className="flex flex-col gap-3">
              {rows.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  onToggle={() => toggle(profile)}
                  onDelete={() => setDeleteTarget(profile)}
                  isBusy={setActive.isPending || deleteProfile.isPending}
                />
              ))}
            </ul>
          )}
          <p className="text-muted-foreground text-xs">
            Active profiles auto-attach to live-transcription sessions. Activate/deactivate is an instant toggle; delete is a destructive removal.
          </p>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`Delete ${deleteTarget ? displayName(deleteTarget) : 'profile'}?`}
        description="This permanently removes the voice biometric model enrolled from your samples. Live-transcription sessions stop attaching it immediately."
        confirmLabel="Delete profile"
        destructive
        isPending={deleteProfile.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}
