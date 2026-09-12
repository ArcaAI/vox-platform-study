'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateUserSettingRequest } from '@/features/users/api/types';
import { getMyDepartments, getMyEntitlements, getMyPreferences, getMyTenant, listMySettings, updateMyPreferences, updateMySetting } from './client';
import { accountKeys } from './keys';
import type { UpdateUserPreferencesRequest } from './types';

export function useMyTenant() {
  return useQuery({ queryKey: accountKeys.tenant(), queryFn: getMyTenant });
}

export function useMyEntitlements(enabled = true) {
  return useQuery({ queryKey: accountKeys.entitlements(), queryFn: getMyEntitlements, enabled });
}

export function useMySettings() {
  return useQuery({ queryKey: accountKeys.settings(), queryFn: listMySettings });
}

export function useMyPreferences() {
  return useQuery({ queryKey: accountKeys.preferences(), queryFn: getMyPreferences });
}

/** The caller's own department(s); works impersonated too. */
export function useMyDepartments() {
  return useQuery({ queryKey: accountKeys.departments(), queryFn: getMyDepartments });
}

function useInvalidateAccount() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: accountKeys.root });
}

export function useUpdateMySetting() {
  const invalidate = useInvalidateAccount();
  return useMutation({
    mutationFn: ({ namespace, key, body }: { namespace: string; key: string; body: UpdateUserSettingRequest }) =>
      updateMySetting(namespace, key, body),
    onSuccess: invalidate,
  });
}

export function useUpdateMyPreferences() {
  const invalidate = useInvalidateAccount();
  return useMutation({ mutationFn: (body: UpdateUserPreferencesRequest) => updateMyPreferences(body), onSuccess: invalidate });
}
