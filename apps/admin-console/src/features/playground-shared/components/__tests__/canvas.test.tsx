/**
 * Playground canvas primitives. PlaygroundCanvas (centered
 * work column), SplitCanvas (input | live-output), and RunBar (Run/Stop +
 * connection/progress chips) that standardize the per-page SSE/WS state.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaygroundCanvas, SplitCanvas } from '../playground-canvas';
import { RunBar } from '../run-bar';

afterEach(cleanup);

describe('PlaygroundCanvas', () => {
  it('renders children in a centered, width-capped column', () => {
    const { container } = render(
      <PlaygroundCanvas>
        <p>work</p>
      </PlaygroundCanvas>,
    );
    expect(screen.getByText('work')).toBeDefined();
    expect(container.querySelector('.max-w-\\[760px\\]')).not.toBeNull();
  });
});

describe('SplitCanvas', () => {
  it('renders both the input and output panes', () => {
    render(<SplitCanvas input={<div>capture</div>} output={<div>transcript</div>} />);
    expect(screen.getByText('capture')).toBeDefined();
    expect(screen.getByText('transcript')).toBeDefined();
  });
});

describe('RunBar', () => {
  it('shows Run when idle and calls onRun', () => {
    const onRun = vi.fn();
    render(<RunBar running={false} onRun={onRun} onStop={vi.fn()} />);
    const button = screen.getByRole('button', { name: /run/i });
    fireEvent.click(button);
    expect(onRun).toHaveBeenCalledOnce();
  });

  it('shows Stop when running and calls onStop', () => {
    const onStop = vi.fn();
    render(<RunBar running onRun={vi.fn()} onStop={onStop} />);
    const button = screen.getByRole('button', { name: /stop/i });
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('renders the connection chip and progress label', () => {
    render(<RunBar running onRun={vi.fn()} onStop={vi.fn()} connection="live" progressLabel="12s · 3 chunks" />);
    expect(screen.getByText(/live/i)).toBeDefined();
    expect(screen.getByText('12s · 3 chunks')).toBeDefined();
  });

  it('disables the action when disabled', () => {
    render(<RunBar running={false} onRun={vi.fn()} onStop={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: /run/i }).hasAttribute('disabled')).toBe(true);
  });
});
