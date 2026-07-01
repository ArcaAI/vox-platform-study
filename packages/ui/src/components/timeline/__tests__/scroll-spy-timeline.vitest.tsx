import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { ScrollSpyTimeline } from '../scroll-spy-timeline';
import type { TimelineMilestone } from '../scroll-spy-timeline';

expect.extend(axeMatchers);

// Avoid loading shiki's async highlighter; the markdown code renderer falls back
// to a plain <pre><code> while this resolves anyway.
vi.mock('shiki', () => ({ codeToHtml: vi.fn(async (code: string) => `<pre><code>${code}</code></pre>`) }));

interface MockEntry {
  target: Element;
  isIntersecting: boolean;
  boundingClientRect: { top: number };
}

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    MockIntersectionObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  trigger(entries: MockEntry[]) {
    this.callback(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

function setReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }));
}

const MILESTONES: TimelineMilestone[] = [
  {
    id: 'v240',
    version: 'v2.4.0',
    date: '2026-06-12',
    title: 'Admin Console redesign',
    intro: 'Full multi-tenant admin surface.',
    media: { type: 'image', images: [{ id: 'shot', src: 'https://ex.com/admin.png', alt: 'Admin dashboard', width: 1440, height: 900 }] },
    sections: [
      { id: 'new', label: 'New · 1', content: { type: 'markdown', markdown: 'Ambient diarization GA\n\n```bash\npnpm build\n```' } },
      { id: 'fixes', label: 'Bug fixes · 1', content: { type: 'markdown', markdown: 'STT reconnect on network blips' } },
    ],
  },
  { id: 'v230', version: 'v2.3.0', date: '2026-04-01', title: 'Guardrail streaming', intro: 'Low-latency guardrail.' },
  { id: 'v220', version: 'v2.2.0', date: '2026-02-01', title: 'Multi-tenant isolation', intro: 'Row-level tenant scoping.' },
];

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

beforeEach(() => {
  MockIntersectionObserver.instances = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = MockIntersectionObserver;
  setReducedMotion(false);
});

afterEach(() => {
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  vi.restoreAllMocks();
});

function markerVersions(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-slot="timeline-marker"]')).map((m) => m.textContent?.match(/v\d+\.\d+\.\d+/)?.[0]);
}

describe('ScrollSpyTimeline (§4a.3)', () => {
  it('renders rail markers newest-first for desc and reversed for asc', () => {
    const { container, rerender } = render(<ScrollSpyTimeline milestones={MILESTONES} aria-label="Releases" />);
    expect(markerVersions(container)).toEqual(['v2.4.0', 'v2.3.0', 'v2.2.0']);
    rerender(<ScrollSpyTimeline milestones={MILESTONES} order="asc" aria-label="Releases" />);
    expect(markerVersions(container)).toEqual(['v2.2.0', 'v2.3.0', 'v2.4.0']);
  });

  it('exposes an accessible ordered list of milestones', () => {
    const { container } = render(<ScrollSpyTimeline milestones={MILESTONES} aria-label="Releases" />);
    const list = screen.getByRole('list', { name: 'Releases' });
    expect(list.tagName).toBe('OL');
    // Count the milestone rows directly (media renderers may add their own nested listitems).
    expect(container.querySelectorAll('[data-slot="timeline-entries"] > li')).toHaveLength(3);
    expect(screen.getByText('Admin Console redesign')).toBeInTheDocument();
  });

  it('expands and collapses a section (reusing useExpansion)', () => {
    render(<ScrollSpyTimeline milestones={MILESTONES} aria-label="Releases" />);
    const toggle = screen.getByRole('button', { name: /bug fixes/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('STT reconnect on network blips')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const controls = toggle.getAttribute('aria-controls')!;
    expect(document.getElementById(controls)).toBeInTheDocument();
    expect(screen.getByText('STT reconnect on network blips')).toBeInTheDocument();
  });

  it('resolves the renderer registry for markdown, image and code content', async () => {
    const { container } = render(<ScrollSpyTimeline milestones={MILESTONES} aria-label="Releases" />);
    // image renderer (milestone media) → <img>
    expect(container.querySelector('img')).toBeTruthy();
    // open the "New" section, which carries markdown + a fenced code block
    fireEvent.click(screen.getByRole('button', { name: /new ·/i }));
    // flush the async (mocked) shiki highlighter inside act
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Ambient diarization GA/)).toBeInTheDocument();
    const code = container.querySelector('code');
    expect(code?.textContent).toContain('pnpm build');
  });

  it('computes the active milestone from the IntersectionObserver and fires onActiveChange', () => {
    const onActiveChange = vi.fn();
    const { container } = render(<ScrollSpyTimeline milestones={MILESTONES} stickyOffset={64} onActiveChange={onActiveChange} aria-label="Releases" />);
    expect(MockIntersectionObserver.instances[0]?.options?.rootMargin).toContain('-64px');
    const entryFor = (id: string, isIntersecting: boolean, top: number): MockEntry => ({
      target: container.querySelector(`[data-slot="timeline-entry"][data-id="${id}"]`)!,
      isIntersecting,
      boundingClientRect: { top },
    });
    act(() => {
      MockIntersectionObserver.instances[0].trigger([entryFor('v240', false, -400), entryFor('v230', true, 30)]);
    });
    expect(onActiveChange).toHaveBeenLastCalledWith('v230');
    const activeMarker = container.querySelector('[data-slot="timeline-marker"][data-active="true"]');
    expect(activeMarker?.textContent).toContain('v2.3.0');
  });

  it('pins the active marker with position:sticky at the sticky offset', () => {
    const { container } = render(<ScrollSpyTimeline milestones={MILESTONES} stickyOffset={48} aria-label="Releases" />);
    // The first milestone is active by default until the reader scrolls.
    const activeMarker = container.querySelector('[data-slot="timeline-marker"][data-active="true"]') as HTMLElement;
    expect(activeMarker).toBeTruthy();
    expect(activeMarker.style.position).toBe('sticky');
    expect(activeMarker.style.top).toBe('48px');
  });

  it('disables the marker travel/pulse animation under prefers-reduced-motion', () => {
    setReducedMotion(true);
    const { container } = render(<ScrollSpyTimeline milestones={MILESTONES} aria-label="Releases" />);
    expect(container.querySelector('[data-slot="scroll-spy-timeline"]')).toHaveAttribute('data-reduced-motion', 'true');
    const activeDot = container.querySelector('[data-slot="timeline-marker"][data-active="true"] [data-slot="timeline-marker-dot"]');
    expect(activeDot?.className).not.toContain('animate');
  });

  it('renders loading, empty and error states', () => {
    const { rerender, container } = render(<ScrollSpyTimeline milestones={[]} isLoading aria-label="Releases" />);
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
    rerender(<ScrollSpyTimeline milestones={[]} aria-label="Releases" />);
    expect(container.querySelector('[data-slot="empty"]')).toBeInTheDocument();
    const onRetry = vi.fn();
    rerender(<ScrollSpyTimeline milestones={[]} error={new Error('nope')} onRetry={onRetry} aria-label="Releases" />);
    expect(screen.getByText('nope')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('applies the density attribute', () => {
    const { container } = render(<ScrollSpyTimeline milestones={MILESTONES} density="compact" aria-label="Releases" />);
    expect(container.querySelector('[data-slot="scroll-spy-timeline"]')).toHaveAttribute('data-density', 'compact');
  });

  it('has no axe violations', async () => {
    const { container } = render(<ScrollSpyTimeline milestones={MILESTONES} aria-label="Release timeline" />);
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
