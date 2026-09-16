/**
 * @arcaai/vox - useLocalVoiceEmbedding Hook
 *
 * A NEW, in-browser voice-enrollment provider that sits ALONGSIDE the existing
 * server-side `useVoiceEmbedding` (backend) provider — it never replaces it.
 *
 * Flow:
 *   1. Extract a speaker embedding locally with Transformers.js (WavLM `*-sv`)
 *      — the audio is processed entirely on the client.
 *   2. Persist the profile through the EXISTING enroll path by delegating to
 *      `useVoiceEmbedding().enroll` (multipart `POST /voice-profiles/enroll`), so
 *      the profile row (+ optional label) lands in the DB exactly as before
 *      (the server computes/stores its own embedding; schema unchanged).
 *   3. Cache the LOCAL embedding tenant/user-namespaced (encrypted) keyed to the
 *      returned profile id, so the "quick test" can run offline.
 *
 * Quick test: extract a fresh clip's embedding and cosine-compare it against the
 * locally-cached enrolled embedding(s) — the same speaker-verification check the
 * diarizer/user-voice detection relies on.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVoiceEmbedding, type EnrollFiles, type EnrollOptions, type VoiceProfile } from './useVoiceEmbedding';
import { useAgenticStore } from '../store';
import { SecureStorage } from '../utils/secureStorage';
import {
  averageEmbeddings,
  bestMatch,
  DEFAULT_VOICE_MATCH_THRESHOLD,
  type EnrolledEmbeddingRef,
  type VoiceMatchResult,
} from '../utils/voiceEmbedding';
import {
  createLocalVoiceEmbedder,
  isLocalVoiceEmbeddingSupported,
  type LocalVoiceEmbedder,
  type LocalVoiceEmbedderProgress,
} from '../core/LocalVoiceEmbedder';
import { clientInferenceDisabledError, isClientInferenceAllowed } from '../core/clientInferenceGate';

/** A locally-cached enrolled embedding, keyed to a persisted voice profile. */
export interface LocalVoiceEmbeddingRecord {
  profileId: string;
  label?: string | null;
  modelId: string;
  dim: number;
  embedding: number[];
  createdAt: string;
}

export type LocalVoiceStatus = 'idle' | 'loading-model' | 'extracting' | 'enrolling' | 'ready' | 'error';

export interface UseLocalVoiceEmbeddingReturn {
  /**
   * Whether in-browser extraction is possible AND permitted.
   *
   * `false` when the runtime cannot do it (no WebAssembly / Web Audio) OR when
   * the host has not set `audio.clientInference: { allow: true }` (TASK-977
   * D-6) — the two are indistinguishable to a caller on purpose: either way
   * there is no local extraction here and the caller should fall back to
   * `useVoiceEmbedding` (server-side enrol). Calling an action anyway rejects
   * with `AgenticError('CLIENT_INFERENCE_DISABLED')` rather than loading a model.
   */
  supported: boolean;
  /** Model id used for local extraction. */
  modelId: string;
  status: LocalVoiceStatus;
  /** Live model-download / extraction progress (null when idle). */
  progress: LocalVoiceEmbedderProgress | null;
  isBusy: boolean;
  error: Error | null;
  /** Locally-cached enrolled embeddings (hydrated from namespaced storage). */
  enrolled: LocalVoiceEmbeddingRecord[];
  /** Extract locally, persist via the existing enroll path, then cache. */
  enroll: (files: EnrollFiles, opts?: EnrollOptions) => Promise<VoiceProfile>;
  /** Compare a fresh clip against the enrolled embedding(s) (cosine). */
  quickTest: (file: File | Blob) => Promise<VoiceMatchResult | null>;
  /** Warm the model (download + init) ahead of enrollment. */
  preloadModel: () => Promise<void>;
  /** Forget all locally-cached embeddings for the current (user, tenant). */
  clearLocal: () => Promise<void>;
}

export interface UseLocalVoiceEmbeddingOptions {
  /** Injectable embedder (tests). Defaults to a Transformers.js WavLM embedder. */
  embedder?: LocalVoiceEmbedder;
  /** Cosine threshold for a quick-test match. */
  matchThreshold?: number;
}

function getCacheKeys(userId: string | null | undefined, tenantId: string | null | undefined) {
  if (!userId || !tenantId) return null;
  return {
    storageKey: `vox.localVoiceEmbeddings.${userId}.${tenantId}`,
    passphrase: `vox-lve-${userId}-${tenantId}`,
  };
}

