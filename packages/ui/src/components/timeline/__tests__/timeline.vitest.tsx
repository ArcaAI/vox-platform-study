import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, renderHook, act, fireEvent, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { useTimeline } from '../use-timeline';
import { HistoryTimelineList } from '../history-timeline-list';
import { MarkdownRenderer } from '../renderers/markdown-renderer';
import { AudioRenderer } from '../renderers/audio-renderer';
import { PdfRenderer } from '../renderers/pdf-renderer';
import type { TimelineItemModel } from '../types';
import type { AsyncCollection } from '@/lib/shared';

expect.extend(axeMatchers);

// Mock react-pdf so the suite never loads pdf.js or a worker.
vi.mock('react-pdf', async () => {
  const React = await import('react');
  return {
    pdfjs: { GlobalWorkerOptions: { workerSrc: '' }, version: '5.4.296' },
    Document: ({ children, onLoadSuccess, onLoadError, file }: any) => {
      const f = typeof file === 'string' ? file : file?.url;
      React.useEffect(() => {
        if (typeof f === 'string' && f.includes('broken')) onLoadError?.(new Error('load failed'));
        else onLoadSuccess?.({ numPages: 3 });
      }, [f, onLoadSuccess, onLoadError]);
      return React.createElement('div', { 'data-testid': 'pdf-document' }, children);
    },
    Page: ({ pageNumber }: any) => React.createElement('div', { 'data-testid': 'pdf-page' }, `page ${pageNumber}`),
  };
});

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
  for (const [prop, value] of [
    ['clientHeight', 600],
    ['clientWidth', 800],
    ['offsetHeight', 600],
    ['offsetWidth', 800],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
  // native <dialog> isn't implemented in happy-dom.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mdItem(id: string, ts: string, body: string, title?: string): TimelineItemModel {
  return { id, timestamp: ts, title: title ?? id, variant: 'markdown', content: { type: 'markdown', markdown: body } };
}

function audioItem(withWords: boolean): TimelineItemModel {
  return {
    id: 'aud',
    timestamp: new Date('2025-01-01T00:00:00Z'),
    variant: 'audio',
    content: {
      type: 'audio',
      src: '/rec.mp3',
      transcript: withWords
        ? {
            segments: [
              {
                id: 's1',
                text: 'hello world',
                speakerLabel: 'Doctor',
                words: [
                  { word: 'hello', start: 1.5, end: 2 },
                  { word: 'world', start: 2, end: 2.6 },
                ],
              },
            ],
          }
        : undefined,
    },
  };
}

describe('useTimeline (headless controller)', () => {
  const items = [mdItem('a', '2025-01-03', 'Alpha'), mdItem('b', '2025-01-02', 'Bravo'), mdItem('c', '2025-01-01', 'Charlie')];

  it('keeps input order for desc (newest-first) and reverses for asc', () => {
    const desc = renderHook(() => useTimeline({ items, order: 'desc' }));
    expect(desc.result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    const asc = renderHook(() => useTimeline({ items, order: 'asc' }));
    expect(asc.result.current.items.map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });

  it('toggles expansion and supports single mode (only one open)', () => {
    const onItemExpand = vi.fn();
    const { result } = renderHook(() => useTimeline({ items, expansion: { mode: 'single' }, onItemExpand }));
    act(() => result.current.toggle('a'));
    expect(result.current.expandedIds).toEqual(['a']);
    act(() => result.current.toggle('b'));
    expect(result.current.expandedIds).toEqual(['b']);
    expect(onItemExpand).toHaveBeenCalledWith('b', true);
  });

  it('calls fetchNextPage on onEndReached only while hasNextPage', () => {
    const fetchNextPage = vi.fn();
    const collection: AsyncCollection<TimelineItemModel> = { data: items, isLoading: false, error: null, hasNextPage: true, fetchNextPage };
    const { result, rerender } = renderHook(
      (props: { hasNextPage: boolean }) => useTimeline({ items, collection: { ...collection, hasNextPage: props.hasNextPage } }),
      {
        initialProps: { hasNextPage: true },
      },
    );
    act(() => result.current.onEndReached());
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    rerender({ hasNextPage: false });
    act(() => result.current.onEndReached());
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});

describe('HistoryTimelineList (shell)', () => {
  it('renders items newest-first and respects order="asc"', () => {
    const items = [mdItem('a', '2025-01-03', 'Alpha', 'Alpha'), mdItem('b', '2025-01-01', 'Bravo', 'Bravo')];
    const { rerender } = render(<HistoryTimelineList items={items} />);
    let articles = screen.getAllByRole('article');
    expect(within(articles[0]).getByText('Alpha')).toBeInTheDocument();
    rerender(<HistoryTimelineList items={items} order="asc" />);
    articles = screen.getAllByRole('article');
    expect(within(articles[0]).getByText('Bravo')).toBeInTheDocument();
  });

  it('renders the empty state, the loading skeleton, and an error retry', () => {
    const { rerender } = render(<HistoryTimelineList items={[]} />);
    expect(screen.getByText(/no history/i)).toBeInTheDocument();
    rerender(<HistoryTimelineList items={[]} isLoading />);
    expect(screen.getByLabelText(/loading/i)).toBeInTheDocument();
    const onRetry = vi.fn();
    rerender(<HistoryTimelineList items={[]} error={new Error('kaboom')} onRetry={onRetry} />);
    expect(screen.getByText('kaboom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('expands/collapses an item and emits onItemExpand', () => {
    const onItemExpand = vi.fn();
    render(<HistoryTimelineList items={[mdItem('a', '2025-01-01', 'Full body text')]} onItemExpand={onItemExpand} />);
    expect(screen.queryByText('Full body text')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText('Full body text')).toBeInTheDocument();
    expect(onItemExpand).toHaveBeenLastCalledWith('a', true);
  });

  it('selects the renderer by variant and falls back for unknown variants', () => {
    const items: TimelineItemModel[] = [
      {
        id: 'f',
        timestamp: '2025-01-02',
        variant: 'file',
        content: { type: 'file', url: '/x.zip', name: 'x.zip', size: 2048 },
        defaultExpanded: true,
      },
      { id: 'u', timestamp: '2025-01-01', variant: 'weird' as never, content: { type: 'custom', render: () => null }, defaultExpanded: true },
    ];
    render(<HistoryTimelineList items={items} />);
    expect(screen.getByRole('link', { name: /download/i })).toBeInTheDocument();
    expect(screen.getByText('x.zip')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-fallback')).toBeInTheDocument();
  });

  it('adapts raw rows through mapItem', () => {
    const raw = [{ kind: 'note', body: 'Mapped body', when: '2025-01-01' }];
    render(
      <HistoryTimelineList
        items={raw}
        mapItem={(r) => ({
          id: r.when,
          timestamp: r.when,
          variant: 'markdown',
          content: { type: 'markdown', markdown: r.body },
          defaultExpanded: true,
        })}
      />,
    );
    expect(screen.getByText('Mapped body')).toBeInTheDocument();
  });

  it('opens the image lightbox and fires onMediaOpen with the index', () => {
    const onMediaOpen = vi.fn();
    const item: TimelineItemModel = {
      id: 'img',
      timestamp: '2025-01-01',
      variant: 'image',
      content: {
        type: 'image',
        images: [
          { id: 'i0', src: 'https://ex.com/0.jpg', alt: 'First scan', width: 100, height: 100 },
          { id: 'i1', src: 'https://ex.com/1.jpg', alt: 'Second scan', width: 100, height: 100 },
        ],
      },
      defaultExpanded: true,
    };
    render(<HistoryTimelineList items={[item]} onMediaOpen={onMediaOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Second scan' }));
    expect(onMediaOpen).toHaveBeenCalledWith('img', 1);
  });

  it('swaps the lightbox to the full-res zoomSrc on open and restores the thumbnail on close', () => {
    const item: TimelineItemModel = {
      id: 'img',
      timestamp: '2025-01-01',
      variant: 'image',
      content: {
        type: 'image',
        images: [{ id: 'i0', src: 'https://ex.com/thumb.jpg', zoomSrc: 'https://ex.com/full.jpg', alt: 'Scan', width: 100, height: 100 }],
      },
      defaultExpanded: true,
    };
    const { container } = render(<HistoryTimelineList items={[item]} />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    // Grid shows the thumbnail.
    expect(img!.getAttribute('src')).toBe('https://ex.com/thumb.jpg');
    // Opening the lightbox upgrades the (reparented) <img> to the full-res source.
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    expect(img!.getAttribute('src')).toBe('https://ex.com/full.jpg');
    // Closing restores the grid thumbnail.
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(img!.getAttribute('src')).toBe('https://ex.com/thumb.jpg');
  });

  it('falls back to src in the lightbox when no zoomSrc is provided', () => {
    const item: TimelineItemModel = {
      id: 'img',
      timestamp: '2025-01-01',
      variant: 'image',
      content: { type: 'image', images: [{ id: 'i0', src: 'https://ex.com/only.jpg', alt: 'Scan', width: 100, height: 100 }] },
      defaultExpanded: true,
    };
    const { container } = render(<HistoryTimelineList items={[item]} />);
    const img = container.querySelector('img');
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    // No zoomSrc → the lightbox keeps the single src (unchanged).
    expect(img!.getAttribute('src')).toBe('https://ex.com/only.jpg');
  });

  it('shows a bottom skeleton while fetching the next page', () => {
    const collection: AsyncCollection<TimelineItemModel> = {
      data: [mdItem('a', '2025-01-01', 'A')],
      isLoading: false,
      error: null,
      hasNextPage: true,
      isFetchingNextPage: true,
      fetchNextPage: vi.fn(),
    };
    render(<HistoryTimelineList items={collection.data} collection={collection} />);
    expect(screen.getByTestId('timeline-loading-more')).toBeInTheDocument();
  });

  it('virtualizes long histories to a bounded number of DOM articles', () => {
    const items = Array.from({ length: 1000 }, (_, i) => mdItem(`m${i}`, `2025-01-${(i % 28) + 1}`, `body ${i}`, `title ${i}`));
    render(<HistoryTimelineList items={items} />);
    const articles = screen.getAllByRole('article');
    expect(articles.length).toBeGreaterThan(0);
    expect(articles.length).toBeLessThan(200);
  });

  it('exposes a feed/article structure and passes axe', async () => {
    const items = [mdItem('a', '2025-01-02', 'A', 'A'), mdItem('b', '2025-01-01', 'B', 'B')];
    const { container } = render(<HistoryTimelineList items={items} aria-label="Consultation history" />);
    expect(screen.getByRole('feed')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(2);
    // The expand affordance (a real button) carries aria-expanded, not the article (valid ARIA).
    expect(screen.getAllByRole('button', { name: /expand|collapse/i })[0]).toHaveAttribute('aria-expanded');
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();
  });

  it('applies the density attribute (token-driven, no hardcoded colors)', () => {
    const { container } = render(<HistoryTimelineList items={[mdItem('a', '2025-01-01', 'A')]} density="compact" />);
    expect(container.querySelector('[data-slot="history-timeline-list"]')).toHaveAttribute('data-density', 'compact');
  });
});

describe('Timeline renderers', () => {
  const base = { expanded: true, density: 'comfortable' as const, lazyMedia: true };

  it('markdown renderer is XSS-safe (no raw script execution)', () => {
    const md = 'Hello **world**\n\n<script>window.__xss = 1</script>';
    const item = mdItem('a', '2025-01-01', md);
    const { container } = render(<MarkdownRenderer {...base} item={item} content={item.content} />);
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('world')).toBeInTheDocument();
  });

  it('audio renderer (D9): clicking a word seeks the audio; player does not autoplay', () => {
    const proto = window.HTMLMediaElement.prototype as unknown as { __ct?: number };
    const seeks: number[] = [];
    const original = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, 'currentTime');
    Object.defineProperty(window.HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get() {
        return (this as typeof proto).__ct ?? 0;
      },
      set(v: number) {
        (this as typeof proto).__ct = v;
        seeks.push(v);
      },
    });
    try {
      const item = audioItem(true);
      const { container } = render(<AudioRenderer {...base} item={item} content={item.content} />);
      const audio = container.querySelector('audio');
      expect(audio).toBeTruthy();
      expect(audio!.hasAttribute('autoplay')).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'hello' }));
      expect(seeks).toContain(1.5);
    } finally {
      if (original) Object.defineProperty(window.HTMLMediaElement.prototype, 'currentTime', original);
    }
  });

  it('audio renderer renders the plain player when there are no word timestamps', () => {
    const item = audioItem(false);
    const { container } = render(<AudioRenderer {...base} item={item} content={item.content} />);
    expect(container.querySelector('audio')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'hello' })).not.toBeInTheDocument();
  });

  it('pdf renderer lazy-mounts only when expanded', async () => {
    const item: TimelineItemModel = { id: 'p', timestamp: '2025-01-01', variant: 'pdf', content: { type: 'pdf', url: '/doc.pdf', name: 'doc.pdf' } };
    const { rerender } = render(<PdfRenderer {...base} expanded={false} item={item} content={item.content} />);
    expect(screen.queryByTestId('pdf-document')).toBeNull();
    rerender(<PdfRenderer {...base} expanded item={item} content={item.content} />);
    expect(await screen.findByTestId('pdf-document')).toBeInTheDocument();
  });

  it('pdf renderer shows a download fallback when the document fails to load', async () => {
    const item: TimelineItemModel = {
      id: 'p',
      timestamp: '2025-01-01',
      variant: 'pdf',
      content: { type: 'pdf', url: '/broken.pdf', name: 'broken.pdf' },
    };
    render(<PdfRenderer {...base} expanded item={item} content={item.content} />);
    expect(await screen.findByRole('link', { name: /download/i })).toBeInTheDocument();
  });
});
