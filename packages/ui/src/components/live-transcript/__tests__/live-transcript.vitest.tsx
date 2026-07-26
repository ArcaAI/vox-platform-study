import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, renderHook, act, fireEvent, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as axeMatchers from 'vitest-axe/matchers';

import { LiveTranscript } from '../live-transcript';
import { useLiveTranscript } from '../use-live-transcript';
import type { LiveTranscriptSegment } from '../types';
import type { AsyncCollection } from '@/lib/shared';

expect.extend(axeMatchers);

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { toast } from 'sonner';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  for (const [prop, value] of [['clientHeight', 600], ['clientWidth', 800], ['offsetHeight', 600], ['offsetWidth', 800]] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

function seg(partial: Partial<LiveTranscriptSegment> & { id: string }): LiveTranscriptSegment {
  return { text: 'text', isFinal: true, ...partial };
}

const WORDS = [
  { word: 'hello', start: 1.5, end: 2 },
  { word: 'world', start: 2, end: 2.6 },
];

describe('useLiveTranscript (headless controller)', () => {
  it('merges code-switching glosses into their final (no duplicate row)', () => {
    const segments = [
      seg({ id: 'f1', text: 'hola', utteranceIndex: 0 }),
      seg({ id: 'g1', text: 'hello', utteranceIndex: 0, resultType: 'gloss' }),
    ];
    const { result } = renderHook(() => useLiveTranscript({ segments }));
    expect(result.current.segments).toHaveLength(1);
    expect(result.current.segments[0].id).toBe('f1');
    expect(result.current.segments[0].englishText).toBe('hello');
  });

  it('derives the active word from audioController.currentTime', () => {
    const segments = [seg({ id: 's1', text: 'hello world', wordTimestamps: WORDS })];
    const { result, rerender } = renderHook((time: number) => useLiveTranscript({ segments, showWords: true, audioController: { seek: vi.fn(), currentTime: time } }), {
      initialProps: 1.6,
    });
    expect(result.current.activeWord).toEqual({ segmentId: 's1', index: 0 });
    rerender(2.3);
    expect(result.current.activeWord).toEqual({ segmentId: 's1', index: 1 });
  });

  it('seekToWord seeks the audio and fires onWordClick', () => {
    const seek = vi.fn();
    const onWordClick = vi.fn();
    const segments = [seg({ id: 's1', text: 'hello world', wordTimestamps: WORDS })];
    const { result } = renderHook(() => useLiveTranscript({ segments, showWords: true, audioController: { seek }, onWordClick }));
    act(() => result.current.seekToWord(segments[0], 1));
    expect(seek).toHaveBeenCalledWith(2);
    expect(onWordClick).toHaveBeenCalledWith(segments[0], WORDS[1]);
  });

  it('canEdit honors editable + final-only policy', () => {
    const { result } = renderHook(() => useLiveTranscript({ segments: [], editable: true, editingPolicy: 'final-only' }));
    expect(result.current.canEdit(seg({ id: 'a', isFinal: true }))).toBe(true);
    expect(result.current.canEdit(seg({ id: 'b', isFinal: false }))).toBe(false);
  });
});

describe('LiveTranscript (shell)', () => {
  it('renders final segments and shows interim text in muted italic', () => {
    const { container } = render(<LiveTranscript segments={[seg({ id: 'f', text: 'Final line' })]} interim="partial words" />);
    expect(screen.getByText('Final line')).toBeInTheDocument();
    const interimRow = container.querySelector('[data-slot="live-transcript-interim"]');
    expect(interimRow).toBeTruthy();
    expect(interimRow!.className).toContain('italic');
  });

  it('renders a stableChars partial with a settled prefix and tentative tail', () => {
    const { container } = render(<LiveTranscript segments={[seg({ id: 'p', text: 'hello world', isFinal: false, stableChars: 5 })]} />);
    const settled = container.querySelector('.not-italic');
    expect(settled?.textContent).toBe('hello');
  });

  it('shows skeleton while loading and an empty state when idle with no segments', () => {
    const { rerender } = render(<LiveTranscript segments={[]} isLoading />);
    expect(screen.getByTestId('transcript-skeleton')).toBeInTheDocument();
    rerender(<LiveTranscript segments={[]} isListening={false} />);
    expect(screen.getByText(/no transcript yet/i)).toBeInTheDocument();
  });

  it('renders the listening pulse when isListening', () => {
    const { container } = render(<LiveTranscript segments={[seg({ id: 'f', text: 'x' })]} isListening />);
    expect(container.querySelector('[data-slot="listening-pulse"][data-active="true"]')).toBeTruthy();
  });

  it('renders speaker labels and timestamps', () => {
    render(
      <LiveTranscript
        segments={[seg({ id: 'f', text: 'Hi', speakerLabel: 'Doctor', startTime: 75 })]}
        showSpeakers
        showTimestamps
        speakers={{ Doctor: { label: 'Dr. Smith', colorRole: 'primary' } }}
      />,
    );
    expect(screen.getByText('Dr. Smith')).toBeInTheDocument();
    expect(screen.getByText('1:15')).toBeInTheDocument();
  });

  it('virtualizes long sessions to a bounded number of segment rows', () => {
    const segments = Array.from({ length: 2000 }, (_, i) => seg({ id: `s${i}`, text: `line ${i}` }));
    const { container } = render(<LiveTranscript segments={segments} />);
    const rows = container.querySelectorAll('[data-slot="transcript-segment"]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);
  });

  it('shows Jump to live + fetches older history when scrolled up, then re-pins on click', () => {
    const fetchNextPage = vi.fn();
    const collection: AsyncCollection<LiveTranscriptSegment> = {
      data: [],
      isLoading: false,
      error: null,
      hasNextPage: true,
      fetchNextPage,
    };
    render(<LiveTranscript segments={[seg({ id: 'a', text: 'A' })]} collection={collection} />);
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 600 });
    log.scrollTop = 0;
    fireEvent.scroll(log);
    expect(fetchNextPage).toHaveBeenCalled();
    const jump = screen.getByRole('button', { name: /jump to latest/i });
    fireEvent.click(jump);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).not.toBeInTheDocument();
  });
});

