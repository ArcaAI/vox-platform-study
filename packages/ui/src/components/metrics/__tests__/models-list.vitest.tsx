import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { ModelsList, type ModelInfo } from '../models-list';

expect.extend(axeMatchers);

const MODELS: ModelInfo[] = [
  { id: 'whisper-large-v3', name: 'Whisper', status: 'loaded', version: 'v3', size: '1.5 GB', updatedAt: new Date(Date.now() - 3 * 60 * 1000) },
  { id: 'gpt-sum-1', name: 'Summarizer', status: 'loading', version: '1.2.0', size: '780 MB' },
  { id: 'guard-1', name: 'Guardrail', status: 'error', version: '0.9', size: '320 MB' },
];

describe('ModelsList', () => {
  it('renders a status badge, size and monospace version per model', () => {
    const { container } = render(<ModelsList models={MODELS} />);
    const rows = container.querySelectorAll('[data-slot="item-list-row"]');
    expect(rows).toHaveLength(3);

    const first = rows[0] as HTMLElement;
    expect(within(first).getByText('Whisper')).toBeInTheDocument();
    expect(within(first).getByText('Loaded')).toBeInTheDocument(); // StatusBadge label
    const size = first.querySelector('[data-slot="model-size"]')!;
    expect(size).toHaveTextContent('1.5 GB');
    const version = first.querySelector('[data-slot="model-version"]')!;
    expect(version).toHaveTextContent('v3');
    expect(version.className).toContain('font-mono');
  });

  it('maps each status to the documented dot role and badge label', () => {
    const { container } = render(<ModelsList models={MODELS} />);
    const dots = container.querySelectorAll('[data-slot="status-dot"]');
    expect(dots[0]).toHaveAttribute('data-color-role', 'success'); // loaded
    expect(dots[1]).toHaveAttribute('data-color-role', 'info'); // loading
    expect(dots[2]).toHaveAttribute('data-color-role', 'destructive'); // error
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('shows the loading skeleton (delegated to ItemList)', () => {
    render(<ModelsList models={[]} isLoading />);
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });

  it('shows a custom empty state', () => {
    render(<ModelsList models={[]} emptyState={<span>No models loaded</span>} />);
    expect(screen.getByText('No models loaded')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<ModelsList models={MODELS} aria-label="Loaded models" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
