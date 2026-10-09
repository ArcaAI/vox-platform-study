'use client';

/**
 * Action-confirmation policy for console dialogs (TASK-1057).
 *
 * One shared query per session (`GET admin/settings/action-confirmations/effective`). Until it
 * answers — or if it fails — every action falls back to its CATALOGUE default, which is today's
 * behaviour, so a dialog never silently drops a prompt the server will demand. The server is the
 * authority for every `enforcement: 'server'` row; typed-name rows are console-only.
 */

import { useQuery, type QueryClient } from '@tanstack/react-query';
import { type ConfirmationMode, type EffectiveActionConfirmation, findActionConfirmation } from '@arcaai/types';
import { getJson } from '@/shared/api';

export const ACTION_CONFIRMATIONS_QUERY_KEY = ['action-confirmations'] as const;

interface EffectiveActionConfirmationsResponse {
  items: EffectiveActionConfirmation[];
}

export async function getEffectiveActionConfirmations(): Promise<EffectiveActionConfirmation[]> {
  const response = await getJson<EffectiveActionConfirmationsResponse>('admin/settings/action-confirmations/effective');
  return response.items;
}

export interface ActionConfirmationPolicy {
  actionId: string;
  mode: ConfirmationMode;
  locked: boolean;
  minLength?: number;
  maxLength?: number;
  /** Whether a value is demanded; `risky` evaluates `when-risky` rows (residency: live-path / pinned / forced). */
  isRequired: (risky?: boolean) => boolean;
  /** Whether `value` satisfies the policy (non-empty, and at least `minLength` when required). */
  isSatisfied: (value: string | boolean | undefined, risky?: boolean) => boolean;
  isLoading: boolean;
}

export function policyFrom(actionId: string, row: EffectiveActionConfirmation | undefined, isLoading = false): ActionConfirmationPolicy {
  const spec = findActionConfirmation(actionId);
  if (!spec) throw new Error(`Unknown action confirmation '${actionId}'.`);
  const mode = row?.mode ?? spec.default;
  const minLength = row?.minLength ?? spec.minLength;
  const maxLength = row?.maxLength ?? spec.maxLength;
  const isRequired = (risky?: boolean) => mode === 'required' || (mode === 'when-risky' && risky === true);
  return {
    actionId,
    mode,
    locked: row?.locked ?? spec.locked === true,
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    isRequired,
    isSatisfied: (value, risky) => {
      if (!isRequired(risky)) return true;
      if (typeof value === 'boolean') return value;
      const trimmed = (value ?? '').trim();
      return trimmed.length > 0 && (minLength === undefined || trimmed.length >= minLength);
    },
    isLoading,
  };
}

export function useActionConfirmation(actionId: string, options: { enabled?: boolean } = {}): ActionConfirmationPolicy {
  const query = useQuery({
    queryKey: ACTION_CONFIRMATIONS_QUERY_KEY,
    queryFn: getEffectiveActionConfirmations,
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
  const row = query.data?.find((item) => item.actionId === actionId);
  return policyFrom(actionId, row, query.isLoading);
}

/** Call after the platform screen saves, so open sessions re-read the policy. */
export function invalidateActionConfirmations(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ACTION_CONFIRMATIONS_QUERY_KEY });
}
