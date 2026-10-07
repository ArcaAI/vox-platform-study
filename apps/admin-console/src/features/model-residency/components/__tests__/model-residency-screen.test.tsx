/**
 * TASK-1005 §13 L-RUI / TASK-1051 lane C1 — the model residency overview
 * (artboard 01). The dialogs and the drawer are lane C2's (frozen props in
 * `residency-dialog-contracts.ts`), so they are mocked here: these tests pin
 * what the SCREEN does — which component it mounts with which props, and how
 * it tracks the async load operations the dialogs admit (C-a, C-b).
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { LoadModelResidencyResponse } from '@/shared/residency';
import type { ModelResidencyCatalogueResponse } from '../../api/types';
import type {
  LinkInstanceDialogProps,
  LoadPreviewDialogProps,
  ModelDetailDrawerContractProps,
  UnloadDialogProps,
} from '../residency-dialog-contracts';
import { ModelResidencyScreen } from '../model-residency-screen';
import {
  GiB,
  LIVE_WHISPER,
  LMS,
  makeCatalogue,
  makeDevice,
  makeSuggestion,
  PINNED_NOT_LOADED,
  ROUTING_GUARD,
  STT,
  UNMATCHED_GEMMA,
} from './residency-test-data';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const spies = vi.hoisted(() => ({
  load: vi.fn(),
  unload: vi.fn(),
  link: vi.fn(),
  drawer: vi.fn(),
}));

vi.mock('../load-preview-dialog', () => ({
  LoadPreviewDialog: (props: LoadPreviewDialogProps) => {
    spies.load(props);
    return props.open ? <div data-testid="load-preview-dialog">{props.model.name}</div> : null;
  },
}));
vi.mock('../unload-dialog', () => ({
  UnloadDialog: (props: UnloadDialogProps) => {
    spies.unload(props);
    return props.open ? <div data-testid="unload-dialog">{props.model.name}</div> : null;
  },
}));
vi.mock('../link-instance-dialog', () => ({
  LinkInstanceDialog: (props: LinkInstanceDialogProps) => {
    spies.link(props);
    return props.open ? <div data-testid="link-dialog">{props.model.name}</div> : null;
  },
}));
vi.mock('../model-detail-drawer', () => ({
  ModelDetailDrawer: (props: ModelDetailDrawerContractProps) => {
    spies.drawer(props);
    return props.open ? (
      <div role="dialog" aria-label={props.model.name}>
        <button type="button" onClick={() => props.onLink(props.service, props.model)}>
          drawer link
        </button>
        <button type="button" onClick={() => props.onLoad(props.service, props.model)}>
          drawer load
        </button>
        <button type="button" onClick={() => props.onReload(props.service, props.model, { contextLength: 8192 })}>
          drawer reload
        </button>
      </div>
    ) : null;
  },
}));

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const BASE = '/api/hope/admin/model-residency';
const CATALOGUE_URL = `${BASE}/catalogue`;

function stubFetch(handle: (call: Call) => Response | unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ success: true });
      const result = handle(call);
      if (result === undefined) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return result instanceof Response ? result : Response.json(result);
    }),
  );
  return calls;
}

function operation(id: string, modelRef: string, status: 'running' | 'succeeded' | 'failed', error: { code: string; message: string } | null = null) {
  return {
    id,
    action: 'load',
    service: 'stt',
    modelRef,
    status,
    error,
    startedAt: '2026-10-07T10:00:00Z',
    finishedAt: status === 'running' ? null : '2026-10-07T10:00:07Z',
  };
}

function accepted(operationId: string, modelRef: string): LoadModelResidencyResponse {
  return { outcome: 'accepted', operationId, model: { service: 'stt', instance: 'hope-stt-1', modelRef, state: 'loading' } };
}

function lastProps<T>(spy: ReturnType<typeof vi.fn>): T {
  return spy.mock.calls.at(-1)![0] as T;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function renderScreen(catalogue: ModelResidencyCatalogueResponse = makeCatalogue(), extra?: (call: Call) => Response | unknown) {
  const calls = stubFetch((call) => (call.url === CATALOGUE_URL ? catalogue : extra?.(call)));
  const view = renderWithProviders(<ModelResidencyScreen />);
  await screen.findByRole('table', { name: 'Models' });
  return { calls, ...view };
}

function row(name: RegExp) {
  return within(screen.getByRole('table', { name: 'Models' })).getByRole('row', { name });
}

describe('ModelResidencyScreen — header', () => {
  it('shows the mode, the real data age and the readiness link', async () => {
    await renderScreen();
    expect(screen.getByRole('heading', { level: 1, name: 'Model residency' })).toBeDefined();
    expect(screen.getByText('Shadow mode — recommends, never acts')).toBeDefined();
    expect(screen.getByText('4 of 4 services reporting · data just now')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Enforce readiness' }).getAttribute('href')).toBe('/model-residency/readiness');
  });

  it('flags stale services in words', async () => {
    await renderScreen(
      makeCatalogue({ mode: 'enforce', freshness: { maxAgeSeconds: 90, staleServices: ['nlp'], oldestReportAt: '2026-10-07T09:58:30Z' } }),
    );
    expect(screen.getByText('Automatic')).toBeDefined();
    const freshness = screen.getByTestId('residency-freshness');
    expect(freshness.textContent).toBe('3 of 4 services reporting · data 1 min old · stale: Medical NLP');
    expect(freshness.getAttribute('data-stale')).toBe('true');
  });
});

describe('ModelResidencyScreen — layout', () => {
  it('renders attention, GPU memory, the models table and recommendations — recommendations outside the pinned top', async () => {
    const over = makeDevice({ overHeadroom: true, freeBytes: 26 * 1024 ** 2, headroomBytes: 2.4 * GiB });
    await renderScreen(makeCatalogue({ devices: [over] }));
    expect(screen.getByRole('heading', { name: 'Needs attention (3)' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'GPU memory' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Recommendations (1)' })).toBeDefined();
    // The ScreenTemplate content region is the one scroll container; the rail lives inside it.
    const rail = screen.getByRole('complementary', { name: /Recommendations/ });
    expect(rail.closest('.overflow-y-auto')).not.toBeNull();
  });

  it('hides the attention strip when nothing needs attention', async () => {
    await renderScreen(makeCatalogue({ services: [{ ...STT, models: [LIVE_WHISPER] }] }));
    expect(screen.queryByRole('heading', { name: /Needs attention/ })).toBeNull();
  });

  it('shows an error state with retry when the first read fails', async () => {
    let attempts = 0;
    stubFetch((call) => {
      if (call.url !== CATALOGUE_URL) return undefined;
      attempts += 1;
      return attempts === 1 ? Response.json({ message: 'boom' }, { status: 500 }) : makeCatalogue();
    });
    renderWithProviders(<ModelResidencyScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('table', { name: 'Models' })).toBeDefined();
  });
});

describe('ModelResidencyScreen — mounts the C2 dialogs with the frozen props', () => {
  it('Load… opens the load preview for that service + model', async () => {
    await renderScreen();
    fireEvent.click(within(row(/Whisper Large Code-Switch/)).getByRole('button', { name: /Load…/ }));
    expect(screen.getByTestId('load-preview-dialog').textContent).toBe('Whisper Large Code-Switch');
    const props = lastProps<LoadPreviewDialogProps>(spies.load);
    expect(props).toMatchObject({ open: true, service: { service: 'stt' }, model: { modelRef: 'whisper-large-cs' } });
    act(() => props.onOpenChange(false));
    expect(screen.queryByTestId('load-preview-dialog')).toBeNull();
  });

  it('Unload… opens the unload dialog; Link… opens the link dialog', async () => {
    await renderScreen();
    fireEvent.click(within(row(/ArcaAI Whisper ml-en/)).getByRole('button', { name: /Unload…/ }));
    expect(screen.getByTestId('unload-dialog').textContent).toBe('ArcaAI Whisper ml-en');

    fireEvent.click(within(row(/gemma-4-e2b-it-qat@q4_0/)).getByRole('button', { name: /Link…/ }));
    expect(lastProps<LinkInstanceDialogProps>(spies.link)).toMatchObject({ open: true, service: { service: 'lm-studio' }, model: UNMATCHED_GEMMA });
  });

  it('the attention strip opens the same dialogs', async () => {
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Link to catalogue…' }));
    expect(screen.getByTestId('link-dialog').textContent).toBe(UNMATCHED_GEMMA.name);
    fireEvent.click(screen.getByRole('button', { name: 'Load…' }));
    expect(screen.getByTestId('load-preview-dialog').textContent).toBe(PINNED_NOT_LOADED.name);
  });

  it('a recommendation’s Apply opens the load preview', async () => {
    await renderScreen(makeCatalogue({ suggestions: [makeSuggestion()] }));
    fireEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    expect(screen.getByTestId('load-preview-dialog').textContent).toBe(PINNED_NOT_LOADED.name);
  });

  it('Details opens the drawer, whose Link opens the link dialog and closes the drawer once linked', async () => {
    await renderScreen();
    fireEvent.click(within(row(/Granite Guardian/)).getByRole('button', { name: /Details/ }));
    const drawerProps = lastProps<ModelDetailDrawerContractProps>(spies.drawer);
    expect(drawerProps).toMatchObject({ open: true, service: { service: 'lm-studio' }, model: ROUTING_GUARD, actionPending: false });
    expect(drawerProps.devices).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'drawer link' }));
    const linkProps = lastProps<LinkInstanceDialogProps>(spies.link);
    expect(linkProps).toMatchObject({ open: true, model: ROUTING_GUARD });
    act(() => linkProps.onLinked?.());
    expect(screen.queryByRole('dialog', { name: ROUTING_GUARD.name })).toBeNull();
  });
});

describe('ModelResidencyScreen — load operations are tracked per model (C-a) and toasted once (C-b)', () => {
  it('two concurrent loads each poll to terminal and each toast exactly once', async () => {
    const twoPinned = makeCatalogue({
      services: [
        { ...STT, models: [PINNED_NOT_LOADED, { ...PINNED_NOT_LOADED, aiModelId: 'other', name: 'Second model', modelRef: 'second' }] },
        LMS,
      ],
    });
    let firstPolls = 0;
    const { calls } = await renderScreen(twoPinned, (call) => {
      if (call.url === `${BASE}/operations/op-1`) {
        firstPolls += 1;
        return operation('op-1', 'whisper-large-cs', firstPolls === 1 ? 'running' : 'succeeded');
      }
      if (call.url === `${BASE}/operations/op-2`)
        return operation('op-2', 'second', 'failed', { code: 'OVER_BUDGET', message: 'Second model did not fit.' });
      return undefined;
    });

    fireEvent.click(within(row(/Whisper Large Code-Switch/)).getByRole('button', { name: /Load…/ }));
    act(() => lastProps<LoadPreviewDialogProps>(spies.load).onAdmitted(accepted('op-1', 'whisper-large-cs')));
    fireEvent.click(within(row(/Second model/)).getByRole('button', { name: /Load…/ }));
    act(() => lastProps<LoadPreviewDialogProps>(spies.load).onAdmitted(accepted('op-2', 'second')));

    // op-2 fails at once; op-1 is still running and its row shows it.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Second model did not fit.'));
    expect(within(row(/Whisper Large Code-Switch/)).getByRole('status', { name: 'Loading' })).toBeDefined();

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Whisper Large Code-Switch loaded.'), { timeout: 4000 });
    expect(screen.queryByTestId('load-preview-dialog')).toBeNull();

    // Further refetches never repeat a terminal toast.
    const catalogueReads = calls.filter((call) => call.url === CATALOGUE_URL).length;
    expect(catalogueReads).toBeGreaterThanOrEqual(2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('an already-loaded admission tracks nothing and toasts nothing (the dialog owns that toast)', async () => {
    const { calls } = await renderScreen();
    fireEvent.click(within(row(/Whisper Large Code-Switch/)).getByRole('button', { name: /Load…/ }));
    act(() =>
      lastProps<LoadPreviewDialogProps>(spies.load).onAdmitted({
        outcome: 'already_loaded',
        model: { service: 'stt', instance: 'x', modelRef: 'whisper-large-cs', state: 'loaded' },
      }),
    );
    expect(calls.some((call) => call.url.includes('/operations/'))).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a drawer reload posts replace + options and tracks the operation', async () => {
    const { calls } = await renderScreen(makeCatalogue(), (call) => {
      if (call.url === `${BASE}/load`) return Response.json(accepted('op-9', 'granite-guardian'), { status: 202 });
      if (call.url === `${BASE}/operations/op-9`) return { ...operation('op-9', 'granite-guardian', 'succeeded'), service: 'lm-studio' };
      return undefined;
    });
    fireEvent.click(within(row(/Granite Guardian/)).getByRole('button', { name: /Details/ }));
    fireEvent.click(screen.getByRole('button', { name: 'drawer reload' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Granite Guardian 4.1 8B loaded.'));
    expect(calls.find((call) => call.url === `${BASE}/load`)?.body).toEqual({
      service: 'lm-studio',
      modelRef: 'granite-guardian',
      replace: true,
      options: { contextLength: 8192 },
    });
  });
});

describe('ModelResidencyScreen — accessibility', () => {
  it('has no axe violations', async () => {
    const over = makeDevice({ overHeadroom: true });
    const { container } = await renderScreen(makeCatalogue({ devices: [over] }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
