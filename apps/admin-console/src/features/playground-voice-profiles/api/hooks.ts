'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateVoiceProfile,
  deactivateVoiceProfile,
  deleteVoiceProfile,
  enrollVoiceProfile,
  getVoiceProfileEnrollmentTarget,
  listVoiceProfiles,
} from './client';
import { voiceProfileKeys } from './keys';
import type { EnrollVoiceProfileInput } from './types';

export function useVoiceProfiles() {
  return useQuery({ queryKey: voiceProfileKeys.list(), queryFn: listVoiceProfiles });
}

/**
 * TASK-887 — the speaker-embedding model a new enrollment would land in.
 *
 * `retry: false`: the honest failures here are a 409 `ASR_AGENT_DIARIZATION_DISABLED` (the
 * agent has diarization off, so nothing may be enrolled — TASK-977), a 400 (the agent diarizes
 * with sortformer, which enrolls nothing) and a 404 (a named agent this tenant cannot see). All
 * are answers, not outages, and retrying them only delays the message.
 */
export function useVoiceProfileEnrollmentTarget(agentSlug?: string) {
  return useQuery({
    queryKey: voiceProfileKeys.enrollmentTarget(agentSlug),
    queryFn: () => getVoiceProfileEnrollmentTarget(agentSlug),
    retry: false,
  });
}

/** Multipart enroll; a success invalidates the list so the new row appears. */
export function useEnrollVoiceProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: EnrollVoiceProfileInput) => enrollVoiceProfile(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: voiceProfileKeys.root }),
  });
}

/** Instant activate/deactivate toggle backed by the two per-id PATCH routes. */
export function useSetVoiceProfileActive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => (active ? activateVoiceProfile(id) : deactivateVoiceProfile(id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: voiceProfileKeys.root }),
  });
}

export function useDeleteVoiceProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteVoiceProfile(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: voiceProfileKeys.root }),
  });
}
