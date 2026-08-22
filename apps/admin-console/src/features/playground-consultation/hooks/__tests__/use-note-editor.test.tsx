/**
 * W1 / R5 — the two-writer contract for the SOAP note.
 *
 * The clinician edits while the system keeps transcribing and generating. The
 * single inviolable rule: clinician-typed text is NEVER discarded without an
 * explicit clinician action. A machine write may reach the VIEW; it may never
 * reach the BUFFER while that buffer is dirty.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GatewayError } from '@/shared/api';
import { useNoteEditor, type EditableDraft } from '../use-note-editor';

const draftV1: EditableDraft = { id: 'sum-1', content: 'S: cough\nO: afebrile', version: 1 };
const draftV2: EditableDraft = { id: 'sum-1', content: 'S: cough x3d\nO: afebrile', version: 2 };
const machineDraft: EditableDraft = { id: 'sum-2', content: 'S: machine rewrite', version: 1 };

function setup(draft: EditableDraft | null, overrides: Partial<Parameters<typeof useNoteEditor>[0]> = {}) {
  const onSave = overrides.onSave ?? vi.fn(async () => draftV2);
  const onReload = overrides.onReload ?? vi.fn(async () => draftV2);
  const hook = renderHook(({ d }: { d: EditableDraft | null }) => useNoteEditor({ draft: d, onSave, onReload }), {
    initialProps: { d: draft },
  });
  return { ...hook, onSave, onReload };
}

describe('useNoteEditor — clean (not editing)', () => {
  it('mirrors the server draft when the clinician has not started editing', () => {
    const { result, rerender } = setup(draftV1);
    expect(result.current.value).toBe(draftV1.content);
    expect(result.current.isEditing).toBe(false);

    // A machine write lands: with no clinician text at risk, it flows straight through.
    rerender({ d: machineDraft });
    expect(result.current.value).toBe(machineDraft.content);
    expect(result.current.supersededBy).toBeNull();
  });
});

describe('useNoteEditor — dirty buffer vs. a machine write', () => {
  it('does NOT let an incoming machine draft overwrite unsaved clinician text', () => {
    const { result, rerender } = setup(draftV1);

    act(() => result.current.beginEdit());
    act(() => result.current.change('S: cough x3 days, worse at night'));
    expect(result.current.isDirty).toBe(true);

    // The harness finishes a new draft mid-edit (a NEW row id).
    rerender({ d: machineDraft });

    // The buffer is untouched; the arrival is surfaced, not applied.
    expect(result.current.value).toBe('S: cough x3 days, worse at night');
    expect(result.current.supersededBy).toEqual(machineDraft);
  });

  it('keepMine() dismisses the notice and retains clinician text', () => {
    const { result, rerender } = setup(draftV1);
    act(() => result.current.beginEdit());
    act(() => result.current.change('mine'));
    rerender({ d: machineDraft });

    act(() => result.current.keepMine());
    expect(result.current.supersededBy).toBeNull();
    expect(result.current.value).toBe('mine');
  });

  it('acceptIncoming() replaces the buffer only on an explicit clinician action', () => {
    const { result, rerender } = setup(draftV1);
    act(() => result.current.beginEdit());
    act(() => result.current.change('mine'));
    rerender({ d: machineDraft });

    act(() => result.current.acceptIncoming());
    expect(result.current.value).toBe(machineDraft.content);
    expect(result.current.supersededBy).toBeNull();
    expect(result.current.isDirty).toBe(false);
  });
});

describe('useNoteEditor — saving under optimistic concurrency', () => {
  it('saves with the version captured at read time', async () => {
    const { result, onSave } = setup(draftV1);
    act(() => result.current.beginEdit());
    act(() => result.current.change('edited'));
    await act(async () => {
      await result.current.save();
    });
    expect(onSave).toHaveBeenCalledWith({ summaryId: 'sum-1', content: 'edited', expectedVersion: 1 });
    expect(result.current.isEditing).toBe(false);
  });

  it('a 412 NEVER discards clinician text — it raises a resolvable conflict', async () => {
    const onSave = vi.fn(async () => {
      throw new GatewayError(412, 'Precondition Failed');
    });
    const onReload = vi.fn(async () => draftV2);
    const { result } = setup(draftV1, { onSave, onReload });

    act(() => result.current.beginEdit());
    act(() => result.current.change('clinician text that must survive'));
    await act(async () => {
      await result.current.save();
    });

    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    // The one unacceptable outcome must not happen.
    expect(result.current.value).toBe('clinician text that must survive');
    expect(result.current.conflict?.serverContent).toBe(draftV2.content);
    expect(result.current.isEditing).toBe(true);
  });

  it('overwriteConflict() re-saves clinician text against the refreshed version', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new GatewayError(412, 'Precondition Failed'))
      .mockResolvedValueOnce({ id: 'sum-1', content: 'clinician text', version: 3 });
    const { result } = setup(draftV1, { onSave, onReload: vi.fn(async () => draftV2) });

    act(() => result.current.beginEdit());
    act(() => result.current.change('clinician text'));
    await act(async () => {
      await result.current.save();
    });
    await waitFor(() => expect(result.current.conflict).not.toBeNull());

    await act(async () => {
      await result.current.overwriteConflict();
    });

    expect(onSave).toHaveBeenLastCalledWith({ summaryId: 'sum-1', content: 'clinician text', expectedVersion: 2 });
    expect(result.current.conflict).toBeNull();
  });

  it('surfaces a non-412 failure without dropping the buffer', async () => {
    const onSave = vi.fn(async () => {
      throw new GatewayError(400, 'Summary is approved and locked');
    });
    const { result } = setup(draftV1, { onSave });

    act(() => result.current.beginEdit());
    act(() => result.current.change('late edit'));
    await act(async () => {
      await result.current.save();
    });

    await waitFor(() => expect(result.current.error).toBe('Summary is approved and locked'));
    expect(result.current.value).toBe('late edit');
    expect(result.current.isEditing).toBe(true);
  });
});

describe('useNoteEditor — stale reads', () => {
  it('never walks the buffer backwards onto an older version of the same row', () => {
    const { result, rerender } = setup(draftV2);
    act(() => result.current.beginEdit());
    // Clinician opened the editor but typed nothing; a stale refetch lands.
    rerender({ d: draftV1 });
    // v1 is older than the v2 baseline — it must be ignored, not adopted.
    expect(result.current.value).toBe(draftV2.content);
  });
});

describe('useNoteEditor — cancel', () => {
  it('cancel() reverts to the server draft and leaves edit mode', () => {
    const { result } = setup(draftV1);
    act(() => result.current.beginEdit());
    act(() => result.current.change('scratch'));
    act(() => result.current.cancel());
    expect(result.current.value).toBe(draftV1.content);
    expect(result.current.isEditing).toBe(false);
    expect(result.current.isDirty).toBe(false);
  });
});
