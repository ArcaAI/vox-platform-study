/**
 * `ModelFormSheet` was a hand-rolled `SheetContent`; it now composes
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
  pipelineTag: 'automatic-speech-recognition',
  modelType: 'BASE_MODEL',
  source: 'HUGGINGFACE',
  sourceUri: 'openai/whisper-large-v4',
  sourceRevision: null,
  format: 'FASTER_WHISPER',
  libraryName: 'faster-whisper',
  servedBy: 'stt',
  deploymentKind: 'SELF_HOSTED',
  wireModelId: null,
  license: 'mit',
  gated: false,
  baseModel: null,
  languages: ['en'],
  hfRevision: null,
  bucketPrefix: null,
  primaryObject: null,
  manifestDigest: null,
  availability: 'UNKNOWN',
  availabilityCheckedAt: null,
  availabilityDetail: null,
  isPlatformDefaultFor: [],
  provider: 'built-in',
  architecture: 'whisper',
  memorySizeMb: 3096,
  computeType: 'float16',
  asrProfile: {
    maxDecodeWindowSec: 7,
    partialWindowSec: 15,
    decoding: { noSpeechThreshold: 0.4 },
  },
  localPath: null,
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
    // TASK-890 §3.11 — the registry row no longer carries `downloadStatus`, so
    // the publish panel asks the JOB endpoint; that answer is stubbed here.
    vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/download')
        ? Response.json({ status: 'DOWNLOADED', localPath: '/mnt/models-bucket/whisper/v1/' })
        : Response.json(MODEL, { headers: { etag: '"4"' } }),
    ),
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
// Weight source (sourceUri / localPath): the two loading modes,
// =============================================================================
/** Open a Radix Select trigger and pick an option by its visible label (happy-dom pointer path). */
async function selectOption(trigger: HTMLElement, optionName: string | RegExp) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  const option = await screen.findByRole('option', { name: optionName });
  fireEvent.pointerUp(option, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(option);
}

describe('ModelFormSheet — registry identity + bucket identity (TASK-860)', () => {
  it('has NO local-path field: localPath is derived by the gateway and shown read-only from the bucket prefix', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId={null} />);

    const dialog = await screen.findByRole('dialog', { name: 'Register model' });
    expect(within(dialog).queryByLabelText(/local path/i)).toBeNull();
    expect(within(dialog).getByTestId('derived-local-path').textContent).toMatch(/not published/i);

    fireEvent.change(within(dialog).getByLabelText(/^bucket prefix/i), { target: { value: 'medical-ner/abc/' } });
    expect(within(dialog).getByTestId('derived-local-path').textContent).toBe('/mnt/models-bucket/medical-ner/abc/');
    fireEvent.change(within(dialog).getByLabelText(/^primary object/i), { target: { value: 'model.gguf' } });
    expect(within(dialog).getByTestId('derived-local-path').textContent).toBe('/mnt/models-bucket/medical-ner/abc/model.gguf');
  });

  it('offers the serving library / served-by / deployment facets, and the wire id only for a CLOUD row', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId={null} />);

    const dialog = await screen.findByRole('dialog', { name: 'Register model' });
    expect(within(dialog).getByLabelText(/^serving library/i)).toBeDefined();
    expect(within(dialog).getByLabelText(/^served by/i)).toBeDefined();
    const wireId = within(dialog).getByLabelText(/^wire model id/i) as HTMLInputElement;
    expect(wireId.disabled).toBe(true);

    await selectOption(within(dialog).getByLabelText(/^deployment/i), 'Cloud');
    expect((within(dialog).getByLabelText(/^wire model id/i) as HTMLInputElement).disabled).toBe(false);
    expect((within(dialog).getByLabelText(/^wire model id/i) as HTMLInputElement).required).toBe(true);
  });

  it('seeds the registry fields from the loaded row and sends them (never localPath) on PATCH', async () => {
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
    expect((within(dialog).getByLabelText(/^licence/i) as HTMLInputElement).value).toBe('mit');
    fireEvent.change(within(dialog).getByLabelText(/^bucket prefix/i), { target: { value: 'whisper-large-v4/q4-0-451faffb5a16/' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!.body as Record<string, unknown>;
    expect(patch).toMatchObject({ libraryName: 'faster-whisper', servedBy: 'stt', deploymentKind: 'SELF_HOSTED', license: 'mit', languages: ['en'], bucketPrefix: 'whisper-large-v4/q4-0-451faffb5a16/' });
    expect(patch).not.toHaveProperty('localPath');
  });

  it('explains that the bucket prefix is normally written by Publish to bucket, and surfaces the S3 model-registry connection status', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId={null} />);

    const dialog = await screen.findByRole('dialog', { name: 'Register model' });
    expect(within(dialog).getByText(/publish to bucket/i)).toBeDefined();
    expect(within(dialog).getByText(/never typed by hand/i)).toBeDefined();
    expect(within(dialog).getByText(/s3 model registry connection/i)).toBeDefined();
    const link = within(dialog).getByRole('link', { name: /configure/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/ai-platform?tab=providers&psvc=model-registry');
  });
});

// =============================================================================
// The Publish action lives in the edit drawer only (no create-time equivalent)
// =============================================================================
describe('ModelFormSheet — Publish action placement', () => {
  it('does NOT render the Publish action in register mode — the model does not exist yet', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId={null} />);

    const dialog = await screen.findByRole('dialog', { name: 'Register model' });
    expect(within(dialog).queryByRole('button', { name: /publish/i })).toBeNull();
  });

  it('renders the Publish action + measured availability + legacy status in edit mode', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId="m-1" />);

    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue('Whisper Large v4');
    // The publish JOB reports DOWNLOADED; availability is UNKNOWN (never inventoried) —
    // two different facts, from two different sources, both shown.
    expect(await within(dialog).findByText('Downloaded')).toBeDefined();
    expect(within(dialog).getByText('Not inventoried')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: /re-publish/i })).toBeDefined();
  });
});

