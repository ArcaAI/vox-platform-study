/**
 * TDD screen tests for frame 15 (AI Model Registry, TASK-860 v2): the HF-organised
 * grid (task · library · served by · deployment · measured availability · platform
 * default · licence), the three list states, register/edit (OCC If-Match + 412
 * alert), the inventory run + "in bucket, not registered" register flow, the
 * platform-default election, and retire — against a URL-branching fetch stub.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { AiModel, ModelInventoryReport, PaginatedModels } from '../../api/types';
import { AiModelsScreen } from '../ai-models-screen';

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

/** Open a Radix Select trigger and pick an option by its visible label (happy-dom pointer path). */
async function selectOption(trigger: HTMLElement, optionName: string | RegExp) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  const option = await screen.findByRole('option', { name: optionName });
  fireEvent.pointerUp(option, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(option);
}

const MODEL: AiModel = {
  id: 'm-1',
  name: 'ArcaAI Whisper ML-EN (GGUF)',
  slug: 'arcaai-whisper-large-ml-en-gguf',
  description: 'Platform ASR default',
  category: 'AUDIO',
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  pipelineTag: 'automatic-speech-recognition',
  modelType: 'QUANTIZED_MODEL',
  source: 'HUGGINGFACE',
  sourceUri: 'taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF',
  sourceRevision: 'main',
  format: 'WHISPER_CPP',
  libraryName: 'whisper.cpp',
  servedBy: 'stt',
  deploymentKind: 'SELF_HOSTED',
  wireModelId: null,
  license: 'mit',
  gated: true,
  baseModel: 'openai/whisper-large-v3-turbo',
  languages: ['ml', 'en'],
  hfRevision: 'abc123',
  bucketPrefix: 'arcaai-whisper-large-ml-en-gguf/f16-0123456789ab/',
  primaryObject: 'ggml-model-f16.bin',
  manifestDigest: 'cafe',
  availability: 'AVAILABLE',
  availabilityCheckedAt: '2026-09-04T09:00:00.000Z',
  availabilityDetail: null,
  isPlatformDefaultFor: ['SPEECH_TO_TEXT'],
  provider: 'built-in',
  architecture: 'whisper',
  memorySizeMb: 1700,
  computeType: 'f16',
  localPath: '/mnt/models-bucket/arcaai-whisper-large-ml-en-gguf/f16-0123456789ab/ggml-model-f16.bin',
  checksum: null,
  resourceStatus: 'ENABLED',
  version: 4,
  tags: ['stt'],
  tenantId: '00000000-0000-0000-0000-000000000000',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
};

const CLOUD_MODEL: AiModel = {
  ...MODEL,
  id: 'm-2',
  name: 'OpenAI GPT-4o Transcribe',
  slug: 'openai-gpt4o-transcribe',
  libraryName: 'openai',
  deploymentKind: 'CLOUD',
  wireModelId: 'gpt-4o-transcribe',
  license: null,
  gated: false,
  bucketPrefix: null,
  primaryObject: null,
  availability: 'NOT_APPLICABLE',
  availabilityCheckedAt: null,
  isPlatformDefaultFor: [],
  provider: 'openai',
};

const REPORT: ModelInventoryReport = {
  checkedAt: '2026-09-04T10:00:00.000Z',
  counts: { available: 1, missing: 0, partial: 0, notApplicable: 1 },
  rows: [{ id: 'm-1', slug: MODEL.slug, availability: 'AVAILABLE', detail: {} }],
  unregistered: [{ bucketPrefix: 'orphan-model/q4-0-123456789abc/', layout: 'flat', slug: 'orphan-model', version: 'q4-0-123456789abc', objectCount: 3, totalBytes: 1024 * 1024 }],
};