async function writeCache(cacheKeys: { storageKey: string; passphrase: string } | null, records: LocalVoiceEmbeddingRecord[]): Promise<void> {
  if (!cacheKeys) return;
  try {
    await SecureStorage.setItemWithPassphrase(cacheKeys.storageKey, cacheKeys.passphrase, JSON.stringify(records));
  } catch {
    // Best-effort cache write — never fail the enroll on a cache error.
  }
}

/** Module-level so the deprecation is reported once per page load, not once per render. */
let localVoiceEmbeddingDeprecationWarned = false;

function warnLocalVoiceEmbeddingDeprecatedOnce(): void {
  if (localVoiceEmbeddingDeprecationWarned) return;
  localVoiceEmbeddingDeprecationWarned = true;
  console.warn(
    '[@arcaai/vox] useLocalVoiceEmbedding is deprecated (TASK-865, removed in R4): it runs a WavLM model in the browser. Use useVoiceEmbedding (server-side enrol) instead.',
  );
}

function normalizeFiles(files: EnrollFiles): ReadonlyArray<File | Blob> {
  if (Array.isArray(files)) return files as ReadonlyArray<File | Blob>;
  return [files as File | Blob];
}

/**
 * In-browser voice enrolment via Transformers.js (WavLM speaker verification).
 *
 * TASK-977 (D-6): this is the "voice embedding for diarization" the owner
 * directive requires to be OFF until an admin enables it, and it runs entirely
 * in the browser — so it is behind the same `audio.clientInference: { allow:
 * true }` switch `TranscriptionPipeline` reads. Without it `supported` is
 * `false` and every action rejects BEFORE the embedder is touched, so no
 * weights are fetched.
 *
 * @deprecated TASK-865 — removed in R4. The browser never runs a model; enrol with
 * `useVoiceEmbedding` (server-side). Logs a console warning on first use.
 */
