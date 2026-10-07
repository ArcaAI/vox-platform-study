/**
 * TASK-1051 lane C1 — the ONE models table (artboard 01): grouped by service,
 * service tabs (`TabsList variant="line"`) and filter chips in the URL,
 * remote/built-in rows as "Not applicable", one primary action per row.
 */

import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { ModelsTable, type ModelsTableProps } from '../models-table';
import {
  FAILED_RNNOISE_LIKE,
  LIVE_WHISPER,
  LMS,
  makeDevice,
  NLP,
  PINNED_NOT_LOADED,
  ROUTING_GUARD,
  STT,
  UNMATCHED_GEMMA,
  WORKER,
} from './residency-test-data';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup(overrides: Partial<ModelsTableProps> = {}, searchParams = '') {
  const props: ModelsTableProps = {
    services: [STT, WORKER, LMS, NLP],
    devices: [makeDevice()],
    pendingKeys: new Set(),
    onLoad: vi.fn(),
    onUnload: vi.fn(),
    onLink: vi.fn(),
    onOpenDrawer: vi.fn(),
    ...overrides,
  };
  const onUrlUpdate = vi.fn();
  const view = renderWithProviders(<ModelsTable {...props} />, { searchParams, onUrlUpdate });
  return { props, onUrlUpdate, ...view };
}

function table() {
  return screen.getByRole('table', { name: 'Models' });
}

function modelNames(): string[] {
  return within(table())
    .queryAllByTestId('model-name')
    .map((el) => el.textContent ?? '');
}

describe('ModelsTable — grouping and tabs', () => {
  it('renders every service as a group header in one table, with counts in the heading and tabs', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Models (7)' })).toBeDefined();
    const headers = within(table())
      .getAllByRole('rowheader')
      .map((cell) => cell.getAttribute('data-service'));
    expect(headers).toEqual(['stt', 'stt-worker', 'lm-studio', 'nlp']);
    expect(screen.getByText('No self-hosted models for this service')).toBeDefined();
    expect(screen.getByText('Read-only · no control API')).toBeDefined();

    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual([
      'All 7',
      'Speech-to-text — live sessions 4',
      'Speech-to-text — background jobs 0',
      'Language models (LM Studio) 2',
      'Medical NLP 1',
    ]);
    expect(screen.getByRole('tablist').getAttribute('data-variant')).toBe('line');
  });

  it('a service tab narrows the table to that service and writes it to the URL', async () => {
    const { onUrlUpdate } = setup();
    const tab = screen.getByRole('tab', { name: /Medical NLP/ });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await vi.waitFor(() => expect(modelNames()).toEqual(['Medical NER']));
    await vi.waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    expect(onUrlUpdate.mock.calls.at(-1)![0].searchParams.get('service')).toBe('nlp');
  });

  it('reads the tab from the URL', () => {
    setup({}, '?service=lm-studio');
    expect(modelNames()).toEqual(['Granite Guardian 4.1 8B', 'gemma-4-e2b-it-qat@q4_0']);
  });
});

describe('ModelsTable — filter chips', () => {
  it('Problems keeps failed, unmatched and pinned-not-loaded rows, and is a pressed toggle', () => {
    setup();
    const chip = screen.getByRole('button', { name: /Problems/ });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.textContent).toBe('Problems 3');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(modelNames()).toEqual(['Whisper Large Code-Switch', 'gemma-4-e2b-it-qat@q4_0', 'Medical NER']);
  });

  it('Loaded, Live path and Hide remote & built-in combine', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /^Loaded/ }));
    expect(modelNames()).toEqual(['ArcaAI Whisper ml-en', 'Granite Guardian 4.1 8B', 'gemma-4-e2b-it-qat@q4_0']);
    fireEvent.click(screen.getByRole('button', { name: /Live path/ }));
    expect(modelNames()).toEqual(['ArcaAI Whisper ml-en']);
  });

  it('Hide remote & built-in drops those rows', () => {
    setup({}, '?service=stt');
    expect(modelNames()).toContain('Sarvam Saaras v4');
    fireEvent.click(screen.getByRole('button', { name: 'Hide remote & built-in' }));
    expect(modelNames()).toEqual(['ArcaAI Whisper ml-en', 'Whisper Large Code-Switch']);
  });

  it('shows an empty state with a reset when the filters hide everything', () => {
    setup({}, '?service=nlp&show=loaded');
    expect(screen.getByText('No models match these filters')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(modelNames()).toEqual(['Medical NER']);
  });
});

