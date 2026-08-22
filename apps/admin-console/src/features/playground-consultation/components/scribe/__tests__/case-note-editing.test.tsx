/**
 * W1 / R5 — the editing surface, driven by the REAL `useNoteEditor` through the
 * real column. This is the test that stands behind the promise made in the
 * ticket: a clinician who has typed clinical text never loses it, no matter
 * what the machine writers do underneath.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GatewayError } from '@/shared/api';
import { useNoteEditor, type EditableDraft } from '../../../hooks/use-note-editor';
import { CaseNoteColumn } from '../case-note-column';
import type { SummaryResult } from '../../../api';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const summary = (over: Partial<SummaryResult> = {}): SummaryResult => ({
  id: 'ctx-1',
  consultationId: 'c-1',
  type: 'summary',
  content: 'S: Follow-up for hypertension.',
  version: 1,
  ...over,
});

/** Wires the real hook to the real column, with the server side controlled by the test. */
function Harness({
  initial,
  onSave = vi.fn(async () => ({ id: 'ctx-1', content: 'saved', version: 2 })),
  onReload = vi.fn(async () => ({ id: 'ctx-1', content: 'server side', version: 2 })),
}: {
  initial: SummaryResult;
  onSave?: (a: { summaryId: string; content: string; expectedVersion: number }) => Promise<EditableDraft>;
  onReload?: () => Promise<EditableDraft | null>;
}) {
  const [draft, setDraft] = useState<SummaryResult>(initial);
  const editor = useNoteEditor({
    draft: { id: draft.id, content: draft.content, version: draft.version },
    onSave,
    onReload,
  });
  return (
    <>
      <button onClick={() => setDraft(summary({ id: 'ctx-2', content: 'MACHINE REWROTE THE NOTE', version: 1 }))}>
        simulate machine write
      </button>
      <CaseNoteColumn
        hasConsultation
        isRecording={false}
        live={null}
        draft={draft}
        draftLoading={false}
        progress={null}
        assurance={null}
        onGenerate={null}
        generatePending={false}
        onApprove={vi.fn()}
        approvePending={false}
        approved={false}
        editor={editor}
      />
    </>
  );
}

afterEach(cleanup);

async function startTyping(text: string) {
  fireEvent.click(screen.getByRole('button', { name: /edit note/i }));
  const box = await screen.findByRole('textbox', { name: /case note/i });
  fireEvent.change(box, { target: { value: text } });
  return box as HTMLTextAreaElement;
}

describe('CaseNoteColumn — editing surface', () => {
  it('renders the draft read-only until the clinician chooses to edit', () => {
    render(<Harness initial={summary()} />);
    expect(screen.queryByRole('textbox', { name: /case note/i })).toBeNull();
    expect((screen.getByRole('button', { name: /edit note/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a machine write during an active edit does not touch the typed text', async () => {
    render(<Harness initial={summary()} />);
    const box = await startTyping('S: chest pain, radiating to left arm');

    fireEvent.click(screen.getByRole('button', { name: /simulate machine write/i }));

    expect(box.value).toBe('S: chest pain, radiating to left arm');
    expect(await screen.findByText(/newer draft/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep my version/i })).toBeTruthy();
  });

  it('a 412 is surfaced visibly and the clinician text is still on screen', async () => {
    const onSave = vi.fn(async () => {
      throw new GatewayError(412, 'Precondition Failed');
    });
    render(<Harness initial={summary()} onSave={onSave} />);
    const box = await startTyping('S: penicillin allergy — DO NOT PRESCRIBE');

    fireEvent.click(screen.getByRole('button', { name: /^save note$/i }));

    expect(await screen.findByText(/changed while you were editing/i)).toBeTruthy();
    expect(box.value).toBe('S: penicillin allergy — DO NOT PRESCRIBE');
    expect(screen.getByRole('button', { name: /overwrite with my version/i })).toBeTruthy();
  });

  it('saves with the If-Match version captured at read time', async () => {
    const onSave = vi.fn(async () => ({ id: 'ctx-1', content: 'edited', version: 8 }));
    render(<Harness initial={summary({ version: 7 })} onSave={onSave} />);
    await startTyping('edited');

    fireEvent.click(screen.getByRole('button', { name: /^save note$/i }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ summaryId: 'ctx-1', content: 'edited', expectedVersion: 7 }),
    );
  });

  it('cannot be edited once signed (the server locks approved summaries)', () => {
    render(
      <CaseNoteColumn
        hasConsultation
        isRecording={false}
        live={null}
        draft={summary()}
        draftLoading={false}
        progress={null}
        assurance={null}
        onGenerate={null}
        generatePending={false}
        onApprove={vi.fn()}
        approvePending={false}
        approved
      />,
    );
    expect(screen.queryByRole('button', { name: /edit note/i })).toBeNull();
  });
});
