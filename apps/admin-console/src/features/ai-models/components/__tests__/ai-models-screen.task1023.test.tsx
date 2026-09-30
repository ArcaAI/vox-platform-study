/**
 * TASK-1023 (C2) — the AI-models screen is access-driven: a platform admin gets the management grid, every other admin a
 * read-only registry view (no write controls, no Jobs, no row actions, no bucket paths).
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { PaginatedRegistryModels, RegistryModelRow } from '../../api/types';
import { AiModelsScreen } from '../ai-models-screen';
import { envelope, modelWith, stubFetch } from './fixtures.task1019';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const REGISTRY_ROW: RegistryModelRow = {
  id: 'r-1',
  slug: 'whisper-ml-en',
  name: 'Whisper ML-EN',
  description: null,
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  libraryName: 'whisper.cpp',
  format: 'WHISPER_CPP',
  servedBy: 'stt',
  deploymentKind: 'SELF_HOSTED',
  license: 'mit',
  gated: false,
  languages: ['ml', 'en'],
  memorySizeMb: 1700,
  lifecycleStatus: 'SERVING',
  availability: 'AVAILABLE',
  isPlatformDefaultFor: [],
  resourceStatus: 'ENABLED',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

function registryEnvelope(rows: RegistryModelRow[]): PaginatedRegistryModels {
  return { data: rows, total: rows.length, page: 0, limit: 25, totalPages: rows.length ? 1 : 0 };
}

function routes(canManage: boolean) {
  return stubFetch((url) => {
    if (url.includes('admin/ai-models/access')) return Response.json({ canManage, tenantManagementEnabled: false });
    if (url.includes('admin/ai-models/registry')) return Response.json(registryEnvelope([REGISTRY_ROW]));
    if (url.includes('admin/ai-models/jobs')) return Response.json([]);
    if (url.includes('admin/ai-models/inventory')) return Response.json(null);
    if (url.includes('admin/ai-models/list')) return Response.json(envelope([modelWith('m-1', 'Whisper ML-EN', 'SERVING')]));
    return Response.json({});
  });
}

describe('AiModelsScreen — access driven (TASK-1023)', () => {
  it('shows a skeleton, not the grid, while access loads', () => {
    stubFetch(() => new Promise<Response>(() => {}));
    renderWithProviders(<AiModelsScreen />);
    expect(screen.getByTestId('ai-models-skeleton')).toBeDefined();
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('renders the read-only registry for a non-manager: no write buttons, no Jobs, no row actions, no bucket paths', async () => {
    const calls = routes(false);
    renderWithProviders(<AiModelsScreen />);

    expect(await screen.findByText('Whisper ML-EN')).toBeDefined();
    expect(screen.getByText('whisper-ml-en')).toBeDefined();
    expect(screen.getByText('automatic speech recognition')).toBeDefined();
    expect(screen.getByText('whisper.cpp')).toBeDefined();
    expect(screen.getByText('Serving')).toBeDefined();
    expect(screen.getByText('mit')).toBeDefined();
    expect(screen.getByText('ml, en')).toBeDefined();

    expect(screen.queryByRole('button', { name: /register model/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /download jobs/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /run inventory/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^edit /i })).toBeNull();
    expect(screen.queryByRole('button', { name: /unregister/i })).toBeNull();
    expect(screen.queryByText(/mnt\/models-bucket/)).toBeNull();

    const urls = calls.map((call) => call.url);
    expect(urls.some((url) => url.includes('admin/ai-models/registry'))).toBe(true);
    expect(urls.some((url) => url.includes('admin/ai-models/list'))).toBe(false);
    expect(urls.some((url) => url.includes('admin/ai-models/jobs'))).toBe(false);
  });

  it('renders the full management grid for a manager, from the list route', async () => {
    const calls = routes(true);
    renderWithProviders(<AiModelsScreen />);

    expect(await screen.findByRole('button', { name: /register model/i })).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Edit Whisper ML-EN' })).toBeDefined();
    const urls = calls.map((call) => call.url);
    expect(urls.some((url) => url.includes('admin/ai-models/list'))).toBe(true);
    expect(urls.some((url) => url.includes('admin/ai-models/registry'))).toBe(false);
  });

  it('has no axe violations in the read-only grid', async () => {
    routes(false);
    const { container } = renderWithProviders(<AiModelsScreen />);
    await screen.findByText('Whisper ML-EN');
    await waitFor(async () => expect((await axe(container)).violations).toHaveLength(0));
  });
});

