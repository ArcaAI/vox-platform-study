/**
 * TASK-1023 (C4) — the slim, EDIT-ONLY model drawer: Name / Description / Tags editable, identity read-only,
 * a Serving tab, and an "Advanced defaults" tab (ASR decode profile) for ASR models only. OCC and the
 * mid-flight edit lock are unchanged.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { AiModel } from '../../api/types';
import { ModelEditSheet } from '../model-edit-sheet';
import { BASE_MODEL, lifecycle, stubFetch, type RecordedCall } from './fixtures.task1019';

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ASR_ROW: AiModel = {
  ...BASE_MODEL,
  tags: ['stt'],
  lifecycle: lifecycle('SERVING'),
  asrProfile: { maxDecodeWindowSec: 7, partialWindowSec: 15, decoding: { noSpeechThreshold: 0.4 } },
};
const NON_ASR_ROW: AiModel = { ...ASR_ROW, id: 'm-2', taskType: 'TOKEN_CLASSIFICATION', pipelineTag: 'token-classification', asrProfile: null };

function serve(row: AiModel, patchStatus = 200) {
  return stubFetch((url, method) => {
    if (method === 'PATCH') {
      return patchStatus === 200
        ? Response.json({ ...row, version: row.version + 1 }, { headers: { etag: `"${row.version + 1}"` } })
        : Response.json({ statusCode: patchStatus, message: 'Precondition Failed' }, { status: patchStatus });
    }
    if (url.endsWith('/download')) return Response.json({ status: 'DOWNLOADED', localPath: null });
    return Response.json(row, { headers: { etag: `"${row.version}"` } });
  });
}

async function openEdit(row: AiModel) {
  renderWithProviders(<ModelEditSheet open onOpenChange={() => {}} modelId={row.id} />);
  const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
  await within(dialog).findByDisplayValue(row.name);
  return dialog;
}

function openTab(dialog: HTMLElement, name: string) {
  const tab = within(dialog).getByRole('tab', { name });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

function patchOf(calls: RecordedCall[]) {
  return calls.find((call) => call.method === 'PATCH');
}

describe('ModelEditSheet — Details', () => {
  it('edits Name, Description and Tags; identity and classification are read-only', async () => {
    serve(ASR_ROW);
    const dialog = await openEdit(ASR_ROW);

    expect(within(dialog).getByLabelText(/^name/i)).toBeDefined();
    expect(within(dialog).getByLabelText(/^description/i)).toBeDefined();
    expect(within(dialog).getByLabelText(/^tags/i)).toBeDefined();
    // None of the 20+ registry fields is an input any more.
    for (const label of [/^slug/i, /^source uri/i, /^serving library/i, /^served by/i, /^licence/i, /^bucket prefix/i, /^category/i]) {
      expect(within(dialog).queryByLabelText(label)).toBeNull();
    }

    const identity = within(dialog).getByRole('group', { name: 'Identity and classification' });
    expect(within(identity).getByText('whisper-ml-en')).toBeDefined();
    expect(within(identity).getByText('whisper.cpp')).toBeDefined();
    expect(within(identity).getByText('stt')).toBeDefined();
    expect(within(identity).getByText('Hugging Face')).toBeDefined();
    expect(within(identity).getByText('whisper-ml-en/f16-0123456789ab/')).toBeDefined();
    expect(within(identity).getByText('mit')).toBeDefined();
  });

  it('saves only what changed, with If-Match derived from the read ETag', async () => {
    const calls = serve(ASR_ROW);
    const dialog = await openEdit(ASR_ROW);

    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Renamed' } });
    fireEvent.change(within(dialog).getByLabelText(/^tags/i), { target: { value: 'stt, primary' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patchOf(calls)).toBeDefined());
    const patch = patchOf(calls)!;
    expect(patch.url).toBe('/api/hope/admin/ai-models/m-1');
    expect(patch.body).toEqual({ name: 'Renamed', tags: ['stt', 'primary'], expectedVersion: 4 });
  });

  it('disables Save with a visible reason while nothing changed', async () => {
    serve(ASR_ROW);
    const dialog = await openEdit(ASR_ROW);
    const save = within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(dialog).getByText('No changes to save.')).toBeDefined();
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Renamed' } });
    expect(save.disabled).toBe(false);
  });

  it('shows the OCC conflict alert on a 412', async () => {
    serve(ASR_ROW, 412);
    const dialog = await openEdit(ASR_ROW);
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('button', { name: /reload latest/i })).toBeDefined();
  });

  it('keeps the Status section and the "Weights in the bucket" panel', async () => {
    serve(ASR_ROW);
    const dialog = await openEdit(ASR_ROW);
    expect(await within(dialog).findByText('Status')).toBeDefined();
    expect(await within(dialog).findByText('Weights in the bucket')).toBeDefined();
  });

  it('never discards unsaved edits silently', async () => {
    serve(ASR_ROW);
    const onOpenChange = vi.fn();
    renderWithProviders(<ModelEditSheet open onOpenChange={onOpenChange} modelId="m-1" />);
    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue(ASR_ROW.name);
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe('ModelEditSheet — Serving tab', () => {
  it('PATCHes the engine sizing facts as `serving`', async () => {
    const calls = serve(ASR_ROW);
    const dialog = await openEdit(ASR_ROW);
    openTab(dialog, 'Serving');

    fireEvent.change(await within(dialog).findByLabelText(/^vram/i), { target: { value: '5' } });
    fireEvent.change(within(dialog).getByLabelText(/^max concurrent sequences/i), { target: { value: '64' } });
    fireEvent.click(within(dialog).getByRole('switch', { name: /enforce eager/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patchOf(calls)).toBeDefined());
    expect(patchOf(calls)!.body).toEqual({ serving: { vramGiB: 5, maxNumSeqs: 64, enforceEager: true }, expectedVersion: 4 });
  });

  it('refuses a VRAM figure that is not greater than zero and disables Save', async () => {
    serve(ASR_ROW);
    const dialog = await openEdit(ASR_ROW);
    openTab(dialog, 'Serving');
    fireEvent.change(await within(dialog).findByLabelText(/^vram/i), { target: { value: '0' } });
    expect(within(dialog).getByText(/greater than 0/i)).toBeDefined();
    expect((within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('marks facts the gateway derived as "Estimated" when the row exposes them', async () => {
    serve({ ...ASR_ROW, servingFacts: { vramGiB: 4.5, derived: true } });
    const dialog = await openEdit(ASR_ROW);
    openTab(dialog, 'Serving');
    expect(await within(dialog).findByText('Estimated')).toBeDefined();
    expect((within(dialog).getByLabelText(/^vram/i) as HTMLInputElement).value).toBe('4.5');
  });
});

describe('ModelEditSheet — Advanced defaults (ASR only)', () => {
  it('is offered for an ASR row, pre-filled, with the note that tenants tune these per Agent', async () => {
    serve(ASR_ROW);
    const dialog = await openEdit(ASR_ROW);
    openTab(dialog, 'Advanced defaults');
    expect((await within(dialog).findByLabelText(/^max decode window/i) as HTMLInputElement).value).toBe('7');
    expect((within(dialog).getByLabelText(/^no-speech threshold/i) as HTMLInputElement).value).toBe('0.4');
    expect(within(dialog).getByText(/tenants tune these per agent/i)).toBeDefined();
  });

  it('is not offered for a non-ASR row', async () => {
    serve(NON_ASR_ROW);
    const dialog = await openEdit(NON_ASR_ROW);
    expect(within(dialog).queryByRole('tab', { name: 'Advanced defaults' })).toBeNull();
  });

  it('sends the edited profile, and refuses an out-of-range value', async () => {
    const calls = serve(ASR_ROW);
    const dialog = await openEdit(ASR_ROW);
    openTab(dialog, 'Advanced defaults');
    const window = await within(dialog).findByLabelText(/^max decode window/i);
    fireEvent.change(window, { target: { value: '99' } });
    expect(within(dialog).getByText(/must be between 1 and 30/i)).toBeDefined();
    expect((within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(window, { target: { value: '10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patchOf(calls)).toBeDefined());
    expect(patchOf(calls)!.body).toEqual({
      asrProfile: { maxDecodeWindowSec: 10, partialWindowSec: 15, decoding: { noSpeechThreshold: 0.4 } },
      expectedVersion: 4,
    });
  });
});

describe('ModelEditSheet — read-only while the row is mid-flight', () => {
  it.each([
    ['DOWNLOADING', 'Editing is unavailable while the model is downloading.'],
    ['UNREGISTERING', 'Editing is unavailable while the model is being unregistered.'],
  ] as const)('%s: fields and Save are disabled with the reason shown', async (status, reason) => {
    const row = { ...ASR_ROW, lifecycle: lifecycle(status) };
    serve(row);
    const dialog = await openEdit(row);
    const notice = within(dialog).getByText(reason);
    expect((within(dialog).getByLabelText(/^name/i) as HTMLInputElement).closest('fieldset[disabled]')).not.toBeNull();
    const save = within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('aria-describedby')).toBe(notice.id);
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Changed while locked' } });
    expect(within(dialog).queryByDisplayValue('Changed while locked')).toBeNull();
  });
});

describe('ModelEditSheet — a11y', () => {
  it.each(['Details', 'Serving', 'Advanced defaults'])('has no axe violations on the %s tab', async (tab) => {
    serve(ASR_ROW);
    const dialog = await openEdit(ASR_ROW);
    if (tab !== 'Details') {
      openTab(dialog, tab);
      await within(dialog).findByRole('tabpanel');
    }
    expect(await axe(dialog)).toHaveNoViolations();
  });
});