function envelope(models: AiModel[]): PaginatedModels {
  return { data: models, total: models.length, page: 0, limit: 25, totalPages: models.length ? 1 : 0 };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function stubFetch(handler: (url: string, method: string) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return handler(url, method);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AiModelsScreen — the HF-organised catalogue grid', () => {
  it('renders task · library · served by · deployment · availability · platform default · licence per row', async () => {
    stubFetch(() => Response.json(envelope([MODEL])));
    renderWithProviders(<AiModelsScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'AI Model Registry' })).toBeDefined();
    expect(await screen.findByText('ArcaAI Whisper ML-EN (GGUF)')).toBeDefined();
    expect(screen.getByText('arcaai-whisper-large-ml-en-gguf')).toBeDefined();
    expect(screen.getByText('automatic-speech-recognition')).toBeDefined();
    expect(screen.getByText('whisper.cpp')).toBeDefined();
    expect(screen.getByText('stt')).toBeDefined();
    expect(screen.getByText('Self-hosted')).toBeDefined();
    expect(screen.getByText('Available')).toBeDefined();
    expect(screen.getByText('Speech to text')).toBeDefined();
    expect(screen.getByText('mit')).toBeDefined();
    expect(screen.getByText('Gated')).toBeDefined();
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.getByRole('grid', { name: 'AI models' })).toBeDefined();
  });

  it('renders a cloud row with its wire id and NOT_APPLICABLE availability, ordered after the self-hosted ASR row of the same task', async () => {
    stubFetch(() => Response.json(envelope([CLOUD_MODEL, MODEL])));
    renderWithProviders(<AiModelsScreen />);

    await screen.findByText('OpenAI GPT-4o Transcribe');
    expect(screen.getByText('Cloud')).toBeDefined();
    expect(screen.getByText('gpt-4o-transcribe')).toBeDefined();
    expect(screen.getByText('Not applicable')).toBeDefined();
    const names = screen.getAllByRole('row').map((row) => row.textContent ?? '');
    const first = names.findIndex((text) => text.includes('ArcaAI Whisper ML-EN (GGUF)'));
    const second = names.findIndex((text) => text.includes('OpenAI GPT-4o Transcribe'));
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
  });

  it('mirrors the loaded layout with skeletons while the list is in flight', () => {
    stubFetch(() => new Promise<Response>(() => {}));
    const { container } = renderWithProviders(<AiModelsScreen />);
    expect(screen.getByRole('heading', { level: 1, name: 'AI Model Registry' })).toBeDefined();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('shows the neutral empty state with a register CTA when no models exist', async () => {
    stubFetch(() => Response.json(envelope([])));
    renderWithProviders(<AiModelsScreen />);
    expect(await screen.findByText('No models registered yet')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Register model' }).length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces a block error with retry and refetches the list', async () => {
    let attempt = 0;
    stubFetch(() => {
      attempt += 1;
      return attempt === 1 ? Response.json({ message: 'boom' }, { status: 500 }) : Response.json(envelope([MODEL]));
    });
    renderWithProviders(<AiModelsScreen />);
    const retry = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(retry);
    expect(await screen.findByText('ArcaAI Whisper ML-EN (GGUF)')).toBeDefined();
  });
});

describe('AiModelsScreen — register / edit / retire', () => {
  it('registers a model by POSTing the registry payload — library, served-by and deployment kind travel; localPath never does', async () => {
    const calls = stubFetch((url, method) => {
      if (method === 'POST') return Response.json({ ...MODEL, id: 'm-9' });
      return Response.json(envelope([]));
    });
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('No models registered yet');

    fireEvent.click(screen.getAllByRole('button', { name: 'Register model' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Register model' });
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Medical NER' } });
    fireEvent.change(within(dialog).getByLabelText(/^slug/i), { target: { value: 'medical-ner' } });
    fireEvent.change(within(dialog).getByLabelText(/^task \(hugging face/i), { target: { value: 'TOKEN_CLASSIFICATION' } });
    fireEvent.change(within(dialog).getByLabelText(/^source uri/i), { target: { value: 'blaze999/Medical-NER' } });
    await selectOption(within(dialog).getByLabelText(/^serving library/i), 'transformers');
    await selectOption(within(dialog).getByLabelText(/^served by/i), 'nlp');
    fireEvent.change(within(dialog).getByLabelText(/^licence/i), { target: { value: 'apache-2.0' } });
    fireEvent.change(within(dialog).getByLabelText(/^languages/i), { target: { value: 'en' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register model' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toBe('/api/hope/admin/ai-models');
    expect(post?.body).toEqual({
      name: 'Medical NER',
      slug: 'medical-ner',
      category: 'UNKNOWN',
      taskType: 'TOKEN_CLASSIFICATION',
      modelType: 'BASE_MODEL',
      source: 'HUGGINGFACE',
      sourceUri: 'blaze999/Medical-NER',
      format: 'SAFETENSOR',
      libraryName: 'transformers',
      servedBy: 'nlp',
      deploymentKind: 'SELF_HOSTED',
      license: 'apache-2.0',
      languages: ['en'],
    });
    expect(post?.body).not.toHaveProperty('localPath');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('edits a model with an If-Match PATCH derived from the read ETag, carrying the registry fields', async () => {
    const calls = stubFetch((url, method) => {
      if (method === 'PATCH') return Response.json({ ...MODEL, name: 'Renamed', version: 5 }, { headers: { etag: '"5"' } });
      if (url.endsWith('/admin/ai-models/m-1')) return Response.json(MODEL, { headers: { etag: '"4"' } });
      return Response.json(envelope([MODEL]));
    });
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('ArcaAI Whisper ML-EN (GGUF)');

    fireEvent.click(screen.getByRole('button', { name: 'Edit ArcaAI Whisper ML-EN (GGUF)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue('ArcaAI Whisper ML-EN (GGUF)');
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.headers.get('if-match')).toBe('"4"');
    expect(patch.body).toMatchObject({ name: 'Renamed', expectedVersion: 4, libraryName: 'whisper.cpp', servedBy: 'stt', bucketPrefix: MODEL.bucketPrefix });
    expect(patch.body).not.toHaveProperty('localPath');
  });

  it('shows the OCC conflict alert when the PATCH returns 412', async () => {
    stubFetch((url, method) => {
      if (method === 'PATCH') return Response.json({ message: 'Version drifted' }, { status: 412 });
      if (url.endsWith('/admin/ai-models/m-1')) return Response.json(MODEL, { headers: { etag: '"4"' } });
      return Response.json(envelope([MODEL]));
    });
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('ArcaAI Whisper ML-EN (GGUF)');

    fireEvent.click(screen.getByRole('button', { name: 'Edit ArcaAI Whisper ML-EN (GGUF)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue('ArcaAI Whisper ML-EN (GGUF)');
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await within(dialog).findByRole('alert')).toBeDefined();
  });

  it('retires a model only after the destructive confirm', async () => {
    const calls = stubFetch((url, method) => {
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json(envelope([MODEL]));
    });
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('ArcaAI Whisper ML-EN (GGUF)');

    fireEvent.click(screen.getByRole('button', { name: 'Retire ArcaAI Whisper ML-EN (GGUF)' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Retire model' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    expect(calls.find((call) => call.method === 'DELETE')?.url).toBe('/api/hope/admin/ai-models/m-1');
  });
});

describe('AiModelsScreen — inventory + "in bucket, not registered"', () => {
  it('runs the inventory on demand, then opens the unregistered panel and registers from a bucket prefix with the prefix pre-filled', async () => {
    const calls = stubFetch((url, method) => {
      if (url.endsWith('/admin/ai-models/inventory')) return Response.json(REPORT);
      if (method === 'POST') return Response.json({ ...MODEL, id: 'm-9' });
      return Response.json(envelope([MODEL]));
    });
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('ArcaAI Whisper ML-EN (GGUF)');

    const unregisteredButton = screen.getByRole('button', { name: /in bucket, not registered/i }) as HTMLButtonElement;
    expect(unregisteredButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Run inventory' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/admin/ai-models/inventory') && call.method === 'POST')).toBe(true));

    // The report had an orphan prefix → the panel opens by itself.
    const panel = await screen.findByRole('dialog', { name: 'In bucket, not registered' });
    expect(within(panel).getByText('orphan-model/q4-0-123456789abc/')).toBeDefined();
    fireEvent.click(within(panel).getByRole('button', { name: 'Register orphan-model/q4-0-123456789abc/' }));

    const form = await screen.findByRole('dialog', { name: 'Register model' });
    expect((within(form).getByLabelText(/^slug/i) as HTMLInputElement).value).toBe('orphan-model');
    expect((within(form).getByLabelText(/^bucket prefix/i) as HTMLInputElement).value).toBe('orphan-model/q4-0-123456789abc/');
    expect(within(form).getByTestId('derived-local-path').textContent).toBe('/mnt/models-bucket/orphan-model/q4-0-123456789abc/');
  });

  it('never probes the discovery route or the inventory on page load', async () => {
    const calls = stubFetch(() => Response.json(envelope([MODEL])));
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('ArcaAI Whisper ML-EN (GGUF)');
    expect(calls.some((call) => call.url.includes('discovery'))).toBe(false);
    expect(calls.some((call) => call.url.includes('inventory'))).toBe(false);
  });
});

describe('AiModelsScreen — platform-default election', () => {
  it('PATCHes :id/platform-default with the ticked tasks from the row action', async () => {
    const calls = stubFetch((url, _method) => {
      if (url.endsWith('/platform-default')) return Response.json({ ...MODEL, isPlatformDefaultFor: ['SPEECH_TO_TEXT', 'TEXT_GENERATION'] });
      return Response.json(envelope([MODEL]));
    });
    renderWithProviders(<AiModelsScreen />);
    await screen.findByText('ArcaAI Whisper ML-EN (GGUF)');

    fireEvent.click(screen.getByRole('button', { name: 'Set platform default for ArcaAI Whisper ML-EN (GGUF)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Platform default for tasks' });
    // Seeded from the row: SPEECH_TO_TEXT is already ticked.
    expect((within(dialog).getByLabelText('Speech to text') as HTMLInputElement).getAttribute('aria-checked') ?? (within(dialog).getByLabelText('Speech to text') as HTMLInputElement).checked).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText('Text generation'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save defaults' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.url).toBe('/api/hope/admin/ai-models/m-1/platform-default');
    expect(patch.body).toEqual({ tasks: ['SPEECH_TO_TEXT', 'TEXT_GENERATION'] });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Platform default for tasks' })).toBeNull());
  });
});

describe('AiModelsScreen accessibility', () => {
  it('has no axe violations with the loaded grid rendered', async () => {
    stubFetch(() => Response.json(envelope([MODEL, CLOUD_MODEL])));
    const { container } = renderWithProviders(<AiModelsScreen />);
    await screen.findByText('ArcaAI Whisper ML-EN (GGUF)');
    expect(await axe(container)).toHaveNoViolations();
  });
});
