/**
 * SummaryPanel — prompt-resolution tier badge (TASK-331 doc-06 F4-UI)
 *
 * The server resolves a 3-tier prompt fallback (preferred → department →
 * default) and echoes it on `SummaryResponse.structuredData.promptResolvedFrom`.
 * The panel surfaces which tier produced each summary; when the field is absent
 * (older summaries / backend not yet populating it) no badge is shown.
 *
 * `@arcaai/vox` + `@arcaai/ui/*` are globally stubbed, so each is mocked here.
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const summaryApi = vi.hoisted(() => ({
  loadSummaries: vi.fn(),
  generateSummary: vi.fn(),
  generatePreSummary: vi.fn(),
}));

vi.mock('@arcaai/vox', () => ({ useArca: () => ({ summary: summaryApi }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardHeader: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, ...p }: any) => <span {...p}>{children}</span> }));
vi.mock('@arcaai/ui/button', () => ({ Button: ({ children, ...p }: any) => <button {...p}>{children}</button> }));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: (p: any) => <div data-testid="skeleton" {...p} /> }));
vi.mock('@arcaai/ui/separator', () => ({ Separator: () => <hr /> }));

import { SummaryPanel } from '../components/summary-panel';

const makeSummary = (promptResolvedFrom?: string) => ({
  id: 's1',
  type: 'summary',
  llmProvider: 'ollama',
  modelName: 'llama3',
  content: 'Summary body text',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...(promptResolvedFrom ? { structuredData: { promptResolvedFrom } } : {}),
});

describe('SummaryPanel — prompt tier badge (TASK-331 doc-06 F4-UI)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['preferred', 'Doctor preferred'],
    ['department', 'Department'],
    ['default', 'Default'],
  ])('renders the %s tier as the "%s" badge', async (tier, label) => {
    summaryApi.loadSummaries = vi.fn().mockResolvedValue([makeSummary(tier)]);
    render(<SummaryPanel consultationId="c-1" />);
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it('renders no tier badge when promptResolvedFrom is absent', async () => {
    summaryApi.loadSummaries = vi.fn().mockResolvedValue([makeSummary()]);
    render(<SummaryPanel consultationId="c-1" />);
    // Summary content rendered → load finished.
    expect(await screen.findByText('Summary body text')).toBeInTheDocument();
    expect(screen.queryByText('Doctor preferred')).not.toBeInTheDocument();
    expect(screen.queryByText('Department')).not.toBeInTheDocument();
    expect(screen.queryByText('Default')).not.toBeInTheDocument();
  });
});
