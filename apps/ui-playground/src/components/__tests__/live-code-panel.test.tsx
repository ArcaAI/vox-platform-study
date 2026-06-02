/**
 * TASK-329 — LiveCodePanel smoke test.
 *
 * Verifies the shared panel:
 *   - renders the supplied snippet (the code flows into the code-block)
 *   - renders the title + description chrome and a copy affordance
 *   - re-renders the new snippet when the `code` prop changes (reactivity)
 *
 * The kibo-ui code-block is mocked centrally in `src/__tests__/setup.ts` with a
 * passthrough that prints `data[0].code`, so no per-test UI mocks are needed here.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveCodePanel } from '../live-code-panel';

describe('LiveCodePanel', () => {
  it('renders the snippet, default chrome, and a copy button', () => {
    render(<LiveCodePanel code="const x = 1;" />);

    expect(screen.getByTestId('live-code-panel')).toBeInTheDocument();
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
    expect(screen.getByText('Live SDK sample')).toBeInTheDocument();
    expect(screen.getByText(/Reflects the current selections/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('honours custom title + description', () => {
    render(<LiveCodePanel code="x" title="Audio sample" description="Audio prefs" />);
    expect(screen.getByText('Audio sample')).toBeInTheDocument();
    expect(screen.getByText('Audio prefs')).toBeInTheDocument();
  });

  it('reflects a changed snippet when the code prop updates', () => {
    const { rerender } = render(<LiveCodePanel code="first()" />);
    expect(screen.getByText('first()')).toBeInTheDocument();

    rerender(<LiveCodePanel code="second()" />);
    expect(screen.getByText('second()')).toBeInTheDocument();
    expect(screen.queryByText('first()')).not.toBeInTheDocument();
  });
});
