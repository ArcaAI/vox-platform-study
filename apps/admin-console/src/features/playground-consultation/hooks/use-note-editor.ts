'use client';

/**
 * W1 / R5 — the clinician's SOAP editing buffer, and the two-writer contract
 * around it.
 *
 * R5 asks for editing *while the system keeps transcribing and generating*, so
 * two writers share one document. The rule this hook enforces:
 *
 *   **A machine write may reach the VIEW. It may never reach the BUFFER while
 *   that buffer holds unsaved clinician text.**
 *
 * Nothing is auto-merged. Two prose SOAP notes have no field structure to
 * merge on (the server stores whole-document `content`), and the client cannot
 * hold back a generation it does not control — so the only honest option left
 * is to surface the collision and let the clinician resolve it. Losing typed
 * clinical text is the one outcome that is never acceptable.
 *
 * This mirrors the server's own posture rather than inventing a policy:
 * `SummaryService.updateSummary` forwards a mid-assurance edit to the harness
 * (`signalEdit`), which then re-runs assurance against the *edited* content.
 * The platform already treats the human edit as authoritative; the UI does too.
 *
 * Two distinct collisions exist, and they are NOT the same event:
 *
 * 1. **Supersede** — a regeneration CREATES a new summary row
 *    (`summary.service.ts:409,659`), so `summary/latest` starts returning a
 *    different `id`. Saving to the row now being edited would succeed and then
 *    be invisible, because the newer row is what `latest` serves. `keepMine()`
 *    therefore re-bases the buffer onto the incoming row while KEEPING the
 *    clinician's text, so the save lands on the row that is actually current.
 * 2. **Version drift** — the same row moved (HTTP 412). The buffer is kept and
 *    a conflict is raised carrying the server's side for comparison.
 */

import { useCallback, useState } from 'react';
import { GatewayError } from '@/shared/api';

/** The editable slice of a persisted summary: the row, its text, its OCC version. */
export interface EditableDraft {
  id: string;
  content: string;
  version: number;
}

export interface NoteEditorConflict {
  /** The server's current text, for side-by-side comparison. Never auto-applied. */
  serverContent: string;
  serverVersion: number;
}

export interface UseNoteEditorOptions {
  /** Latest persisted draft from the server; null when none exists yet. */
  draft: EditableDraft | null;
  /** PATCH `:id/summary/:summaryId` under If-Match. Rejects with a 412 GatewayError on drift. */
  onSave: (args: { summaryId: string; content: string; expectedVersion: number }) => Promise<EditableDraft>;
  /** Re-read the latest draft — used to show the server's side of a 412. */
  onReload: () => Promise<EditableDraft | null>;
}

export interface UseNoteEditorResult {
  /** Text to render. While editing this is the clinician's buffer, never the server's. */
  value: string;
  isEditing: boolean;
  isDirty: boolean;
  saving: boolean;
  /** A newer machine draft arrived while the buffer was dirty. Surfaced, not applied. */
  supersededBy: EditableDraft | null;
  /** Set after a 412. The buffer is intact; the clinician chooses. */
  conflict: NoteEditorConflict | null;
  /** Last save failure that is not a conflict (e.g. "approved and locked"). */
  error: string | null;
  beginEdit: () => void;
  change: (next: string) => void;
  cancel: () => void;
  save: () => Promise<void>;
  /** Explicit: discard my text, take the incoming machine draft. */
  acceptIncoming: () => void;
  /** Explicit: keep my text, re-based onto the incoming row so the save is the one that counts. */
  keepMine: () => void;
  /** Explicit: re-apply my text on top of the server's newer version. */
  overwriteConflict: () => Promise<void>;
  dismissError: () => void;
}

interface EditorState {
  /** The row the buffer is based on — supplies `expectedVersion` on save. */
  baseline: EditableDraft | null;
  /** null ⇒ not editing (the view follows the server). */
  buffer: string | null;
  superseded: EditableDraft | null;
  conflict: NoteEditorConflict | null;
  error: string | null;
  /** `id@version` of the last server draft this state reconciled against. */
  trackedKey: string | null;
}

const draftKey = (draft: EditableDraft | null): string | null => (draft ? `${draft.id}@${draft.version}` : null);

function initialState(draft: EditableDraft | null): EditorState {
  return { baseline: draft, buffer: null, superseded: null, conflict: null, error: null, trackedKey: draftKey(draft) };
}

/**
 * Folds a newly observed server draft into the editor state. Pure, so the
 * two-writer contract is testable without a component.
 */
