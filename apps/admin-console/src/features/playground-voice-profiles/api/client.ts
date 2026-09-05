/**
 * Voice-profile client (frame 52, matrix row 36). All paths are gateway-
 * relative; the shared core prepends the BFF proxy mount. These are the
 * caller's OWN biometric rows — no `admin/` prefix and no tenant context
 * (the plane works with or without a working-tenant selection).
 */

import { deleteJson, getJson, patchJson, request } from '@/shared/api';
import type { EnrollVoiceProfileInput, VoiceProfile, VoiceProfileEnrollmentTarget, VoiceProfileToggleResponse } from './types';

const BASE = 'voice-profiles';

/** Gateway caps on POST /enroll (FilesInterceptor + ParseFilePipe). */
export const MAX_SAMPLES = 3;
export const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
/** EnrollBodyDto cap on the optional label. */
export const MAX_LABEL_LENGTH = 100;

/**
 * POST /voice-profiles/enroll — multipart with the repeated `files` field and
 * an optional `label`. The shared core skips the JSON content-type for
 * FormData bodies so fetch derives the multipart boundary itself.
 */
export async function enrollVoiceProfile({ files, label, agentSlug }: EnrollVoiceProfileInput): Promise<VoiceProfile> {
  const form = new FormData();
  for (const file of files) {
    form.append('files', file);
  }
  if (label) {
    form.append('label', label);
  }
  // TASK-887 — absent means the tenant's ASSIGNED ASR agent, resolved by the gateway with the
  // same cascade a session uses, so the profile lands in the space that will match it.
  if (agentSlug) {
    form.append('agentSlug', agentSlug);
  }
  return (await request<VoiceProfile>(`${BASE}/enroll`, { method: 'POST', body: form })).data;
}

/** GET /voice-profiles/enrollment-target — which embedding model a new enrollment would use. */
export function getVoiceProfileEnrollmentTarget(agentSlug?: string): Promise<VoiceProfileEnrollmentTarget> {
  return getJson(agentSlug ? `${BASE}/enrollment-target?agentSlug=${encodeURIComponent(agentSlug)}` : `${BASE}/enrollment-target`);
}

export function listVoiceProfiles(): Promise<VoiceProfile[]> {
  return getJson(BASE);
}

export function activateVoiceProfile(id: string): Promise<VoiceProfileToggleResponse> {
  return patchJson(`${BASE}/${encodeURIComponent(id)}/activate`);
}

export function deactivateVoiceProfile(id: string): Promise<VoiceProfileToggleResponse> {
  return patchJson(`${BASE}/${encodeURIComponent(id)}/deactivate`);
}

/** DELETE :id — biometric removal; returns the removed row. */
export function deleteVoiceProfile(id: string): Promise<VoiceProfile> {
  return deleteJson<VoiceProfile>(`${BASE}/${encodeURIComponent(id)}`);
}
