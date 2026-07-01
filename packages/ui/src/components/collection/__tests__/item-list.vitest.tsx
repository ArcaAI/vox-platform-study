import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { ItemList } from '../item-list';

expect.extend(axeMatchers);

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // happy-dom has no layout engine → give the virtualizer a real viewport.
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  for (const [prop, value] of [['clientHeight', 600], ['clientWidth', 800], ['offsetHeight', 600], ['offsetWidth', 800]] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
});

interface Job {
  id: string;
  name: string;
}

const JOBS: Job[] = [
  { id: 'cs-1', name: 'CS-20461' },
  { id: 'cs-2', name: 'CS-20458' },
  { id: 'cs-3', name: 'CS-20455' },
];

function renderList(props: Partial<React.ComponentProps<typeof ItemList<Job>>> = {}) {
  return render(
    <ItemList<Job>
      items={JOBS}
      getItemId={(j) => j.id}
      aria-label="Processing jobs"
      renderRow={(j) => <span>{j.name}</span>}
      renderDetail={(j) => <div>Detail for {j.name}</div>}
      {...props}
    />,
  );
}

function triggers(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-slot="item-list-row-trigger"]'));
}

describe('ItemList (§4a.2)', () => {
  it('renders a listitem per item', () => {
    renderList();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('CS-20461')).toBeInTheDocument();
  });

  it('expands and collapses a row on click, revealing the detail panel', () => {
    const { container } = renderList();
    const [first] = triggers(container);
    expect(screen.queryByText('Detail for CS-20461')).not.toBeInTheDocument();
    fireEvent.click(first);
    expect(screen.getByText('Detail for CS-20461')).toBeInTheDocument();
    fireEvent.click(first);
    expect(screen.queryByText('Detail for CS-20461')).not.toBeInTheDocument();
  });

  it('expands with ArrowRight and collapses with ArrowLeft (keyboard model)', () => {
    const { container } = renderList();
    const [first] = triggers(container);
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByText('Detail for CS-20461')).toBeInTheDocument();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(screen.queryByText('Detail for CS-20461')).not.toBeInTheDocument();
  });

  it('moves focus between rows with ArrowDown/ArrowUp (roving tabindex)', () => {
    const { container } = renderList();
    const rows = triggers(container);
    rows[0].focus();
    expect(rows[0]).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(rows[1]).toHaveFocus();
    expect(rows[1]).toHaveAttribute('tabindex', '0');
    expect(rows[0]).toHaveAttribute('tabindex', '-1');
  });

  it('wires aria-expanded and aria-controls to the detail region', () => {
    const { container } = renderList();
    const [first] = triggers(container);
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(first).not.toHaveAttribute('aria-controls');
    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    const controls = first.getAttribute('aria-controls')!;
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls)).toBeInTheDocument();
  });

  it('single mode keeps only one row open at a time', () => {
    const { container } = renderList({ expansion: { mode: 'single' } });
    const rows = triggers(container);
    fireEvent.click(rows[0]);
    expect(screen.getByText('Detail for CS-20461')).toBeInTheDocument();
    fireEvent.click(rows[1]);
    expect(screen.queryByText('Detail for CS-20461')).not.toBeInTheDocument();
    expect(screen.getByText('Detail for CS-20458')).toBeInTheDocument();
  });

  it('multiple mode keeps several rows open at once', () => {
    const { container } = renderList({ expansion: { mode: 'multiple' } });
    const rows = triggers(container);
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1]);
    expect(screen.getByText('Detail for CS-20461')).toBeInTheDocument();
    expect(screen.getByText('Detail for CS-20458')).toBeInTheDocument();
  });

  it('calls onRowClick with the id', () => {
    const onRowClick = vi.fn();
    const { container } = renderList({ onRowClick });
    fireEvent.click(triggers(container)[1]);
    expect(onRowClick).toHaveBeenCalledWith('cs-2');
  });

  it('shows a skeleton while loading and an Empty state when empty', () => {
    const { rerender, container } = renderList({ items: [], isLoading: true });
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
    rerender(<ItemList<Job> items={[]} getItemId={(j) => j.id} renderRow={(j) => <span>{j.name}</span>} />);
    expect(container.querySelector('[data-slot="empty"]')).toBeInTheDocument();
  });

  it('applies the density attribute', () => {
    const { container } = renderList({ density: 'compact' });
    expect(container.querySelector('[data-slot="item-list"]')).toHaveAttribute('data-density', 'compact');
  });

  it('virtualizes large lists to a bounded number of DOM listitems', () => {
    const many: Job[] = Array.from({ length: 1000 }, (_, i) => ({ id: `j${i}`, name: `Job ${i}` }));
    renderList({ items: many, virtualized: true, height: 480 });
    const rows = screen.getAllByRole('listitem');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
  });

  it('has no axe violations', async () => {
    const { container } = renderList();
    fireEvent.click(triggers(container)[0]);
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
