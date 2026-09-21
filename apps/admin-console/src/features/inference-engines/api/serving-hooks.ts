'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getLmStudioRuntime, loadLmStudioModel, unloadLmStudioModel } from './serving-client';
import { inferenceEngineKeys } from './keys';
import type { LoadModelRequest } from './serving-types';

/**
 * The runtime read behind the Serving Control tab.
 *
 * `retry: false` for the same reason as the probe: an engine that is not up is
 * an ANSWER, and retrying three times only delays telling the operator so.
 *
 * `staleTime: 0` unlike every other read in this feature — this one backs load
 * and unload decisions against live VRAM, and a cached free-space figure is how
 * an admin arms a load the card can no longer take.
 */
export function useLmStudioRuntime() {
  return useQuery({
    queryKey: inferenceEngineKeys.runtime('lm-studio'),
    queryFn: getLmStudioRuntime,
    staleTime: 0,
    retry: false,
  });
}

/**
 * Load / reload one model.
 *
 * Deliberately NOT wired to a toast or a confirmation here: the caller owns
 * both, because the disruption this causes (D-2 — in-flight generations are
 * dropped) has to be named in the component that knows WHICH model is about to
 * go down.
 */
export function useLoadLmStudioModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ modelKey, body }: { modelKey: string; body: LoadModelRequest }) => loadLmStudioModel(modelKey, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inferenceEngineKeys.engine('lm-studio') }),
  });
}

/** Unload one running instance. Advisory — JIT reloads it on the next request. */
export function useUnloadLmStudioModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (identifier: string) => unloadLmStudioModel(identifier),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inferenceEngineKeys.engine('lm-studio') }),
  });
}