describe('LiveTranscript words (D9)', () => {
  it('renders clickable word tokens that seek + fire onWordClick; active word gets aria-current', () => {
    const seek = vi.fn();
    const onWordClick = vi.fn();
    render(
      <LiveTranscript
        segments={[seg({ id: 's1', text: 'hello world', wordTimestamps: WORDS })]}
        showWords
        audioController={{ seek, currentTime: 1.6 }}
        onWordClick={onWordClick}
      />,
    );
    const hello = screen.getByRole('button', { name: /hello/i });
    expect(hello).toHaveAttribute('aria-current', 'true');
    fireEvent.click(screen.getByRole('button', { name: /world/i }));
    expect(seek).toHaveBeenCalledWith(2);
    expect(onWordClick).toHaveBeenCalled();
  });

  it('renders non-interactive word spans when no audioController is present', () => {
    render(<LiveTranscript segments={[seg({ id: 's1', text: 'hello world', wordTimestamps: WORDS })]} showWords />);
    expect(screen.queryByRole('button', { name: /hello/i })).not.toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('renders plain text when a segment has no word timestamps; confidence:null words still render', () => {
    const { rerender } = render(<LiveTranscript segments={[seg({ id: 's1', text: 'no words here' })]} showWords />);
    expect(screen.getByText('no words here')).toBeInTheDocument();
    rerender(
      <LiveTranscript
        segments={[seg({ id: 's2', text: 'hi', wordTimestamps: [{ word: 'hi', start: 0, end: 1, confidence: null }] })]}
        showWords
        audioController={{ seek: vi.fn() }}
      />,
    );
    expect(screen.getByRole('button', { name: /hi/i })).toBeInTheDocument();
  });
});

describe('LiveTranscript editing (D4 — Lexical)', () => {
  const finals = [seg({ id: 's1', text: 'First segment' }), seg({ id: 's2', text: 'Second segment' })];

  // Warm the lazily-imported editor (it pulls in the whole Lexical library) so
  // its first transform/eval happens here, off the timed `findByRole` path. On
  // a loaded CI runner a cold `React.lazy(() => import('./segment-editor'))`
  // could exceed the 1s default async timeout, leaving the "Loading editor"
  // fallback mounted and flaking the first edit test.
  beforeAll(async () => {
    await import('../segment-editor');
  });

  it('hides the edit affordance when not editable and blocks editing interim under final-only', () => {
    const { rerender } = render(<LiveTranscript segments={finals} editable={false} />);
    expect(screen.queryByRole('button', { name: /edit segment/i })).not.toBeInTheDocument();
    rerender(<LiveTranscript segments={[seg({ id: 'i', text: 'interim seg', isFinal: false })]} editable editingPolicy="final-only" />);
    expect(screen.queryByRole('button', { name: /edit segment/i })).not.toBeInTheDocument();
  });

  it('lazy-mounts a single Lexical editor seeded with the segment text', async () => {
    render(<LiveTranscript segments={finals} editable />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /edit segment/i })[0]);
    const editor = await screen.findByRole('textbox', { name: /edit transcript segment/i });
    expect(editor.textContent).toContain('First segment');
    // Opening another segment's editor keeps only one mounted.
    fireEvent.click(screen.getByRole('button', { name: /edit segment/i }));
    await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(1));
  });

  it('saves (plain text) via Save and ⌘/Ctrl+Enter, and cancels via Esc', async () => {
    const onEditSegment = vi.fn().mockResolvedValue(undefined);
    render(<LiveTranscript segments={finals} editable onEditSegment={onEditSegment} />);

    fireEvent.click(screen.getAllByRole('button', { name: /edit segment/i })[0]);
    await screen.findByRole('textbox', { name: /edit transcript segment/i });
    fireEvent.click(screen.getByRole('button', { name: /save edit/i }));
    expect(onEditSegment).toHaveBeenLastCalledWith('s1', 'First segment');

    fireEvent.click(screen.getAllByRole('button', { name: /edit segment/i })[0]);
    const editor = await screen.findByRole('textbox', { name: /edit transcript segment/i });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    expect(onEditSegment).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getAllByRole('button', { name: /edit segment/i })[0]);
    const editor2 = await screen.findByRole('textbox', { name: /edit transcript segment/i });
    fireEvent.keyDown(editor2, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(onEditSegment).toHaveBeenCalledTimes(2);
  });

  it('reverts and surfaces a toast when the save is rejected', async () => {
    const onEditSegment = vi.fn().mockRejectedValue(new Error('nope'));
    render(<LiveTranscript segments={finals} editable onEditSegment={onEditSegment} />);
    fireEvent.click(screen.getAllByRole('button', { name: /edit segment/i })[0]);
    await screen.findByRole('textbox', { name: /edit transcript segment/i });
    fireEvent.click(screen.getByRole('button', { name: /save edit/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});

describe('LiveTranscript a11y', () => {
  it('is a polite log; interim excluded; pauses during edit; axe clean', async () => {
    const { container, rerender } = render(
      <LiveTranscript
        segments={[seg({ id: 's1', text: 'hello world', wordTimestamps: WORDS })]}
        interim="live partial"
        showWords
        audioController={{ seek: vi.fn() }}
        editable
        aria-label="Consultation transcript"
      />,
    );
    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(container.querySelector('[data-slot="live-transcript-interim"]')).toHaveAttribute('aria-live', 'off');

    const results = await axe(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results).toHaveNoViolations();

    fireEvent.click(screen.getAllByRole('button', { name: /edit segment/i })[0]);
    await screen.findByRole('textbox', { name: /edit transcript segment/i });
    expect(screen.getByRole('log')).toHaveAttribute('aria-live', 'off');
    rerender(<></>);
  });
});
