'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { activateVoiceProfile, deactivateVoiceProfile, deleteVoiceProfile, enrollVoiceProfile, listVoiceProfiles } from './client';
import { voiceProfileKeys } from './keys';
import type { EnrollVoiceProfileInput } from './types';

export function useVoiceProfiles() {
    return useQuery({ queryKey: voiceProfileKeys.list(), queryFn: listVoiceProfiles });
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