function reconcile(state: EditorState, draft: EditableDraft | null, key: string | null): EditorState {
  // Not editing: nothing of the clinician's is at risk, so follow the server.
  if (state.buffer === null) {
    return { baseline: draft, buffer: null, superseded: null, conflict: null, error: state.error, trackedKey: key };
  }

  // A stale read must never walk the buffer backwards onto an older version of
  // the same row (a refetch that raced a save we already applied locally).
  if (draft && state.baseline && draft.id === state.baseline.id && draft.version < state.baseline.version) {
    return { ...state, trackedKey: key };
  }

  const dirty = state.buffer !== (state.baseline?.content ?? '');
  if (!dirty) {
    // Edit mode is open but empty-handed — adopting costs the clinician nothing.
    return { baseline: draft, buffer: draft?.content ?? '', superseded: null, conflict: null, error: state.error, trackedKey: key };
  }

  // Dirty: the machine write is announced, never applied.
  return { ...state, superseded: draft, trackedKey: key };
}

export function useNoteEditor({ draft, onSave, onReload }: UseNoteEditorOptions): UseNoteEditorResult {
  const [state, setState] = useState<EditorState>(() => initialState(draft));
  const [saving, setSaving] = useState(false);

  // Render-time derived-state sync (the house pattern — see `useSnapshotStream`
  // in ../api/hooks.ts): no effect, no extra commit, no flash of server text
  // over the clinician's buffer.
  const incomingKey = draftKey(draft);
  if (incomingKey !== state.trackedKey) {
    setState((current) => reconcile(current, draft, incomingKey));
  }

  const isEditing = state.buffer !== null;
  const value = state.buffer ?? state.baseline?.content ?? '';
  const isDirty = isEditing && state.buffer !== (state.baseline?.content ?? '');

  const beginEdit = useCallback(() => {
    setState((s) => (s.buffer !== null ? s : { ...s, buffer: s.baseline?.content ?? '', error: null }));
  }, []);

  const change = useCallback((next: string) => {
    setState((s) => ({ ...s, buffer: next, error: null }));
  }, []);

  const cancel = useCallback(() => {
    setState((s) => ({ ...s, buffer: null, superseded: null, conflict: null, error: null }));
  }, []);

  const acceptIncoming = useCallback(() => {
    setState((s) => (s.superseded ? { ...s, baseline: s.superseded, buffer: s.superseded.content, superseded: null } : s));
  }, []);

  /**
   * Keep the clinician's text, but re-base it onto the row that is now current
   * — otherwise the save would land on a superseded row and vanish from view.
   */
  const keepMine = useCallback(() => {
    setState((s) => (s.superseded ? { ...s, baseline: s.superseded, superseded: null } : s));
  }, []);

  const dismissError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  const commit = useCallback(
    async (content: string, baseline: EditableDraft) => {
      setSaving(true);
      try {
        const saved = await onSave({ summaryId: baseline.id, content, expectedVersion: baseline.version });
        setState({ baseline: saved, buffer: null, superseded: null, conflict: null, error: null, trackedKey: draftKey(saved) });
      } catch (error) {
        if (error instanceof GatewayError && error.isVersionConflict) {
          // 412. The buffer stays exactly as typed; re-base so the clinician can
          // re-apply it on top of whatever the server now holds.
          const fresh = await onReload().catch(() => null);
          setState((s) => ({
            ...s,
            baseline: fresh ?? s.baseline,
            trackedKey: draftKey(fresh ?? s.baseline),
            conflict: fresh
              ? { serverContent: fresh.content, serverVersion: fresh.version }
              : { serverContent: '', serverVersion: s.baseline?.version ?? 0 },
          }));
          return;
        }
        setState((s) => ({ ...s, error: error instanceof Error ? error.message : 'Could not save the note' }));
      } finally {
        setSaving(false);
      }
    },
    [onSave, onReload],
  );

  const save = useCallback(async () => {
    if (state.buffer === null || !state.baseline) return;
    await commit(state.buffer, state.baseline);
  }, [commit, state.buffer, state.baseline]);

  const overwriteConflict = useCallback(async () => {
    if (state.buffer === null || !state.baseline) return;
    await commit(state.buffer, state.baseline);
  }, [commit, state.buffer, state.baseline]);

  return {
    value,
    isEditing,
    isDirty,
    saving,
    supersededBy: state.superseded,
    conflict: state.conflict,
    error: state.error,
    beginEdit,
    change,
    cancel,
    save,
    acceptIncoming,
    keepMine,
    overwriteConflict,
    dismissError,
  };
}