export function useLocalVoiceEmbedding(options: UseLocalVoiceEmbeddingOptions = {}): UseLocalVoiceEmbeddingReturn {
  warnLocalVoiceEmbeddingDeprecatedOnce();
  // Reuse the EXISTING backend enroll path verbatim for DB persistence.
  const { enroll: backendEnroll } = useVoiceEmbedding();

  const store = useAgenticStore();
  const userId = (store as unknown as { authUser?: { id?: string } | null }).authUser?.id ?? null;
  const tenantId = (store as unknown as { config?: { api?: { tenantId?: string } } | null }).config?.api?.tenantId ?? null;
  // The host's own config, read off the provider store this hook already holds.
  const clientInferenceAllowed = isClientInferenceAllowed((store as unknown as { config?: Parameters<typeof isClientInferenceAllowed>[0] }).config);
  const cacheKeys = useMemo(() => getCacheKeys(userId, tenantId), [userId, tenantId]);

  const matchThreshold = options.matchThreshold ?? DEFAULT_VOICE_MATCH_THRESHOLD;

  // One embedder per hook instance; reused across enroll/quickTest calls.
  const embedderRef = useRef<LocalVoiceEmbedder | null>(null);
  if (!embedderRef.current) {
    embedderRef.current = options.embedder ?? createLocalVoiceEmbedder();
  }
  const embedder = embedderRef.current;

  // A runtime that CAN extract locally still may not: the host has to opt in.
  const supported = useMemo(
    () => clientInferenceAllowed && (options.embedder ? true : isLocalVoiceEmbeddingSupported()),
    [clientInferenceAllowed, options.embedder],
  );

  const [status, setStatus] = useState<LocalVoiceStatus>('idle');
  const [progress, setProgress] = useState<LocalVoiceEmbedderProgress | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [enrolled, setEnrolled] = useState<LocalVoiceEmbeddingRecord[]>([]);
  const enrolledRef = useRef<LocalVoiceEmbeddingRecord[]>([]);

  const applyEnrolled = useCallback((next: LocalVoiceEmbeddingRecord[]) => {
    enrolledRef.current = next;
    setEnrolled(next);
  }, []);

  // Hydrate locally-cached embeddings on mount / (user, tenant) change.
  const hydratedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!cacheKeys || hydratedKeyRef.current === cacheKeys.storageKey) return;
    hydratedKeyRef.current = cacheKeys.storageKey;
    let cancelled = false;
    void (async () => {
      try {
        const cached = await SecureStorage.getItemWithPassphrase(cacheKeys.storageKey, cacheKeys.passphrase);
        if (cached && !cancelled) {
          const parsed = JSON.parse(cached) as LocalVoiceEmbeddingRecord[];
          if (Array.isArray(parsed)) applyEnrolled(parsed);
        }
      } catch {
        // Best-effort hydration.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheKeys, applyEnrolled]);

  const handleProgress = useCallback((p: LocalVoiceEmbedderProgress) => setProgress(p), []);

  /**
   * The hard-off gate. Called FIRST by every action so the refusal lands before
   * the embedder is touched — `supported: false` tells a caller to branch, this
   * makes sure a caller that does not branch still cannot fetch weights.
   */
  const assertClientInferenceAllowed = useCallback(() => {
    if (clientInferenceAllowed) return;
    const err = clientInferenceDisabledError('useLocalVoiceEmbedding');
    setStatus('error');
    setError(err);
    throw err;
  }, [clientInferenceAllowed]);

  const preloadModel = useCallback(async () => {
    assertClientInferenceAllowed();
    setError(null);
    setStatus('loading-model');
    try {
      await embedder.load(handleProgress);
      setStatus('ready');
    } catch (err) {
      setStatus('error');
      setError(err as Error);
      throw err;
    }
  }, [assertClientInferenceAllowed, embedder, handleProgress]);

  const enroll = useCallback(
    async (files: EnrollFiles, opts?: EnrollOptions): Promise<VoiceProfile> => {
      // Refuse the whole call, not just the local half: the local extraction IS
      // this hook. A host that wants server-side enrolment calls
      // `useVoiceEmbedding().enroll` directly.
      assertClientInferenceAllowed();
      setError(null);
      const fileList = normalizeFiles(files);
      try {
        // 1. Extract locally (model loads lazily on first clip).
        setStatus('loading-model');
        await embedder.load(handleProgress);
        setStatus('extracting');
        const embeddings: number[][] = [];
        for (const file of fileList) {
          embeddings.push(await embedder.embedBlob(file, handleProgress));
        }
        const embedding = averageEmbeddings(embeddings);

        // 2. Persist via the EXISTING enroll path (audio → DB profile row).
        setStatus('enrolling');
        const profile = await backendEnroll(files, opts);

        // 3. Cache the LOCAL embedding keyed to the persisted profile.
        const record: LocalVoiceEmbeddingRecord = {
          profileId: profile.id,
          label: opts?.label ?? (typeof profile.label === 'string' ? profile.label : null),
          modelId: embedder.modelId,
          dim: embedding.length,
          embedding,
          createdAt: new Date().toISOString(),
        };
        const next = [...enrolledRef.current.filter((r) => r.profileId !== profile.id), record];
        applyEnrolled(next);
        await writeCache(cacheKeys, next);

        setProgress(null);
        setStatus('ready');
        return profile;
      } catch (err) {
        setStatus('error');
        setError(err as Error);
        throw err;
      }
    },
    [assertClientInferenceAllowed, embedder, handleProgress, backendEnroll, cacheKeys, applyEnrolled],
  );

  const quickTest = useCallback(
    async (file: File | Blob): Promise<VoiceMatchResult | null> => {
      assertClientInferenceAllowed();
      setError(null);
      try {
        setStatus('loading-model');
        await embedder.load(handleProgress);
        setStatus('extracting');
        const candidate = await embedder.embedBlob(file, handleProgress);
        const refs: EnrolledEmbeddingRef[] = enrolledRef.current.map((r) => ({
          profileId: r.profileId,
          embedding: r.embedding,
          label: r.label,
        }));
        const result = bestMatch(candidate, refs, matchThreshold);
        setProgress(null);
        setStatus('ready');
        return result;
      } catch (err) {
        setStatus('error');
        setError(err as Error);
        throw err;
      }
    },
    [assertClientInferenceAllowed, embedder, handleProgress, matchThreshold],
  );

  const clearLocal = useCallback(async () => {
    applyEnrolled([]);
    if (cacheKeys) {
      try {
        localStorage.removeItem(cacheKeys.storageKey);
      } catch {
        // ignore
      }
    }
  }, [cacheKeys, applyEnrolled]);

  const isBusy = status === 'loading-model' || status === 'extracting' || status === 'enrolling';

  return {
    supported,
    modelId: embedder.modelId,
    status,
    progress,
    isBusy,
    error,
    enrolled,
    enroll,
    quickTest,
    preloadModel,
    clearLocal,
  };
}
