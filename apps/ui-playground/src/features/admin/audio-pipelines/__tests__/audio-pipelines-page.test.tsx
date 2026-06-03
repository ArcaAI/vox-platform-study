/**
 * AudioPipelinesPage (TASK-331 doc-03 #2)
 *
 * The consolidated entry point: a single page with two sub-administration tabs
 * — Frontend Pipeline (local-model capture defaults) and Backend Pipelines
 * (backend ASR YAML management). The two tab bodies are exercised by their own
 * suites; here we just pin the consolidation (title + both tabs mounted).
 */

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div>{children}</div> }));

vi.mock('@arcaai/ui/tabs', () => ({
  Tabs: ({ children }: any) => <div data-testid="tabs">{children}</div>,
  TabsList: ({ children }: any) => <div role="tablist">{children}</div>,
  TabsTrigger: ({ children, value }: any) => (
    <button role="tab" data-value={value}>
      {children}
    </button>
  ),
  TabsContent: ({ children, value }: any) => <div data-testid={`tabpanel-${value}`}>{children}</div>,
}));

vi.mock('../frontend-pipeline-tab', () => ({ FrontendPipelineTab: () => <div data-testid="frontend-tab" /> }));
vi.mock('../backend-pipelines-tab', () => ({ BackendPipelinesTab: () => <div data-testid="backend-tab" /> }));

import AudioPipelinesPage from '../index';

describe('AudioPipelinesPage (TASK-331 doc-03 consolidation)', () => {
  it('renders the consolidated title and both pipeline tabs', () => {
    render(<AudioPipelinesPage />);

    expect(screen.getByText('Audio Pipelines')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /frontend pipeline/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /backend pipelines/i })).toBeInTheDocument();
    expect(screen.getByTestId('frontend-tab')).toBeInTheDocument();
    expect(screen.getByTestId('backend-tab')).toBeInTheDocument();
  });
});