describe('ModelFormSheet accessibility', () => {
  it('has no axe violations in register mode (registry fields + bucket help)', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId={null} />);
    const dialog = await screen.findByRole('dialog', { name: 'Register model' });

    expect(await axe(dialog)).toHaveNoViolations();
  });

  it('has no axe violations in edit mode (registry fields + the Publish panel)', async () => {
    stubFetch();
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId="m-1" />);
    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue('Whisper Large v4');

    expect(await axe(dialog)).toHaveNoViolations();
  });
});

// =============================================================================
// ASR decode profile (`_metadata.asr`, TASK-934) — rendered only for a row
// whose taskType is `AUTOMATIC_SPEECH_RECOGNITION`.
// =============================================================================

const NON_ASR_MODEL: AiModel = { ...MODEL, id: 'm-2', taskType: 'TEXT_TO_SPEECH', pipelineTag: 'text-to-speech', asrProfile: null };

function stubFetchFor(model: AiModel) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/download') ? Response.json({ status: 'DOWNLOADED', localPath: '/mnt/models-bucket/whisper/v1/' }) : Response.json(model, { headers: { etag: '"4"' } }),
    ),
  );
}

describe('ModelFormSheet — ASR decode profile (TASK-934)', () => {
  it('renders the section, pre-filled from the row, for an ASR row', async () => {
    stubFetchFor(MODEL);
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId="m-1" />);

    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue('Whisper Large v4');

    expect(within(dialog).getByText('ASR decode profile')).toBeDefined();
    expect((within(dialog).getByLabelText(/^max decode window/i) as HTMLInputElement).value).toBe('7');
    expect((within(dialog).getByLabelText(/^partial window/i) as HTMLInputElement).value).toBe('15');
    expect((within(dialog).getByLabelText(/^no-speech threshold/i) as HTMLInputElement).value).toBe('0.4');
  });

  it('does NOT render the section for a non-ASR row', async () => {
    stubFetchFor(NON_ASR_MODEL);
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId="m-2" />);

    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue('Whisper Large v4');

    expect(within(dialog).queryByText('ASR decode profile')).toBeNull();
    expect(within(dialog).queryByLabelText(/^max decode window/i)).toBeNull();
  });

  it('shows an under-field error for an out-of-range value and disables Save', async () => {
    stubFetchFor(MODEL);
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId="m-1" />);

    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue('Whisper Large v4');

    const saveButton = within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);

    fireEvent.change(within(dialog).getByLabelText(/^max decode window/i), { target: { value: '99' } });

    expect(within(dialog).getByText(/must be between 1 and 30/i)).toBeDefined();
    expect(saveButton.disabled).toBe(true);

    // Back in range: the error clears and Save re-enables.
    fireEvent.change(within(dialog).getByLabelText(/^max decode window/i), { target: { value: '10' } });
    expect(within(dialog).queryByText(/must be between 1 and 30/i)).toBeNull();
    expect(saveButton.disabled).toBe(false);
  });

  it('sends the edited profile in the PATCH body, and blanking every field clears it (null)', async () => {
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
    fireEvent.change(within(dialog).getByLabelText(/^partial window/i), { target: { value: '20' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!.body as { asrProfile: unknown };
    expect(patch.asrProfile).toEqual({ maxDecodeWindowSec: 7, partialWindowSec: 20, decoding: { noSpeechThreshold: 0.4 } });
  });

  it('has no axe violations with the ASR section rendered', async () => {
    stubFetchFor(MODEL);
    renderWithProviders(<ModelFormSheet open onOpenChange={() => {}} modelId="m-1" />);
    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    await within(dialog).findByDisplayValue('Whisper Large v4');
    expect(within(dialog).getByText('ASR decode profile')).toBeDefined();

    expect(await axe(dialog)).toHaveNoViolations();
  });
});
