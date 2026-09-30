/**
 * C1 (TASK-1019, Lane C) — Register from Hugging Face: typing a repo id reads the
 * Hub preview, prefills the editable fields and shows size + gated state; submit
 * posts `register-from-hub`; a 422 `HF_TOKEN_REQUIRED` renders the link to AI
 * providers; the registered row lands on the grid already DOWNLOADING.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ManageModelsScreen as AiModelsScreen } from '../manage-models-screen';
import { RegisterFromHubSheet } from '../register-from-hub-sheet';
import { PREVIEW, envelope, modelWith, stubFetch } from './fixtures.task1019';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function typeRepoId(value: string) {
  const dialog = await screen.findByRole('dialog', { name: 'Register from Hugging Face' });
  fireEvent.change(within(dialog).getByLabelText(/^repository id/i), { target: { value } });
  return dialog;
}

describe('RegisterFromHubSheet (C1)', () => {
  it('fetches the preview for a typed repo id, prefills the fields, shows size + gated, and posts register-from-hub', async () => {
    const calls = stubFetch((url, method) => {
      if (url.includes('/admin/ai-models/hub/preview')) return Response.json(PREVIEW);
      if (url.endsWith('/admin/ai-models/register-from-hub') && method === 'POST') {
        return Response.json({ model: modelWith('m-9', 'Whisper ML-EN (HF)', 'DOWNLOADING'), jobId: 'job-1' }, { status: 202 });
      }
      return Response.json(envelope([]));
    });
    renderWithProviders(<RegisterFromHubSheet open onOpenChange={() => {}} />);

    const dialog = await typeRepoId('org/whisper-ml-en');

    // Debounced preview → Hub card facts.
    expect(await within(dialog).findByText(/3 GB/)).toBeDefined();
    expect(within(dialog).getByText('Gated')).toBeDefined();
    expect(within(dialog).getByText('apache-2.0')).toBeDefined();
    const previewCall = calls.find((call) => call.url.includes('hub/preview'));
    expect(previewCall?.url).toContain('repoId=org%2Fwhisper-ml-en');

    // Prefilled from the card, and editable.
    const name = within(dialog).getByLabelText(/^name/i) as HTMLInputElement;
    expect(name.value).toBe('Whisper ML-EN (HF)');
    expect((within(dialog).getByLabelText(/^slug/i) as HTMLInputElement).value).toBe('whisper-ml-en-hf');
    fireEvent.change(name, { target: { value: 'Whisper ML-EN (edited)' } });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Register and download' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.url).toBe('/api/hope/admin/ai-models/register-from-hub');
    expect(post.body).toEqual({
      repoId: 'org/whisper-ml-en',
      slug: 'whisper-ml-en-hf',
      name: 'Whisper ML-EN (edited)',
      taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
      format: 'WHISPER_CPP',
    });
  });

  it('does not ask the Hub for an id that is not org/name', async () => {
    const calls = stubFetch(() => Response.json(PREVIEW));
    renderWithProviders(<RegisterFromHubSheet open onOpenChange={() => {}} />);
    const dialog = await typeRepoId('not-a-repo-id');
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(calls.some((call) => call.url.includes('hub/preview'))).toBe(false);
    expect((within(dialog).getByRole('button', { name: 'Register and download' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('Enter a Hugging Face repo id like org/name.')).toBeDefined();
  });

  it('a 422 HF_TOKEN_REQUIRED renders the "configure the HF token in AI providers" link and blocks submit', async () => {
    stubFetch(() =>
      Response.json({ statusCode: 422, message: 'Repository is gated and no Hugging Face token is configured', code: 'HF_TOKEN_REQUIRED' }, { status: 422 }),
    );
    renderWithProviders(<RegisterFromHubSheet open onOpenChange={() => {}} />);
    const dialog = await typeRepoId('org/private-model');

    const link = await within(dialog).findByRole('link', { name: /hugging face token in ai providers/i });
    expect(link.getAttribute('href')).toBe('/ai-providers');
    expect((within(dialog).getByRole('button', { name: 'Register and download' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a 404 says the repository does not exist', async () => {
    stubFetch(() => Response.json({ statusCode: 404, message: 'Not Found' }, { status: 404 }));
    renderWithProviders(<RegisterFromHubSheet open onOpenChange={() => {}} />);
    const dialog = await typeRepoId('org/nope');
    expect(await within(dialog).findByText(/no hugging face repository with that id/i)).toBeDefined();
  });

  it('through the screen: the registered row appears on the grid as DOWNLOADING', async () => {
    let registered = false;
    const calls = stubFetch((url, method) => {
      if (url.includes('/hub/preview')) return Response.json(PREVIEW);
      if (url.endsWith('/register-from-hub') && method === 'POST') {
        registered = true;
        return Response.json({ model: modelWith('m-9', 'Whisper ML-EN (HF)', 'DOWNLOADING'), jobId: 'job-1' }, { status: 202 });
      }
      return Response.json(
        envelope(registered ? [modelWith('m-9', 'Whisper ML-EN (HF)', 'DOWNLOADING', {}, { download: { bytesDone: 512, bytesTotal: 1024, error: null } })] : []),
      );
    });
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('No models registered yet');

    fireEvent.click(screen.getByRole('button', { name: 'Register from Hugging Face' }));
    const dialog = await typeRepoId('org/whisper-ml-en');
    await within(dialog).findByText(/3 GB/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register and download' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(await screen.findByText('Downloading')).toBeDefined();
    expect(screen.getByRole('progressbar', { name: /download progress for whisper ml-en/i }).getAttribute('aria-valuenow')).toBe('50');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Register from Hugging Face' })).toBeNull());
  });
});
