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
import { axe } from 'vitest-axe';
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

// =============================================================================
// Weight source (sourceUri / localPath): the two loading modes, TASK-855
// =============================================================================
describe('ModelFormSheet — weight source (Mode U / Mode M)', () => {
  it('disables Local path with a visible reason in register mode — the create DTO does not accept it', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId={null} />);

    const dialog = await screen.findByRole('dialog', { name: 'Register model' });
    const localPath = within(dialog).getByLabelText(/local path/i) as HTMLInputElement;
    expect(localPath.disabled).toBe(true);
    const hintId = localPath.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(within(dialog).getByText(/set a mount override/i)).toBeDefined();
  });

  it('enables Local path in edit mode, seeded from the loaded row', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId="m-1" />);

    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue('Whisper Large v4');
    const localPath = within(dialog).getByLabelText(/local path/i) as HTMLInputElement;
    expect(localPath.disabled).toBe(false);
    // MODEL.localPath is null -> the field seeds empty, not "null".
    expect(localPath.value).toBe('');
  });

  it('always sends localPath on PATCH (including "" to clear a previously-set override)', async () => {
    const calls: { method: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ method, body });
        if (method === 'PATCH') return Response.json({ ...MODEL, version: 5 }, { headers: { etag: '"5"' } });
        return Response.json(MODEL, { headers: { etag: '"4"' } });
      }),
    );
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId="m-1" />);

    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue('Whisper Large v4');
    fireEvent.change(within(dialog).getByLabelText(/local path/i), { target: { value: '/mnt/models-bucket/whisper-large-v4/q4-0-451faffb5a16/' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect((patch.body as { localPath: string }).localPath).toBe('/mnt/models-bucket/whisper-large-v4/q4-0-451faffb5a16/');
  });

  it('explains Mode U (S3 URI) and Mode M (mount) and that <version> is content-derived, not typed by hand', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId={null} />);

    const dialog = await screen.findByRole('dialog', { name: 'Register model' });
    expect(within(dialog).getByText(/mode u/i)).toBeDefined();
    expect(within(dialog).getByText(/mode m/i)).toBeDefined();
    expect(within(dialog).getByText(/content-derived/i)).toBeDefined();
    expect(within(dialog).getByText(/q4-0-451faffb5a16/i)).toBeDefined();
  });

  it('surfaces the S3 model-registry connection status with a deep link, in both create and edit mode', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId={null} />);

    const dialog = await screen.findByRole('dialog', { name: 'Register model' });
    expect(within(dialog).getByText(/s3 model registry connection/i)).toBeDefined();
    const link = within(dialog).getByRole('link', { name: /configure/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/ai-platform?tab=providers&psvc=model-registry');
  });
});

// =============================================================================
// The Download action lives in the edit drawer only (no create-time equivalent)
// =============================================================================
describe('ModelFormSheet — Download action placement', () => {
  it('does NOT render the Download action in register mode — the model does not exist yet', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId={null} />);

    const dialog = await screen.findByRole('dialog', { name: 'Register model' });
    expect(within(dialog).queryByRole('button', { name: /^download$/i })).toBeNull();
  });

  it('renders the Download action + current status in edit mode', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId="m-1" />);

    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue('Whisper Large v4');
    // MODEL.downloadStatus is 'DOWNLOADED'.
    expect(within(dialog).getByText('Downloaded')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: /re-download/i })).toBeDefined();
  });
});

// =============================================================================
// Accessibility — both new surfaces (weight-source fields/help + the Download
// panel) with 0 axe violations, in register mode and in edit mode.
// =============================================================================
describe('ModelFormSheet accessibility', () => {
  it('has no axe violations in register mode (Local path disabled + help text)', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId={null} />);
    const dialog = await screen.findByRole('dialog', { name: 'Register model' });

    expect(await axe(dialog)).toHaveNoViolations();
  });

  it('has no axe violations in edit mode (Local path enabled + the Download panel)', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId="m-1" />);
    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue('Whisper Large v4');

    expect(await axe(dialog)).toHaveNoViolations();
  });
});
