import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import * as React from 'react';

import { useScrollSpy } from '../use-scroll-spy';

interface MockEntry {
  target: Element;
  isIntersecting: boolean;
  boundingClientRect: { top: number };
}

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  elements = new Set<Element>();

  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.elements.add(el);
  }
  unobserve(el: Element) {
    this.elements.delete(el);
  }
  disconnect() {
    this.elements.clear();
  }
  trigger(entries: MockEntry[]) {
    this.callback(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

function Harness({ ids, offset, onActiveChange }: { ids: string[]; offset?: number; onActiveChange?: (id: string) => void }) {
  const { activeId, register } = useScrollSpy({ ids, offset, onActiveChange });
  return React.createElement(
    'div',
    null,
    React.createElement('span', { 'data-testid': 'active' }, activeId ?? 'none'),
    ...ids.map((id) => React.createElement('section', { key: id, 'data-id': id, ref: register(id) }, id)),
  );
}

function lastObserver() {
  return MockIntersectionObserver.instances.at(-1)!;
}

function sectionEntry(container: HTMLElement, id: string, isIntersecting: boolean, top: number): MockEntry {
  const target = container.querySelector(`[data-id="${id}"]`)!;
  return { target, isIntersecting, boundingClientRect: { top } };
}

describe('useScrollSpy (§4a.3)', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = MockIntersectionObserver;
  });
  afterEach(() => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  });

  it('builds an IntersectionObserver whose rootMargin encodes the sticky offset', () => {
    render(React.createElement(Harness, { ids: ['a', 'b', 'c'], offset: 80 }));
    expect(lastObserver().options?.rootMargin).toContain('-80px');
  });

  it('marks the topmost in-view entry active (active-index math) and fires onActiveChange', () => {
    const onActiveChange = vi.fn();
    const { getByTestId, container } = render(React.createElement(Harness, { ids: ['a', 'b', 'c'], offset: 0, onActiveChange }));
    act(() => {
      lastObserver().trigger([
        sectionEntry(container, 'a', false, -500),
        sectionEntry(container, 'b', true, 40),
        sectionEntry(container, 'c', true, 600),
      ]);
    });
    // Both b and c intersect; b has the smaller top → b is the in-view (active) milestone.
    expect(getByTestId('active').textContent).toBe('b');
    expect(onActiveChange).toHaveBeenLastCalledWith('b');
  });

  it('updates the active entry as the reader scrolls and only fires on change', () => {
    const onActiveChange = vi.fn();
    const { getByTestId, container } = render(React.createElement(Harness, { ids: ['a', 'b', 'c'], offset: 0, onActiveChange }));
    act(() => {
      lastObserver().trigger([sectionEntry(container, 'a', true, 10), sectionEntry(container, 'b', true, 300)]);
    });
    expect(getByTestId('active').textContent).toBe('a');
    onActiveChange.mockClear();
    // Re-emitting the same winner must not fire onActiveChange again.
    act(() => {
      lastObserver().trigger([sectionEntry(container, 'a', true, 5)]);
    });
    expect(onActiveChange).not.toHaveBeenCalled();
    // Scroll further: a leaves view, b becomes topmost in-view.
    act(() => {
      lastObserver().trigger([sectionEntry(container, 'a', false, -200), sectionEntry(container, 'b', true, 20)]);
    });
    expect(getByTestId('active').textContent).toBe('b');
    expect(onActiveChange).toHaveBeenLastCalledWith('b');
  });

  it('ignores entries with no intersecting sections (keeps last active)', () => {
    const { getByTestId, container } = render(React.createElement(Harness, { ids: ['a', 'b'], offset: 0 }));
    act(() => {
      lastObserver().trigger([sectionEntry(container, 'a', true, 10)]);
    });
    expect(getByTestId('active').textContent).toBe('a');
    act(() => {
      lastObserver().trigger([sectionEntry(container, 'a', false, -300), sectionEntry(container, 'b', false, 700)]);
    });
    expect(getByTestId('active').textContent).toBe('a');
  });
});
