/**
 * LiveByteCount tests (TASK-351 P0-6 / H7)
 *
 * The leaf component subscribes to a ByteCounterHandle via
 * useSyncExternalStore: byte ticks update ONLY this component — siblings
 * (the transcript list) must not re-render.
 */

import { act, render, screen } from '@testing-library/react';
import { createByteCounter } from '@/lib/byte-counter';
import { LiveByteCount } from '../live-byte-count';

function Probe({ onRender }: { onRender: () => void }) {
  onRender();
  return <div data-testid="probe" />;
}

describe('LiveByteCount', () => {
  it('renders the current value through the formatter', () => {
    const counter = createByteCounter();
    counter.add(2048);

    render(<LiveByteCount handle={counter.handle} format={(b) => `${b / 1024} KB sent`} />);

    expect(screen.getByText('2 KB sent')).toBeInTheDocument();
  });

  it('updates on byte ticks without re-rendering siblings', () => {
    const counter = createByteCounter();
    const probeRenders = vi.fn();

    render(
      <>
        <Probe onRender={probeRenders} />
        <LiveByteCount handle={counter.handle} format={(b) => `${b} B`} />
      </>,
    );
    expect(probeRenders).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0 B')).toBeInTheDocument();

    act(() => {
      counter.add(2560);
    });

    expect(screen.getByText('2560 B')).toBeInTheDocument();
    // The sibling subtree did not re-render on the byte tick.
    expect(probeRenders).toHaveBeenCalledTimes(1);
  });

  it('renders the raw number when no formatter is given', () => {
    const counter = createByteCounter();
    counter.add(7);

    render(<LiveByteCount handle={counter.handle} />);

    expect(screen.getByText('7')).toBeInTheDocument();
  });
});
