/**
 * @arcaai/vox - useVoiceEnrollmentStatus Hook
 *
 * Lightweight gate helper that tells the consumer whether the current user
 * has an active enrolled voice profile. Used to gate on-device diarization:
 * if `features.diarization === true` and `hasActive === false`, the host
 * should refuse to start the local STT provider (or downgrade the feature
 * with a user-visible explanation).
 *
 * Ownership note
 * -----------------------
 * `packages/stt/src/core/STTProcessor.ts` is owned by the STT package. This file
 * publishes a stable `VoiceEnrollmentChecker` interface and a
 * `createVoiceEnrollmentChecker(apiClient)` factory so that package can wire
 * the gate without depending on React or on this hook's internals.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useVoiceEmbedding, type VoiceProfile } from './useVoiceEmbedding';
import { extractArray } from '../utils/responseUtils';
import { VOICE_EMBEDDING_ENDPOINTS } from '../core/constants';

export interface UseVoiceEnrollmentStatusReturn {
  /** True iff the user has at least one profile with `isActive === true`. */
  hasActive: boolean;
  /** True while the initial `list()` is in-flight. */
  isLoading: boolean;
  /** Current cached profiles for the user. */
  profiles: VoiceProfile[];
}

/**
 * Stable interface that non-React consumers (e.g. `STTProcessor` in
 * `@arcaai/stt`) can rely on to gate on-device
 * diarization on voice enrollment.
 *
 * Implementations MUST be side-effect-free and idempotent. The default
 * implementation (`createVoiceEnrollmentChecker`) fails closed (returns
 * `false`) on any error so the gate errs on the side of refusing to
 * enable un-personalized diarization.
 */
export interface VoiceEnrollmentChecker {
  /**
   * Returns true iff the current user has at least one ACTIVE voice profile.
   * MAY perform a network call (e.g. `GET /voice-profiles`) on first invocation.
   */
  checkHasActiveProfile(): Promise<boolean>;
}

/**
 * Factory that builds a `VoiceEnrollmentChecker` against any object that
 * exposes a `get(endpoint)` method (typically `AgenticClient`).
 *
 * Decoupled from React so non-hook consumers (STT provider initialization,
 * jobs, plugins) can use it without `renderHook`.
 */
export function createVoiceEnrollmentChecker(apiClient: { get: <T = unknown>(endpoint: string) => Promise<T> }): VoiceEnrollmentChecker {
  return {
    async checkHasActiveProfile(): Promise<boolean> {
      try {
        const raw = await apiClient.get(VOICE_EMBEDDING_ENDPOINTS.list);
        const profiles = extractArray<VoiceProfile>(raw);
        return profiles.some((p) => p.isActive === true);
      } catch {
        // Fail-closed: refuse to claim enrollment exists when we can't verify it.
        return false;
      }
    },
  };
}

export function useVoiceEnrollmentStatus(): UseVoiceEnrollmentStatusReturn {
  const { profiles, isLoading, list } = useVoiceEmbedding();

  const refresh = useCallback(() => {
    void list();
  }, [list]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const hasActive = useMemo(() => profiles.some((p) => p.isActive === true), [profiles]);

  return { hasActive, isLoading, profiles };
}
