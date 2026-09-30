/**
 * TASK-1023 (C1) — the ONE Register model sheet: Hugging Face (repo id only), MLflow (not available yet),
 * Local path (picked from the model bucket). Overrides live behind "Advanced" and are sent only when changed.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { LocalModelPreview, ModelInventoryReport } from '../../api/types';
import { RegisterModelSheet } from '../register-model-sheet';
import { PREVIEW, modelWith, stubFetch } from './fixtures.task1019';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const BUCKET_FILES = [
  { key: 'whisper/f16-abc/ggml-model.bin', size: 1000 },
  { key: 'whisper/f16-abc/config.json', size: 10 },
  { key: 'gemma/q4/model.gguf', size: 500 },
];

const LOCAL_PREVIEW: LocalModelPreview = {
  bucketPrefix: 'whisper/f16-abc/',
  localPath: '/mnt/models-bucket/whisper/f16-abc/ggml-model.bin',
  primaryObject: 'ggml-model.bin',
  layout: 'flat',
  files: [{ key: 'whisper/f16-abc/ggml-model.bin', size: 1000 }],
  totalBytes: 1010,
  revision: null,
  suggested: {
    slug: 'whisper-f16',
    name: 'Whisper F16',
    taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
    libraryName: 'whisper.cpp',
    format: 'WHISPER_CPP',
    servedBy: 'stt',
    architecture: 'whisper',
    computeType: 'f16',
  },
};

const INVENTORY: ModelInventoryReport = {
  checkedAt: '2026-09-30T10:00:00.000Z',
  counts: { available: 0, missing: 0, partial: 0, notApplicable: 0 },
  rows: [],
  unregistered: [{ bucketPrefix: 'orphan/q4-123/', layout: 'flat', slug: 'orphan', version: 'q4-123', objectCount: 2, totalBytes: 2048 }],
};

function routes(overrides: (url: string, method: string) => Response | undefined = () => undefined) {
  return stubFetch((url, method) => {
    const custom = overrides(url, method);
    if (custom) return custom;
    if (url.includes('/admin/ai-models/hub/preview')) return Response.json(PREVIEW);
    if (url.includes('/admin/ai-models/local/preview')) return Response.json(LOCAL_PREVIEW);
    if (url.includes('/admin/ai-models/inventory')) return Response.json(INVENTORY);
    if (url.includes('/storage/buckets/hope-models/files')) return Response.json(BUCKET_FILES);
    if (url.endsWith('/admin/ai-models/register-from-hub') && method === 'POST') {
      return Response.json({ model: modelWith('m-9', 'Whisper', 'DOWNLOADING'), jobId: 'job-1' }, { status: 202 });
    }
    if (url.endsWith('/admin/ai-models/register-from-path') && method === 'POST') return Response.json(modelWith('m-10', 'Whisper F16', 'DOWNLOADED'), { status: 201 });
    return Response.json({});
  });
}

async function openSheet(props: Partial<React.ComponentProps<typeof RegisterModelSheet>> = {}) {
  renderWithProviders(<RegisterModelSheet open onOpenChange={() => {}} {...props} />);
  return screen.findByRole('dialog', { name: 'Register model' });
}

async function typeRepoId(dialog: HTMLElement, value: string) {
  fireEvent.change(within(dialog).getByLabelText(/^repository id/i), { target: { value } });
}

describe('RegisterModelSheet — Hugging Face tab', () => {
  it('asks for a repository id only, shows a read-only summary after the preview, and posts { repoId } alone for an untouched form', async () => {
    const calls = routes();
    const dialog = await openSheet();
    expect(within(dialog).getByRole('tab', { name: 'Hugging Face', selected: true })).toBeDefined();
    // No hyperparameter or identity inputs are shown before "Advanced".
    expect(within(dialog).queryByLabelText(/^name/i)).toBeNull();

    await typeRepoId(dialog, 'org/whisper-ml-en');
    const summary = await within(dialog).findByRole('group', { name: 'Model summary' });
    expect(within(summary).getByText(/3 GB/)).toBeDefined();
    expect(within(summary).getByText('apache-2.0')).toBeDefined();
    expect(within(summary).getByText('Gated')).toBeDefined();
    expect(within(summary).getByText(/automatic speech recognition/i)).toBeDefined();
    expect(calls.find((call) => call.url.includes('hub/preview'))?.url).toContain('repoId=org%2Fwhisper-ml-en');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Register and download' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.url).toBe('/api/hope/admin/ai-models/register-from-hub');
    expect(post.body).toEqual({ repoId: 'org/whisper-ml-en' });
  });

  it('sends only the overrides the admin changed under Advanced', async () => {
    const calls = routes();
    const dialog = await openSheet();
    await typeRepoId(dialog, 'org/whisper-ml-en');
    await within(dialog).findByRole('group', { name: 'Model summary' });

    fireEvent.click(within(dialog).getByRole('button', { name: /advanced/i }));
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'My Whisper' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register and download' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ repoId: 'org/whisper-ml-en', name: 'My Whisper' });
  });

  it('opens Advanced and asks for served-by when the gateway answers SERVED_BY_REQUIRED', async () => {
    routes((url, method) =>
      url.endsWith('/register-from-hub') && method === 'POST'
        ? Response.json({ statusCode: 400, message: 'servedBy is required', code: 'SERVED_BY_REQUIRED' }, { status: 400 })
        : undefined,
    );
    const dialog = await openSheet();
    await typeRepoId(dialog, 'org/whisper-ml-en');
    await within(dialog).findByRole('group', { name: 'Model summary' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register and download' }));
    expect(await within(dialog).findByLabelText(/^served by/i)).toBeDefined();
    expect(within(dialog).getByRole('alert').textContent).toMatch(/served by/i);
  });

  it('a 422 HF_TOKEN_REQUIRED links to AI providers and blocks submit', async () => {
    routes((url) =>
      url.includes('hub/preview') ? Response.json({ statusCode: 422, message: 'gated', code: 'HF_TOKEN_REQUIRED' }, { status: 422 }) : undefined,
    );
    const dialog = await openSheet();
    await typeRepoId(dialog, 'org/private-model');
    const link = await within(dialog).findByRole('link', { name: /hugging face token in ai providers/i });
    expect(link.getAttribute('href')).toBe('/ai-providers');
    expect((within(dialog).getByRole('button', { name: 'Register and download' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('RegisterModelSheet — MLflow tab', () => {
  it('says it is not available yet and offers no inputs or submit', async () => {
    routes();
    const dialog = await openSheet();
    fireEvent.mouseDown(within(dialog).getByRole('tab', { name: 'MLflow' }), { button: 0 });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'MLflow' }));
    expect(await within(dialog).findByText(/registering from the internal mlflow registry is not available yet/i)).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: /^register/i })).toBeNull();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
  });
});

describe('RegisterModelSheet — Local path tab', () => {
  async function openLocal(props: Partial<React.ComponentProps<typeof RegisterModelSheet>> = {}) {
    const dialog = await openSheet({ initialTab: 'LOCAL', ...props });
    return dialog;
  }

  it('picks a folder from the bucket, shows /mnt/models-bucket/<prefix> and the preview, and posts register-from-path', async () => {
    const calls = routes();
    const dialog = await openLocal();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Open folder whisper' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Select folder f16-abc' }));

    expect(await within(dialog).findByText('/mnt/models-bucket/whisper/f16-abc/')).toBeDefined();
    const summary = await within(dialog).findByRole('group', { name: 'Model summary' });
    expect(within(summary).getByText('whisper.cpp')).toBeDefined();
    expect(calls.find((call) => call.url.includes('local/preview'))?.url).toContain('path=whisper%2Ff16-abc%2F');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.url).toBe('/api/hope/admin/ai-models/register-from-path');
    expect(post.body).toEqual({ path: 'whisper/f16-abc/' });
  });

  it('a suggestion from "In the bucket, not registered" fills the path in one click', async () => {
    routes();
    const dialog = await openLocal();
    fireEvent.click(await within(dialog).findByRole('button', { name: /orphan/ }));
    expect(await within(dialog).findByText('/mnt/models-bucket/orphan/q4-123/')).toBeDefined();
  });

  it('opens with a preselected prefix (the "In bucket, not registered" drawer hand-off)', async () => {
    const calls = routes();
    const dialog = await openLocal({ initialLocalPath: 'orphan/q4-123/' });
    expect(await within(dialog).findByText('/mnt/models-bucket/orphan/q4-123/')).toBeDefined();
    await waitFor(() => expect(calls.some((call) => call.url.includes('local/preview'))).toBe(true));
  });

  it('shows the gateway message for an empty path (404 PATH_EMPTY) and keeps submit disabled', async () => {
    routes((url) => (url.includes('local/preview') ? Response.json({ statusCode: 404, message: 'Nothing under that path', code: 'PATH_EMPTY' }, { status: 404 }) : undefined));
    const dialog = await openLocal({ initialLocalPath: 'nothing/' });
    expect(await within(dialog).findByText(/holds no model files/i)).toBeDefined();
    expect((within(dialog).getByRole('button', { name: 'Register' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('RegisterModelSheet — a11y', () => {
  it.each(['HUGGINGFACE', 'MLFLOW', 'LOCAL'] as const)('has no axe violations on the %s tab', async (tab) => {
    routes();
    const dialog = await openSheet({ initialTab: tab });
    await waitFor(async () => expect((await axe(dialog)).violations).toHaveLength(0));
  });
});
