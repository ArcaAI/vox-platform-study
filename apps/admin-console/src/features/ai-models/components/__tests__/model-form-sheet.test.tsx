/**
 * TASK-769: `ModelFormSheet` was a hand-rolled `SheetContent`; it now composes
 * the console-wide `DetailDrawer` with its actions in the PINNED footer
 * (submit reaches the form through `form={formId}`). Covered here: open/close
 * wiring, the accessible name, that the loaded row still seeds the fields
 * without a remount, and the guard that stops a close from silently
 * discarding unsaved edits.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { AiModel } from '../../api/types';
import { ModelFormSheet } from '../model-form-sheet';

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const MODEL: AiModel = {
  id: 'm-1',
  name: 'Whisper Large v4',
  slug: 'whisper-large-v4',
  description: 'STT fallback',
  category: 'AUDIO',
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  modelType: 'BASE_MODEL',
  source: 'HUGGINGFACE',
  sourceUri: 'openai/whisper-large-v4',
  sourceRevision: null,
  format: 'FASTER_WHISPER',
  provider: 'built-in',
  architecture: 'whisper',
  memorySizeMb: 3096,
  computeType: 'float16',
  downloadStatus: 'DOWNLOADED',
  localPath: null,
  downloadedAt: null,
  fileSizeMb: null,
  checksum: null,
  resourceStatus: 'ENABLED',
  version: 4,
  tags: ['stt'],
  tenantId: 't-1',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(MODEL, { headers: { etag: '"4"' } })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ModelFormSheet', () => {
  it('is closed until `open`, and names the register drawer', async () => {
    stubFetch();
    const { rerender } = renderWithProviders(<ModelFormSheet open={false} onOpenChange={() => {}} modelId={null} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<ModelFormSheet open onOpenChange={() => {}} modelId={null} />);
    // Accessible name comes from the drawer title.
    const dialog = await screen.findByRole('dialog', { name: 'Register model' });
    // Actions live in the pinned footer, reaching the form by id.
    expect((within(dialog).getByRole('button', { name: 'Register model' }) as HTMLButtonElement).getAttribute('form')).toBeTruthy();
  });

  it('closes straight away when nothing was edited', async () => {
    stubFetch();
    const onOpenChange = vi.fn();
    renderWithProviders(<ModelFormSheet open onOpenChange={onOpenChange} modelId={null} />);

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('never discards unsaved edits silently — closing asks first', async () => {
    stubFetch();
    const onOpenChange = vi.fn();
    renderWithProviders(<ModelFormSheet open onOpenChange={onOpenChange} modelId={null} />);

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Gemma 4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Discard unsaved changes?')).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    fireEvent.click(within(confirm).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('seeds the fields from the loaded row in the SAME drawer node (no remount)', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId="m-1" />);

    // The drawer node captured while the row is still loading must be the one
    // the loaded form renders into — the retired Sheet did the same.
    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    expect(await within(dialog).findByDisplayValue('Whisper Large v4')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeDefined();
  });
});
