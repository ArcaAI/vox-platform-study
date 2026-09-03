'use client';

/**
 * Debounced autosave `PATCH` with `If-Match`, paused on 412, never auto-retried ( Task
 * 15 / flow, implemented literally — `contracts/definition-api.contract.md`).
 *
 * Deliberately NOT a TanStack `useMutation` — the debounce-coalesce-then-single-flight
 * discipline and the "stop autosaving after a conflict, resume only on an explicit user action"
 * rule are easier to reason about as a small hand-rolled scheduler than to bend a mutation hook
 * into. `updateWorkflowDefinition` (Task 10's `api/client.ts`) is the only network call made.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { GatewayError } from '@/shared/api';
import { updateWorkflowDefinition } from '../api/client';
import type { UpdateWorkflowDefinitionRequest, WorkflowDefinition } from '../api/types';
import type { AutosaveState } from '../store/types';

export interface UseAutosaveOptions {
  definitionId: string;
  /** The ETag captured at the last successful read/save — read lazily so the hook always PATCHes
   *  against the freshest known version. */
  getEtag: () => string | null;
  onSaved: (definition: WorkflowDefinition, etag: string | null) => void;
  onStateChange: (state: AutosaveState) => void;
  onMissingPrecondition?: () => void;
  debounceMs?: number;
}

export interface UseAutosaveResult {
  /** Debounce-coalesced: calling this repeatedly within `debounceMs` only fires ONE PATCH with
   *  the LATEST patch. A no-op while paused (412 conflict) — never auto-retries. */
  schedule: (patch: UpdateWorkflowDefinitionRequest) => void;
  /** Cancels a pending debounced save without sending it (route-change guard, unmount). */
  cancel: () => void;
  /** Clears the 412 pause after the caller has resolved the conflict (reload or explicit
   *  overwrite via `OccConflictAlert`) — autosave NEVER resumes by itself. */
  resume: () => void;
  paused: boolean;
  /** The raw error from the last failed save, for `OccConflictAlert` (`shared/occ/occ-alert.tsx`
   *  — takes `error: unknown` directly). `null` after a success or `resume()`. */
  lastError: GatewayError | null;
}

const DEFAULT_DEBOUNCE_MS = 1000;

export function useAutosave({ definitionId, getEtag, onSaved, onStateChange, onMissingPrecondition, debounceMs = DEFAULT_DEBOUNCE_MS }: UseAutosaveOptions): UseAutosaveResult {
  const [paused, setPaused] = useState(false);
  const [lastError, setLastError] = useState<GatewayError | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatchRef = useRef<UpdateWorkflowDefinitionRequest | null>(null);
  const pausedRef = useRef(false);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const flush = useCallback(async () => {
    const patch = pendingPatchRef.current;
    pendingPatchRef.current = null;
    if (!patch) return;
    const etag = getEtag();
    if (!etag) {
      // No ETag captured yet — this is a client bug (a save was scheduled before the initial
      // GET completed), not a server precondition failure; surface it the same way as 428.
      onMissingPrecondition?.();
      return;
    }
    onStateChange('saving');
    try {
      const { data, etag: nextEtag } = await updateWorkflowDefinition(definitionId, patch, etag);
      setLastError(null);
      onSaved(data, nextEtag);
      onStateChange('saved');
    } catch (error) {
      if (error instanceof GatewayError && error.isVersionConflict) {
        pausedRef.current = true;
        setPaused(true);
        setLastError(error);
        onStateChange('conflict');
        return;
      }
      if (error instanceof GatewayError && error.isMissingPrecondition) {
        setLastError(error);
        onMissingPrecondition?.();
        onStateChange('error');
        return;
      }
      if (error instanceof GatewayError) setLastError(error);
      onStateChange('error');
    }
  }, [definitionId, getEtag, onSaved, onStateChange, onMissingPrecondition]);

  const schedule = useCallback(
    (patch: UpdateWorkflowDefinitionRequest) => {
      if (pausedRef.current) return; // Never auto-retry past a 412 — an explicit resume is required.
      pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, debounceMs);
    },
    [debounceMs, flush],
  );

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingPatchRef.current = null;
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    setPaused(false);
    setLastError(null);
  }, []);

  return { schedule, cancel, resume, paused, lastError };
}
