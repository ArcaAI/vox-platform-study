/**
 * What the in-node prompt editor is allowed to CLAIM happened.
 *
 * `PUT :id/nodes/:nodeId/prompt` used to mint unconditionally, so "Minted v6 and pinned …" was
 * always true. It is not any more: content byte-identical to the template's latest version
 * moves the pin and mints NOTHING, and a node already pinned there is a true no-op — no graph
 * write, no `_version` bump, no sys-event.
 *
 * Because DD-11 PATH 2 deliberately leaves node pins alone when a template is edited out of
 * band, ADOPTION is the COMMON path through this dialog, not the rare one. A success toast that
 * reports a mint on every save would therefore be wrong most of the time, and specifically wrong
 * about whether an immutable clinical artifact was created. So the outcome is read off the
 * response (`promptVersionMinted` / `promptVersionNumber`) rather than predicted from
 * `latest + 1`.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { renderWithProviders } from '@/test/render';
import type { NodePromptBinding } from '../../../api/types';
import { NodePromptEditor } from '../node-prompt-editor';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const LATEST_CONTENT = 'Reviewed wording from the library.';

function binding(overrides: Partial<NodePromptBinding> = {}): NodePromptBinding {
  return {
    nodeId: 'generate_note',
    nodeType: 'prompt.template_ref',
    promptTemplateId: '11111111-1111-4111-8111-111111111111',
    promptTemplateName: 'SOAP note generation',
    pinnedVersionNumber: 4,
    latestVersionNumber: 5,
    hasNewVersion: true,
    ...overrides,
  };
}

/** The PUT answer, shaped like `NodePromptUpdateResponse` — a superset of the definition. */
function updateResponse(overrides: Record<string, unknown>) {
  return Response.json({ id: 'def-1', version: 8, ...overrides }, { headers: { etag: '"8"' } });
}

function stubEditor(putResponse: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      if (path.endsWith('/versions')) {
        return Response.json([
          { id: 'pv-4', versionNumber: 4, content: 'Old wording.' },
          { id: 'pv-5', versionNumber: 5, content: LATEST_CONTENT },
        ]);
      }
      if ((init?.method ?? 'GET') === 'PUT') return putResponse;
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
}

async function openEditor() {
  renderWithProviders(
    <NodePromptEditor binding={binding()} definitionId="def-1" etag='"7"' open onOpenChange={vi.fn()} onSaved={vi.fn()} />,
  );
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect((within(dialog).getByLabelText('Prompt content') as HTMLTextAreaElement).value).toBe(LATEST_CONTENT));
  return dialog;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  cleanup();
});

describe('NodePromptEditor — reporting what the server actually did', () => {
  it('reports a MINT with the version the server stamped, not a locally guessed latest + 1', async () => {
    stubEditor(updateResponse({ promptVersionMinted: true, promptVersionNumber: 6, previousPromptVersionNumber: 4 }));
    const dialog = await openEditor();

    fireEvent.change(within(dialog).getByLabelText('Prompt content'), { target: { value: 'Edited wording.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Save as v6 and pin this node/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.calls[0][0]).toBe('Minted v6 and pinned generate_note to it');
  });

  it('does NOT claim a mint when the server adopted an existing version', async () => {
    // The common path: the editor opens on the template's latest content and the admin saves it
    // unchanged. The server moves the pin to v5 and mints nothing.
    stubEditor(updateResponse({ promptVersionMinted: false, promptVersionNumber: 5, previousPromptVersionNumber: 4 }));
    const dialog = await openEditor();

    fireEvent.click(within(dialog).getByRole('button', { name: /Adopt v5 for this node/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const message = vi.mocked(toast.success).mock.calls[0][0] as string;
    expect(message).toBe('Pinned generate_note to the existing v5 — no new version was created');
    expect(message).not.toMatch(/minted/i);
    // The old bug in one assertion: it must never name a version the server did not create.
    expect(message).not.toMatch(/v6/);
  });

  it('says plainly that NOTHING changed when the node was already pinned to that version', async () => {
    stubEditor(updateResponse({ promptVersionMinted: false, promptVersionNumber: 5, previousPromptVersionNumber: 5 }));
    const dialog = await openEditor();

    fireEvent.click(within(dialog).getByRole('button', { name: /Adopt v5 for this node/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.calls[0][0]).toBe('generate_note was already pinned to v5 — nothing changed');
  });

  it('labels the action by what saving would actually do — adopt while unchanged, mint once edited', async () => {
    stubEditor(updateResponse({ promptVersionMinted: true, promptVersionNumber: 6, previousPromptVersionNumber: 4 }));
    const dialog = await openEditor();

    expect(within(dialog).getByRole('button', { name: /Adopt v5 for this node/ })).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: /Save as v6/ })).toBeNull();

    fireEvent.change(within(dialog).getByLabelText('Prompt content'), { target: { value: 'Edited wording.' } });
    expect(within(dialog).getByRole('button', { name: /Save as v6 and pin this node/ })).toBeDefined();
  });

  it('states BOTH outcomes up front, so the dialog never promises a mint it may not perform', async () => {
    stubEditor(updateResponse({ promptVersionMinted: true, promptVersionNumber: 6, previousPromptVersionNumber: 4 }));
    const dialog = await openEditor();

    expect(within(dialog).getByText(/Saving unchanged content adopts v5 and creates nothing/i)).toBeDefined();
    expect(within(dialog).getByText(/any edit mints v6/i)).toBeDefined();
  });

  it('still surfaces a failure as an error toast', async () => {
    stubEditor(Response.json({ message: 'Definition has changed', statusCode: 412 }, { status: 412 }));
    const dialog = await openEditor();

    fireEvent.click(within(dialog).getByRole('button', { name: /Adopt v5 for this node/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });
});
