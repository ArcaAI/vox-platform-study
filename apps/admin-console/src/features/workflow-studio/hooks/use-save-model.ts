'use client';

/**
 * TASK-893 §3.4 — the EXPLICIT save that replaces the Studio's debounced autosave.
 *
 * The transport half is unchanged and deliberately so: one `PATCH` with `If-Match`, a 412
 * PAUSES saving and is never retried by itself, a 428 (or a missing ETag, which is the same bug
 * seen a step earlier) surfaces through `onMissingPrecondition`. What is gone is the SCHEDULER —
 * the debounce, the coalescing `pendingPatchRef`, the timer and its unmount cleanup — because
 * with a Save button there is nothing left to coalesce: the user's click IS the flush.
 *
 * Still deliberately NOT a TanStack `useMutation`. The pause-after-conflict rule is a small
 * explicit state machine here, and `updateWorkflowDefinition` (`api/client.ts`) remains the only
 * network call made.
 */
import { useCallback, useRef, useState } from 'react';
import { GatewayError } from '@/shared/api';
import { updateWorkflowDefinition } from '../api/client';
import type { WorkflowDefinition, WorkflowGraph } from '../api/types';
import type { SaveState } from '../store/types';

/** What one explicit save may change. A subset of `UpdateWorkflowDefinitionRequest`:
 *  `expectedVersion` is NOT here because the client derives it from the ETag
 *  (`api/client.ts`'s `updateWorkflowDefinition`), so a caller can never send a version that
 *  disagrees with the precondition it just asserted. */
export interface SaveDefinitionPatch {
  graph?: WorkflowGraph;
  name?: string;
  description?: string;
}

export interface SaveOptions {
  /** TASK-965 WF-3 — an ETag that overrides `getEtag()` for THIS save only: the "Overwrite anyway"
   *  path has just read the latest row and must re-send against that version in the same tick,
   *  before React has re-rendered the state `getEtag` closes over. */
  etag?: string | null;
}

export interface UseSaveModelOptions {
  definitionId: string;
  /** The ETag captured at the last successful read/save — read lazily so the hook always PATCHes
   *  against the freshest known version. */
  getEtag: () => string | null;
  onSaved: (saved: WorkflowDefinition, nextEtag: string | null) => void;
  onStateChange: (state: SaveState) => void;
  /** A save was attempted with no ETag to assert, or the gateway answered 428. Both are client
   *  bugs (a save issued before the initial GET settled), not conditions to retry through. */
  onMissingPrecondition: () => void;
}

export interface SaveModel {
  /**
   * Explicit, user-initiated save. Resolves when the request has settled — it never throws, so a
   * toolbar handler can `void save(...)` without an error boundary; every outcome is reported
   * through `onStateChange` / `onSaved` / `onMissingPrecondition` and `lastError`.
   *
   * A no-op while `paused` (a 412 stands) or while a save is already in flight: a second click
   * on a stale ETag can only produce the same conflict, and the resolution is `resume()` after
   * the caller has reloaded or chosen to overwrite — exactly the rule autosave enforced, now
   * driven by a button instead of a timer.
   */
  save: (patch: SaveDefinitionPatch, options?: SaveOptions) => Promise<void>;
  saving: boolean;
  /** True after a 412 until `resume()`. */
  paused: boolean;
  /** The raw error from the last failed save, for `OccConflictAlert` (`shared/occ/occ-alert.tsx`
   *  — takes `error: unknown` directly). `null` after a success or `resume()`. */
  lastError: GatewayError | null;
  /** Clears the 412 pause after the caller has resolved the conflict (reload or explicit
   *  overwrite via `OccConflictAlert`) — saving NEVER resumes by itself. */
  resume: () => void;
}

export function useSaveModel({ definitionId, getEtag, onSaved, onStateChange, onMissingPrecondition }: UseSaveModelOptions): SaveModel {
  const [paused, setPaused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastError, setLastError] = useState<GatewayError | null>(null);
  // Refs, not the state above, guard re-entry: `setSaving(true)` is not visible to a second
  // click within the same tick, and a double-submit would race two PATCHes at the same ETag.
  const pausedRef = useRef(false);
  const savingRef = useRef(false);

  const save = useCallback(
    async (patch: SaveDefinitionPatch, options?: SaveOptions) => {
      if (pausedRef.current || savingRef.current) return;
      const etag = options?.etag ?? getEtag();
      if (!etag) {
        // No ETag captured yet — a client bug (a save issued before the initial GET completed),
        // not a server precondition failure; surfaced the same way as a 428, and NOT reported as
        // an `error` save state because nothing was attempted.
        onMissingPrecondition();
        return;
      }
      savingRef.current = true;
      setSaving(true);
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
          onMissingPrecondition();
          onStateChange('error');
          return;
        }
        if (error instanceof GatewayError) setLastError(error);
        onStateChange('error');
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [definitionId, getEtag, onSaved, onStateChange, onMissingPrecondition],
  );

  const resume = useCallback(() => {
    pausedRef.current = false;
    setPaused(false);
    setLastError(null);
  }, []);

  return { save, saving, paused, lastError, resume };
}
