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

export interface UseVoiceEnrollmentStatusOptions {
  /**
   * TASK-887 — the `AiModel` slug of the speaker-embedding model the agent the user will
   * transcribe with declares (`useVoiceEmbedding().enrollmentTarget()`).
   *
   * A profile is only ever matched by an agent bound to the model that embedded it, so a
   * profile from another model is INVISIBLE to this agent rather than merely less accurate —
   * which is why "enrolled" and "enrolled for THIS agent" are different questions.
   */
  modelId?: string;
}

export interface UseVoiceEnrollmentStatusReturn {
  /** True iff the user has at least one profile with `isActive === true`. */
  hasActive: boolean;
  /**
   * True when the user HAS an active profile but none of them were embedded by `modelId` —
   * the "re-enroll for this agent" state. Always false when no `modelId` was supplied (the
   * question cannot be asked) and when the user has nothing enrolled at all (that is
   * `!hasActive`, a different prompt).
   */
  needsReenrollment: boolean;
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

export function useVoiceEnrollmentStatus(options?: UseVoiceEnrollmentStatusOptions): UseVoiceEnrollmentStatusReturn {
  const { profiles, isLoading, list } = useVoiceEmbedding();
  const modelId = options?.modelId;

  const refresh = useCallback(() => {
    void list();
  }, [list]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const hasActive = useMemo(() => profiles.some((p) => p.isActive === true), [profiles]);
  const needsReenrollment = useMemo(
    () => Boolean(modelId) && hasActive && !profiles.some((p) => p.isActive === true && p.modelId === modelId),
    [profiles, hasActive, modelId],
  );

  return { hasActive, needsReenrollment, isLoading, profiles };
}
