/**
 * Knowledge Base screen — fetch is stubbed at the network
 * boundary. Covers the working-tenant gate, the offset-paginated grid, the
 * empty state, opening the detail drawer (Overview + force-audited Chunks
 * tab), the archive confirm flow, the fail-closed delete confirm flow
 * (type-to-confirm), and an axe scan in both themes.
 */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { KnowledgeChunk, KnowledgeDocument } from '../../api/types';
import { KnowledgeDocumentsScreen } from '../knowledge-documents-screen';
import { installFetchStub, sessionPayload, type RecordedCall } from './fetch-stub';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function knowledgeDocument(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: 'doc-1',
    tenantId: 'tnt-1',
    title: 'Sepsis Protocol',
    source: 'protocols/sepsis.md',
    sourceType: 'markdown',
    mimeType: 'text/markdown',
    checksum: 'sha256:abc',
    status: 'APPROVED',
    approvedBy: 'admin-1',
    approvedAt: '2026-08-10T10:00:00.000Z',
    ingestedAt: '2026-08-10T10:05:00.000Z',
    chunkCount: 1,
    version: 2,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-10T10:05:00.000Z',
    ...overrides,
  };
}

function chunk(overrides: Partial<KnowledgeChunk> = {}): KnowledgeChunk {
  return {
    id: 'chunk-1',
    tenantId: 'tnt-1',
    knowledgeDocumentId: 'doc-1',
    chunkIndex: 0,
    text: 'Give antibiotics within one hour of recognizing sepsis.',
    tokenCount: 12,
    startOffset: 0,
    endOffset: 55,
    qdrantPointId: 'pt-1',
    embeddingModel: 'model-x',
    embeddingDim: 4,
    status: 'APPROVED',
    createdAt: '2026-08-10T10:05:00.000Z',
    ...overrides,
  };
}

const DOCS_PAGE = { data: [knowledgeDocument()], count: 1, limit: 25, page: 0 };
const EMPTY_PAGE = { data: [], count: 0, limit: 25, page: 0 };
const CHUNKS_PAGE = { data: [chunk()], count: 1, limit: 10, page: 0 };

function stubRoutes(overrides: { docs?: typeof DOCS_PAGE; workingTenantId?: string | null; extra?: (call: RecordedCall) => Response | unknown } = {}) {
  return installFetchStub((call) => {
    if (call.url === '/api/auth/session') return sessionPayload({ workingTenantId: overrides.workingTenantId });
    if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? [] : { ok: true };
    if (call.url.startsWith('/api/hope/admin/knowledge/documents/doc-1/chunks')) return CHUNKS_PAGE;
    if (call.url.startsWith('/api/hope/admin/knowledge/documents/doc-1/archive') && call.method === 'POST') return knowledgeDocument({ status: 'ARCHIVED' });
    if (call.url.startsWith('/api/hope/admin/knowledge/documents/doc-1') && call.method === 'DELETE') return knowledgeDocument();
    if (call.url.startsWith('/api/hope/admin/knowledge/documents/doc-1')) return knowledgeDocument();
    if (call.url.startsWith('/api/hope/admin/knowledge/documents?')) return overrides.docs ?? DOCS_PAGE;
    const extra = overrides.extra?.(call);
    if (extra !== undefined) return extra;
    return { success: true };
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
});

describe('KnowledgeDocumentsScreen', () => {
  it('asks an elevated session without a working tenant to pick one (no data queries fired)', async () => {
    const calls = stubRoutes({ workingTenantId: null });
    renderWithProviders(<KnowledgeDocumentsScreen />);

    expect(await screen.findByText('Select a working tenant')).toBeDefined();
    expect(calls.every((call) => !call.url.includes('/admin/knowledge/documents'))).toBe(true);
  });

  it('lands on the Knowledge Base catalog with an empty state when there are none', async () => {
    stubRoutes({ docs: EMPTY_PAGE });
    renderWithProviders(<KnowledgeDocumentsScreen />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge Base' })).toBeDefined();
    expect(await screen.findByText('No knowledge documents yet')).toBeDefined();
  });

  it('renders the grid and opens the detail drawer with the Overview tab on row click', async () => {
    stubRoutes();
    renderWithProviders(<KnowledgeDocumentsScreen />);

    await waitFor(() => expect(screen.getByRole('grid', { name: 'Knowledge documents' })).toBeDefined());
    const row = await screen.findByText('Sepsis Protocol');
    row.closest('[data-slot="data-grid-row"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByRole('tab', { name: /Overview/ })).toBeDefined();
    expect(await within(drawer).findByText('protocols/sepsis.md')).toBeDefined();
  });

  it('the Chunks tab loads decrypted chunk text and is force-audited server-side (no client special-casing)', async () => {
    const calls = stubRoutes();
    renderWithProviders(<KnowledgeDocumentsScreen />, { searchParams: '?kdtab=chunks' });

    const row = await screen.findByText('Sepsis Protocol');
    row.closest('[data-slot="data-grid-row"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(await screen.findByText(/Give antibiotics within one hour/)).toBeDefined();
    await waitFor(() => expect(calls.some((call) => call.url.includes('/doc-1/chunks'))).toBe(true));
  });

  it('archives a document after confirmation', async () => {
    const calls = stubRoutes();
    renderWithProviders(<KnowledgeDocumentsScreen />);

    const row = await screen.findByText('Sepsis Protocol');
    row.closest('[data-slot="data-grid-row"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const drawer = await screen.findByRole('dialog');
    (await within(drawer).findByRole('button', { name: /Archive/ })).click();

    const confirmDialog = await screen.findByRole('alertdialog');
    within(confirmDialog).getByRole('button', { name: 'Archive document' }).click();

    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/doc-1/archive'))).toBe(true));
  });

  it('requires typing the exact title before the destructive delete confirm arms', async () => {
    stubRoutes();
    renderWithProviders(<KnowledgeDocumentsScreen />);

    const row = await screen.findByText('Sepsis Protocol');
    row.closest('[data-slot="data-grid-row"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const drawer = await screen.findByRole('dialog');
    (await within(drawer).findByRole('button', { name: /Delete/ })).click();

    const confirmDialog = await screen.findByRole('alertdialog');
    const confirmButton = within(confirmDialog).getByRole('button', { name: 'Delete document' });
    expect(confirmButton.hasAttribute('disabled')).toBe(true);
  });

  it('has no axe violations in the light theme (catalog, then the drawer)', async () => {
    stubRoutes();
    const { container } = renderWithProviders(<KnowledgeDocumentsScreen />);
    await waitFor(() => expect(screen.getByRole('grid', { name: 'Knowledge documents' })).toBeDefined());
    await screen.findByText('Sepsis Protocol');
    expect(await axe(container)).toHaveNoViolations();

    const row = screen.getByText('Sepsis Protocol');
    row.closest('[data-slot="data-grid-row"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const dialog = await screen.findByRole('dialog');
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme (catalog, then the drawer)', async () => {
    document.documentElement.classList.add('dark');
    stubRoutes();
    const { container } = renderWithProviders(<KnowledgeDocumentsScreen />);
    await waitFor(() => expect(screen.getByRole('grid', { name: 'Knowledge documents' })).toBeDefined());
    await screen.findByText('Sepsis Protocol');
    expect(await axe(container)).toHaveNoViolations();

    const row = screen.getByText('Sepsis Protocol');
    row.closest('[data-slot="data-grid-row"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const dialog = await screen.findByRole('dialog');
    expect(await axe(dialog)).toHaveNoViolations();
  });
});
