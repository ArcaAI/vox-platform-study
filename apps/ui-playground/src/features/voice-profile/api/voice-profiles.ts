import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminClient } from '../../admin/api/admin-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoiceProfile {
  id: string;
  userId: string;
  isActive: boolean;
  label: string | null;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Query Keys
// ---------------------------------------------------------------------------

const keys = {
  all: ['voice-profiles'] as const,
  list: () => [...keys.all, 'list'] as const,
};

// ---------------------------------------------------------------------------
// Query Hooks
// ---------------------------------------------------------------------------

export function useVoiceProfiles() {
  return useQuery({
    queryKey: keys.list(),
    queryFn: () => adminClient.get<VoiceProfile[]>('/voice-profile'),
  });
}

// ---------------------------------------------------------------------------
// Mutation Hooks
// ---------------------------------------------------------------------------

export function useEnrollVoiceProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ files, label }: { files: File[]; label?: string }) => {
      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file);
      }
      if (label) formData.append('label', label);
      return adminClient.upload<VoiceProfile>('/voice-profile/enroll', formData);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function useActivateVoiceProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminClient.patch<{ success: boolean }>(`/voice-profile/${id}/activate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function useDeactivateVoiceProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminClient.patch<{ success: boolean }>(`/voice-profile/${id}/deactivate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function useDeleteVoiceProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      adminClient.delete<void>(`/voice-profile/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}