describe('ModelsTable — rows', () => {
  it('renders remote and built-in rows as "Not applicable" with no action', () => {
    setup();
    const remote = within(table()).getByRole('row', { name: /Sarvam Saaras v4/ });
    expect(within(remote).getByText('Remote API')).toBeDefined();
    expect(within(remote).getByText('Cloud · no GPU memory')).toBeDefined();
    expect(within(remote).getByText('Not applicable')).toBeDefined();
    expect(within(remote).queryByRole('button', { name: /Load|Unload|Link|Reload/ })).toBeNull();

    const builtin = within(table()).getByRole('row', { name: /RNNoise/ });
    expect(within(builtin).getByText('Built in')).toBeDefined();
    expect(within(builtin).getByText('Not applicable')).toBeDefined();
  });

  it('shows name + mono slug, state · where, used by, keep policy and traffic', () => {
    setup();
    const row = within(table()).getByRole('row', { name: /ArcaAI Whisper ml-en/ });
    expect(within(row).getByText('whisper-ml-en')).toBeDefined();
    expect(within(row).getByText('Loaded')).toBeDefined();
    expect(within(row).getByText('GPU 0 · 1.5 GB measured')).toBeDefined();
    expect(within(row).getByText('5 agents · 3 tenants')).toBeDefined();
    expect(within(row).getByText('Live consultations')).toBeDefined();
    expect(within(row).getByText('Always loaded')).toBeDefined();
    expect(within(row).getByText(/4\.2 req\/min · p50 310 ms · 2 in flight/)).toBeDefined();

    const routing = within(table()).getByRole('row', { name: /Granite Guardian/ });
    expect(within(routing).getByText('Routing policy')).toBeDefined();
    expect(within(routing).getByText('Guardrail judge')).toBeDefined();
    expect(within(routing).getByText('—')).toBeDefined();
  });

  it('routes each primary action to its dialog, and Details to the drawer', () => {
    const { props } = setup();
    fireEvent.click(within(within(table()).getByRole('row', { name: /Whisper Large Code-Switch/ })).getByRole('button', { name: /Load…/ }));
    expect(props.onLoad).toHaveBeenCalledWith(STT, PINNED_NOT_LOADED);

    fireEvent.click(within(within(table()).getByRole('row', { name: /ArcaAI Whisper ml-en/ })).getByRole('button', { name: /Unload…/ }));
    expect(props.onUnload).toHaveBeenCalledWith(STT, LIVE_WHISPER);

    const orphan = within(table()).getByRole('row', { name: /gemma-4-e2b-it-qat@q4_0/ });
    fireEvent.click(within(orphan).getByRole('button', { name: /Link…/ }));
    expect(props.onLink).toHaveBeenCalledWith(LMS, UNMATCHED_GEMMA);
    expect(within(orphan).queryByRole('button', { name: /Details/ })).toBeNull();
    expect(within(orphan).getByText('Not in the model catalogue')).toBeDefined();

    fireEvent.click(within(within(table()).getByRole('row', { name: /Medical NER/ })).getByRole('button', { name: /Details/ }));
    expect(props.onOpenDrawer).toHaveBeenCalledWith(NLP, FAILED_RNNOISE_LIKE);
  });

  it('Reload… opens the drawer (its profile editor)', () => {
    const reloadOnly = { ...ROUTING_GUARD, actions: ['reload' as const, 'edit_policy' as const] };
    const lms = { ...LMS, models: [reloadOnly] };
    const { props } = setup({ services: [lms] });
    fireEvent.click(screen.getByRole('button', { name: /Reload…/ }));
    expect(props.onOpenDrawer).toHaveBeenCalledWith(lms, reloadOnly);
  });

  it('offers no action on a read-only service', () => {
    const worker = { ...WORKER, models: [LIVE_WHISPER] };
    setup({ services: [worker] });
    const row = within(table()).getByRole('row', { name: /ArcaAI Whisper ml-en/ });
    expect(within(row).queryByRole('button', { name: /Unload/ })).toBeNull();
  });

  it('marks a model with a pending operation busy and disables its action', () => {
    setup({ pendingKeys: new Set(['stt|whisper-large-cs']) });
    const row = within(table()).getByRole('row', { name: /Whisper Large Code-Switch/ });
    expect(within(row).getByRole('status', { name: 'Loading' })).toBeDefined();
    expect(within(row).getByRole('button', { name: /Load…/ })).toHaveProperty('disabled', true);
  });

  it('flags an unreachable service in its group header', () => {
    setup({ services: [{ ...NLP, reachable: false }] });
    expect(screen.getByRole('alert').textContent).toMatch(/Medical NLP did not answer/);
  });

  it('has no axe violations', async () => {
    const { container } = setup();
    expect(await axe(container)).toHaveNoViolations();
  });
});
