import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { RunningTasksList, type RunningTask } from '../running-tasks-list';

expect.extend(axeMatchers);

const TASKS: RunningTask[] = [
  { id: 'job_01', name: 'Summarize consultation', status: 'running', progress: 42, updatedAt: new Date(Date.now() - 5 * 60 * 1000) },
  { id: 'job_02', name: 'Transcribe audio', status: 'succeeded', updatedAt: new Date(Date.now() - 60 * 60 * 1000) },
  { id: 'job_03', name: 'Guardrail scan', status: 'failed', updatedAt: new Date(Date.now() - 2 * 60 * 1000) },
];

describe('RunningTasksList', () => {
  it('renders each task with a status dot, mono id, progress bar and relative time', () => {
    const { container } = render(<RunningTasksList tasks={TASKS} />);
    const rows = container.querySelectorAll('[data-slot="item-list-row"]');
    expect(rows).toHaveLength(3);

    // status dot maps to a color role per status
    const running = rows[0];
    expect(running.querySelector('[data-slot="status-dot"]')).toHaveAttribute('data-color-role', 'info');
    // mono id
    const id = running.querySelector('[data-slot="task-id"]')!;
    expect(id).toHaveTextContent('job_01');
    expect(id.className).toContain('font-mono');
    // progress bar with the right value
    const bar = running.querySelector('[role="progressbar"]')!;
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    // relative time
    expect(running.querySelector('[data-slot="task-updated"]')).toHaveTextContent(/ago/i);
  });

  it('maps each status to the documented color role', () => {
    const { container } = render(<RunningTasksList tasks={TASKS} />);
    const dots = container.querySelectorAll('[data-slot="status-dot"]');
    expect(dots[0]).toHaveAttribute('data-color-role', 'info'); // running
    expect(dots[1]).toHaveAttribute('data-color-role', 'success'); // succeeded
    expect(dots[2]).toHaveAttribute('data-color-role', 'destructive'); // failed
  });

  it('shows the loading skeleton (delegated to ItemList)', () => {
    render(<RunningTasksList tasks={[]} isLoading />);
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
  });

  it('shows a custom empty state', () => {
    render(<RunningTasksList tasks={[]} emptyState={<span>No active tasks</span>} />);
    expect(screen.getByText('No active tasks')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<RunningTasksList tasks={TASKS} aria-label="Recent activity" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
