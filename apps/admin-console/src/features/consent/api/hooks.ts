'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createConsentGrant, listConsentGrants, listGrantsForPatient, revokeConsentGrant } from './client';
import { consentKeys } from './keys';
import type { ConsentGrant, CreateConsentGrantRequest, ListConsentGrantsParams, RevokeConsentGrantRequest } from './types';

export function useConsentGrants(params: ListConsentGrantsParams, enabled = true) {
  return useQuery({ queryKey: consentKeys.list(params), queryFn: () => listConsentGrants(params), enabled });
}

/**
 * Point-of-care read. `enabled` is false until a patient is selected, so the
 * consultation workspace never fires this for an empty id.
 */
export function usePatientConsentGrants(externalPatientId: string | null, enabled = true) {
  return useQuery({
    queryKey: consentKeys.byPatient(externalPatientId ?? ''),
    queryFn: () => listGrantsForPatient(externalPatientId as string),
    enabled: enabled && Boolean(externalPatientId),
  });
}

/**
 * Invalidates the WHOLE consent root on success, not just the list that
 * triggered it: the register and the consultation workspace's point-of-care
 * read are different query keys over the same rows, and a grant recorded in
 * one must immediately unblock the other.
 */
export function useCreateConsentGrant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateConsentGrantRequest): Promise<ConsentGrant> => createConsentGrant(body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: consentKeys.root }),
  });
}

export function useRevokeConsentGrant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body, expectedVersion }: { id: string; body: RevokeConsentGrantRequest; expectedVersion: number }) =>
      revokeConsentGrant(id, body, expectedVersion),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: consentKeys.root }),
  });
}
